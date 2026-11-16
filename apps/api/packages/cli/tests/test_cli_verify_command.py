"""Tests for ``scholium verify <file.car>``."""

import argparse
import copy
import io
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
    make_paper,
    notice,
    signed,
    tombstone,
    write_car,
)
from scholium_cli import verify as verify_module
from scholium_cli.main import main
from scholium_cli.verify import verify_car_bytes
from scholium_record_core import sign_record


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


def test_an_archive_of_two_papers_needs_a_choice(car_file, capsys):
    one, two = make_paper(seed="one"), make_paper(seed="two")
    data = write_car(one.blocks() + two.blocks())
    code, out, _ = verify(car_file, data, capsys=capsys)
    assert code == 1
    assert "name one with --paper" in out
    assert "paper=" not in out

    for paper in (one, two):
        code, out, _ = verify(car_file, data, "--paper", paper.short_id, capsys=capsys)
        assert code == 0, out
        assert paper.short_id in out


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
