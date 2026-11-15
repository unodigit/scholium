"""Errors raised by the sanitizer plugin.

These are plain Python exceptions, not HTTP ones: the sanitizer is a library
the background scan job (and tests) call.  A scan that cannot inspect a file
does not raise -- it records a failed ``pdf_unreadable`` report so the file
is held rather than served -- so these errors are reserved for programmer
mistakes in the calling code.
"""

from __future__ import annotations

__all__ = ["InvalidScanReport", "SanitizerError"]


class SanitizerError(Exception):
    """Base class for sanitizer failures."""


class InvalidScanReport(SanitizerError, ValueError):
    """A scan report is missing its cid, check name or result."""
