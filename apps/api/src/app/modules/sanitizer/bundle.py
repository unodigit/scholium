"""Scanning zip/tar bundles for unsafe entries (plugin: sanitizer).

A bundle is not a passive archive: it can carry path-traversal entries
(``../``), symlinks and absolute paths that escape the extraction root, and
may carry malware.  This module inspects zip and tar archives structurally
and (when ``CLAMD_SOCKET`` is set) scans the bytes through ClamAV/clamd,
recording a ``failed`` report for each hazard it finds::

    from app.modules import sanitizer

    result = sanitizer.scan_bundle_bytes(data)   # cid computed from the bytes
    result.failed                                # True
    result.check_names                           # ("path_traversal",)

Scanning *saves* to ``scan_reports`` by default (pass ``record=False`` for a
dry run).  A clean bundle writes nothing (subject to AV availability): when
``CLAMD_SOCKET`` is unset an ``av_unavailable`` finding is recorded instead.

The checks are deliberately structural.  We do not extract anything and we
do not execute anything; we look at the archive's member names and metadata.
"""

from __future__ import annotations

import io
import os
import socket
import stat
import struct
import tarfile
import zipfile
from collections.abc import Buffer
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Protocol, Union

from .models import RESULT_FAILED, RESULT_PASSED, ScanReport
from .reports import record_finding

__all__ = [
    "CHECK_ABSOLUTE_PATH",
    "CHECK_ABSOLUTE_PATHS",
    "CHECK_AV_UNAVAILABLE",
    "CHECK_MALWARE",
    "CHECK_PATH_TRAVERSAL",
    "CHECK_SYMLINK",
    "CHECK_SYMLINKS",
    "CHECK_UNREADABLE",
    "CHECK_BUNDLE_UNREADABLE",
    "CHECK_ORDER",
    "BundleScanResult",
    "ZipScanResult",
    "TarScanResult",
    "ScanResult",
    "BundleResult",
    "ArchiveScanResult",
    "Finding",
    "analyze_archive",
    "analyze_bundle",
    "analyze_tar",
    "analyze_zip",
    "detect_bundle_kind",
    "check_archive",
    "check_bundle",
    "check_tar",
    "check_zip",
    "scan_archive",
    "scan_archive_bytes",
    "scan_archive_stream",
    "scan_archive_path",
    "scan_archive_blob",
    "scan_bundle",
    "scan_bundle_bytes",
    "scan_bundle_stream",
    "scan_bundle_path",
    "scan_bundle_blob",
    "scan_tar",
    "scan_tar_bytes",
    "scan_tar_stream",
    "scan_tar_path",
    "scan_tar_blob",
    "scan_zip",
    "scan_zip_bytes",
    "scan_zip_stream",
    "scan_zip_path",
    "scan_zip_blob",
]

# Re-export Finding from pdf for convenience.
from .pdf import Finding as _PdfFinding

Finding = _PdfFinding

# ---------------------------------------------------------------------------
# Check names
# ---------------------------------------------------------------------------

CHECK_PATH_TRAVERSAL = "path_traversal"
CHECK_SYMLINK = "symlink"
CHECK_SYMLINKS = CHECK_SYMLINK
CHECK_ABSOLUTE_PATH = "absolute_path"
CHECK_ABSOLUTE_PATHS = CHECK_ABSOLUTE_PATH
CHECK_MALWARE = "malware"
CHECK_VIRUS = CHECK_MALWARE
CHECK_CLAMAV = CHECK_MALWARE
CHECK_AV_UNAVAILABLE = "av_unavailable"
CHECK_BUNDLE_UNREADABLE = "bundle_unreadable"
# Backwards/alias for the pdf unreadable name (kept distinct).
CHECK_UNREADABLE = CHECK_BUNDLE_UNREADABLE

CHECK_ORDER = (
    CHECK_PATH_TRAVERSAL,
    CHECK_SYMLINK,
    CHECK_ABSOLUTE_PATH,
    CHECK_MALWARE,
    CHECK_AV_UNAVAILABLE,
    CHECK_BUNDLE_UNREADABLE,
)

_LABELS = {
    CHECK_PATH_TRAVERSAL: "path traversal entry",
    CHECK_SYMLINK: "symlink entry",
    CHECK_ABSOLUTE_PATH: "absolute path entry",
    CHECK_MALWARE: "malware",
    CHECK_AV_UNAVAILABLE: "antivirus unavailable",
    CHECK_BUNDLE_UNREADABLE: "unreadable bundle",
}

