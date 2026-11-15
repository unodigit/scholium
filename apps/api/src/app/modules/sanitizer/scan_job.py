"""Scanning every file of a version in ``scanning`` state (plugin: sanitizer).

Feature 63: once every listed co-author has consented, a version enters
``scanning`` (feature 55).  A background job then scans *all* of the files
its signed manifest lists, records the verdict on each blob and moves the
version on::

    from app.modules import sanitizer

    result = sanitizer.scan_version(version_cid)
    result.files                  # one FileScanResult per manifest entry
    result.state                  # "moderation" (clean) or "held" (failed)
    result.failing_check          # e.g. "javascript" when held

The work is also available as a job on :mod:`app.jobs` (kind
``sanitizer.scan_version``).  The sanitizer subscribes to
``version.state_changed`` and enqueues ``{"version_cid": ...}`` when a
version enters ``scanning``, so in a running node the scan starts by itself::

    sanitizer.enqueue_scan(version_cid)     # explicit, e.g. a re-scan
    sanitizer.scan_version_job({})          # scan every version in scanning

What a scan does
----------------

1. Only a version whose ``paper_versions.state`` is still ``scanning`` is
   touched; anything else is skipped so a late or duplicated job can never
   re-open a version a moderator already moved.
2. The file list comes from the ``manifest`` record ``paper_versions``
   points at (falling back to a manifest embedded in the version's own
   signed record).  A missing or malformed manifest holds the version with
   :data:`CHECK_MANIFEST_UNREADABLE` rather than letting unscanned bytes
   through.  (The automatic trigger only fires once the manifest is
   readable; a version whose manifest has not arrived yet simply stays
   ``scanning``.)
3. Each file is read from the content store and dispatched by what it is:
   PDFs go through :func:`.pdf.scan_pdf_bytes` (active content and hidden
   text, features 60 and 61) and zip/tar bundles through
   :func:`.bundle.scan_bundle_bytes` (feature 62).  Files no check applies to
   are passed -- the sanitizer only holds what it can judge.  A listed file
   whose blob row or bytes are missing is itself a failure
   (:data:`CHECK_FILE_MISSING` / :data:`CHECK_FILE_UNREADABLE`).
4. Every scanned blob's ``scan_status`` is saved as ``passed`` or ``failed``
   in the ``blobs`` table.
5. A clean version gets a node-signed ``rendition`` record listing its
   sanitized files and the tool versions (feature 64, :mod:`.rendition`),
   then moves to ``moderation``; a version with any failing file is ``held``
   with the exact failing check named in the state event's ``reason``
   (``"scan failed: javascript"``) and in the returned result, and gets no
   rendition.  A rendition that cannot be signed (no node key) is logged and
   does not stop the version: ``rendition_cid`` is then ``None``.

The scan never extracts or executes anything.  It is idempotent: re-running
it for a version already in ``moderation`` or ``held`` is a no-op.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy import select

from app import db, jobs

from .bundle import detect_bundle_kind, scan_bundle_bytes
from .models import RESULT_FAILED, RESULT_PASSED
from .pdf import Finding, scan_pdf_bytes
from .rendition import create_rendition
from .reports import record_finding
from .tools import KIND_BUNDLE, KIND_OTHER, KIND_PDF, tool_versions

__all__ = [
    "CHECK_FILE_MISSING",
    "CHECK_FILE_UNREADABLE",
    "CHECK_MANIFEST_UNREADABLE",
    "JOB_KIND",
    "FileScanResult",
    "VersionScanResult",
    "enqueue_scan",
    "ensure_subscribed",
    "scan_pending_versions",
    "scan_version",
    "scan_version_job",
    "versions_in_scanning_state",
]

logger = logging.getLogger(__name__)

#: Job kind registered with :mod:`app.jobs`.
JOB_KIND = "sanitizer.scan_version"

#: The state a version must be in for the job to scan it.
SCANNING = "scanning"
#: Where a clean version goes.
MODERATION = "moderation"
#: Where a version with a failing check goes.
HELD = "held"

#: The version's manifest could not be read or lists no files.
CHECK_MANIFEST_UNREADABLE = "manifest_unreadable"
#: A listed file has no ``blobs`` row (or its bytes are gone).
CHECK_FILE_MISSING = "file_missing"
#: A listed file exists but could not be read or scanned.
CHECK_FILE_UNREADABLE = "file_unreadable"

_PDF_MAGIC = b"%PDF-"
_PDF_MEDIA_TYPES = frozenset({"application/pdf", "application/x-pdf"})
_BUNDLE_MEDIA_TYPES = frozenset(
    {
        "application/zip",
        "application/x-zip",
        "application/x-zip-compressed",
        "application/x-tar",
        "application/gzip",
        "application/x-gzip",
        "application/x-compressed-tar",
        "application/x-gtar",
    }
)
#: How far into a file the ``%PDF-`` header may sit before the file is not
#: treated as a PDF.  Real PDFs start at byte 0; a little slack tolerates a
#: byte-order mark or leading whitespace.
_PDF_HEADER_WINDOW = 1024

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    """``repr(value)``, shortened for a log or error message."""
    text = repr(value)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FileScanResult:
    """The verdict of scanning one file of a version.

    ``check_names`` holds the failed checks in the order the scanner reports
    them (empty for a clean file); ``detail`` is the first finding's detail,
    if any.  ``cid`` is the file id and ``path`` the manifest path, so a held
    version's failing file can be named without reading ``scan_reports``.
    ``kind`` is how the file was scanned (``"pdf"``, ``"bundle"`` or
    ``"other"``) -- it decides which tools the version's rendition lists.
    """

    cid: str
    path: Optional[str] = None
    result: str = RESULT_PASSED
    check_names: tuple[str, ...] = ()
    detail: Optional[str] = None
    kind: str = KIND_OTHER

    @property
    def passed(self) -> bool:
        """Whether this file produced no failing check."""
        return self.result == RESULT_PASSED

    @property
    def failed(self) -> bool:
        """Whether at least one check failed for this file."""
        return not self.passed

    def to_dict(self) -> dict[str, Any]:
        """A JSON-friendly summary of the file's scan."""
        return {
            "cid": self.cid,
            "path": self.path,
            "result": self.result,
            "check_names": list(self.check_names),
            "detail": self.detail,
            "kind": self.kind,
        }


