"""Tests for ``scholium rebuild <archive.car> --db <path>``.

The archives here carry what a complete public export carries: the event-log
entries (one block per appended record, chained by ``entry_hash``), the record
envelopes and the file blocks.  ``car_helpers.archive_car`` assembles one the
way an honest node would, and the tampering tests then break exactly one thing
at a time.
"""

import base64
import copy
import json
import os
import sqlite3
import subprocess
import sys

import dag_cbor
import pytest
from car_helpers import (
    KEYS,
    archive_car,
    dag_cbor_cid,
    entry_hash,
    flip,
    full_record_block,
    header,
    log_entry_blocks,
    make_paper,
    notice,
    record_bytes,
    signed,
    write_car,
)
from scholium_cli.main import main
from scholium_record_core import sign_envelope


@pytest.fixture
def car_file(tmp_path):
    def write(data: bytes, name: str = "archive.car"):
        path = tmp_path / name
        path.write_bytes(data)
        return str(path)

    return write


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "rebuilt.db")


def rebuild(car_file, data, db, capsys, *options):
    code = main(["rebuild", car_file(data), "--db", db, *options])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def query(db, sql, params=()):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in con.execute(sql, params)]
    finally:
        con.close()


def one(db, sql, params=()):
    rows = query(db, sql, params)
    assert len(rows) == 1, rows
    return rows[0]


# --- the happy path -----------------------------------------------------


def test_rebuilds_every_paper_and_prints_the_count(car_file, db_path, capsys):
    one_, two = make_paper(seed="one"), make_paper(seed="two", versions=2)
    code, out, err = rebuild(car_file, archive_car([one_, two]), db_path, capsys)
    assert code == 0, out
    assert err == ""
    assert f"Rebuilt 2 papers (3 versions) into {db_path}" in out
    assert "Result: REBUILT (2 papers)" in out
    assert len(query(db_path, "SELECT * FROM paper")) == 2
    assert len(query(db_path, "SELECT * FROM paper_version")) == 3
    assert len(query(db_path, "SELECT * FROM paper_status")) == 2


def test_the_log_chain_line_reports_the_head(car_file, db_path, capsys):
    paper = make_paper(versions=2)
    code, out, _ = rebuild(car_file, archive_car([paper]), db_path, capsys)
    assert code == 0
    entries = len(paper.records())
    assert f"Log chain intact: {entries} entries (seq 1-{entries})" in out
    assert f"{entries} records authenticated" in out


def test_paper_rows_carry_the_view_columns(car_file, db_path, capsys):
    paper = make_paper(versions=2)
    code, out, _ = rebuild(car_file, archive_car([paper]), db_path, capsys)
    assert code == 0, out
    row = one(db_path, "SELECT * FROM paper WHERE paper_cid = ?", (paper.paper_id,))
    assert row["short_id"] == paper.short_id
    assert row["title"] == "A Paper, version 2"
    assert json.loads(row["categories"]) == ["math"]
    assert row["licence"] == "CC-BY-4.0"
    assert row["status"] == "preprint"
    assert row["latest_version_cid"] == paper.versions[-1]["id"]
    assert row["version_count"] == 2
    assert row["created"] == paper.genesis["created"]


def test_version_rows_match_the_signed_records(car_file, db_path, capsys):
    paper = make_paper(versions=2)
    code, out, _ = rebuild(car_file, archive_car([paper]), db_path, capsys)
    assert code == 0, out
    for position, version in enumerate(paper.versions):
        row = one(
            db_path, "SELECT * FROM paper_version WHERE version_cid = ?", (version["id"],)
        )
        body = version["body"]
        assert row["paper_cid"] == paper.paper_id
        assert row["n"] == position + 1
        assert row["title"] == body["title"]
        assert row["abstract"] == body["abstract"]
        assert row["manifest_cid"] == body["manifest"]
        expected_prev = paper.versions[position - 1]["id"] if position else paper.paper_id
        assert row["prev_cid"] == expected_prev
        assert json.loads(row["authors"]) == body["authors"]
        assert row["licence"] == body["licence"]
        assert row["change_note"] == body["changeNote"]
        assert row["created"] == version["created"]


