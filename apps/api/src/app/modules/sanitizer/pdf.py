"""Scanning PDFs for active content (plugin: sanitizer).

A PDF is not a passive document: it can carry JavaScript, embed other files,
and run a Launch action or an OpenAction when opened.  This module walks the
PDF object graph with :mod:`pypdf` and records a ``failed`` report for each
hazard it finds::

    from app.modules import sanitizer

    result = sanitizer.scan_pdf_bytes(data)       # cid computed from the bytes
    result = sanitizer.scan_pdf(path, cid=cid)    # explicit file id
    result.failed, result.check_names             # (True, ("javascript",))

Scanning *saves* to ``scan_reports`` by default (pass ``record=False`` for a
dry run).  A clean PDF writes nothing: absence of failed rows is the clean
verdict, and the background job records the ``blobs.scan_status`` separately.
A PDF that pypdf cannot parse, or that stays encrypted, records a failed
``pdf_unreadable`` report instead of raising -- an unreadable file must be
held, not served.

The checks are deliberately structural.  We do not execute anything and we do
not rely on page text; we look for the PDF constructs themselves:

* ``javascript`` -- a JavaScript action (``/S /JavaScript`` or any ``/JS``
  key), including document-level JavaScript name trees and additional actions;
* ``embedded_files`` -- the ``/EmbeddedFiles`` name tree, an
  ``/EmbeddedFile`` stream, or an ``/EF`` entry;
* ``launch`` -- a Launch action (``/S /Launch``);
* ``openaction`` -- an ``/OpenAction`` entry in the document catalog.

Each check produces at most one row per file; the ``detail`` names every
place the construct was found, so a file with three JavaScript actions still
has one ``javascript`` finding.
"""

from __future__ import annotations

import io
import os
from collections.abc import Buffer
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Protocol, Union

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject

from .models import RESULT_FAILED, RESULT_PASSED, ScanReport
from .reports import record_finding

__all__ = [
    "CHECK_EMBEDDED_FILES",
    "CHECK_JAVASCRIPT",
    "CHECK_LAUNCH_ACTION",
    "CHECK_OPEN_ACTION",
    "CHECK_UNREADABLE",
    "CHECK_ORDER",
    "Finding",
    "PdfScanResult",
    "analyze_pdf",
    "check_pdf",
    "scan_blob",
    "scan_pdf",
    "scan_pdf_bytes",
    "scan_pdf_path",
    "scan_pdf_stream",
]

#: PDF JavaScript, wherever it appears in the object graph.
CHECK_JAVASCRIPT = "javascript"
#: The document embeds another file (``/EmbeddedFiles``, ``/EmbeddedFile``, ``/EF``).
CHECK_EMBEDDED_FILES = "embedded_files"
#: The document contains a Launch action.
CHECK_LAUNCH_ACTION = "launch"
#: The document catalog has an ``/OpenAction`` entry.
CHECK_OPEN_ACTION = "openaction"
#: pypdf could not parse the file, or it stayed encrypted.
CHECK_UNREADABLE = "pdf_unreadable"

#: Stable order for findings and their report rows.
CHECK_ORDER = (
    CHECK_JAVASCRIPT,
    CHECK_EMBEDDED_FILES,
    CHECK_LAUNCH_ACTION,
    CHECK_OPEN_ACTION,
    CHECK_UNREADABLE,
)

#: Human-readable label per check, used in ``detail``.
_LABELS = {
    CHECK_JAVASCRIPT: "JavaScript action",
    CHECK_EMBEDDED_FILES: "embedded file",
    CHECK_LAUNCH_ACTION: "Launch action",
    CHECK_OPEN_ACTION: "OpenAction entry",
    CHECK_UNREADABLE: "unreadable PDF",
}

#: Guard against pathologically nested objects: enough for any real document,
#: small enough that a hostile PDF cannot pin a worker for minutes.
_MAX_OBJECTS = 200_000
#: How many locations are listed in one detail string before summarising.
_MAX_LOCATIONS = 6
#: Longest object path quoted in a detail string.
_MAX_PATH = 160
#: Longest detail string stored in the table.
_MAX_DETAIL = 2_000


class SupportsRead(Protocol):
    """A binary readable: ``read(n)`` returns up to ``n`` bytes, ``b""`` at EOF."""

    def read(self, size: int = -1, /) -> bytes: ...