@dataclass(frozen=True)
class VersionScanResult:
    """The verdict of scanning a version, and where the version went.

    ``skipped`` is true when the version was not in ``scanning`` state, in
    which case nothing was read and no state changed.  When the version was
    scanned, ``state`` is the state it ended in and ``failing_check`` names
    the first failing check (``None`` for a clean version).  A clean version
    also carries ``rendition_cid``, the node-signed ``rendition`` record made
    for it -- ``None`` when the version was held or skipped, or when the node
    could not sign one (the failure is logged; the version still moves on).
    """

    version_cid: str
    files: tuple[FileScanResult, ...] = ()
    state: Optional[str] = None
    skipped: bool = False
    failing_check: Optional[str] = None
    failing_cid: Optional[str] = None
    failing_path: Optional[str] = None
    reason: Optional[str] = None
    rendition_cid: Optional[str] = None

    @property
    def failed(self) -> bool:
        """Whether the version was held for a failing check."""
        return self.failing_check is not None

    @property
    def passed(self) -> bool:
        """Whether the version was scanned and every file passed."""
        return not self.skipped and not self.failed

    def to_dict(self) -> dict[str, Any]:
        """A JSON-friendly summary of the version's scan."""
        return {
            "version_cid": self.version_cid,
            "state": self.state,
            "skipped": self.skipped,
            "failing_check": self.failing_check,
            "failing_cid": self.failing_cid,
            "failing_path": self.failing_path,
            "reason": self.reason,
            "rendition_cid": self.rendition_cid,
            "files": [result.to_dict() for result in self.files],
        }


class _Unscannable(Exception):
    """The version's file list cannot be resolved; hold it with ``check_name``."""

    def __init__(self, detail: str, check_name: str = CHECK_MANIFEST_UNREADABLE) -> None:
        super().__init__(detail)
        self.detail = detail
        self.check_name = check_name


# --------------------------------------------------------------------------- #
# Reading the version and its manifest
# --------------------------------------------------------------------------- #


def _get_version(version_cid: str):
    """The stored ``paper_versions`` row for ``version_cid``, or ``None``."""
    from app.modules.submissions import get_version

    return get_version(version_cid)


