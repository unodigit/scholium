"""File sanitizer plugin.

Feature 60: PDFs are checked with :mod:`pypdf` for active content -- JavaScript,
embedded files, Launch and OpenAction actions -- and a ``failed`` row is saved
to the ``scan_reports`` table for every PDF that contains one::

    from app.modules import sanitizer

    result = sanitizer.scan_pdf_bytes(data)   # cid computed from the bytes
    result.failed                              # True
    result.check_names                         # ("javascript",)

    result = sanitizer.scan_pdf(blob.cid)      # bytes read from the blob store
    sanitizer.reports_for(blob.cid)            # the saved rows

Nothing is executed and nothing is deleted: the scan only inspects the PDF
object graph and records what it finds.  A clean PDF writes no rows; an
unparseable or still-encrypted one records a failed ``pdf_unreadable`` report
so the file is held rather than served.

Feature 61 adds a ``hidden_text`` check (see :mod:`.hidden_text`) for text a
reader cannot see -- white or near-white glyphs, text under 2pt, transparent
or invisible-mode text -- and for instruction-like strings aimed at a
downstream model (``"ignore previous instructions"``)::

    hits = sanitizer.analyze_hidden_text(pdf_bytes)   # tuple[HiddenTextHit]
    sanitizer.hidden_text_detail(hits)                # the report's detail
    result = sanitizer.scan_pdf_bytes(pdf_bytes)      # saves the finding

Feature 63 scans every file of a version that is in ``scanning`` state and
moves the version on (see :mod:`.scan_job`)::

    result = sanitizer.scan_version(version_cid)   # every manifest file
    result.state                                   # "moderation" or "held"
    result.failing_check                           # e.g. "javascript"

The work runs as the background job ``sanitizer.scan_version``; a
``version.state_changed`` event for a version entering ``scanning`` enqueues
it automatically.  Each scanned blob's ``scan_status`` is saved to the
``blobs`` table, a clean version moves to ``moderation`` and a version with a
failing file is held with the exact failing check in the event's ``reason``.

The module exposes no ``router``.  Importing this package registers the
``ScanReport`` model on the shared declarative base before ``create_app``
creates tables, and the module loader discovers it automatically.

See :mod:`app.modules.sanitizer.models` for the table, :mod:`.reports` for the
read/write helpers, :mod:`.pdf` for the structural checks, :mod:`.bundle` for
archive checks and :mod:`.scan_job` for the per-version background scan.
"""

from __future__ import annotations

from typing import Optional

from fastapi import FastAPI

from .errors import InvalidScanReport, SanitizerError
from .models import (
    RESULT_FAILED,
    RESULT_PASSED,
    RESULTS,
    ScanReport,
    ensure_table,
)
from .hidden_text import (
    CHECK_HIDDEN_TEXT,
    INSTRUCTION_PATTERNS,
    NEAR_TRANSPARENT,
    NEAR_WHITE,
    TINY_FONT_SIZE,
    HiddenTextHit,
    analyze_hidden_text,
    analyze_hidden_text_reader,
    detect_hidden_text,
    hidden_text_detail,
)
from .pdf import (
    CHECK_EMBEDDED_FILES,
    CHECK_JAVASCRIPT,
    CHECK_LAUNCH_ACTION,
    CHECK_OPEN_ACTION,
    CHECK_ORDER as PDF_CHECK_ORDER,
    CHECK_UNREADABLE,
    Finding,
    PdfScanResult,
    analyze_pdf,
    check_pdf,
    scan_blob,
    scan_pdf,
    scan_pdf_bytes,
    scan_pdf_path,
    scan_pdf_stream,
)
from .bundle import (
    CHECK_ABSOLUTE_PATH,
    CHECK_ABSOLUTE_PATHS,
    CHECK_AV_UNAVAILABLE,
    CHECK_BUNDLE_UNREADABLE,
    CHECK_MALWARE,
    CHECK_ORDER,
    CHECK_ORDER as BUNDLE_CHECK_ORDER,
    CHECK_PATH_TRAVERSAL,
    CHECK_SYMLINK,
    CHECK_SYMLINKS,
    CHECK_UNREADABLE as CHECK_BUNDLE_UNREADABLE_ALIAS,
    BundleScanResult,
    ZipScanResult,
    TarScanResult,
    ScanResult,
    BundleResult,
    ArchiveScanResult,
    analyze,
    analyze_archive,
    analyze_bundle,
    analyze_tar,
    analyze_zip,
    check_archive,
    check_bundle,
    check_tar,
    check_zip,
    scan,
    scan_archive,
    scan_archive_blob,
    scan_archive_bytes,
    scan_archive_path,
    scan_archive_stream,
    scan_bundle,
    scan_bundle_blob,
    scan_bundle_bytes,
    scan_bytes,
    scan_bundle_path,
    scan_bundle_stream,
    scan_tar,
    scan_tar_blob,
    scan_tar_bytes,
    scan_tar_path,
    scan_tar_stream,
    scan_zip,
    scan_zip_blob,
    scan_zip_bytes,
    scan_zip_path,
    scan_zip_stream,
)
from .reports import (
    delete_reports,
    first_failure,
    has_failure,
    record_finding,
    record_report,
    reports_for,
)
from .scan_job import (
    CHECK_FILE_MISSING,
    CHECK_FILE_UNREADABLE,
    CHECK_MANIFEST_UNREADABLE,
    JOB_KIND,
    FileScanResult,
    VersionScanResult,
    enqueue_scan,
    ensure_subscribed,
    scan_pending_versions,
    scan_version,
    scan_version_job,
    versions_in_scanning_state,
)

