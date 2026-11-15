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
    CHECK_ORDER,
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
]
