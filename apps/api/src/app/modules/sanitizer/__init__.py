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

The module exposes no ``router``.  Importing this package registers the
``ScanReport`` model on the shared declarative base before ``create_app``
creates tables, and the module loader discovers it automatically.

See :mod:`app.modules.sanitizer.models` for the table, :mod:`.reports` for the
read/write helpers and :mod:`.pdf` for the structural checks.
"""

from __future__ import annotations

from .errors import InvalidScanReport, SanitizerError
from .models import (
    RESULT_FAILED,
    RESULT_PASSED,
    RESULTS,
    ScanReport,
    ensure_table,
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

__all__ = [
    "CHECK_EMBEDDED_FILES",
    "CHECK_JAVASCRIPT",
    "CHECK_LAUNCH_ACTION",
    "CHECK_OPEN_ACTION",
    "CHECK_ORDER",
    "CHECK_UNREADABLE",
    "Finding",
    "InvalidScanReport",
    "PdfScanResult",
    "RESULT_FAILED",
    "RESULT_PASSED",
    "RESULTS",
    "SanitizerError",
    "ScanReport",
    "analyze_pdf",
    "check_pdf",
    "delete_reports",
    "ensure_table",
    "first_failure",
    "has_failure",
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
]
