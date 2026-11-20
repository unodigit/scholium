"""Tests for ``scholium verify <file.car>``."""

import argparse
import copy
import io
import json
import subprocess
import sys

import dag_cbor
import pytest
from car_helpers import (
    KEYS,
    canonical_record_block,
    dag_cbor_cid,
    did,
    file_block,
    file_entry,
    flip,
    full_record_block,
    header,
    log_entry_blocks,
    make_paper,
    notice,
    signed,
    tombstone,
    write_car,
)
from scholium_cli import verify as verify_module
from scholium_cli.main import main
from scholium_cli.verify import verify_car_bytes
from scholium_record_core import encode_signature, sign_record


@pytest.fixture
def car_file(tmp_path):
    def write(data: bytes, name: str = "paper.car"):
        path = tmp_path / name
        path.write_bytes(data)
        return str(path)

    return write


def verify(car_file, data, *options, capsys):
    code = main(["verify", car_file(data), *options])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def record_offsets(paper):
    """``(start, end)`` of the data of each record block in ``paper.car()``."""
    offset = len(header())
    spans = []
    for cid, data in paper.blocks():
        length = len(bytes(cid)) + len(data)
        prefix = 1 if length < 128 else 2
        start = offset + prefix + len(bytes(cid))
        spans.append((start, start + len(data)))
        offset += prefix + length
    return spans


# --- the happy path -----------------------------------------------------


def test_a_valid_archive_verifies_with_exit_0(car_file, capsys):
    paper = make_paper(versions=2)
    code, out, err = verify(car_file, paper.car(), capsys=capsys)
    assert code == 0, out
    assert err == ""
    assert "Result: VERIFIED" in out
    assert "NOT VERIFIED" not in out


def test_prints_the_plain_language_checklist(car_file, capsys):
    paper = make_paper(versions=2)
    _, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert f"Paper: {paper.short_id}/v2" in out
    assert "Verifying paper.car" in out
    assert "match their content ids" in out
    assert "Signed by all 2 listed authors" in out
    assert "Version history is intact (v1 → v2)" in out
    assert "The file matches the signed manifest" in out
    assert "anchor pending" in out
    assert "No retraction, correction or tombstone applies" in out
    lines = [line for line in out.splitlines() if line.startswith("  ")]
    assert len(lines) == 6
    assert sum(line.lstrip().startswith("✓") for line in lines) == 5
    assert sum(line.lstrip().startswith("…") for line in lines) == 1


def test_a_single_version_paper_verifies(car_file, capsys):
    code, out, _ = verify(car_file, make_paper().car(), capsys=capsys)
    assert code == 0
    assert "The file matches the signed manifest" in out


def test_extra_blocks_are_checked_then_ignored(car_file, capsys):
    paper = make_paper()
    entry = dag_cbor.encode({"seq": 1, "record": paper.paper_id, "prev_hash": b"\x00" * 32})
    blocks = paper.blocks() + [full_record_block({"not": "a record"})]
    blocks.append((dag_cbor_cid(entry), entry))
    code, out, _ = verify(car_file, write_car(blocks), capsys=capsys)
    assert code == 0, out
    assert f"All {len(blocks)} blocks" in out


def test_duplicate_blocks_do_not_matter(car_file, capsys):
    paper = make_paper()
    blocks = paper.blocks()
    code, _, _ = verify(car_file, write_car(blocks + blocks), capsys=capsys)
    assert code == 0


def test_record_order_in_the_archive_does_not_matter(car_file, capsys):
    paper = make_paper(versions=2)
    blocks = paper.blocks()
    code, _, _ = verify(car_file, write_car(blocks[::-1]), capsys=capsys)
    assert code == 0


def test_works_as_a_real_process_with_the_documented_exit_codes(tmp_path):
    paper = make_paper()
    good = tmp_path / "good.car"
    good.write_bytes(paper.car())
    bad = tmp_path / "bad.car"
    start, _ = record_offsets(paper)[0]
    bad.write_bytes(flip(paper.car(), start + 3))

    def run(path):
        return subprocess.run(
            [sys.executable, "-m", "scholium_cli.main", "verify", str(path)],
            capture_output=True,
            check=False,
            text=True,
            encoding="utf-8",
        )

    ok, broken = run(good), run(bad)
    assert ok.returncode == 0, ok.stderr
    assert "Result: VERIFIED" in ok.stdout
    assert broken.returncode == 1, broken.stderr
    assert "NOT VERIFIED" in broken.stdout
    assert run(tmp_path / "missing.car").returncode == 2


