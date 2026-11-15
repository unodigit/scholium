"""Tests for ``scholium verify-file <path> <sch-id> --archive <file.car>``."""

import argparse
import copy
import io
import subprocess
import sys

import pytest
from car_helpers import (
    KEYS,
    did,
    file_block,
    file_entry,
    flip,
    make_paper,
    manuscript,
    notice,
    signed,
    tombstone,
    write_car,
)
from scholium_cli import verify_file as verify_file_module
from scholium_cli.main import main
from scholium_cli.verify_file import check_file, hash_file, parse_target
from scholium_record_core import compute_file_id, sign_record


@pytest.fixture
def check(tmp_path, capsys):
    """Run ``verify-file`` on ``content`` and the archive ``car``; return (code, out, err)."""

    def run(car: bytes, content: bytes, sch_id: str, *options: str):
        archive = tmp_path / "paper.car"
        archive.write_bytes(car)
        target = tmp_path / "downloaded.bin"
        target.write_bytes(content)
        code = main(["verify-file", str(target), sch_id, "--archive", str(archive), *options])
        captured = capsys.readouterr()
        return code, captured.out, captured.err

    return run


def paper_with_files(files: dict[str, bytes], seed: str = "s-1"):
    """A one-version paper whose signed manifest lists exactly ``files``."""
    paper = make_paper(seed=seed)
    manifest = signed(
        "alice",
        "manifest",
        {"files": [file_entry(path, data) for path, data in files.items()]},
    )
    version = copy.deepcopy(paper.versions[0])
    del version["id"], version["sig"]
    version["body"]["manifest"] = manifest["id"]
    version = sign_record(version, KEYS["alice"])
    consents = [
        signed(a, "coauthor.consent", {"version": version["id"], "role": "author", "decision": "accept"})
        for a in ("alice", "bob")
    ]
    paper.manifests, paper.versions, paper.consents = [manifest], [version], [consents]
    paper.files = dict(files)
    return paper


# --- a file that is in the signed manifest: exit 0 -------------------------


def test_a_file_in_the_signed_manifest_matches_with_exit_0(check):
    paper = make_paper()
    code, out, err = check(paper.car(), manuscript(1), f"{paper.short_id}/v1")
    assert code == 0, out
    assert err == ""
    assert "This file matches the signed manifest (listed as main-v1.pdf)" in out
    assert "Result: MATCH" in out
    assert "MISMATCH" not in out and "NOT VERIFIED" not in out


def test_it_prints_the_file_id_and_the_version_it_checked(check):
    paper = make_paper()
    _, out, _ = check(paper.car(), manuscript(1), f"{paper.short_id}/v1")
    assert f"Checking downloaded.bin against {paper.short_id}/v1" in out
    assert f"File id: {compute_file_id(manuscript(1))} ({len(manuscript(1))} bytes)" in out


def test_the_authenticity_of_the_manifest_is_shown_too(check):
    paper = make_paper()
    _, out, _ = check(paper.car(), manuscript(1), f"{paper.short_id}/v1")
    assert "match their content ids" in out
    assert "Signed by all 2 listed authors" in out
    assert "Version history is intact" in out
    assert "anchor pending" in out
    assert "No retraction, correction or tombstone applies" in out
    # the archive's own file check is replaced by the check of the file itself
    assert "The file matches the signed manifest" not in out


def test_what_the_local_file_is_called_does_not_matter(check):
    # the manifest says main-v1.pdf; the file on disk is downloaded.bin
    paper = make_paper()
    code, out, _ = check(paper.car(), manuscript(1), f"{paper.short_id}/v1")
    assert code == 0
    assert "downloaded.bin" in out and "listed as main-v1.pdf" in out


def test_the_archive_need_not_carry_the_files(check):
    paper = make_paper()
    code, out, _ = check(paper.car(with_files=False), manuscript(1), f"{paper.short_id}/v1")
    assert code == 0, out
    assert "This file matches the signed manifest" in out


def test_a_file_among_many_in_the_manifest_matches(check):
    files = {f"data-{n}.csv": f"row {n}".encode() for n in range(5)}
    paper = paper_with_files(files)
    code, out, _ = check(paper.car(), files["data-3.csv"], f"{paper.short_id}/v1")
    assert code == 0, out
    assert "listed as data-3.csv" in out


def test_the_empty_file_matches_when_the_manifest_signs_it(check):
    paper = paper_with_files({"empty.txt": b""})
    code, out, _ = check(paper.car(), b"", f"{paper.short_id}/v1")
    assert code == 0, out
    assert "(0 bytes)" in out