__all__ = [
    "CHECK_EMBEDDED_FILES",
    "CHECK_HIDDEN_TEXT",
    "CHECK_JAVASCRIPT",
    "CHECK_LAUNCH_ACTION",
    "CHECK_OPEN_ACTION",
    "CHECK_ORDER",
    "CHECK_UNREADABLE",
    "Finding",
    "HiddenTextHit",
    "INSTRUCTION_PATTERNS",
    "InvalidScanReport",
    "NEAR_TRANSPARENT",
    "NEAR_WHITE",
    "PdfScanResult",
    "RESULT_FAILED",
    "RESULT_PASSED",
    "RESULTS",
    "SanitizerError",
    "ScanReport",
    "TINY_FONT_SIZE",
    "analyze_hidden_text",
    "analyze_hidden_text_reader",
    "analyze_pdf",
    "check_pdf",
    "delete_reports",
    "detect_hidden_text",
    "ensure_table",
    "first_failure",
    "has_failure",
    "hidden_text_detail",
    "record_finding",
    "record_report",
    "reports_for",
    "scan_blob",
    "scan_pdf",
    "scan_pdf_bytes",
    "scan_pdf_path",
    "scan_pdf_stream",
    "CHECK_ABSOLUTE_PATH",
    "CHECK_ABSOLUTE_PATHS",
    "CHECK_AV_UNAVAILABLE",
    "CHECK_BUNDLE_UNREADABLE",
    "CHECK_MALWARE",
    "CHECK_PATH_TRAVERSAL",
    "CHECK_SYMLINK",
    "CHECK_SYMLINKS",
    "BUNDLE_CHECK_ORDER",
    "BundleScanResult",
    "ZipScanResult",
    "TarScanResult",
    "ScanResult",
    "BundleResult",
    "ArchiveScanResult",
    "analyze",
    "analyze_archive",
    "analyze_bundle",
    "analyze_tar",
    "analyze_zip",
    "check_archive",
    "check_bundle",
    "check_tar",
    "check_zip",
    "scan",
    "scan_archive",
    "scan_bytes",
    "scan_archive_blob",
    "scan_archive_bytes",
    "scan_archive_path",
    "scan_archive_stream",
    "scan_bundle",
    "scan_bundle_blob",
    "scan_bundle_bytes",
    "scan_bundle_path",
    "scan_bundle_stream",
    "scan_tar",
    "scan_tar_blob",
    "scan_tar_bytes",
    "scan_tar_path",
    "scan_tar_stream",
    "scan_zip",
    "scan_zip_blob",
    "scan_zip_bytes",
    "scan_zip_path",
    "scan_zip_stream",
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


def on_startup(app: Optional[FastAPI] = None) -> None:
    """Re-attach the version-state subscription when the app starts.

    The subscription is also made at import time; doing it again here is
    harmless (registration is idempotent) and restores it after anything
    that clears the process-wide subscriber list, such as a test fixture.
    """
    ensure_subscribed()