def _files_from_body(body: object) -> Optional[list[Mapping[str, Any]]]:
    """The manifest file entries in ``body``, or ``None`` when it is not one.

    ``body`` may be a manifest record body (``{"files": [...]}``), a plain
    list of entries, or anything else (which gives ``None``).  Entries are
    normalized to mappings; a non-mapping entry makes the manifest unusable.
    """
    if isinstance(body, Mapping):
        files = body.get("files")
    elif isinstance(body, Sequence) and not isinstance(body, (str, bytes, bytearray)):
        files = body
    else:
        return None
    if isinstance(files, (str, bytes, bytearray)) or not isinstance(files, Sequence):
        return None
    entries: list[Mapping[str, Any]] = []
    for entry in files:
        if not isinstance(entry, Mapping):
            raise _Unscannable(
                "the manifest lists a file entry that is not an object"
            )
        cid = entry.get("cid")
        if not isinstance(cid, str) or not cid:
            raise _Unscannable(
                f"the manifest entry {_show(entry.get('path'))} has no cid"
            )
        entries.append(entry)
    if not entries:
        raise _Unscannable("the manifest lists no files")
    return entries


def _manifest_files(version_cid: str, manifest_cid: object) -> list[Mapping[str, Any]]:
    """Resolve a version's manifest to its file entries.

    The canonical pointer is ``paper_versions.manifest_cid`` naming a
    ``manifest`` record in the event log.  As a fallback -- for records
    written before the manifest was split out, or by a caller that inlined it
    -- the version's own signed body may carry the manifest as an object or as
    another record cid, or the file list itself.

    Raises:
        _Unscannable: when no usable file list can be found.
    """
    from app.modules import ledger

    entries: Optional[list[Mapping[str, Any]]] = None
    if isinstance(manifest_cid, str) and manifest_cid:
        entry = ledger.entry_by_cid(manifest_cid)
        body = getattr(entry, "body", None) if entry is not None else None
        if body is not None:
            entries = _files_from_body(body)

    if entries is None:
        entry = ledger.entry_by_cid(version_cid)
        body = getattr(entry, "body", None) if entry is not None else None
        if isinstance(body, Mapping):
            manifest = body.get("manifest")
            if manifest is None:
                manifest = body.get("manifest_cid", body.get("manifestCid"))
            if isinstance(manifest, Mapping) or (
                isinstance(manifest, Sequence)
                and not isinstance(manifest, (str, bytes, bytearray))
            ):
                entries = _files_from_body(manifest)
            elif isinstance(manifest, str) and manifest:
                manifest_entry = ledger.entry_by_cid(manifest)
                manifest_body = (
                    getattr(manifest_entry, "body", None)
                    if manifest_entry is not None
                    else None
                )
                if manifest_body is not None:
                    entries = _files_from_body(manifest_body)
            if entries is None:
                entries = _files_from_body(body)

    if entries is None:
        raise _Unscannable(
            f"the manifest for version {_show(version_cid)} lists no files"
        )
    return entries


# --------------------------------------------------------------------------- #
# Scanning one file
# --------------------------------------------------------------------------- #


def _media_essence(value: object) -> str:
    """The bare lowercase ``type/subtype`` of ``value`` (or ``""``)."""
    if not isinstance(value, str):
        return ""
    return value.split(";", 1)[0].strip().lower()


