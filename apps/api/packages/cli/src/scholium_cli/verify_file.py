"""``scholium verify-file <path> <sch-id> --archive <file.car>``: is this the signed file?

A paper version's signed manifest lists the file id (a raw-codec CID) of every
file in the version.  This command computes the file id of ``path`` and prints
whether it is one of the files the manifest of ``sch-id`` signs.

``sch-id`` is ``sch:xxxx-xxxx-xxxx/vN`` for one version, or ``sch:xxxx-xxxx-xxxx``
for the newest version of a paper; the version that was checked is always
printed.  The signed records come from a CARv1 archive exported from a node
(``--archive``).  The manifest is believed only after the whole paper has been
verified exactly as ``scholium verify`` verifies it -- signatures, consents,
version history -- so a forged or tampered manifest can never vouch for a file:
the command never says *match* for an archive that ``scholium verify`` rejects.
Nothing here touches the network.

Exit codes:

``0``
    Match: the file's id is in the signed manifest, with the signed size.  A
    paper that has been retracted, corrected or tombstoned still matches --
    the notice is shown on the checklist, as ``scholium verify`` does.
``1``
    No match: the file is not what the authors signed, or the signed manifest
    itself could not be verified (a forged or damaged record, a version the
    archive does not hold, an unreadable archive), so nothing could be
    compared.
``2``
    The command could not run: the file or the archive cannot be read, the
    ``sch-id`` is malformed or no ``--archive`` was given.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple, TextIO

from multiformats import CID
from scholium_record_core import (
    CID_VERSION,
    FILE_BASE,
    FILE_CODEC,
    FILE_HASH,
    format_version_id,
    parse_short_id,
    parse_version_id,
    verify_paper,
)

from .archive import load_archive
from .car import CarError, read_car
from .checklist import FAIL, PASS, Item, Verdict, build_verdict, manifest_files
from .verify import _detail_lines, _marks

__all__ = [
    "EXIT_MATCH",
    "EXIT_MISMATCH",
    "EXIT_USAGE",
    "MATCH",
    "MISMATCH",
    "UNVERIFIED",
    "Outcome",
    "Target",
    "add_arguments",
    "check_file",
    "hash_file",
    "parse_target",
    "render",
    "run",
]

EXIT_MATCH = 0
EXIT_MISMATCH = 1
EXIT_USAGE = 2

#: The file is in the signed manifest.
MATCH = "match"
#: The manifest verified, and the file is not in it.
MISMATCH = "mismatch"
#: The manifest could not be verified, so the file was not compared.
UNVERIFIED = "unverified"

#: Bytes read from the file at a time, so a dataset need not fit in memory.
_CHUNK_SIZE = 1 << 20


class Target(NamedTuple):
    """The paper (and version) an ``sch-id`` names, in canonical form."""

    paper: str
    """``sch:xxxx-xxxx-xxxx``."""
    head: str | None
    """``sch:xxxx-xxxx-xxxx/vN``, or ``None`` for the paper's newest version."""

    @property
    def label(self) -> str:
        return self.head or self.paper


