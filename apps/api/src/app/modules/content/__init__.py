"""Content store module (plugin: content).

Feature 43: file bytes live in a CID-addressed blob directory
(``settings.CONTENT_DIR``) and every stored file is recorded in the ``blobs``
table with its ``cid``, ``size``, ``media_type`` and ``scan_status``::

    from app.modules import content

    blob = content.store_bytes(data, media_type="application/pdf")
    blob = content.store_stream(fileobj)          # constant memory
    content.get_blob(blob.cid)                    # the blobs row, or None
    content.blob_path(blob.cid)                   # where the bytes live
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

The cid is the raw-codec CIDv1 sha2-256 file id of the bytes
(:func:`scholium_record_core.compute_file_id`), computed here from what was
actually written -- never accepted from a caller.  New blobs start in
``scanning``; only the sanitizer moves them to ``passed`` or ``failed``.

This package exposes no ``router``: serving the bytes
(``GET /v1/content/{cid}``) is a separate feature.  The module loader still
discovers it, which registers the ``Blob`` model on the shared declarative
base before ``create_app`` creates tables.

See :mod:`app.modules.content.store` for the on-disk layout and write
guarantees and :mod:`app.modules.content.service` for the ``blobs`` row
semantics.
"""

from __future__ import annotations

from .errors import (
    BlobConflict,
    BlobNotFound,
    ContentError,
    InvalidMediaType,
    InvalidScanStatus,
)
from .models import (
    SCAN_FAILED,
    SCAN_PASSED,
    SCAN_SCANNING,
    SCAN_STATUSES,
    Blob,
    ensure_table,
)
from .service import (
    get_blob,
    normalize_media_type,
    set_scan_status,
    store_bytes,
    store_stream,
)
from .store import blob_path, content_dir, exists, open_blob

__all__ = [
    "Blob",
    "BlobConflict",
    "BlobNotFound",
    "ContentError",
    "InvalidMediaType",
    "InvalidScanStatus",
    "SCAN_FAILED",
    "SCAN_PASSED",
    "SCAN_SCANNING",
    "SCAN_STATUSES",
    "blob_path",
    "content_dir",
    "ensure_table",
    "exists",
    "get_blob",
    "normalize_media_type",
    "open_blob",
    "set_scan_status",
    "store_bytes",
    "store_stream",
]