def _kind_of(raw: bytes, media_type: object) -> str:
    """``"pdf"``, ``"bundle"`` or ``"other"`` for a file's bytes.

    The declared media type is only a hint: bytes that start with a PDF
    header are scanned as a PDF whoever declared what, and a file declared as
    a zip/tar is handed to the bundle scanner even when it turns out not to
    be an archive (which then records ``bundle_unreadable`` rather than
    silently passing).
    """
    essence = _media_essence(media_type)
    if essence in _PDF_MEDIA_TYPES:
        return KIND_PDF
    if raw[:_PDF_HEADER_WINDOW].lstrip().startswith(_PDF_MAGIC):
        return KIND_PDF
    if essence in _BUNDLE_MEDIA_TYPES:
        return KIND_BUNDLE
    if raw[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        return KIND_BUNDLE
    if len(raw) >= 262 and raw[257:262] == b"ustar":
        return KIND_BUNDLE
    if raw[:2] == b"\x1f\x8b" and detect_bundle_kind(raw) != "unknown":
        return KIND_BUNDLE
    return KIND_OTHER


def _set_scan_status(cid: str, status: str) -> None:
    """Save ``status`` on the ``blobs`` row for ``cid``, if there is one."""
    from app.modules import content

    try:
        content.set_scan_status(cid, status)
    except content.BlobNotFound:
        # A manifest may name bytes this node never stored.  The scan is
        # still a failure (the file is unscannable), but there is no row to
        # update; the finding recorded by the caller is the durable verdict.
        logger.warning("no blobs row for %s; scan status not saved", _show(cid))


def _scan_bytes(cid: str, raw: bytes, kind: str) -> tuple[Finding, ...]:
    """Run the checks that apply to a file of ``kind`` and return their findings.

    The per-type scanners save one ``scan_reports`` row per failed check.
    """
    if kind == KIND_PDF:
        return scan_pdf_bytes(raw, cid=cid).findings
    if kind == KIND_BUNDLE:
        return scan_bundle_bytes(raw, cid=cid).findings
    return ()


def _failed(
    cid: str,
    path: Optional[str],
    check_name: str,
    detail: str,
) -> FileScanResult:
    """Record one failed finding for a file and return its result."""
    record_finding(cid, check_name, detail)
    return FileScanResult(
        cid=cid,
        path=path,
        result=RESULT_FAILED,
        check_names=(check_name,),
        detail=detail,
    )


def _scan_file(entry: Mapping[str, Any]) -> FileScanResult:
    """Scan one manifest entry and save its ``blobs.scan_status``."""
    cid = entry["cid"]
    path_value = entry.get("path")
    path = path_value if isinstance(path_value, str) and path_value else None
    media_type = entry.get("mediaType", entry.get("media_type"))

    from app.modules import content

    blob = content.get_blob(cid)
    if blob is None:
        return _failed(
            cid,
            path,
            CHECK_FILE_MISSING,
            f"file {path or cid} is not in the content store",
        )

    try:
        with content.open_blob(cid) as handle:
            raw = handle.read()
    except FileNotFoundError:
        _set_scan_status(cid, RESULT_FAILED)
        return _failed(
            cid,
            path,
            CHECK_FILE_MISSING,
            f"the stored bytes for {path or cid} are missing",
        )
    except (OSError, ValueError) as exc:
        _set_scan_status(cid, RESULT_FAILED)
        return _failed(
            cid,
            path,
            CHECK_FILE_UNREADABLE,
            f"the stored bytes for {path or cid} could not be read: {exc}",
        )

    declared = media_type if media_type is not None else getattr(blob, "media_type", None)
    try:
        kind = _kind_of(raw, declared)
        findings = _scan_bytes(cid, raw, kind)
    except Exception as exc:  # noqa: BLE001 - one bad file must not stop the version
        _set_scan_status(cid, RESULT_FAILED)
        return _failed(
            cid,
            path,
            CHECK_FILE_UNREADABLE,
            f"the scan of {path or cid} failed: {exc}",
        )

    if findings:
        _set_scan_status(cid, RESULT_FAILED)
        first = findings[0]
        return FileScanResult(
            cid=cid,
            path=path,
            result=RESULT_FAILED,
            check_names=tuple(finding.check_name for finding in findings),
            detail=first.detail,
            kind=kind,
        )

    _set_scan_status(cid, RESULT_PASSED)
    return FileScanResult(cid=cid, path=path, result=RESULT_PASSED, kind=kind)


# --------------------------------------------------------------------------- #
# Scanning one version
# --------------------------------------------------------------------------- #


def _move_version(version_cid: str, state: str, reason: str) -> str:
    """Move ``version_cid`` to ``state`` and return the state it now has."""
    from app.modules import ledger
    from app.modules.submissions import transition_version

    try:
        actor = ledger.node_did()
    except Exception:  # noqa: BLE001 - an actor is informative, not required
        actor = None
    row = transition_version(version_cid, state, actor=actor, reason=reason)
    return getattr(row, "state", state)


def _held(
    version_cid: str,
    check_name: str,
    *,
    failing_cid: Optional[str] = None,
    failing_path: Optional[str] = None,
    reason: Optional[str] = None,
    files: tuple[FileScanResult, ...] = (),
) -> VersionScanResult:
    """Hold ``version_cid`` naming ``check_name`` and return the result."""
    reason = reason if reason is not None else f"scan failed: {check_name}"
    state = _move_version(version_cid, HELD, reason)
    return VersionScanResult(
        version_cid=version_cid,
        files=files,
        state=state,
        failing_check=check_name,
        failing_cid=failing_cid,
        failing_path=failing_path,
        reason=reason,
    )


def _rendition_files(
    entries: Sequence[Mapping[str, Any]], files: Sequence[FileScanResult]
) -> list[dict[str, Any]]:
    """The ``files`` of a version's rendition: its scanned manifest entries.

    ``entries`` and ``files`` line up one to one (``files`` was scanned from
    ``entries``).  The size comes from the ``blobs`` row -- the bytes this node
    holds -- and the media type from the manifest, then the row.
    """
    from app.modules import content

    listed: list[dict[str, Any]] = []
    for entry, result in zip(entries, files, strict=True):
        item: dict[str, Any] = {"cid": result.cid, "scanStatus": result.result}
        if result.path is not None:
            item["path"] = result.path
        blob = content.get_blob(result.cid)
        if blob is not None:
            item["size"] = int(blob.size)
        media_type = entry.get("mediaType", entry.get("media_type")) or getattr(
            blob, "media_type", None
        )
        if isinstance(media_type, str) and media_type:
            item["mediaType"] = media_type
        role = entry.get("role")
        if isinstance(role, str) and role:
            item["role"] = role
        listed.append(item)
    return listed


def _record_rendition(
    version_cid: str,
    paper_cid: object,
    entries: Sequence[Mapping[str, Any]],
    files: Sequence[FileScanResult],
) -> Optional[str]:
    """Sign and append the rendition of a version whose files all passed.

    Returns the record's cid, or ``None`` when the rendition could not be
    made.  That is logged but never raised: the files did pass, and failing
    the job would be retried until it gave up with the version still in
    ``scanning`` and its bytes unserved -- a worse outcome than a missing
    provenance record.
    """
    try:
        result = create_rendition(
            version_cid,
            _rendition_files(entries, files),
            tool_versions(file.kind for file in files),
            paper_cid=paper_cid if isinstance(paper_cid, str) else None,
        )
    except Exception:  # noqa: BLE001 - see the docstring
        logger.exception("could not create a rendition for version %s", _show(version_cid))
        return None
    return result.record_cid


def scan_version(version_cid: str) -> VersionScanResult:
    """Scan every file of a version in ``scanning`` state and move it on.

    A clean version gets a node-signed ``rendition`` record (feature 64, see
    :mod:`.rendition`) and moves to ``moderation``; a version with any failing
    file is held, with the exact failing check named in the state event's
    ``reason`` and in the returned :class:`VersionScanResult`, and gets no
    rendition.

    A version that is not in ``scanning`` state is left exactly as it is
    (``result.skipped`` is true): scanning is only ever started from that
    state, so a duplicated or late job cannot re-open a version moderation
    has already decided.

    Raises:
        UnknownVersion: ``version_cid`` names no stored version.
    """
    from app.modules.submissions import UnknownVersion

    if not isinstance(version_cid, str) or not version_cid:
        raise UnknownVersion(version_cid)
    row = _get_version(version_cid)
    if row is None:
        raise UnknownVersion(version_cid)

    current_state = getattr(row, "state", None)
    if current_state != SCANNING:
        return VersionScanResult(
            version_cid=version_cid,
            state=current_state,
            skipped=True,
            reason=f"version is in state {current_state!r}, not scanning",
        )

    try:
        entries = _manifest_files(version_cid, getattr(row, "manifest_cid", None))
    except _Unscannable as exc:
        return _held(
            version_cid,
            exc.check_name,
            reason=f"scan failed: {exc.check_name} ({exc.detail})",
        )

    files = tuple(_scan_file(entry) for entry in entries)
    failing = next((result for result in files if result.failed), None)
    if failing is not None:
        check_name = failing.check_names[0]
        return _held(
            version_cid,
            check_name,
            failing_cid=failing.cid,
            failing_path=failing.path,
            files=files,
        )

    # The rendition is signed before the move so a ``moderation`` subscriber
    # (and a retried job, which finds it and appends nothing) already sees it.
    rendition_cid = _record_rendition(
        version_cid, getattr(row, "paper_cid", None), entries, files
    )
    reason = "all files passed scanning"
    state = _move_version(version_cid, MODERATION, reason)
    return VersionScanResult(
        version_cid=version_cid,
        files=files,
        state=state,
        reason=reason,
        rendition_cid=rendition_cid,
    )


# --------------------------------------------------------------------------- #
# The background job
# --------------------------------------------------------------------------- #


def versions_in_scanning_state() -> list[str]:
    """The version cids currently waiting for a scan, in cid order."""
    from app.modules.submissions import SCANNING as SUBMISSIONS_SCANNING
    from app.modules.submissions.models import PaperVersion, ensure_tables

    ensure_tables()
    with db.SessionLocal() as session:
        return list(
            session.scalars(
                select(PaperVersion.version_cid)
                .where(PaperVersion.state == SUBMISSIONS_SCANNING)
                .order_by(PaperVersion.version_cid)
            )
        )


def scan_pending_versions() -> int:
    """Scan every version currently in ``scanning`` state; return how many.

    Versions whose row disappeared between the query and the scan are
    skipped.  Each scan is independent: one failure does not stop the rest.
    """
    from app.modules.submissions import UnknownVersion

    scanned = 0
    for version_cid in versions_in_scanning_state():
        try:
            scan_version(version_cid)
        except UnknownVersion:
            continue
        scanned += 1
    return scanned


def scan_version_job(payload: Any) -> None:
    """Job handler: scan the version named in ``payload``, or all pending.

    ``payload`` is ``{"version_cid": ...}`` (``version``, ``versionCid`` and
    ``id`` are accepted as aliases); an empty payload sweeps every version
    currently in ``scanning`` state.
    """
    payload = payload if isinstance(payload, Mapping) else {}
    version_cid = (
        payload.get("version_cid")
        or payload.get("versionCid")
        or payload.get("version")
        or payload.get("id")
    )
    if isinstance(version_cid, str) and version_cid:
        from app.modules.submissions import UnknownVersion

        try:
            scan_version(version_cid)
        except UnknownVersion:
            logger.warning(
                "sanitizer job for unknown version %s", _show(version_cid)
            )
        return
    scan_pending_versions()


def enqueue_scan(version_cid: str) -> int:
    """Enqueue a scan of ``version_cid`` and return the job id.

    Raises:
        ValueError: if ``version_cid`` is not a non-empty string.
        UnknownJobKind: never in practice -- the handler is registered when
            this module is imported.
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise ValueError("a non-empty version_cid is required")
    ensure_subscribed()
    return jobs.enqueue(JOB_KIND, {"version_cid": version_cid})


# --------------------------------------------------------------------------- #
# Rather than wire versions into it, react to the version.state_changed event
# --------------------------------------------------------------------------- #


def _manifest_ready(version_cid: str) -> bool:
    """Whether ``version_cid`` is a scanning version with a readable manifest.

    The event subscription only starts a scan once the manifest can actually
    be read.  A version whose ``manifest`` record has not reached this node
    yet stays ``scanning`` -- its bytes remain unserved (``423``) -- rather
    than being held for a gap that may still resolve.  An explicit
    :func:`scan_version` or a sweep still holds such a version, so a manifest
    that never arrives cannot leave it publishable.
    """
    row = _get_version(version_cid)
    if row is None or getattr(row, "state", None) != SCANNING:
        return False
    try:
        _manifest_files(version_cid, getattr(row, "manifest_cid", None))
    except _Unscannable:
        return False
    return True


def _on_version_state_changed(event: Any) -> None:
    """Start a scan when a version enters ``scanning`` (feature 52 event)."""
    if getattr(event, "state", None) != SCANNING:
        return
    version_cid = getattr(event, "version_cid", None)
    if not isinstance(version_cid, str) or not version_cid:
        return
    try:
        if _manifest_ready(version_cid):
            enqueue_scan(version_cid)
    except Exception:  # noqa: BLE001 - a broken job must not break the transition
        logger.exception(
            "could not enqueue a scan for version %s", _show(version_cid)
        )


def ensure_subscribed() -> None:
    """Make sure this module hears about versions entering ``scanning``.

    Registration is idempotent.  It is done at import time for a normally
    started node and again before every enqueue, so a test or tool that
    cleared the process-wide subscriber list does not silently stop scans
    from being scheduled.
    """
    from app.modules.submissions import subscribe_version_state_changed

    subscribe_version_state_changed(_on_version_state_changed)


# Register at import time so ``jobs.enqueue`` accepts the kind, and so a
# version entering ``scanning`` schedules its scan without any further wiring.
jobs.register(JOB_KIND, scan_version_job)
ensure_subscribed()