_MAX_DETAIL = 2_000

from .pdf import _truncate as _pdf_truncate


def _truncate(text: str, limit: int = _MAX_DETAIL) -> str:
    return _pdf_truncate(text, limit)


@dataclass(frozen=True)
class BundleScanResult:
    cid: Optional[str]
    findings: tuple[Finding, ...] = ()
    reports: tuple[ScanReport, ...] = field(default_factory=tuple)

    @property
    def failed(self) -> bool:
        return bool(self.findings)

    @property
    def passed(self) -> bool:
        return not self.findings

    @property
    def ok(self) -> bool:
        return self.passed

    @property
    def result(self) -> str:
        return RESULT_FAILED if self.findings else RESULT_PASSED

    @property
    def check_names(self) -> tuple[str, ...]:
        return tuple(f.check_name for f in self.findings)

    def finding(self, check_name: str) -> Optional[Finding]:
        for f in self.findings:
            if f.check_name == check_name:
                return f
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "cid": self.cid,
            "result": self.result,
            "findings": [
                {"check_name": f.check_name, "result": f.result, "detail": f.detail}
                for f in self.findings
            ],
        }


# Aliases
ZipScanResult = BundleScanResult
TarScanResult = BundleScanResult
ScanResult = BundleScanResult
BundleResult = BundleScanResult
ArchiveScanResult = BundleScanResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class SupportsRead(Protocol):
    def read(self, size: int = -1, /) -> bytes: ...


PdfSource = None  # placeholder unused
BundleSource = Union[Buffer, str, os.PathLike, SupportsRead]


def _as_bytes(data: Buffer) -> bytes:
    if isinstance(data, bytes):
        return data
    if isinstance(data, (bytearray, memoryview)):
        return bytes(data)
    raise TypeError(f"bundle bytes must be bytes-like, got {type(data).__name__}")


def _resolve_cid(cid: Optional[str], raw: bytes) -> str:
    if cid is None:
        from scholium_record_core import compute_file_id

        return compute_file_id(raw)
    if not isinstance(cid, str) or not cid.strip():
        raise ValueError(f"cid must be a non-empty string, got {cid!r}")
    return cid


def _is_file_cid(value: str) -> bool:
    try:
        from scholium_record_core import parse_file_cid

        parse_file_cid(value)
    except (ImportError, ValueError):
        return False
    return True


def _unreadable(reason: str) -> Finding:
    return Finding(CHECK_BUNDLE_UNREADABLE, reason)