#: Anything :func:`scan_pdf` accepts: the bytes, a path, a binary stream, or
#: a canonical file id (scanned through the blob directory).
PdfSource = Union[Buffer, str, os.PathLike, SupportsRead]


@dataclass(frozen=True)
class Finding:
    """One failed check produced by a PDF scan."""

    check_name: str
    detail: str
    result: str = RESULT_FAILED

    def __post_init__(self) -> None:
        object.__setattr__(self, "detail", _truncate(self.detail, _MAX_DETAIL))


@dataclass(frozen=True)
class PdfScanResult:
    """The verdict of scanning one PDF.

    ``cid`` is the file id of the scanned bytes (always present for a
    complete scan).  ``findings`` is empty for a clean PDF; ``reports`` holds
    the rows persisted to ``scan_reports`` (empty when ``record=False`` or
    the PDF is clean).
    """

    cid: Optional[str]
    findings: tuple[Finding, ...] = ()
    reports: tuple[ScanReport, ...] = field(default_factory=tuple)

    @property
    def failed(self) -> bool:
        """Whether any check found a hazard."""
        return bool(self.findings)

    @property
    def passed(self) -> bool:
        """Whether the PDF is clean (the inverse of :attr:`failed`)."""
        return not self.findings

    @property
    def ok(self) -> bool:
        """Alias for :attr:`passed`."""
        return self.passed

    @property
    def result(self) -> str:
        """``"failed"`` or ``"passed"`` for the whole scan."""
        return RESULT_FAILED if self.findings else RESULT_PASSED

    @property
    def check_names(self) -> tuple[str, ...]:
        """The failed check names, in :data:`CHECK_ORDER`."""
        return tuple(finding.check_name for finding in self.findings)

    def finding(self, check_name: str) -> Optional[Finding]:
        """The finding for ``check_name``, or ``None``."""
        for finding in self.findings:
            if finding.check_name == check_name:
                return finding
        return None

    def to_dict(self) -> dict[str, Any]:
        """A JSON-friendly summary of the scan."""
        return {
            "cid": self.cid,
            "result": self.result,
            "findings": [
                {
                    "check_name": finding.check_name,
                    "result": finding.result,
                    "detail": finding.detail,
                }
                for finding in self.findings
            ],
        }


def analyze_pdf(data: Buffer) -> tuple[Finding, ...]:
    """Inspect PDF ``data`` with pypdf and return its findings, without saving.

    Never raises for bad input: a file pypdf cannot parse (or one that stays
    encrypted) yields a single :data:`CHECK_UNREADABLE` finding.
    """
    raw = _as_bytes(data)
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            # Many PDFs are "encrypted" with an empty user password and can
            # still be inspected; only an undecryptable one is unreadable.
            try:
                decrypted = reader.decrypt("")
            except Exception as exc:  # noqa: BLE001 - any failure means held
                return (_unreadable(f"PDF is encrypted and could not be decrypted: {exc}"),)
            if not decrypted:
                return (
                    _unreadable(
                        "PDF is encrypted and cannot be inspected without a password"
                    ),
                )
        root = reader.trailer.get("/Root")
        if root is None:
            return (_unreadable("PDF has no document catalog (/Root)"),)
        collector = _Collector()
        collector.walk(root, "/Root")
        return collector.findings()
    except Exception as exc:  # noqa: BLE001 - pypdf raises many unrelated types
        return (_unreadable(f"PDF could not be parsed with pypdf: {exc}"),)