def test_a_reviewed_paper_gets_the_reviewed_status(car_file, db_path, capsys):
    paper = make_paper()
    for reviewer in ("carol", "dave"):
        paper.extra.append(
            signed(
                reviewer,
                "review.formal",
                {
                    "target": paper.versions[0]["id"],
                    "scores": {},
                    "confidence": 3,
                    "recommendation": "minor revisions",
                },
            )
        )
    code, out, _ = rebuild(car_file, archive_car([paper]), db_path, capsys)
    assert code == 0, out
    row = one(db_path, "SELECT * FROM paper_status WHERE paper_cid = ?", (paper.paper_id,))
    assert row["status"] == "reviewed"
    assert row["rule"] == "reviews_supportive"
    assert row["short_id"] == paper.short_id
    assert len(json.loads(row["evidence"])) == 2


@pytest.mark.parametrize(
    "record, status, rule",
    [
        (lambda p: notice("alice", "retraction", p.paper_id), "retracted", "retraction"),
        (lambda p: notice("alice", "correction", p.paper_id), "corrected", "correction"),
        (
            lambda p: signed(
                "committee",
                "moderation.decision",
                {
                    "target": p.versions[0]["id"],
                    "action": "hold",
                    "clause": "MOD-07",
                    "reasonCid": "x",
                },
            ),
            "contested",
            "moderation_hold",
        ),
        (
            lambda p: signed(
                "carol",
                "review.formal",
                {
                    "target": p.versions[0]["id"],
                    "scores": {},
                    "confidence": 3,
                    "recommendation": "reject",
                },
            ),
            "contested",
            "review_rejection",
        ),
        (
            lambda p: signed(
                "carol", "review.commit", {"target": p.versions[0]["id"], "commitment": "ab" * 16}
            ),
            "under_review",
            "review_activity",
        ),
    ],
)
def test_every_status_rule_lands_in_the_status_view(
    car_file, db_path, capsys, record, status, rule
):
    paper = make_paper()
    paper.extra.append(record(paper))
    code, out, _ = rebuild(car_file, archive_car([paper]), db_path, capsys)
    assert code == 0, out
    row = one(db_path, "SELECT * FROM paper_status WHERE paper_cid = ?", (paper.paper_id,))
    assert row["status"] == status
    assert row["rule"] == rule
    paper_row = one(db_path, "SELECT status FROM paper WHERE paper_cid = ?", (paper.paper_id,))
    assert paper_row["status"] == status


def test_a_notice_about_one_paper_does_not_touch_the_other(car_file, db_path, capsys):
    one_, two = make_paper(seed="one"), make_paper(seed="two")
    one_.extra.append(notice("alice", "retraction", one_.paper_id))
    code, out, _ = rebuild(car_file, archive_car([one_, two]), db_path, capsys)
    assert code == 0, out
    statuses = {
        row["paper_cid"]: row["status"]
        for row in query(db_path, "SELECT paper_cid, status FROM paper_status")
    }
    assert statuses[one_.paper_id] == "retracted"
    assert statuses[two.paper_id] == "preprint"


def test_rebuilding_twice_yields_identical_databases(car_file, tmp_path, capsys):
    paper = make_paper(versions=2)
    paper.extra.append(notice("alice", "correction", paper.paper_id))
    data = archive_car([paper])
    first, second = str(tmp_path / "a.db"), str(tmp_path / "b.db")
    assert main(["rebuild", car_file(data, "one.car"), "--db", first]) == 0
    assert main(["rebuild", car_file(data, "two.car"), "--db", second]) == 0
    for table in ("paper", "paper_version", "paper_status"):
        assert query(first, f"SELECT * FROM {table}") == query(second, f"SELECT * FROM {table}")


def test_an_empty_archive_rebuilds_zero_papers(car_file, db_path, capsys):
    code, out, err = rebuild(car_file, write_car([]), db_path, capsys)
    assert code == 0, err
    assert "Rebuilt 0 papers (0 versions)" in out
    assert query(db_path, "SELECT * FROM paper") == []


# --- the log chain: exit 1 -------------------------------------------------


def test_records_without_log_entries_cannot_be_rebuilt(car_file, db_path, capsys):
    paper = make_paper()
    code, out, _ = rebuild(car_file, write_car(paper.blocks()), db_path, capsys)
    assert code == 1
    assert "no log entries" in out
    assert "Result: NOT REBUILT" in out


