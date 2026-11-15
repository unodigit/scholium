"""Errors raised by the content store (plugin: content).

These are plain Python exceptions, not HTTP ones: the store is a library
the uploads, submissions and sanitizer plugins call.  The routes that
use it decide which status code each failure becomes.
"""

from __future__ import annotations

__all__ = [
    "BlobConflict",
    "BlobNotFound",
    "ContentError",
    "InvalidMediaType",
    "InvalidScanStatus",
]


class ContentError(Exception):
    """Base class for content store failures."""


class InvalidMediaType(ContentError, ValueError):
    """A media type is not a bare ``type/subtype`` (RFC 6838)."""


class InvalidScanStatus(ContentError, ValueError):
    """A scan status is not one of the known :data:`~.models.SCAN_STATUSES`."""


class BlobNotFound(ContentError, LookupError):
    """No row in the ``blobs`` table has the requested cid."""


class BlobConflict(ContentError):
    """The ``blobs`` row for a cid disagrees with the bytes just stored.

    Content addressing makes this impossible short of a sha2-256 collision
    or a corrupted database, so it is reported loudly rather than resolved
    by trusting either side.
    """
