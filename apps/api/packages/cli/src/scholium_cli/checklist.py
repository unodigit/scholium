"""The plain-language verification checklist.

:func:`scholium_record_core.verify_paper` answers six technical questions
(chain, signatures, prev hashes, consents, manifests, supersession).  A
reader wants five plain ones, the same five the browser's Proof tab shows:

1. *Signed by all authors* -- every record is authentic and every listed
   author consented (``signatures`` + ``consents``).
2. *History intact* -- the versions chain back to the genesis record and
   every link matches the hash of what it names (``chain`` +
   ``prev_hashes``).
3. *Files match* -- the manifest is valid and every file present in the
   archive is exactly the bytes the manifest signed (``manifests`` + the
   file blocks).
4. *Timestamp or anchor pending* -- an offline verifier cannot reach the
   chain, so this is always reported as pending, never as passed.
5. *No retraction* -- whether a retraction, correction or tombstone applies
   (``supersession``).

Ahead of those sits a sixth line about the archive itself: every block must
hash to the CID it is filed under.

An item is a pass, a fail, *pending* (could not be checked here) or a
*warning* (verified, but the reader should know).  Only fails make the
verdict negative.  A retracted paper's history still verifies, so a
retraction is a warning, not a failure -- the same rule
:class:`~scholium_record_core.VerificationReport` applies.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from scholium_record_core import (
    STATUS_CORRECTED,
    STATUS_RETRACTED,
    STATUS_TOMBSTONED,
    CheckResult,
    VerificationReport,
    format_version_id,
    parse_file_cid,
    validate_manifest_body,
)

from .archive import Archive

__all__ = [
    "FAIL",
    "PASS",
    "PENDING",
    "WARN",
    "Item",
    "Verdict",
    "build_verdict",
    "unreadable_verdict",
]

PASS = "pass"
FAIL = "fail"
PENDING = "pending"
WARN = "warn"

#: The record-core wording names Python arguments; the CLI has options.
_ARGUMENT_WORDING = re.compile(r"\b(paper|head)=")


def _cli_wording(text: str) -> str:
    return _ARGUMENT_WORDING.sub(r"--\1 ", text)


@dataclass(frozen=True)
class Item:
    """One line of the checklist."""

    key: str
    state: str
    text: str
    details: tuple[str, ...] = ()
    """Individual findings; shown for fails and warnings, or with ``--verbose``."""


@dataclass(frozen=True)
class Verdict:
    """The outcome of verifying one archive."""

    items: tuple[Item, ...]
    status: str
    """``verified``, ``corrected``, ``retracted``, ``tombstoned`` or ``invalid``."""
    report: VerificationReport | None = None
    block_count: int = 0
    record_count: int = 0
    file_count: int = 0
    version: str | None = None
    """``sch:xxxx-xxxx-xxxx/vN`` of the verified version, when known."""

    @property
    def ok(self) -> bool:
        """True when nothing failed: the exit code is 0 exactly then."""
        return not any(item.state == FAIL for item in self.items)

    @property
    def failures(self) -> tuple[Item, ...]:
        return tuple(item for item in self.items if item.state == FAIL)


# --- individual items ---------------------------------------------------


def _item_from_checks(
    key: str, passed_text: str | None, *checks: CheckResult
) -> Item:
    """A pass (with ``passed_text``, or the last check's message) or the failures."""
    failing = [check for check in checks if not check.passed]
    if not failing:
        return Item(key, PASS, passed_text or checks[-1].message)
    details: list[str] = []
    for check in failing:
        details.extend(check.details)
    first = failing[0].message
    return Item(
        key,
        FAIL,
        _cli_wording(first),
        tuple(_cli_wording(d) for d in details if d not in first),
    )


def _archive_item(archive: Archive) -> Item:
    problems = archive.corrupt_messages()
    if not problems:
        return Item(
            "archive",
            PASS,
            f"All {archive.block_count} blocks in the archive match their content ids",
        )
    return Item(
        "archive",
        FAIL,
        "The archive was altered or damaged: some blocks do not match their "
        f"content ids ({len(problems)} of {archive.block_count})",
        tuple(problems),
    )


def _index(records: tuple[dict[str, Any], ...]) -> dict[str, Mapping[str, Any]]:
    by_id: dict[str, Mapping[str, Any]] = {}
    for record in records:
        record_id = record.get("id")
        if isinstance(record_id, str):
            by_id.setdefault(record_id, record)
    return by_id


def _manifest_files(
    report: VerificationReport, archive: Archive
) -> list[dict[str, Any]] | None:
    """File entries of the verified version's manifest, or ``None`` if unreadable."""
    if report.head is None:
        return None
    by_id = _index(archive.records)
    version = by_id.get(report.head)
    body = version.get("body") if version is not None else None
    reference = body.get("manifest") if isinstance(body, Mapping) else None
    manifest = by_id.get(reference) if isinstance(reference, str) else None
    if manifest is None:
        return None
    try:
        return list(validate_manifest_body(manifest.get("body"))["files"])
    except ValueError:
        return None


def _files_item(report: VerificationReport, archive: Archive) -> Item:
    manifests = report.checks["manifests"]
    if not manifests.passed:
        return _item_from_checks("files", None, manifests)

    entries = _manifest_files(report, archive)
    if entries is None:  # the manifests check passed, so this should not happen
        return Item("files", FAIL, "The manifest of the verified version cannot be read")
    if not entries:
        return Item("files", PASS, "The signed manifest lists no files")

    matched = 0
    absent: list[str] = []
    mismatched: list[str] = []
    for entry in entries:
        path = entry["path"]
        key = bytes(parse_file_cid(entry["cid"]))
        if key in archive.corrupt:
            mismatched.append(
                f"{path}: the bytes in the archive do not hash to the signed file id "
                f"{entry['cid']}"
            )
        elif key not in archive.files:
            absent.append(path)
        elif len(archive.files[key]) != entry["size"]:
            mismatched.append(
                f"{path}: the archive holds {len(archive.files[key])} bytes, "
                f"the signed manifest says {entry['size']}"
            )
        else:
            matched += 1

    total = len(entries)
    if mismatched:
        return Item(
            "files",
            FAIL,
            f"{len(mismatched)} of {total} files failed the check against the "
            "signed manifest",
            tuple(mismatched),
        )
    if absent:
        listing = tuple(f"{path}: not included in this archive" for path in absent)
        if not matched:
            text = (
                "The file contents are not in this archive, so they could not be "
                "compared with the signed manifest"
            )
        else:
            text = (
                f"{matched} of {total} files match the signed manifest; "
                f"{len(absent)} not included in this archive"
            )
        return Item("files", WARN, text, listing)
    text = (
        "The file matches the signed manifest"
        if total == 1
        else f"All {total} files match the signed manifest"
    )
    return Item("files", PASS, text)


def _anchor_item() -> Item:
    return Item(
        "anchor",
        PENDING,
        "Timestamp anchor not checked offline (anchor pending); the creation "
        "times inside the records are informational",
    )


def _supersession_item(report: VerificationReport) -> Item:
    check = report.checks["supersession"]
    if not check.passed:
        return _item_from_checks("retraction", None, check)

    notices = tuple(
        f"{s.kind} {s.id} signed by {s.author}"
        + (" (applies)" if s.applied else f" (not applied: {s.reason})")
        for s in report.supersessions
    )
    if report.status == STATUS_RETRACTED:
        text = "Retracted: a retraction notice applies (the history still verifies)"
    elif report.status == STATUS_TOMBSTONED:
        text = "Tombstoned: a trusted authority removed this content (the signed record remains)"
    elif report.status == STATUS_CORRECTED:
        text = "Corrected: a correction notice applies to this paper"
    else:
        return Item("retraction", PASS, "No retraction, correction or tombstone applies", notices)
    return Item("retraction", WARN, text, notices)


# --- verdicts -----------------------------------------------------------


def _version_label(report: VerificationReport, archive: Archive) -> str | None:
    if report.short_id is None or report.head is None:
        return None
    head = _index(archive.records).get(report.head)
    body = head.get("body") if head is not None else None
    number = body.get("n") if isinstance(body, Mapping) else None
    try:
        return format_version_id(report.short_id, number)  # type: ignore[arg-type]
    except ValueError:
        return report.short_id


def build_verdict(archive: Archive, report: VerificationReport) -> Verdict:
    """Combine the archive's block checks with the paper's verification report."""
    checks = report.checks
    items = (
        _archive_item(archive),
        _item_from_checks(
            "authors", checks["consents"].message, checks["signatures"], checks["consents"]
        ),
        _item_from_checks(
            "history", checks["chain"].message, checks["chain"], checks["prev_hashes"]
        ),
        _files_item(report, archive),
        _anchor_item(),
        _supersession_item(report),
    )
    failed = any(item.state == FAIL for item in items) or not report.valid
    return Verdict(
        items=items,
        status="invalid" if failed else report.status,
        report=report,
        block_count=archive.block_count,
        record_count=len(archive.records),
        file_count=len(archive.files),
        version=_version_label(report, archive),
    )


def unreadable_verdict(reason: str) -> Verdict:
    """The verdict for a file that is not a CARv1 archive at all."""
    return Verdict(
        items=(
            Item(
                "archive",
                FAIL,
                f"This file is not a readable CAR archive: {reason}",
            ),
        ),
        status="invalid",
    )