# --- tampering: exit 1 --------------------------------------------------


def test_one_altered_byte_of_a_record_is_a_hash_mismatch(car_file, capsys):
    paper = make_paper()
    data = paper.car()
    start, end = record_offsets(paper)[2]  # the version record
    code, out, _ = verify(car_file, flip(data, (start + end) // 2), capsys=capsys)
    assert code == 1
    assert "do not match their content ids" in out
    assert "Result: NOT VERIFIED" in out


def test_an_altered_record_with_a_recomputed_cid_fails_the_signature(car_file, capsys):
    paper = make_paper()
    forged = copy.deepcopy(paper.versions[0])
    forged["body"]["title"] = "A Different Paper"  # id and sig are now stale
    records = [forged if r is paper.versions[0] else r for r in paper.records()]
    code, out, _ = verify(car_file, paper.car(records=records), capsys=capsys)
    assert code == 1
    assert "match their content ids" in out  # the blocks are internally consistent
    assert "✗" in out
    assert "id does not match the hash of its content" in out


def test_a_signature_by_the_wrong_key_fails(car_file, capsys):
    paper = make_paper()
    forged = copy.deepcopy(paper.versions[0])
    forged["sig"] = signed("mallory", "paper.version", forged["body"], prev=forged["prev"])["sig"]
    records = [forged if r is paper.versions[0] else r for r in paper.records()]
    code, out, _ = verify(car_file, paper.car(records=records), capsys=capsys)
    assert code == 1
    assert "signature does not verify against its author" in out


def test_a_missing_version_breaks_the_history(car_file, capsys):
    paper = make_paper(versions=3)
    records = [r for r in paper.records() if r is not paper.versions[1]]
    code, out, _ = verify(car_file, paper.car(records=records), capsys=capsys)
    assert code == 1
    assert "The version history is broken" in out


def test_a_missing_consent_fails(car_file, capsys):
    paper = make_paper()
    records = [r for r in paper.records() if r is not paper.consents[0][1]]
    code, out, _ = verify(car_file, paper.car(records=records), capsys=capsys)
    assert code == 1
    assert "Not every listed author consented" in out


def test_a_declined_consent_fails(car_file, capsys):
    paper = make_paper()
    decline = signed(
        "bob",
        "coauthor.consent",
        {"version": paper.versions[0]["id"], "role": "author", "decision": "decline"},
        created="2026-11-15T00:00:00Z",
    )
    paper.extra.append(decline)
    code, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert code == 1
    assert "declined by" in out


def test_an_altered_file_fails_the_archive_and_the_manifest(car_file, capsys):
    paper = make_paper()
    cid, data = file_block(paper.files["main-v1.pdf"])
    forged = [b for b in paper.blocks(with_files=False)] + [(cid, flip(data, 0))]
    code, out, _ = verify(car_file, write_car(forged), capsys=capsys)
    assert code == 1
    assert "some blocks do not match their content ids (1 of" in out
    assert "main-v1.pdf: the bytes in the archive do not hash to the signed file id" in out
    assert "failed the check against the signed manifest" in out


def test_a_file_of_the_wrong_size_in_a_signed_manifest_fails(car_file, capsys):
    paper = make_paper(file_size=999)
    code, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert code == 1
    assert "the signed manifest says 999" in out


def test_an_unsigned_canonical_record_is_reported_unsigned(car_file, capsys):
    paper = make_paper()
    blocks = [canonical_record_block(r) for r in paper.records()]
    code, out, _ = verify(car_file, write_car(blocks), capsys=capsys)
    assert code == 1
    assert "has no signature" in out


def test_a_forged_retraction_fails_instead_of_being_ignored(car_file, capsys):
    paper = make_paper()
    retraction = notice("alice", "retraction", paper.paper_id)
    retraction["body"]["reason"] = "forged"
    paper.extra.append(retraction)
    code, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert code == 1
    assert "failed authentication" in out


@pytest.mark.parametrize(
    "data",
    [b"", b"not a car file at all", b"\x00", b"\xff" * 64],
)
def test_a_file_that_is_not_a_car_fails_with_exit_1(car_file, capsys, data):
    code, out, err = verify(car_file, data, capsys=capsys)
    assert code == 1
    assert "not a readable CAR archive" in out
    assert "Result: NOT VERIFIED" in out
    assert err == ""


def test_a_truncated_archive_fails_with_exit_1(car_file, capsys):
    data = make_paper().car()
    code, out, _ = verify(car_file, data[: len(data) // 2], capsys=capsys)
    assert code == 1
    assert "not a readable CAR archive" in out


def test_an_archive_without_any_paper_fails(car_file, capsys):
    code, out, _ = verify(car_file, write_car([file_block(b"just a file")]), capsys=capsys)
    assert code == 1
    assert "no paper.genesis or paper.version" in out


@pytest.mark.slow
def test_no_single_byte_flip_in_the_archive_goes_unnoticed():
    """Altering any one byte after the header never yields exit 0.

    The header's ``roots`` are not covered by any hash and nothing is read
    from them, so the sweep starts after the header.  Files are included: a
    flipped file block is a hash mismatch like any other.
    """
    paper = make_paper(authors=("alice",))
    data = paper.car()
    survivors = [
        (index, mask)
        for index in range(len(header()), len(data))
        for mask in (0x01,)
        if verify_car_bytes(flip(data, index, mask)).ok
    ]
    assert survivors == []


# --- retraction and authorities: still verified, exit 0 -----------------


def test_a_retracted_paper_still_verifies_and_says_so(car_file, capsys):
    paper = make_paper()
    paper.extra.append(notice("alice", "retraction", paper.paper_id))
    code, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert code == 0
    assert "!" in out
    assert "Retracted: a retraction notice applies" in out
    assert "Result: VERIFIED (status: retracted)" in out


def test_a_correction_is_a_warning_not_a_failure(car_file, capsys):
    paper = make_paper()
    paper.extra.append(notice("alice", "correction", paper.paper_id))
    code, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert code == 0
    assert "Corrected:" in out
    assert "Result: VERIFIED (status: corrected)" in out


def test_a_tombstone_applies_only_from_a_trusted_authority(car_file, capsys):
    paper = make_paper()
    paper.extra.append(tombstone("committee", paper.paper_id))
    data = paper.car()

    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 0
    assert "Result: VERIFIED\n" in out
    assert "not applied: advisory" in verify_detail(car_file, data, capsys)

    code, out, _ = verify(car_file, data, "--authority", did("committee"), capsys=capsys)
    assert code == 0
    assert "Tombstoned:" in out
    assert "Result: VERIFIED (status: tombstoned)" in out


def verify_detail(car_file, data, capsys):
    main(["verify", car_file(data), "--verbose"])
    return capsys.readouterr().out


def test_a_file_missing_from_the_archive_is_a_warning_not_a_mismatch(car_file, capsys):
    paper = make_paper()
    code, out, _ = verify(car_file, paper.car(with_files=False), capsys=capsys)
    assert code == 0
    assert "could not be compared with the signed manifest" in out
    assert "main-v1.pdf: not included in this archive" in out


def test_some_files_missing_says_how_many(car_file, capsys):
    paper = make_paper()
    extra = b"a second file"
    paper.files["data.csv"] = extra
    manifest = signed(
        "alice", "manifest", {"files": [file_entry("main-v1.pdf", paper.files["main-v1.pdf"]), file_entry("data.csv", extra)]}
    )
    version = copy.deepcopy(paper.versions[0])
    del version["id"], version["sig"]
    version["body"]["manifest"] = manifest["id"]
    version = sign_record(version, KEYS["alice"])
    consents = [
        signed("alice", "coauthor.consent", {"version": version["id"], "role": "author", "decision": "accept"}),
        signed("bob", "coauthor.consent", {"version": version["id"], "role": "author", "decision": "accept"}),
    ]
    records = [paper.genesis, manifest, version, *consents]
    blocks = [full_record_block(r) for r in records] + [file_block(paper.files["main-v1.pdf"])]
    code, out, _ = verify(car_file, write_car(blocks), capsys=capsys)
    assert code == 0, out
    assert "1 of 2 files match the signed manifest; 1 not included in this archive" in out


# --- several papers in one archive --------------------------------------


def node_head_block(seq, entry_hash, name="alice", *, signature_over=None):
    """The signed log head ``GET /v1/sync/head`` serves, as a CAR block.

    ``signature_over`` signs different bytes than the head carries, which is
    how a forged head is built without breaking its block hash.
    """
    node_did = did(name)
    claimed = {
        "entry_hash": bytes(entry_hash).hex(),
        "node_did": node_did,
        "seq": int(seq),
    }
    signed = dict(claimed)
    signed.update(signature_over or {})
    message = json.dumps(signed, sort_keys=True, separators=(",", ":")).encode("utf-8")
    head = dict(claimed)
    head["signature"] = encode_signature(KEYS[name].sign(message).signature)
    return full_record_block(head)


def whole_node_archive(
    record_groups, files=(), *, mutate=None, head=True, signature_over=None
):
    """A whole-node archive: the signed head, log entries, records and files.

    ``record_groups`` is one list of records per paper.  The log is chained
    over every record in order, exactly as a node appends them.
    """
    records = [record for group in record_groups for record in group]
    entries = log_entry_blocks(records, mutate=mutate)
    blocks = []
    if head and entries:
        last = dag_cbor.decode(entries[-1][1])
        blocks.append(
            node_head_block(last["seq"], bytes(last["entry_hash"]), signature_over=signature_over)
        )
    blocks += entries
    blocks += [full_record_block(record) for record in records]
    blocks += [file_block(data) for data in files]
    return write_car(blocks, roots=[blocks[0][0]] if blocks else [])


def unsigned(record):
    """``record`` with its signature removed: its id still hashes its content."""
    record = copy.deepcopy(record)
    del record["sig"]
    return record


def legacy_erasure(name="alice"):
    """An ``erasure.request`` a pre-D1 log holds unsigned (the member signed none)."""
    return unsigned(
        signed(
            name,
            "erasure.request",
            {"basis": "data-subject-request", "content": "bafyreiexample"},
        )
    )


def test_a_whole_node_archive_verifies_every_paper(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two", versions=2)
    data = whole_node_archive(
        [one.records(), two.records()], files=[*one.files.values(), *two.files.values()]
    )
    code, out, err = verify(car_file, data, capsys=capsys)
    assert code == 0, out
    assert err == ""
    assert "Result: VERIFIED" in out
    assert one.short_id in out
    assert two.short_id in out
    assert "Version history is intact" in out
    assert "Log chain intact" in out


def test_a_whole_node_archive_summarises_every_paper_status(car_file, capsys):
    """One retracted paper must not label the whole archive retracted.

    The archive still verifies (a retraction is a warning, not a failure), but
    the result line counts the papers instead of carrying a single paper's
    status.
    """
    one, two = make_paper(seed="one"), make_paper(seed="two")
    one.extra.append(list_decision("committee", one.versions[0]["id"]))
    two.extra.append(notice("alice", "retraction", two.paper_id))
    data = whole_node_archive(
        [one.records(), two.records()], files=[*one.files.values(), *two.files.values()]
    )

    code, out, err = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert err == ""
    assert "Result: VERIFIED — 2 papers (1 listed, 1 retracted)" in out
    assert "Result: VERIFIED (status: retracted)" not in out


def test_a_whole_node_archive_of_listed_papers_says_how_many(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")
    for paper in (one, two):
        paper.extra.append(list_decision("committee", paper.versions[0]["id"]))
    data = whole_node_archive([one.records(), two.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert "Result: VERIFIED — 2 papers (2 listed)" in out


def test_a_whole_node_archive_counts_each_notice_status(car_file, capsys):
    one, two, three = (
        make_paper(seed="one"),
        make_paper(seed="two"),
        make_paper(seed="three"),
    )
    one.extra.append(list_decision("committee", one.versions[0]["id"]))
    two.extra.append(notice("alice", "correction", two.paper_id))
    three.extra.append(notice("alice", "retraction", three.paper_id))
    data = whole_node_archive([one.records(), two.records(), three.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert (
        "Result: VERIFIED — 3 papers (1 listed, 1 corrected, 1 retracted)" in out
    )


def list_decision(name, target, *, created="2026-11-14T05:32:00Z"):
    """A moderator's ``list`` decision on a version, as the node records it."""
    return signed(
        name,
        "moderation.decision",
        {"target": target, "action": "list", "clause": "MOD-01", "reasonCid": "x"},
        created=created,
    )


def hold(name, target, *, created="2026-11-14T05:34:00Z"):
    """A moderator's ``hold`` decision on a version, as the node records it."""
    return signed(
        name,
        "moderation.decision",
        {"target": target, "action": "hold", "clause": "MOD-05", "reasonCid": "x"},
        created=created,
    )


def release(name, target, *, state="listed", created="2026-11-14T05:35:00Z"):
    """A moderator's ``release`` decision, which ends a hold."""
    return signed(
        name,
        "moderation.decision",
        {"target": target, "action": "release", "state": state, "clause": "MOD-05", "reasonCid": "x"},
        created=created,
    )


def test_a_whole_node_archive_counts_a_queued_paper_as_awaiting_moderation(
    car_file, capsys
):
    """A paper with no decision yet is in the queue, not listed.

    The node serves no page for it -- ``GET /v1/papers/{id}`` answers 404 until
    a moderator lists a version -- so the archive summary must not sweep it into
    the listed papers (bug_spec_verify14, bug 2).  The listed paper carries the
    ``list`` decision that put it in the catalog.
    """
    listed, queued = make_paper(seed="one"), make_paper(seed="two")
    listed.extra.append(list_decision("committee", listed.versions[0]["id"]))
    data = whole_node_archive([listed.records(), queued.records()])

    code, out, err = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert err == ""
    assert "Result: VERIFIED — 2 papers (1 listed, 1 awaiting moderation)" in out


def test_a_whole_node_archive_counts_a_held_paper_as_held(car_file, capsys):
    """A paper under a moderation hold is not listed, whatever its history verifies.

    The node's own /network counts it out of "listed"; the archive summary must
    classify it the same way, not sweep it into the listed papers.
    """
    one, two = make_paper(seed="one"), make_paper(seed="two")
    one.extra.append(list_decision("committee", one.versions[0]["id"]))
    two.extra.append(hold("committee", two.versions[0]["id"]))
    data = whole_node_archive([one.records(), two.records()])

    code, out, err = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert err == ""
    assert "Result: VERIFIED — 2 papers (1 listed, 1 held)" in out


def test_a_released_hold_does_not_count_as_held(car_file, capsys):
    """The summary reads the current moderation state, not every decision in the log."""
    one, two = make_paper(seed="one"), make_paper(seed="two")
    one.extra.append(list_decision("committee", one.versions[0]["id"]))
    target = two.versions[0]["id"]
    two.extra.append(hold("committee", target))
    two.extra.append(release("committee", target))
    data = whole_node_archive([one.records(), two.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert "Result: VERIFIED — 2 papers (2 listed)" in out


def test_a_whole_node_archive_narrows_to_one_paper_with_paper(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = whole_node_archive([one.records(), two.records()])
    for paper in (one, two):
        code, out, _ = verify(car_file, data, "--paper", paper.short_id, capsys=capsys)
        assert code == 0, out
        assert f"Paper: {paper.short_id}" in out


def test_a_whole_node_archive_names_the_paper_that_fails(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")
    forged = copy.deepcopy(two.versions[0])
    forged["body"]["title"] = "tampered after signing"
    two_records = [forged if record is two.versions[0] else record for record in two.records()]
    data = whole_node_archive([one.records(), two_records])
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 1, out
    assert "Result: NOT VERIFIED" in out
    assert two.short_id in out
    assert "id does not match the hash of its content" in out


def test_a_whole_node_archive_checks_the_log_chain(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")

    def break_link(seq, entry):
        if seq == 2:
            entry["prev_hash"] = b"\x01" * 32

    data = whole_node_archive([one.records(), two.records()], mutate=break_link)
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 1, out
    assert "log chain is broken" in out
    assert "seq 2" in out


def test_a_whole_node_archive_checks_the_signed_head(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = whole_node_archive([one.records(), two.records()])
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 0, out
    assert "log head" in out.lower()


def test_a_forged_head_fails_the_whole_node_archive(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = whole_node_archive(
        [one.records(), two.records()], signature_over={"seq": 999}
    )
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 1, out
    assert "Result: NOT VERIFIED" in out
    assert "head" in out.lower()


def test_whole_node_log_and_record_blocks_must_agree(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")

    def rewrite_raw(seq, entry):
        if seq == 1:
            entry["raw"] = entry["raw"] + b"\x00"  # entry_hash is recomputed, link holds

    data = whole_node_archive([one.records(), two.records()], mutate=rewrite_raw)
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 1, out
    assert "canonical bytes" in out


def test_a_bad_signature_in_a_log_entry_fails_the_whole_node(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")

    def wrong_signature(seq, entry):
        if seq == 1:
            entry["sig"] = encode_signature(
                KEYS["mallory"].sign(b"not this record").signature
            )

    data = whole_node_archive(
        [one.records(), two.records()], mutate=wrong_signature
    )
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 1, out
    assert "signature that does not verify" in out


def test_a_legacy_unsigned_erasure_request_still_verifies(car_file, capsys):
    """A log written before the node signed erasures keeps verifying (D1).

    The erasure request of a pre-fix log carries no signature at all, so it
    can never authenticate; verify accepts it as a legacy record and says so
    on its own line instead of failing the whole archive forever.
    """
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = whole_node_archive(
        [[*one.records(), legacy_erasure()], two.records()]
    )

    code, out, err = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert err == ""
    assert "1 legacy erasure record without a signature (accepted)" in out
    assert "failed authentication" not in out
    assert "Result: VERIFIED" in out


def test_the_signature_tick_is_absent_when_a_record_is_not_authenticated(
    car_file, capsys
):
    """The log-records tick must not contradict the records line (D1)."""
    one, two = make_paper(seed="one"), make_paper(seed="two")
    forged = unsigned(
        signed("carol", "discussion.post", {"target": one.paper_id, "text": "hi"})
    )
    data = whole_node_archive([[*one.records(), forged], two.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 1, out
    assert "failed authentication" in out
    assert "Every log entry carries its record and the author's signature" not in out


def test_a_legacy_unsigned_erasure_does_not_tick_every_signature(car_file, capsys):
    """An accepted legacy record did not authenticate, so the tick is not shown."""
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = whole_node_archive([[legacy_erasure()], one.records(), two.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 0, out
    assert "Every log entry carries its record and the author's signature" not in out


def test_an_unsigned_record_of_another_type_still_fails(car_file, capsys):
    """Only an erasure request may be unsigned; a discussion post may not."""
    one, two = make_paper(seed="one"), make_paper(seed="two")
    forged = unsigned(
        signed("carol", "discussion.post", {"target": one.paper_id, "text": "hi"})
    )
    data = whole_node_archive([[*one.records(), forged], two.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 1, out
    assert "has no signature" in out
    assert "legacy erasure record" not in out


def test_a_tampered_legacy_erasure_request_still_fails(car_file, capsys):
    """Only the missing signature is tolerated; an altered one is not."""
    one, two = make_paper(seed="one"), make_paper(seed="two")
    erasure = legacy_erasure()
    erasure["body"]["content"] = "bafyreitampered"  # id no longer hashes it
    data = whole_node_archive([[erasure], one.records(), two.records()])

    code, out, _ = verify(car_file, data, capsys=capsys)

    assert code == 1, out
    assert "id does not match the hash of its content" in out
    assert "legacy erasure record" not in out


def test_bad_authorities_are_a_usage_error_not_a_paper_failure():
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = whole_node_archive([one.records(), two.records()])
    with pytest.raises(ValueError, match="authorities"):
        verify_car_bytes(data, authorities=[5])  # type: ignore[list-item]


def test_head_selects_an_earlier_version(car_file, capsys):
    paper = make_paper(versions=2)
    code, out, _ = verify(
        car_file, paper.car(), "--head", f"{paper.short_id}/v1", capsys=capsys
    )
    assert code == 0
    assert f"Paper: {paper.short_id}/v1" in out


# --- usage errors: exit 2 -----------------------------------------------


def test_a_missing_file_is_a_usage_error(tmp_path, capsys):
    code = main(["verify", str(tmp_path / "nope.car")])
    captured = capsys.readouterr()
    assert code == 2
    assert "cannot read" in captured.err
    assert captured.out == ""


def test_a_directory_is_a_usage_error(tmp_path, capsys):
    code = main(["verify", str(tmp_path)])
    assert code == 2
    assert "cannot read" in capsys.readouterr().err


def test_a_malformed_paper_option_is_a_usage_error(car_file, capsys):
    code, out, err = verify(car_file, make_paper().car(), "--paper", "nonsense", capsys=capsys)
    assert code == 2
    assert "paper must be" in err
    assert out == ""


def test_a_malformed_authority_is_ignored_unless_it_matches(car_file, capsys):
    code, _, _ = verify(car_file, make_paper().car(), "--authority", "x", capsys=capsys)
    assert code == 0


def test_no_command_prints_usage_and_exits_2(capsys):
    assert main([]) == 2
    assert "usage: scholium" in capsys.readouterr().err


def test_version_flag_still_works(capsys):
    assert main(["--version"]) == 0
    assert capsys.readouterr().out.strip() == "0.1.0"


def test_a_missing_file_argument_is_rejected_by_argparse():
    with pytest.raises(SystemExit) as exc:
        main(["verify"])
    assert exc.value.code == 2


# --- output ---------------------------------------------------------------


def test_verbose_adds_technical_details(car_file, capsys):
    paper = make_paper()
    code, out, _ = verify(car_file, paper.car(), "--verbose", capsys=capsys)
    assert code == 0
    assert "Technical details" in out
    assert f"genesis  {paper.paper_id}" in out
    assert f"head     {paper.versions[0]['id']}" in out
    assert f"signer   {did('alice')}" in out
    assert "signatures" in out and "ok:" in out


def test_without_verbose_the_technical_details_are_not_printed(car_file, capsys):
    _, out, _ = verify(car_file, make_paper().car(), capsys=capsys)
    assert "Technical details" not in out
    assert "bafyrei" not in out  # no record ids unless asked for


def test_long_lists_of_findings_are_cut_off_with_a_pointer_to_verbose(car_file, capsys):
    paper = make_paper()
    for number in range(12):
        forged = notice("alice", "correction", paper.paper_id, number=number)
        forged["body"]["reason"] = "tampered after signing"
        paper.extra.append(forged)
    code, out, _ = verify(car_file, paper.car(), capsys=capsys)
    assert code == 1
    assert "more (use --verbose)" in out
    # the headline quotes the first finding, then the list is capped at 8
    assert out.count("id does not match the hash of its content") == 1 + 8
    assert "and 3 more" in out

    code, out, _ = verify(car_file, paper.car(), "--verbose", capsys=capsys)
    assert "more (use --verbose)" not in out
    assert out.count("id does not match the hash of its content") >= 12


def test_ascii_terminals_get_ascii_marks(car_file):
    path = car_file(make_paper().car())
    args = argparse.Namespace(file=path, paper=None, head=None, authority=[], verbose=False)

    class Ascii(io.StringIO):
        encoding = "ascii"

    out = Ascii()
    assert verify_module.run(args, out=out, err=io.StringIO()) == 0
    assert "[ok]" in out.getvalue()
    assert "✓" not in out.getvalue()


def test_verify_car_bytes_returns_a_verdict_without_printing():
    verdict = verify_car_bytes(make_paper().car())
    assert verdict.ok
    assert verdict.status == "verified"
    assert [item.key for item in verdict.items] == [
        "archive",
        "authors",
        "history",
        "files",
        "anchor",
        "retraction",
    ]
    assert verdict.record_count == 5  # genesis, manifest, version, two consents
    assert verdict.file_count == 1
    assert verdict.block_count == 6