def test_one_file_listed_under_two_paths_names_both(check):
    paper = paper_with_files({"a.csv": b"same", "b.csv": b"same"})
    code, out, _ = check(paper.car(), b"same", f"{paper.short_id}/v1")
    assert code == 0
    assert "listed as a.csv, b.csv" in out


# --- versions and paper ids ---------------------------------------------------


@pytest.mark.parametrize(
    ("content_version", "named_version", "code"),
    [(1, 1, 0), (2, 2, 0), (1, 2, 1), (2, 1, 1)],
)
def test_each_version_has_its_own_manifest(check, content_version, named_version, code):
    paper = make_paper(versions=2)
    got, out, _ = check(
        paper.car(), manuscript(content_version), f"{paper.short_id}/v{named_version}"
    )
    assert got == code, out
    assert (f"Checking downloaded.bin against {paper.short_id}/v{named_version}") in out


def test_a_paper_id_names_the_newest_version_and_says_so(check):
    paper = make_paper(versions=2)
    code, out, _ = check(paper.car(), manuscript(2), paper.short_id)
    assert code == 0, out
    assert f"against {paper.short_id}/v2" in out

    code, out, _ = check(paper.car(), manuscript(1), paper.short_id)  # v1's file, newest is v2
    assert code == 1
    assert "This file does not match what the authors signed" in out


def test_the_sch_id_is_case_insensitive(check):
    paper = make_paper()
    code, out, _ = check(paper.car(), manuscript(1), f"{paper.short_id}/v1".upper())
    assert code == 0, out
    assert f"against {paper.short_id}/v1" in out  # printed in canonical form


def test_an_archive_of_two_papers_is_told_apart_by_the_sch_id(check):
    one = paper_with_files({"main.pdf": b"first paper"}, seed="one")
    two = paper_with_files({"main.pdf": b"second paper"}, seed="two")
    data = write_car(one.blocks() + two.blocks())

    assert check(data, b"first paper", f"{one.short_id}/v1")[0] == 0
    assert check(data, b"second paper", f"{two.short_id}/v1")[0] == 0
    # a paper's file does not vouch under another paper's id
    assert check(data, b"first paper", f"{two.short_id}/v1")[0] == 1
    assert check(data, b"second paper", f"{one.short_id}/v1")[0] == 1


# --- a file that is not in the signed manifest: exit 1 -----------------------


def test_a_different_file_does_not_match_and_exits_1(check):
    paper = make_paper()
    code, out, err = check(paper.car(), b"some other file", f"{paper.short_id}/v1")
    assert code == 1
    assert err == ""
    assert "This file does not match what the authors signed" in out
    assert "Result: MISMATCH" in out
    assert "matches the signed manifest" not in out


def test_one_altered_byte_does_not_match(check):
    paper = make_paper()
    code, out, _ = check(paper.car(), flip(manuscript(1), 0), f"{paper.short_id}/v1")
    assert code == 1
    assert "Result: MISMATCH" in out


def test_a_truncated_or_extended_file_does_not_match(check):
    paper = make_paper()
    data = manuscript(1)
    for content in (data[:-1], data + b"\n", b""):
        code, out, _ = check(paper.car(), content, f"{paper.short_id}/v1")
        assert code == 1, content
        assert "Result: MISMATCH" in out


def test_a_mismatch_shows_what_was_signed(check):
    paper = make_paper()
    _, out, _ = check(paper.car(), b"other", f"{paper.short_id}/v1")
    signed_id = compute_file_id(manuscript(1))
    assert f"main-v1.pdf: signed as {signed_id} ({len(manuscript(1))} bytes)" in out
    assert f"File id: {compute_file_id(b'other')}" in out


def test_a_long_manifest_is_cut_off_unless_verbose(check):
    files = {f"part-{n:02d}.bin": f"part {n}".encode() for n in range(11)}
    paper = paper_with_files(files)

    code, out, _ = check(paper.car(), b"not a part", f"{paper.short_id}/v1")
    assert code == 1
    assert "part-07.bin: signed as" in out
    assert "part-08.bin: signed as" not in out
    assert "and 3 more (use --verbose)" in out

    code, out, _ = check(paper.car(), b"not a part", f"{paper.short_id}/v1", "--verbose")
    assert code == 1
    assert "part-10.bin: signed as" in out
    assert "more (use --verbose)" not in out