def _is_traversal(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    parts = name.replace("\\", "/").split("/")
    if any(part == ".." for part in parts):
        return True
    # Also catch encoded or normalized escapes.
    try:
        import posixpath

        norm = posixpath.normpath(name)
        if norm.startswith("../") or norm == "..":
            return True
        if posixpath.isabs(name):
            # absolute handled separately but also traversal-ish
            pass
    except Exception:
        pass
    return False


def _is_absolute(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    if name.startswith("/"):
        return True
    if len(name) >= 3 and name[1] == ":" and name[0].isalpha() and name[2] in ("/", "\\"):
        return True
    return False


def _where(name: str, what: str) -> str:
    return f"{what} at {_truncate(name, 160)}"


def _build_findings(locations: dict[str, list[str]], unreadable: Optional[str] = None) -> list[Finding]:
    findings: list[Finding] = []
    if unreadable is not None:
        findings.append(Finding(CHECK_BUNDLE_UNREADABLE, unreadable))
    for check_name in (CHECK_PATH_TRAVERSAL, CHECK_SYMLINK, CHECK_ABSOLUTE_PATH):
        locs = locations.get(check_name, [])
        if not locs:
            continue
        label = _LABELS[check_name]
        if len(locs) == 1:
            detail = f"Bundle contains {label}: {locs[0]}"
        else:
            shown = "; ".join(locs[:6])
            if len(locs) > 6:
                shown += f"; and {len(locs) - 6} more"
            detail = f"Bundle contains {label} in {len(locs)} places: {shown}"
        findings.append(Finding(check_name, _truncate(detail, _MAX_DETAIL)))
    return findings


def _order(findings: list[Finding]) -> tuple[Finding, ...]:
    order_index = {name: i for i, name in enumerate(CHECK_ORDER)}
    return tuple(sorted(findings, key=lambda f: order_index.get(f.check_name, 99)))


# ---------------------------------------------------------------------------
# Archive analysis
# ---------------------------------------------------------------------------

def _analyze_zip_raw(raw: bytes) -> tuple[Finding, ...]:
    locations = {CHECK_PATH_TRAVERSAL: [], CHECK_SYMLINK: [], CHECK_ABSOLUTE_PATH: []}
    unreadable = None
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except Exception as exc:
        unreadable = f"zip could not be parsed: {exc}"
        # still run AV separately; return unreadable finding only
        return (Finding(CHECK_BUNDLE_UNREADABLE, _truncate(unreadable, _MAX_DETAIL)),)
    try:
        for info in zf.infolist():
            name = info.filename
            if _is_absolute(name):
                if name not in locations[CHECK_ABSOLUTE_PATH]:
                    locations[CHECK_ABSOLUTE_PATH].append(_where(name, "absolute path entry"))
            if _is_traversal(name):
                if name not in [x.split(" at ")[-1] for x in []]:
                    pass
                loc = _where(name, "path traversal entry")
                if loc not in locations[CHECK_PATH_TRAVERSAL]:
                    locations[CHECK_PATH_TRAVERSAL].append(loc)
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                loc = _where(name, "symlink entry")
                if loc not in locations[CHECK_SYMLINK]:
                    locations[CHECK_SYMLINK].append(loc)
        zf.close()
    except Exception as exc:
        zf.close()
        unreadable = f"zip could not be read: {exc}"
        return (Finding(CHECK_BUNDLE_UNREADABLE, _truncate(unreadable, _MAX_DETAIL)),)
    findings = _build_findings(locations)
    if unreadable:
        findings.insert(0, Finding(CHECK_BUNDLE_UNREADABLE, _truncate(unreadable, _MAX_DETAIL)))
    return _order(findings)


def _analyze_tar_raw(raw: bytes) -> tuple[Finding, ...]:
    locations = {CHECK_PATH_TRAVERSAL: [], CHECK_SYMLINK: [], CHECK_ABSOLUTE_PATH: []}
    unreadable = None
    try:
        tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:*")
    except Exception as exc:
        unreadable = f"tar could not be parsed: {exc}"
        return (Finding(CHECK_BUNDLE_UNREADABLE, _truncate(unreadable, _MAX_DETAIL)),)
    try:
        for member in tf.getmembers():
            name = member.name
            if _is_absolute(name):
                loc = _where(name, "absolute path entry")
                if loc not in locations[CHECK_ABSOLUTE_PATH]:
                    locations[CHECK_ABSOLUTE_PATH].append(loc)
            if _is_traversal(name):
                loc = _where(name, "path traversal entry")
                if loc not in locations[CHECK_PATH_TRAVERSAL]:
                    locations[CHECK_PATH_TRAVERSAL].append(loc)
            if member.issym() or member.islnk():
                loc = _where(name, "symlink entry")
                if loc not in locations[CHECK_SYMLINK]:
                    locations[CHECK_SYMLINK].append(loc)
            # link target checks
            if getattr(member, "linkname", None):
                ln = member.linkname
                if _is_absolute(ln):
                    loc = _where(name, "absolute path entry")
                    if loc not in locations[CHECK_ABSOLUTE_PATH]:
                        locations[CHECK_ABSOLUTE_PATH].append(loc)
                if _is_traversal(ln):
                    loc = _where(name, "path traversal entry")
                    if loc not in locations[CHECK_PATH_TRAVERSAL]:
                        locations[CHECK_PATH_TRAVERSAL].append(loc)
        tf.close()
    except Exception as exc:
        try:
            tf.close()
        except Exception:
            pass
        unreadable = f"tar could not be read: {exc}"
        return (Finding(CHECK_BUNDLE_UNREADABLE, _truncate(unreadable, _MAX_DETAIL)),)
    findings = _build_findings(locations)
    if unreadable:
        findings.insert(0, Finding(CHECK_BUNDLE_UNREADABLE, _truncate(unreadable, _MAX_DETAIL)))
    return _order(findings)


def _detect_kind(raw: bytes) -> str:
    if zipfile.is_zipfile(io.BytesIO(raw)):
        return "zip"
    try:
        tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:*")
        tf.getmembers()
        tf.close()
        return "tar"
    except Exception:
        return "unknown"


def detect_bundle_kind(data: Buffer) -> str:
    """Return ``"zip"``, ``"tar"`` or ``"unknown"`` for ``data``.

    The background version scan uses this to decide whether a file is a
    bundle before handing it to :func:`scan_bundle_bytes`.  Detection looks
    only at the archive structure: nothing is extracted or executed.
    """
    return _detect_kind(_as_bytes(data))



def _analyze_archive_raw(raw: bytes) -> tuple[Finding, ...]:
    kind = _detect_kind(raw)
    if kind == "zip":
        return _analyze_zip_raw(raw)
    if kind == "tar":
        return _analyze_tar_raw(raw)
    return (Finding(CHECK_BUNDLE_UNREADABLE, "bundle is not a recognized zip or tar archive"),)


# ---------------------------------------------------------------------------
# AV scan via clamd
# ---------------------------------------------------------------------------

def _clamd_connect(socket_path: str, timeout: Optional[float] = None) -> socket.socket:
    """Open a connection to clamd at ``socket_path`` (a unix path or ``host:port``).

    ``timeout`` applies to the connect itself as well as later I/O; ``None``
    leaves the connect blocking.
    """
    if "/" in socket_path or os.path.exists(socket_path):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        address: Any = socket_path
    elif ":" in socket_path:
        host, port = socket_path.rsplit(":", 1)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        address = (host, int(port))
    else:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        address = socket_path
    try:
        if timeout is not None:
            sock.settimeout(timeout)
        sock.connect(address)
    except BaseException:
        sock.close()
        raise
    return sock


def _clamd_scan(socket_path: str, raw: bytes) -> str:
    sock = _clamd_connect(socket_path)
    sock.settimeout(60)
    try:
        sock.sendall(b"INSTREAM\n")
        offset = 0
        chunk_size = 8192
        while offset < len(raw):
            chunk = raw[offset:offset + chunk_size]
            sock.sendall(struct.pack("!I", len(chunk)) + chunk)
            offset += len(chunk)
        sock.sendall(struct.pack("!I", 0))
        data = b""
        while True:
            try:
                r = sock.recv(4096)
            except socket.timeout:
                break
            if not r:
                break
            data += r
            if b"\n" in data or b"\x00" in data:
                break
        return data.decode("utf-8", errors="replace").strip().strip("\x00").strip()
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _av_scan(raw: bytes) -> Optional[Finding]:
    socket_path = os.getenv("CLAMD_SOCKET", "")
    if not socket_path:
        return Finding(CHECK_AV_UNAVAILABLE, "ClamAV (clamd) is unavailable: CLAMD_SOCKET is not set")
    try:
        response = _clamd_scan(socket_path, raw)
    except Exception as exc:
        return Finding(CHECK_AV_UNAVAILABLE, _truncate(f"ClamAV (clamd) is unavailable: {exc}", _MAX_DETAIL))
    if not response:
        return Finding(CHECK_AV_UNAVAILABLE, "ClamAV (clamd) returned no response")
    upper = response.upper()
    if "FOUND" in upper:
        # response like "stream: Eicar-Test-Signature FOUND"
        virus = response
        if ":" in virus:
            virus = virus.split(":", 1)[-1].strip()
        virus = virus.replace("FOUND", "").strip()
        detail = "ClamAV detected malware"
        if virus:
            detail = f"ClamAV detected malware: {virus}"
        return Finding(CHECK_MALWARE, _truncate(detail, _MAX_DETAIL))
    if "OK" in upper or "CLEAN" in upper:
        return None
    if "ERROR" in upper:
        return Finding(CHECK_AV_UNAVAILABLE, _truncate(f"ClamAV (clamd) error: {response}", _MAX_DETAIL))
    # Unknown response: treat as unavailable to be safe.
    return Finding(CHECK_AV_UNAVAILABLE, _truncate(f"ClamAV (clamd) unexpected response: {response}", _MAX_DETAIL))


# ---------------------------------------------------------------------------
# Public analyze functions
# ---------------------------------------------------------------------------

def analyze_zip(data: Buffer) -> tuple[Finding, ...]:
    raw = _as_bytes(data)
    structural = _analyze_zip_raw(raw)
    findings = list(structural)
    if (not structural) or os.getenv("CLAMD_SOCKET", ""):
        av = _av_scan(raw)
        if av is not None:
            findings.append(av)
    return _order(findings)


def analyze_tar(data: Buffer) -> tuple[Finding, ...]:
    raw = _as_bytes(data)
    structural = _analyze_tar_raw(raw)
    findings = list(structural)
    if (not structural) or os.getenv("CLAMD_SOCKET", ""):
        av = _av_scan(raw)
        if av is not None:
            findings.append(av)
    return _order(findings)


def analyze_bundle(data: Buffer) -> tuple[Finding, ...]:
    raw = _as_bytes(data)
    structural = _analyze_archive_raw(raw)
    findings = list(structural)
    if (not structural) or os.getenv("CLAMD_SOCKET", ""):
        av = _av_scan(raw)
        if av is not None:
            findings.append(av)
    return _order(findings)


analyze_archive = analyze_bundle


# ---------------------------------------------------------------------------
# scan functions
# ---------------------------------------------------------------------------

def _scan_and_record(raw: bytes, *, cid: Optional[str], record: bool, kind: str = "auto") -> BundleScanResult:
    if kind == "zip":
        findings = analyze_zip(raw)
    elif kind == "tar":
        findings = analyze_tar(raw)
    else:
        findings = analyze_bundle(raw)
    file_id = _resolve_cid(cid, raw)
    reports: list[ScanReport] = []
    if record:
        for finding in findings:
            reports.append(record_finding(file_id, finding.check_name, finding.detail))
    return BundleScanResult(cid=file_id, findings=findings, reports=tuple(reports))


def scan_bundle_bytes(data: Buffer, *, cid: Optional[str] = None, record: bool = True, kind: str = "auto", format: Optional[str] = None, archive_format: Optional[str] = None, **kwargs) -> BundleScanResult:
    if format is not None:
        kind = format
    if archive_format is not None:
        kind = archive_format
    if "type" in kwargs and kwargs["type"] is not None:
        kind = kwargs["type"]
    raw = _as_bytes(data)
    return _scan_and_record(raw, cid=cid, record=record, kind=kind)


def scan_zip_bytes(data: Buffer, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    return scan_bundle_bytes(data, cid=cid, record=record, kind="zip")


def scan_tar_bytes(data: Buffer, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    return scan_bundle_bytes(data, cid=cid, record=record, kind="tar")


# Source handling (bytes/path/stream/cid) like pdf.scan_pdf
def scan_bundle(source: BundleSource, *, cid: Optional[str] = None, record: bool = True, kind: str = "auto", format: Optional[str] = None, archive_format: Optional[str] = None, **kwargs) -> BundleScanResult:
    if format is not None:
        kind = format
    if archive_format is not None:
        kind = archive_format
    if "type" in kwargs and kwargs["type"] is not None:
        kind = kwargs["type"]
    if isinstance(source, (bytes, bytearray, memoryview)):
        return scan_bundle_bytes(source, cid=cid, record=record, kind=kind)
    if isinstance(source, os.PathLike):
        return scan_bundle_path(source, cid=cid, record=record, kind=kind)
    if isinstance(source, str):
        if _is_file_cid(source) and not Path(source).exists():
            return scan_bundle_blob(source, record=record, kind=kind)
        return scan_bundle_path(source, cid=cid, record=record, kind=kind)
    read = getattr(source, "read", None)
    if callable(read):
        return scan_bundle_stream(source, cid=cid, record=record, kind=kind)  # type: ignore[arg-type]
    raise TypeError(
        "source must be bundle bytes, a path, a binary stream or a file id, "
        f"got {type(source).__name__}"
    )


def scan_bundle_stream(stream: SupportsRead, *, cid: Optional[str] = None, record: bool = True, kind: str = "auto", format: Optional[str] = None, archive_format: Optional[str] = None, **kwargs) -> BundleScanResult:
    if format is not None: kind = format
    if archive_format is not None: kind = archive_format
    if "type" in kwargs and kwargs["type"] is not None: kind = kwargs["type"]
    chunk = stream.read()
    if not isinstance(chunk, (bytes, bytearray, memoryview)):
        raise TypeError(
            "stream must be a binary readable; read() returned "
            f"{type(chunk).__name__}"
        )
    return scan_bundle_bytes(chunk, cid=cid, record=record, kind=kind)


def scan_bundle_path(path: Union[str, os.PathLike], *, cid: Optional[str] = None, record: bool = True, kind: str = "auto", format: Optional[str] = None, archive_format: Optional[str] = None, **kwargs) -> BundleScanResult:
    if format is not None: kind = format
    if archive_format is not None: kind = archive_format
    if "type" in kwargs and kwargs["type"] is not None: kind = kwargs["type"]
    with open(path, "rb") as handle:
        data = handle.read()
    return scan_bundle_bytes(data, cid=cid, record=record, kind=kind)


def scan_bundle_blob(cid_arg: str, *, record: bool = True, kind: str = "auto", format: Optional[str] = None, archive_format: Optional[str] = None, **kwargs) -> BundleScanResult:
    from app.modules.content import open_blob

    if format is not None: kind = format
    if archive_format is not None: kind = archive_format
    if "type" in kwargs and kwargs["type"] is not None: kind = kwargs["type"]
    with open_blob(cid_arg) as handle:
        data = handle.read()
    return scan_bundle_bytes(data, cid=cid_arg, record=record, kind=kind)


# zip aliases
def scan_zip(source: BundleSource, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return scan_zip_bytes(source, cid=cid, record=record)
    if isinstance(source, os.PathLike):
        return scan_zip_path(source, cid=cid, record=record)
    if isinstance(source, str):
        if _is_file_cid(source) and not Path(source).exists():
            return scan_zip_blob(source, record=record)
        return scan_zip_path(source, cid=cid, record=record)
    read = getattr(source, "read", None)
    if callable(read):
        return scan_zip_stream(source, cid=cid, record=record)  # type: ignore[arg-type]
    raise TypeError("source must be bundle bytes, a path, a binary stream or a file id")


def scan_zip_bytes(data: Buffer, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    return scan_bundle_bytes(data, cid=cid, record=record, kind="zip")


def scan_zip_stream(stream: SupportsRead, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    chunk = stream.read()
    if not isinstance(chunk, (bytes, bytearray, memoryview)):
        raise TypeError("stream must be a binary readable")
    return scan_zip_bytes(chunk, cid=cid, record=record)


def scan_zip_path(path: Union[str, os.PathLike], *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    with open(path, "rb") as handle:
        data = handle.read()
    return scan_zip_bytes(data, cid=cid, record=record)


def scan_zip_blob(cid_arg: str, *, record: bool = True) -> BundleScanResult:
    from app.modules.content import open_blob

    with open_blob(cid_arg) as handle:
        data = handle.read()
    return scan_zip_bytes(data, cid=cid_arg, record=record)


# tar aliases
def scan_tar(source: BundleSource, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return scan_tar_bytes(source, cid=cid, record=record)
    if isinstance(source, os.PathLike):
        return scan_tar_path(source, cid=cid, record=record)
    if isinstance(source, str):
        if _is_file_cid(source) and not Path(source).exists():
            return scan_tar_blob(source, record=record)
        return scan_tar_path(source, cid=cid, record=record)
    read = getattr(source, "read", None)
    if callable(read):
        return scan_tar_stream(source, cid=cid, record=record)  # type: ignore[arg-type]
    raise TypeError("source must be bundle bytes, a path, a binary stream or a file id")


def scan_tar_bytes(data: Buffer, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    return scan_bundle_bytes(data, cid=cid, record=record, kind="tar")


def scan_tar_stream(stream: SupportsRead, *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    chunk = stream.read()
    if not isinstance(chunk, (bytes, bytearray, memoryview)):
        raise TypeError("stream must be a binary readable")
    return scan_tar_bytes(chunk, cid=cid, record=record)


def scan_tar_path(path: Union[str, os.PathLike], *, cid: Optional[str] = None, record: bool = True) -> BundleScanResult:
    with open(path, "rb") as handle:
        data = handle.read()
    return scan_tar_bytes(data, cid=cid, record=record)


def scan_tar_blob(cid_arg: str, *, record: bool = True) -> BundleScanResult:
    from app.modules.content import open_blob

    with open_blob(cid_arg) as handle:
        data = handle.read()
    return scan_tar_bytes(data, cid=cid_arg, record=record)


# aliases
scan_archive = scan_bundle
scan_archive_bytes = scan_bundle_bytes
scan_archive_stream = scan_bundle_stream
scan_archive_path = scan_bundle_path
scan_archive_blob = scan_bundle_blob

check_bundle = scan_bundle
check_zip = scan_zip
check_tar = scan_tar
check_archive = scan_bundle
check_bundle_bytes = scan_bundle_bytes

# Generic aliases
analyze = analyze_bundle
scan = scan_bundle
scan_bytes = scan_bundle_bytes
