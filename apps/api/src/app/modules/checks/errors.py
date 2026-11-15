"""Errors raised by the automated checks plugin (plugin: checks).

These are plain Python exceptions, not HTTP ones: the checks are a library
the submission pipeline and its background jobs call.  The routes that use
them decide which status code each failure becomes.
"""

from __future__ import annotations

__all__ = [
    "ChecksError",
    "InvalidVersionCid",
    "MetadataMatchError",
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


class MetadataMatchError(ChecksError, ValueError):
    """The metadata check could not be run.

    Raised when the signed title or the first page text is not supplied and
    cannot be recovered: the version has no signed record in the event log,
    that record has no usable title, or it names no manuscript PDF whose
    first page could be extracted.
    """
