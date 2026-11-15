"""Errors raised by the automated checks plugin (plugin: checks).

These are plain Python exceptions, not HTTP ones: the checks are a library
the submission pipeline and its background jobs call.  The routes that use
them decide which status code each failure becomes.
"""

from __future__ import annotations

__all__ = [
    "ChecksError",
    "InvalidVersionCid",
    "PdfTextError",
]


class ChecksError(Exception):
    """Base class for automated check failures."""


class InvalidVersionCid(ChecksError, ValueError):
    """A version id is not a canonical base32 CID string."""


class PdfTextError(ChecksError, ValueError):
    """Text could not be extracted from a PDF.

    Raised for bytes that are not a PDF, for damaged PDFs, and for PDFs that
    are encrypted with a password.  A well-formed PDF with no text layer (a
    scan) is *not* an error: it simply has no paragraphs.
    """