def test_a_manifest_that_lists_no_files_is_invalid_and_matches_nothing(check):
    # record-core requires at least one file, so not even the empty file "matches"
    paper = paper_with_files({})
    for content in (manuscript(1), b""):
        code, out, _ = check(paper.car(), content, f"{paper.short_id}/v1")
        assert code == 1
        assert "must list at least one file" in out
        assert "so the file was not compared" in out


def test_the_right_id_with_a_wrong_signed_size_does_not_match(check):
    paper = make_paper(file_size=999)
    code, out, _ = check(paper.car(with_files=False), manuscript(1), f"{paper.short_id}/v1")
    assert code == 1
    assert "signed file id but not the signed size" in out
    assert "main-v1.pdf: signed as" in out and "(999 bytes)" in out
    assert "Result: MISMATCH" in out


def test_a_wrong_signed_size_is_also_caught_by_the_archive_copy_of_the_file(check):
    paper = make_paper(file_size=999)
    code, out, _ = check(paper.car(), manuscript(1), f"{paper.short_id}/v1")
    assert code == 1
    assert "the signed manifest says 999" in out
    assert "Result: NOT VERIFIED" in out


# --- a manifest that cannot be trusted: exit 1, the file is not compared -----


def test_a_forged_manifest_cannot_vouch_for_a_file(check):
    """Swap a file id into the signed manifest: the stale signature gives it away."""
    paper = make_paper()
    evil = b"malware"
    forged = copy.deepcopy(paper.manifests[0])
    forged["body"]["files"] = [file_entry("main-v1.pdf", evil)]  # id and sig now stale
    records = [forged if r is paper.manifests[0] else r for r in paper.records()]
    code, out, _ = check(paper.car(records=records), evil, f"{paper.short_id}/v1")
    assert code == 1
    assert "✗" in out
    assert "Result: NOT VERIFIED" in out
    assert "so the file was not compared" in out
    assert "matches the signed manifest" not in out and "Result: MATCH" not in out


def test_a_manifest_signed_by_the_wrong_key_cannot_vouch_for_a_file(check):
    paper = make_paper()
    evil = b"malware"
    forged = copy.deepcopy(paper.manifests[0])
    forged["body"]["files"] = [file_entry("main-v1.pdf", evil)]
    forged["sig"] = signed("mallory", "manifest", forged["body"])["sig"]
    records = [forged if r is paper.manifests[0] else r for r in paper.records()]
    code, out, _ = check(paper.car(records=records), evil, f"{paper.short_id}/v1")
    assert code == 1
    assert "so the file was not compared" in out


def _missing_consent(paper):
    return paper.car(records=[r for r in paper.records() if r is not paper.consents[0][1]])


def _forged_version_signature(paper):
    forged = copy.deepcopy(paper.versions[0])
    forged["sig"] = signed("mallory", "paper.version", forged["body"], prev=forged["prev"])["sig"]
    return paper.car(records=[forged if r is paper.versions[0] else r for r in paper.records()])


def _damaged_file_block(paper):
    cid, data = file_block(paper.files["main-v1.pdf"])
    return write_car(paper.blocks(with_files=False) + [(cid, flip(data, 0))])


def _damaged_record_block(paper):
    return write_car(paper.blocks()[:1] + [(cid, flip(data, 5)) for cid, data in paper.blocks()[1:2]])


@pytest.mark.parametrize(
    "break_it",
    [_missing_consent, _forged_version_signature, _damaged_file_block, _damaged_record_block],
)
def test_it_never_matches_an_archive_that_verify_rejects(tmp_path, check, break_it, capsys):
    """Even with the genuine file in hand, an archive that fails ``verify`` fails here."""
    paper = make_paper()
    data = break_it(paper)
    archive = tmp_path / "broken.car"
    archive.write_bytes(data)
    assert main(["verify", str(archive), "--paper", paper.short_id]) == 1
    capsys.readouterr()

    code, out, _ = check(data, manuscript(1), f"{paper.short_id}/v1")
    assert code == 1, out
    assert "Result: NOT VERIFIED" in out
    assert "Result: MATCH" not in out


def test_a_version_the_archive_does_not_hold_cannot_be_checked(check):
    paper = make_paper(versions=2)
    code, out, _ = check(paper.car(), manuscript(2), f"{paper.short_id}/v3")
    assert code == 1
    assert "contain no version 3" in out
    assert "so the file was not compared" in out


def test_a_paper_the_archive_does_not_hold_cannot_be_checked(check):
    paper, other = make_paper(), make_paper(seed="other")
    code, out, _ = check(paper.car(), manuscript(1), f"{other.short_id}/v1")
    assert code == 1
    assert "no record belongs to the paper" in out