def test_a_chain_that_does_not_start_at_seq_1_fails(car_file, db_path, capsys):
    paper = make_paper()
    records = paper.records()
    blocks = log_entry_blocks(records, start_seq=2)
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 1
    assert "expected seq 1, found 2" in out


def test_a_missing_log_entry_is_a_gap(car_file, db_path, capsys):
    paper = make_paper(versions=2)
    records = paper.records()
    blocks = log_entry_blocks(records)
    del blocks[2]  # the entry of the first version record
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 1
    assert "expected seq 3, found 4" in out


def test_a_broken_prev_link_fails(car_file, db_path, capsys):
    paper = make_paper(versions=2)

    def break_link(seq, entry):
        if seq == 3:
            # self-consistent, but no longer the hash of the entry before it
            entry["prev_hash"] = b"\x01" * 32

    records = paper.records()
    blocks = log_entry_blocks(records, mutate=break_link)
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 1
    assert "seq 3" in out
    assert "prev_hash" in out


def test_log_bytes_that_disagree_with_the_record_fail(car_file, db_path, capsys):
    paper = make_paper()

    def rewrite_raw(seq, entry):
        if seq == 2:
            entry["raw"] = b"not the canonical bytes"  # entry_hash follows; the record does not

    records = paper.records()
    blocks = log_entry_blocks(records, mutate=rewrite_raw)
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 1
    assert "does not carry the canonical bytes" in out


def test_a_record_absent_from_the_log_fails(car_file, db_path, capsys):
    paper, other = make_paper(seed="one"), make_paper(seed="two")
    code, out, _ = rebuild(
        car_file,
        write_car(
            log_entry_blocks(paper.records())
            + [full_record_block(record) for record in paper.records() + other.records()]
        ),
        db_path,
        capsys,
    )
    assert code == 1
    assert "is not named by any log entry" in out


def test_one_altered_byte_of_a_record_fails(car_file, db_path, capsys):
    paper = make_paper()
    data = archive_car([paper])
    code, out, _ = rebuild(car_file, flip(data, len(header()) + 10), db_path, capsys)
    assert code == 1
    assert "do not match" in out


def test_an_altered_log_entry_fails_even_with_a_recomputed_cid(car_file, db_path, capsys):
    paper = make_paper()

    def break_hash(seq, entry):
        if seq == 1:
            entry["entry_hash"] = b"\x02" * 32  # the block cid follows; the chain does not

    records = paper.records()
    blocks = log_entry_blocks(records, mutate=break_hash)
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 1
    assert "entry_hash" in out


def test_nothing_is_written_when_verification_fails(car_file, db_path, capsys):
    paper = make_paper()
    code, _, _ = rebuild(car_file, write_car(paper.blocks()), db_path, capsys)
    assert code == 1
    assert not os.path.exists(db_path)


def test_log_entries_in_their_wire_form_are_read_too(car_file, db_path, capsys):
    """Hashes as hex and ``raw`` as base64 -- how ``GET /v1/sync/range`` serves them."""
    paper = make_paper()
    records = paper.records()
    blocks = []
    prev = b"\x00" * 32
    for seq, record in enumerate(records, start=1):
        raw = record_bytes(record)
        digest = entry_hash(prev, record["id"], raw)
        entry = {
            "seq": seq,
            "record_cid": record["id"],
            "raw": base64.b64encode(raw).decode("ascii"),
            "prev_hash": prev.hex(),
            "entry_hash": digest.hex(),
        }
        data = dag_cbor.encode(entry)
        blocks.append((dag_cbor_cid(data), data))
        prev = digest
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 0, out
    assert len(query(db_path, "SELECT * FROM paper")) == 1


def test_a_log_entry_with_an_unreadable_field_fails(car_file, db_path, capsys):
    paper = make_paper()
    records = paper.records()
    blocks = log_entry_blocks(records)
    entry = dag_cbor.decode(blocks[0][1])
    entry["raw"] = 123  # not bytes, not base64; the block cid follows, the chain cannot
    data = dag_cbor.encode(entry)
    blocks[0] = (dag_cbor_cid(data), data)
    blocks += [full_record_block(record) for record in records]
    code, out, _ = rebuild(car_file, write_car(blocks), db_path, capsys)
    assert code == 1
    assert "not well formed" in out


