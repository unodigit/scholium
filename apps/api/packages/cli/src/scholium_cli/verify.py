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

import dag_cbor
import httpx

import argparse
import base64
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TextIO

from scholium_record_core import parse_file_cid, verify_paper

from .archive import Archive, load_archive
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
    parser.add_argument(
        "--node",
        metavar="URL",
        help="fetch the records and proofs from this node instead of reading a "
        "local archive (pass an sch: id as the positional argument)",
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


def _fetch_sync_range(base: str, cursor: int = 0) -> list[dict[str, Any]]:
    """Fetch every event-log entry from ``base`` (paginated)."""
    entries: list[dict[str, Any]] = []
    seen: set[int] = set()
    current = cursor
    while True:
        response = httpx.get(
            f"{base}/v1/sync/range", params={"from": current}, timeout=30.0
        )
        response.raise_for_status()
        page = response.json()
        if not isinstance(page, list) or not page:
            break
        new_items = [item for item in page if item.get("seq") not in seen]
        if not new_items:
            break
        for item in new_items:
            seen.add(item.get("seq"))
        entries.extend(new_items)
        current = max(item.get("seq", current) for item in new_items)
        if len(page) < 1:
            break
    return entries


def _run_node(args: argparse.Namespace, out: TextIO, err: TextIO) -> int:
    """Run ``scholium verify ... --node URL``; return the exit code."""
    base = str(args.node).rstrip("/")
    target = str(getattr(args, "file", None) or getattr(args, "target", None) or "")
    paper = args.paper or (target.split("/")[0] if target.startswith("sch:") else None)
    head = args.head or (target if "/" in target else None)
    authorities = list(args.authority or [])

    entries: list[dict[str, Any]] = []
    sync_error: Exception | None = None
    try:
        entries = _fetch_sync_range(base)
    except Exception as exc:  # noqa: BLE001 - network/HTTP/JSON failure
        sync_error = exc

    records: list[dict[str, Any]] = []
    files: dict[bytes, bytes] = {}
    if entries:
        for entry in entries:
            raw_value = entry.get("raw")
            try:
                raw = base64.b64decode(str(raw_value), validate=True)
                value = dag_cbor.decode(raw)
            except Exception:  # noqa: BLE001 - skip malformed entries
                continue
            if not isinstance(value, dict):
                continue
            record = dict(value)
            if "id" not in record:
                record["id"] = entry.get("record_cid")
            # ``raw`` is the canonical record: the bytes the id hashes, which
            # never include ``sig``.  The node serves the author's signature
            # beside it on the log entry; without it every record is unsigned.
            # (The signature is still checked cryptographically by
            # ``verify_paper``; a full envelope keeps the one it carries.)
            signature = entry.get("sig")
            if record.get("sig") is None and isinstance(signature, str):
                record["sig"] = signature
            records.append(record)

        # Fetch proofs (best effort: the node must answer, but a failure to
        # fetch one does not invalidate the records we already hold).
        for entry in entries:
            cid = entry.get("record_cid")
            if not isinstance(cid, str):
                continue
            try:
                httpx.get(f"{base}/v1/records/{cid}/proof", timeout=30.0).raise_for_status()
            except Exception:  # noqa: BLE001
                pass

        # Fetch file bytes for any manifest we can decode (best effort).
        record_by_id = {r.get("id"): r for r in records if isinstance(r.get("id"), str)}
        for record in records:
            body = record.get("body")
            if not isinstance(body, dict):
                continue
            manifest_cid = body.get("manifest")
            manifest = record_by_id.get(manifest_cid) if isinstance(manifest_cid, str) else None
            if not isinstance(manifest, dict):
                continue
            manifest_body = manifest.get("body")
            if not isinstance(manifest_body, dict):
                continue
            for entry_file in manifest_body.get("files", []) or []:
                if not isinstance(entry_file, dict):
                    continue
                cid = entry_file.get("cid")
                if not isinstance(cid, str):
                    continue
                try:
                    response = httpx.get(f"{base}/v1/content/{cid}", timeout=30.0)
                    response.raise_for_status()
                except Exception:  # noqa: BLE001
                    continue
                try:
                    key = bytes(parse_file_cid(cid))
                except Exception:  # noqa: BLE001
                    continue
                files[key] = response.content

    # Fall back to an exported CAR when the log could not be replayed.
    if not records:
        paper_id = paper or target.split("/")[0]
        try:
            response = httpx.get(f"{base}/v1/export/paper/{paper_id}.car", timeout=30.0)
            response.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            cause = sync_error if sync_error is not None else exc
            print(f"scholium: cannot fetch from {base}: {cause}", file=err)
            return EXIT_USAGE
        try:
            verdict = verify_car_bytes(
                response.content, paper=paper, head=head, authorities=authorities
            )
        except ValueError as exc:
            print(f"scholium: {exc}", file=err)
            return EXIT_USAGE
        name = target
        for line in render(verdict, name, verbose=args.verbose, marks=_marks(out)):
            print(line, file=out)
        return EXIT_VERIFIED if verdict.ok else EXIT_NOT_VERIFIED

    try:
        archive = Archive(
            block_count=len(entries) + len(records) + len(files),
            records=tuple(records),
            files=files,
            corrupt={},
            cids={},
        )
        report = verify_paper(tuple(records), paper=paper, head=head, authorities=authorities)
    except ValueError as exc:
        print(f"scholium: {exc}", file=err)
        return EXIT_USAGE
    verdict = build_verdict(archive, report)

    name = target
    for line in render(verdict, name, verbose=args.verbose, marks=_marks(out)):
        print(line, file=out)
    return EXIT_VERIFIED if verdict.ok else EXIT_NOT_VERIFIED


def run(args: argparse.Namespace, out: TextIO | None = None, err: TextIO | None = None) -> int:
    """Run ``scholium verify`` for parsed ``args``; return the exit code."""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    if getattr(args, "node", None):
        return _run_node(args, out, err)

    target = getattr(args, "file", None) or getattr(args, "target", None)
    path = Path(target)
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