@pytest.mark.parametrize("data", [b"", b"not a car file at all", b"\xff" * 64])
def test_an_archive_that_is_not_a_car_cannot_be_checked(check, data):
    paper = make_paper()
    code, out, err = check(data, manuscript(1), f"{paper.short_id}/v1")
    assert code == 1
    assert err == ""
    assert "paper.car is not a readable CAR archive" in out  # the archive, not the file
    assert "Result: NOT VERIFIED" in out


def test_a_truncated_archive_cannot_be_checked(check):
    paper = make_paper()
    data = paper.car()
    code, out, _ = check(data[: len(data) // 2], manuscript(1), f"{paper.short_id}/v1")
    assert code == 1
    assert "not a readable CAR archive" in out


# --- retraction and authorities: still a match, exit 0 -----------------------


def test_a_retracted_paper_still_matches_and_says_so(check):
    paper = make_paper()
    paper.extra.append(notice("alice", "retraction", paper.paper_id))
    code, out, _ = check(paper.car(), manuscript(1), f"{paper.short_id}/v1")
    assert code == 0
    assert "Retracted: a retraction notice applies" in out
    assert "Result: MATCH (status: retracted)" in out


def test_a_tombstone_applies_only_from_a_trusted_authority(check):
    paper = make_paper()
    paper.extra.append(tombstone("committee", paper.paper_id))
    sch_id = f"{paper.short_id}/v1"

    code, out, _ = check(paper.car(), manuscript(1), sch_id)
    assert code == 0
    assert "Result: MATCH\n" in out

    code, out, _ = check(paper.car(), manuscript(1), sch_id, "--authority", did("committee"))
    assert code == 0
    assert "Tombstoned:" in out
    assert "Result: MATCH (status: tombstoned)" in out


# --- usage errors: exit 2 -----------------------------------------------------


def test_without_an_archive_it_says_what_to_pass(tmp_path, capsys):
    file = tmp_path / "f.bin"
    file.write_bytes(b"x")
    code = main(["verify-file", str(file), make_paper().short_id])
    captured = capsys.readouterr()
    assert code == 2
    assert "--archive" in captured.err
    assert captured.out == ""


def test_a_missing_file_is_a_usage_error(tmp_path, capsys):
    archive = tmp_path / "paper.car"
    paper = make_paper()
    archive.write_bytes(paper.car())
    code = main(
        ["verify-file", str(tmp_path / "nope.bin"), f"{paper.short_id}/v1", "--archive", str(archive)]
    )
    captured = capsys.readouterr()
    assert code == 2
    assert "cannot read" in captured.err and "nope.bin" in captured.err
    assert captured.out == ""


def test_a_directory_instead_of_a_file_is_a_usage_error(tmp_path, capsys):
    archive = tmp_path / "paper.car"
    paper = make_paper()
    archive.write_bytes(paper.car())
    code = main(["verify-file", str(tmp_path), f"{paper.short_id}/v1", "--archive", str(archive)])
    assert code == 2
    assert "cannot read" in capsys.readouterr().err


def test_a_missing_archive_is_a_usage_error(tmp_path, capsys):
    file = tmp_path / "f.bin"
    file.write_bytes(b"x")
    code = main(
        [
            "verify-file",
            str(file),
            f"{make_paper().short_id}/v1",
            "--archive",
            str(tmp_path / "nope.car"),
        ]
    )
    captured = capsys.readouterr()
    assert code == 2
    assert "cannot read" in captured.err and "nope.car" in captured.err
    assert captured.out == ""


def _bad_sch_ids():
    paper = make_paper()
    short = paper.short_id
    bad_checksum = short[:-1] + ("a" if short[-1] != "a" else "b")
    return [
        "nonsense",
        "",
        paper.paper_id,  # a record id is not an sch: id
        bad_checksum,
        f"{bad_checksum}/v1",
        f"{short}/v0",
        f"{short}/",
        f"{short}/v1/extra",
        f"{short}/1",
        "sch:xxxx-xxxx-xxxx",
    ]


@pytest.mark.parametrize("sch_id", _bad_sch_ids())
def test_a_malformed_sch_id_is_a_usage_error(tmp_path, capsys, sch_id):
    archive, file = tmp_path / "paper.car", tmp_path / "f.bin"
    archive.write_bytes(make_paper().car())
    file.write_bytes(manuscript(1))
    code = main(["verify-file", str(file), sch_id, "--archive", str(archive)])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    assert captured.err.startswith("scholium: ")


def test_the_arguments_are_required_by_argparse():
    for argv in (["verify-file"], ["verify-file", "only-a-path"]):
        with pytest.raises(SystemExit) as exc:
            main(argv)
        assert exc.value.code == 2


def test_the_command_is_listed_in_the_help(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--help"])
    assert exc.value.code == 0
    assert "verify-file" in capsys.readouterr().out


# --- the file id ------------------------------------------------------------------


@pytest.mark.parametrize(
    "size",
    [
        0,
        1,
        verify_file_module._CHUNK_SIZE - 1,
        verify_file_module._CHUNK_SIZE,
        verify_file_module._CHUNK_SIZE + 1,
        2 * verify_file_module._CHUNK_SIZE + 12345,
    ],
)
def test_hash_file_gives_the_same_id_as_record_core_across_chunk_boundaries(tmp_path, size):
    data = (bytes(range(256)) * (size // 256 + 1))[:size]
    path = tmp_path / "f.bin"
    path.write_bytes(data)
    assert hash_file(path) == (compute_file_id(data), size)


def test_a_file_larger_than_one_chunk_is_checked(check, monkeypatch):
    monkeypatch.setattr(verify_file_module, "_CHUNK_SIZE", 16)
    content = b"a dataset that takes several reads to hash " * 5
    paper = paper_with_files({"data.bin": content})
    code, out, _ = check(paper.car(), content, f"{paper.short_id}/v1")
    assert code == 0, out
    assert f"({len(content)} bytes)" in out


# --- parsing and the pure function ---------------------------------------------


def test_parse_target_canonicalises_paper_and_version_ids():
    short = make_paper().short_id
    assert parse_target(short.upper()) == (short, None)
    assert parse_target(f"{short}/V3".upper()) == (short, f"{short}/v3")
    assert parse_target(f"{short}/v3").label == f"{short}/v3"
    assert parse_target(short).label == short


def test_check_file_returns_an_outcome_without_printing(capsys):
    paper = make_paper()
    target = parse_target(f"{paper.short_id}/v1")
    outcome = check_file(paper.car(), target, compute_file_id(manuscript(1)), len(manuscript(1)))
    assert outcome.matched
    assert outcome.result == "match"
    assert outcome.version == f"{paper.short_id}/v1"
    assert [item.key for item in outcome.items] == [
        "archive",
        "authors",
        "history",
        "file",
        "anchor",
        "retraction",
    ]
    assert capsys.readouterr().out == ""

    other = check_file(paper.car(), target, compute_file_id(b"other"), 5)
    assert not other.matched and other.result == "mismatch"


# --- output -------------------------------------------------------------------------


def test_ascii_terminals_get_ascii_marks(tmp_path):
    paper = make_paper()
    archive, file = tmp_path / "paper.car", tmp_path / "f.bin"
    archive.write_bytes(paper.car())
    file.write_bytes(manuscript(1))
    args = argparse.Namespace(
        path=str(file),
        sch_id=f"{paper.short_id}/v1",
        archive=str(archive),
        authority=[],
        verbose=False,
    )

    class Ascii(io.StringIO):
        encoding = "ascii"

    out = Ascii()
    assert verify_file_module.run(args, out=out, err=io.StringIO()) == 0
    assert "[ok]" in out.getvalue()
    assert "✓" not in out.getvalue()


def test_works_as_a_real_process_with_the_documented_exit_codes(tmp_path):
    paper = make_paper()
    archive = tmp_path / "paper.car"
    archive.write_bytes(paper.car())
    good, bad = tmp_path / "good.pdf", tmp_path / "bad.pdf"
    good.write_bytes(manuscript(1))
    bad.write_bytes(flip(manuscript(1), 0))
    sch_id = f"{paper.short_id}/v1"

    def run(path, *args):
        return subprocess.run(
            [sys.executable, "-m", "scholium_cli.main", "verify-file", str(path), sch_id, *args],
            capture_output=True,
            check=False,
            text=True,
            encoding="utf-8",
        )

    ok = run(good, "--archive", str(archive))
    assert ok.returncode == 0, ok.stderr
    assert "Result: MATCH" in ok.stdout
    broken = run(bad, "--archive", str(archive))
    assert broken.returncode == 1, broken.stderr
    assert "does not match what the authors signed" in broken.stdout
    assert run(tmp_path / "missing.pdf", "--archive", str(archive)).returncode == 2
    assert run(good).returncode == 2