def scan_pdf(
    source: PdfSource,
    *,
    cid: Optional[str] = None,
    record: bool = True,
) -> PdfScanResult:
    """Scan a PDF and (by default) save its failed results to ``scan_reports``.

    ``source`` may be:

    * ``bytes``/``bytearray``/``memoryview`` -- the PDF itself;
    * a filesystem path (``str`` or :class:`os.PathLike`);
    * a binary stream (anything with ``read``);
    * a canonical file id string -- the bytes are read through the content
      blob directory (see :func:`scan_blob`).

    A ``str`` that is not an existing path but parses as a canonical file id
    is treated as a cid.  A path that does not exist raises
    :class:`FileNotFoundError`.

    Args:
        cid: the file id to record the reports under.  Defaults to
            :func:`scholium_record_core.compute_file_id` of the bytes.
        record: when ``False``, inspect only and write nothing.

    Returns:
        A :class:`PdfScanResult` whose ``findings`` and ``cid`` describe the
        scan; ``reports`` holds the persisted rows (empty for a clean PDF).
    """
    if isinstance(source, (bytes, bytearray, memoryview)):
        return scan_pdf_bytes(source, cid=cid, record=record)
    if isinstance(source, os.PathLike):
        return scan_pdf_path(source, cid=cid, record=record)
    if isinstance(source, str):
        if _is_file_cid(source) and not Path(source).exists():
            return scan_blob(source, record=record)
        return scan_pdf_path(source, cid=cid, record=record)
    read = getattr(source, "read", None)
    if callable(read):
        return scan_pdf_stream(source, cid=cid, record=record)  # type: ignore[arg-type]
    raise TypeError(
        "source must be PDF bytes, a path, a binary stream or a file id, "
        f"got {type(source).__name__}"
    )


def check_pdf(
    source: PdfSource,
    *,
    cid: Optional[str] = None,
    record: bool = True,
) -> PdfScanResult:
    """Alias for :func:`scan_pdf`."""
    return scan_pdf(source, cid=cid, record=record)


def scan_pdf_bytes(
    data: Buffer,
    *,
    cid: Optional[str] = None,
    record: bool = True,
) -> PdfScanResult:
    """Scan PDF ``data`` and (by default) save its failed results."""
    raw = _as_bytes(data)
    return _scan_and_record(raw, cid=cid, record=record)


def scan_pdf_stream(
    stream: SupportsRead,
    *,
    cid: Optional[str] = None,
    record: bool = True,
) -> PdfScanResult:
    """Scan everything read from the binary ``stream``."""
    chunk = stream.read()
    if not isinstance(chunk, (bytes, bytearray, memoryview)):
        raise TypeError(
            "stream must be a binary readable; read() returned "
            f"{type(chunk).__name__}"
        )
    return scan_pdf_bytes(chunk, cid=cid, record=record)