@pytest.mark.slow
def test_no_single_byte_flip_in_the_archive_rebuilds(tmp_path):
    """Altering any one byte after the header never yields a rebuild.

    The header's ``roots`` are not covered by any hash and nothing is read
    from them, so the sweep starts after the header (the same rationale as
    ``verify``'s sweep).  Every flip lands inside a block, and a block whose
    bytes changed no longer hashes to its CID.
    """
    from scholium_cli.rebuild import rebuild_car_bytes

    paper = make_paper(authors=("alice",))
    data = archive_car([paper])
    survivors = []
    for index in range(len(header()), len(data)):
        result = rebuild_car_bytes(flip(data, index, 0x01), tmp_path / f"flip-{index}.db")
        if result.ok:
            survivors.append(index)
    assert survivors == []


# --- record verification: exit 1 -------------------------------------------


def test_a_forged_signature_fails(car_file, db_path, capsys):
    paper = make_paper()
    forged = copy.deepcopy(paper.consents[0][1])
    forged["sig"] = sign_envelope(forged, KEYS["mallory"])
    records = [forged if r is paper.consents[0][1] else r for r in paper.records()]
    code, out, _ = rebuild(car_file, archive_car([records]), db_path, capsys)
    assert code == 1
    assert "signature does not verify against its author" in out


def test_a_missing_consent_fails_the_paper(car_file, db_path, capsys):
    paper = make_paper()
    records = [r for r in paper.records() if r is not paper.consents[0][1]]
    code, out, _ = rebuild(car_file, archive_car([records]), db_path, capsys)
    assert code == 1
    assert "Not every listed author consented" in out


def test_competing_heads_fail(car_file, db_path, capsys):
    paper = make_paper()
    fork = signed(
        "alice",
        "paper.version",
        {**copy.deepcopy(paper.versions[0]["body"]), "title": "A Fork"},
        prev=paper.paper_id,
    )
    code, out, _ = rebuild(car_file, archive_car([paper, [fork]]), db_path, capsys)
    assert code == 1
    assert "competing heads" in out


# --- usage errors: exit 2 --------------------------------------------------


def test_an_existing_database_is_refused(tmp_path, capsys):
    db = tmp_path / "there.db"
    db.write_text("precious data")
    code = main(["rebuild", str(tmp_path / "a.car"), "--db", str(db)])
    captured = capsys.readouterr()
    assert code == 2
    assert "already exists" in captured.err
    assert db.read_text() == "precious data"


def test_a_missing_archive_file_is_a_usage_error(tmp_path, db_path, capsys):
    code = main(["rebuild", str(tmp_path / "nope.car"), "--db", db_path])
    captured = capsys.readouterr()
    assert code == 2
    assert "cannot read" in captured.err
    assert captured.out == ""


def test_a_missing_db_option_is_rejected_by_argparse(car_file):
    with pytest.raises(SystemExit) as exc:
        main(["rebuild", car_file(b"")])
    assert exc.value.code == 2


def test_a_db_path_without_a_parent_directory_is_a_usage_error(car_file, tmp_path, capsys):
    paper = make_paper()
    code, out, err = rebuild(
        car_file, archive_car([paper]), str(tmp_path / "nope" / "x.db"), capsys
    )
    assert code == 2
    assert "cannot write" in err


# --- as a real process ------------------------------------------------------


def test_works_as_a_real_process_with_the_documented_exit_codes(tmp_path):
    paper = make_paper()
    good = tmp_path / "archive.car"
    good.write_bytes(archive_car([paper]))
    altered = flip(archive_car([paper]), len(archive_car([paper])) // 2)
    bad = tmp_path / "altered.car"
    bad.write_bytes(altered)

    def run(path, db):
        return subprocess.run(
            [sys.executable, "-m", "scholium_cli.main", "rebuild", str(path), "--db", str(db)],
            capture_output=True,
            check=False,
            text=True,
            encoding="utf-8",
        )

    ok = run(good, tmp_path / "ok.db")
    assert ok.returncode == 0, ok.stderr
    assert "Rebuilt 1 paper (1 version)" in ok.stdout
    broken = run(bad, tmp_path / "broken.db")
    assert broken.returncode == 1, broken.stderr
    assert "NOT REBUILT" in broken.stdout
    assert not (tmp_path / "broken.db").exists()
    again = run(good, tmp_path / "ok.db")
    assert again.returncode == 2
    assert "already exists" in again.stderr