@dataclass(frozen=True)
class Outcome:
    """What checking one file against one signed manifest found."""

    items: tuple[Item, ...]
    result: str
    """:data:`MATCH`, :data:`MISMATCH` or :data:`UNVERIFIED`."""
    file_id: str
    size: int
    version: str
    """``sch:xxxx-xxxx-xxxx/vN`` that was checked (the target's, if none was found)."""
    status: str = "verified"
    """The paper's status once verified: ``verified``, ``corrected``, ..."""

    @property
    def matched(self) -> bool:
        """True when the exit code is 0."""
        return self.result == MATCH


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the ``verify-file`` options to ``parser``."""
    parser.add_argument("path", metavar="PATH", help="the file to check")
    parser.add_argument(
        "sch_id",
        metavar="SCH-ID",
        help="the paper version the file belongs to (sch:xxxx-xxxx-xxxx/vN); a paper "
        "id (sch:xxxx-xxxx-xxxx) names its newest version",
    )
    parser.add_argument(
        "--archive",
        metavar="FILE.car",
        help="a CARv1 archive holding the paper's signed records, exported from a "
        "node (required: the signed manifest is read from it)",
    )
    parser.add_argument(
        "--authority",
        metavar="DID",
        action="append",
        default=[],
        help="a did:key you trust to retract, correct or tombstone any paper "
        "(repeatable), as for `scholium verify`",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="also print every file the signed manifest lists",
    )


def parse_target(sch_id: str) -> Target:
    """Parse ``sch:xxxx-xxxx-xxxx`` or ``sch:xxxx-xxxx-xxxx/vN``.

    Raises:
        ValueError: if ``sch_id`` is malformed, mistyped (bad checksum) or is
            not an ``sch:`` id at all -- a record id is not accepted.
    """
    if "/" in sch_id:
        version = parse_version_id(sch_id)
        return Target(version.short_id, format_version_id(*version))
    return Target(parse_short_id(sch_id), None)


def hash_file(path: Path) -> tuple[str, int]:
    """The file id and size in bytes of the file at ``path``.

    The id is the one :func:`scholium_record_core.compute_file_id` gives the
    same bytes (sha2-256, raw codec, base32 CIDv1), computed without holding
    the whole file in memory.

    Raises:
        OSError: if the file cannot be opened or read.
    """
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
    cid = CID(
        base=FILE_BASE,
        version=CID_VERSION,
        codec=FILE_CODEC,
        digest=(FILE_HASH, digest.digest()),
    )
    return str(cid), size


def _compare(file_id: str, size: int, entries: list[dict[str, Any]]) -> Item:
    """Compare a file with the entries of a verified, signed manifest."""
    listing = tuple(f"{e['path']}: signed as {e['cid']} ({e['size']} bytes)" for e in entries)
    same_id = [e for e in entries if e["cid"] == file_id]
    if not same_id:
        return Item("file", FAIL, "This file does not match what the authors signed", listing)

    exact = [e for e in same_id if e["size"] == size]
    if not exact:
        # The id is a hash of the bytes, so the manifest itself misstates the size.
        return Item(
            "file",
            FAIL,
            "This file has the signed file id but not the signed size: "
            f"the file is {size} bytes",
            tuple(f"{e['path']}: signed as {e['cid']} ({e['size']} bytes)" for e in same_id),
        )
    paths = ", ".join(e["path"] for e in exact)
    return Item(
        "file",
        PASS,
        f"This file matches the signed manifest (listed as {paths})",
        listing,
    )


def _checklist(verdict: Verdict, file_item: Item | None) -> tuple[Item, ...]:
    """The paper's checklist with the archive's own file check swapped for the file's.

    ``scholium verify`` has a ``files`` item about the file blocks *inside* the
    archive.  Here the file under test is the one that matters, so its item
    takes that slot; the archive's item stays only when it is a failure.
    """
    items: list[Item] = []
    for item in verdict.items:
        if item.key != "files":
            items.append(item)
            continue
        if item.state == FAIL:
            items.append(item)
        if file_item is not None:
            items.append(file_item)
    return tuple(items)


def check_file(
    archive_data: bytes,
    target: Target,
    file_id: str,
    size: int,
    *,
    archive_name: str = "the archive",
    authorities: Sequence[str] = (),
) -> Outcome:
    """Compare the file ``file_id`` (``size`` bytes) with the signed manifest of ``target``.

    ``archive_data`` is a CARv1 archive.  The paper is verified first; only a
    manifest that verifies is compared with the file.
    """
    try:
        car = read_car(archive_data)
    except CarError as exc:
        item = Item("archive", FAIL, f"{archive_name} is not a readable CAR archive: {exc}")
        return Outcome((item,), UNVERIFIED, file_id, size, target.label)

    archive = load_archive(car)
    report = verify_paper(
        archive.records, paper=target.paper, head=target.head, authorities=authorities
    )
    verdict = build_verdict(archive, report)
    version = verdict.version or target.label

    entries = manifest_files(report, archive) if verdict.ok else None
    if entries is None:
        return Outcome(_checklist(verdict, None), UNVERIFIED, file_id, size, version, verdict.status)

    file_item = _compare(file_id, size, entries)
    result = MATCH if file_item.state == PASS else MISMATCH
    return Outcome(_checklist(verdict, file_item), result, file_id, size, version, verdict.status)


def _result_line(outcome: Outcome) -> str:
    if outcome.result == UNVERIFIED:
        return (
            "Result: NOT VERIFIED (the signed manifest could not be verified, "
            "so the file was not compared)"
        )
    if outcome.result == MISMATCH:
        return "Result: MISMATCH"
    if outcome.status == "verified":
        return "Result: MATCH"
    return f"Result: MATCH (status: {outcome.status})"


def render(outcome: Outcome, name: str, *, verbose: bool = False, marks: dict[str, str]) -> list[str]:
    """The checklist as lines of text."""
    lines = [
        f"Checking {name} against {outcome.version}",
        f"File id: {outcome.file_id} ({outcome.size} bytes)",
        "",
    ]
    width = max(len(mark) for mark in marks.values())
    for item in outcome.items:
        lines.append(f"  {marks[item.state].ljust(width)} {item.text}")
        lines.extend(_detail_lines(item, verbose, indent=" " * (width + 5)))
    lines.extend(["", _result_line(outcome)])
    return lines


def _cannot_read(path: Path, exc: OSError, err: TextIO) -> int:
    print(f"scholium: cannot read {path}: {exc.strerror or exc}", file=err)
    return EXIT_USAGE


def run(args: argparse.Namespace, out: TextIO | None = None, err: TextIO | None = None) -> int:
    """Run ``scholium verify-file`` for parsed ``args``; return the exit code."""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    try:
        target = parse_target(args.sch_id)
    except ValueError as exc:
        print(f"scholium: {exc}", file=err)
        return EXIT_USAGE
    if args.archive is None:
        print(
            "scholium: the signed manifest is read from an archive: "
            "pass --archive FILE.car (a CAR export of the paper)",
            file=err,
        )
        return EXIT_USAGE

    path, archive_path = Path(args.path), Path(args.archive)
    try:
        archive_data = archive_path.read_bytes()
    except OSError as exc:
        return _cannot_read(archive_path, exc, err)
    try:
        file_id, size = hash_file(path)
    except OSError as exc:
        return _cannot_read(path, exc, err)

    outcome = check_file(
        archive_data,
        target,
        file_id,
        size,
        archive_name=archive_path.name,
        authorities=args.authority,
    )
    for line in render(outcome, path.name, verbose=args.verbose, marks=_marks(out)):
        print(line, file=out)
    return EXIT_MATCH if outcome.matched else EXIT_MISMATCH