def scan_pdf_path(
    path: Union[str, os.PathLike],
    *,
    cid: Optional[str] = None,
    record: bool = True,
) -> PdfScanResult:
    """Scan the PDF at ``path``.

    Raises:
        FileNotFoundError: if there is no file at ``path``.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    return scan_pdf_bytes(data, cid=cid, record=record)


def scan_blob(cid: str, *, record: bool = True) -> PdfScanResult:
    """Scan the stored bytes for file id ``cid``.

    The bytes come from the content plugin's blob directory, so ``cid`` must
    be a canonical raw-codec file id and the bytes must have been stored.

    Raises:
        ValueError: if ``cid`` is not a canonical file id.
        FileNotFoundError: if the bytes are not in the blob directory.
    """
    # Imported here so importing the sanitizer package never depends on the
    # content plugin being importable (the module loader imports every package).
    from app.modules.content import open_blob

    with open_blob(cid) as handle:
        data = handle.read()
    # Do not recompute: the caller asked about these exact stored bytes, and
    # the cid names them.  (compute_file_id(data) equals cid for stored blobs.)
    return scan_pdf_bytes(data, cid=cid, record=record)


def _scan_and_record(
    raw: bytes,
    *,
    cid: Optional[str],
    record: bool,
) -> PdfScanResult:
    findings = analyze_pdf(raw)
    file_id = _resolve_cid(cid, raw)
    reports: list[ScanReport] = []
    if record:
        for finding in findings:
            reports.append(record_finding(file_id, finding.check_name, finding.detail))
    return PdfScanResult(cid=file_id, findings=findings, reports=tuple(reports))


def _resolve_cid(cid: Optional[str], raw: bytes) -> str:
    if cid is None:
        from scholium_record_core import compute_file_id

        return compute_file_id(raw)
    if not isinstance(cid, str) or not cid.strip():
        raise ValueError(f"cid must be a non-empty string, got {cid!r}")
    return cid


def _unreadable(reason: str) -> Finding:
    return Finding(CHECK_UNREADABLE, reason)


def _as_bytes(data: Buffer) -> bytes:
    if isinstance(data, bytes):
        return data
    if isinstance(data, (bytearray, memoryview)):
        return bytes(data)
    raise TypeError(f"PDF bytes must be bytes-like, got {type(data).__name__}")


def _is_file_cid(value: str) -> bool:
    """Whether ``value`` is a canonical raw-codec file id."""
    try:
        from scholium_record_core import parse_file_cid

        parse_file_cid(value)
    except (ImportError, ValueError):
        return False
    return True


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


class _Collector:
    """Walks a PDF object graph iteratively, collecting hazards by check."""

    def __init__(self) -> None:
        self._locations: dict[str, list[str]] = {name: [] for name in CHECK_ORDER}
        self._seen: set[int] = set()
        #: Keeps every visited object alive: ``_seen`` holds ids, and an id
        #: could otherwise be reused by a new object after garbage collection,
        #: which would look like a cycle and silently skip real content.
        self._kept: list[Any] = []
        self._visited = 0

    def walk(self, value: Any, path: str) -> None:
        stack: list[tuple[Any, str]] = [(value, path)]
        while stack:
            current, current_path = stack.pop()
            resolved = self._resolve(current)
            if resolved is None:
                continue
            if isinstance(resolved, IndirectObject):
                # Unresolvable indirect references (dangling xref entries)
                # cannot carry an inspectable action; skip them.
                continue
            if isinstance(resolved, ArrayObject):
                if not self._mark_visited(resolved):
                    continue
                base = _truncate(current_path, _MAX_PATH)
                for index in range(len(resolved)):
                    stack.append((resolved[index], f"{base}[{index}]"))
                continue
            if isinstance(resolved, DictionaryObject):
                if not self._mark_visited(resolved):
                    continue
                self._inspect(resolved, current_path)
                base = _truncate(current_path, _MAX_PATH)
                for key, item in resolved.items():
                    # Keys are untrusted: bound the segment before concatenating
                    # so a megabyte-long name cannot blow up every child path.
                    segment = _truncate(str(key), 80)
                    stack.append((item, f"{base}{segment}"))
                continue
            # Scalars (names, strings, numbers, booleans, null) carry no
            # structure of their own; their owning dictionary was inspected.

    def _mark_visited(self, value: Any) -> bool:
        marker = id(value)
        if marker in self._seen:
            return False
        self._seen.add(marker)
        self._kept.append(value)
        self._visited += 1
        return self._visited <= _MAX_OBJECTS

    def _resolve(self, value: Any) -> Any:
        if isinstance(value, IndirectObject):
            try:
                return value.get_object()
            except Exception:  # noqa: BLE001 - a broken reference is not a hazard
                return None
        return value

    def _inspect(self, mapping: DictionaryObject, path: str) -> None:
        keys = {str(key) for key in mapping.keys()}
        action_type = str(mapping.get("/S", ""))
        type_name = str(mapping.get("/Type", ""))

        if action_type == "/JavaScript" or "/JS" in keys:
            self._add(CHECK_JAVASCRIPT, self._where(path, "/JavaScript action"))
        if (
            "/EmbeddedFiles" in keys
            or "/EmbeddedFile" in keys
            or "/EF" in keys
            or type_name == "/EmbeddedFile"
        ):
            self._add(CHECK_EMBEDDED_FILES, self._where(path, "embedded file reference"))
        if action_type == "/Launch" or "/Launch" in keys:
            self._add(CHECK_LAUNCH_ACTION, self._where(path, "/Launch action"))
        if "/OpenAction" in keys:
            self._add(CHECK_OPEN_ACTION, self._where(path, "/OpenAction"))

    def _where(self, path: str, what: str) -> str:
        return f"{what} at {_truncate(path, _MAX_PATH)}"

    def _add(self, check_name: str, location: str) -> None:
        locations = self._locations[check_name]
        if location not in locations:
            locations.append(location)

    def findings(self) -> tuple[Finding, ...]:
        findings: list[Finding] = []
        for check_name in CHECK_ORDER:
            locations = self._locations[check_name]
            if not locations:
                continue
            label = _LABELS[check_name]
            findings.append(Finding(check_name, self._detail(label, locations)))
        return tuple(findings)

    @staticmethod
    def _detail(label: str, locations: list[str]) -> str:
        shown = "; ".join(locations[:_MAX_LOCATIONS])
        if len(locations) > _MAX_LOCATIONS:
            shown += f"; and {len(locations) - _MAX_LOCATIONS} more"
        if len(locations) == 1:
            return f"PDF contains {label}: {shown}"
        return f"PDF contains {label} in {len(locations)} places: {shown}"
