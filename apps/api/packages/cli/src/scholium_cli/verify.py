"""``scholium verify <file.car>``: verify a paper offline from its archive.

Reads the CARv1 archive, checks every block against its CID, verifies the
paper with :func:`scholium_record_core.verify_paper` and prints the
plain-language checklist (see :mod:`scholium_cli.checklist`).  Nothing here
touches the network.

Exit codes:

``0``
    Verified: every signature and hash checked out.  A paper that has been
    retracted, corrected or tombstoned still verifies -- the notice is shown
    on the checklist, but it is not a failure of the paper's history.
``1``
    Not verified: a signature, a hash or the archive itself failed (a block
    that does not match its CID, a broken version chain, a forged record, an
    unreadable archive).
``2``
    The command could not run: the file cannot be read or an option is
    invalid.  Nothing was verified.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO

from scholium_record_core import verify_paper

from .archive import load_archive
from .car import CarError, read_car
from .checklist import (
    FAIL,
    PASS,
    PENDING,
    WARN,
    Item,
    Verdict,
    build_verdict,
    unreadable_verdict,
)

__all__ = [
    "EXIT_NOT_VERIFIED",
    "EXIT_USAGE",
    "EXIT_VERIFIED",
    "add_arguments",
    "render",
    "run",
    "verify_car_bytes",
]

EXIT_VERIFIED = 0
EXIT_NOT_VERIFIED = 1
EXIT_USAGE = 2

#: Findings printed under one item before the rest are summarised.
_DETAIL_LIMIT = 8

_UNICODE_MARKS = {PASS: "✓", FAIL: "✗", PENDING: "…", WARN: "!"}
_ASCII_MARKS = {PASS: "[ok]", FAIL: "[FAIL]", PENDING: "[..]", WARN: "[!]"}


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the ``verify`` options to ``parser``."""
    parser.add_argument("file", metavar="FILE.car", help="a CARv1 archive exported from a node")
    parser.add_argument(
        "--paper",
        metavar="ID",
        help="the paper to verify (sch: id or genesis record id); needed when the "
        "archive holds more than one paper",
    )
    parser.add_argument(
        "--head",
        metavar="ID",
        help="the version to verify (sch:xxxx-xxxx-xxxx/vN or version record id); "
        "defaults to the newest, needed to choose between competing heads",
    )
    parser.add_argument(
        "--authority",
        metavar="DID",
        action="append",
        default=[],
        help="a did:key you trust to retract, correct or tombstone any paper "
        "(repeatable); without it only a paper's own authors can retract or "
        "correct it and no tombstone applies",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="also print record ids, signers and every individual finding",
    )


def verify_car_bytes(
    data: bytes,
    *,
    paper: str | None = None,
    head: str | None = None,
    authorities: Sequence[str] = (),
) -> Verdict:
    """Verify the archive in ``data``.

    Raises:
        ValueError: if ``paper``, ``head`` or ``authorities`` is malformed.
    """
    try:
        car = read_car(data)
    except CarError as exc:
        return unreadable_verdict(str(exc))
    archive = load_archive(car)
    report = verify_paper(archive.records, paper=paper, head=head, authorities=authorities)
    return build_verdict(archive, report)


def _marks(stream: TextIO) -> dict[str, str]:
    try:
        "✓✗…".encode(stream.encoding or "ascii")
    except (UnicodeEncodeError, LookupError):
        return _ASCII_MARKS
    return _UNICODE_MARKS


def render(verdict: Verdict, name: str, *, verbose: bool = False, marks: dict[str, str]) -> list[str]:
    """The checklist as lines of text."""
    report = verdict.report
    lines = [f"Verifying {name}"]
    if report is not None and report.short_id is not None:
        lines.append(f"Paper: {verdict.version or report.short_id}")
    if verdict.block_count:
        lines.append(
            f"Archive: {verdict.block_count} blocks "
            f"({verdict.record_count} records, {verdict.file_count} files)"
        )
    lines.append("")

    width = max(len(mark) for mark in marks.values())
    for item in verdict.items:
        lines.append(f"  {marks[item.state].ljust(width)} {item.text}")
        lines.extend(_detail_lines(item, verbose, indent=" " * (width + 5)))

    if verbose and report is not None:
        lines.extend(["", "Technical details"])
        lines.append(f"  genesis  {report.genesis}")
        lines.append(f"  head     {report.head}")
        lines.append(f"  status   {report.status}")
        for did in report.signers:
            lines.append(f"  signer   {did}")
        for check_name, check in report.checks.items():
            lines.append(f"  {check_name:<12} {'ok' if check.passed else 'FAILED'}: {check.message}")

    lines.append("")
    lines.append(_result_line(verdict))
    return lines


def _detail_lines(item: Item, verbose: bool, indent: str) -> list[str]:
    if not item.details or not (verbose or item.state in (FAIL, WARN)):
        return []
    shown = item.details if verbose else item.details[:_DETAIL_LIMIT]
    lines = [f"{indent}- {detail}" for detail in shown]
    if len(shown) < len(item.details):
        lines.append(f"{indent}- ... and {len(item.details) - len(shown)} more (use --verbose)")
    return lines


def _result_line(verdict: Verdict) -> str:
    if not verdict.ok:
        count = len(verdict.failures)
        return f"Result: NOT VERIFIED ({count} check{'s' if count != 1 else ''} failed)"
    if verdict.status == "verified":
        return "Result: VERIFIED"
    return f"Result: VERIFIED (status: {verdict.status})"


def run(args: argparse.Namespace, out: TextIO | None = None, err: TextIO | None = None) -> int:
    """Run ``scholium verify`` for parsed ``args``; return the exit code."""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    path = Path(args.file)
    try:
        data = path.read_bytes()
    except OSError as exc:
        print(f"scholium: cannot read {path}: {exc.strerror or exc}", file=err)
        return EXIT_USAGE
    try:
        verdict = verify_car_bytes(
            data, paper=args.paper, head=args.head, authorities=args.authority
        )
    except ValueError as exc:
        print(f"scholium: {exc}", file=err)
        return EXIT_USAGE

    for line in render(verdict, path.name, verbose=args.verbose, marks=_marks(out)):
        print(line, file=out)
    return EXIT_VERIFIED if verdict.ok else EXIT_NOT_VERIFIED
