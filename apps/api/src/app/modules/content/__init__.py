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

Feature 44: the package also exports ``router``, which serves
``GET /v1/content/{cid}``: the bytes only once ``scan_status`` is ``passed``,
with ``Content-Security-Policy: sandbox`` and
``X-Content-Type-Options: nosniff``, answering ``423`` while scanning and
``451`` for tombstoned (denylisted) content.  Bytes a paper version
references through its manifest are served publicly only once a referencing
version is ``listed``; until then they go only to that version's authors and
to moderators (:func:`app.modules.content.visibility.may_read`).  The module
loader discovers the router by convention.

See :mod:`app.modules.content.store` for the on-disk layout and write
guarantees, :mod:`app.modules.content.service` for the ``blobs`` row
semantics and :mod:`app.modules.content.router` for the HTTP surface.
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
from .router import (
    CONTENT_SECURITY_POLICY,
    NOSNIFF,
    SECURITY_HEADERS,
    router,
)
from .service import (
    get_blob,
    is_tombstoned,
    normalize_media_type,
    set_scan_status,
    store_bytes,
    store_stream,
)
from .store import blob_path, content_dir, exists, open_blob
from .visibility import MODERATOR_TIER, may_read

__all__ = [
    "Blob",
    "BlobConflict",
    "BlobNotFound",
    "CONTENT_SECURITY_POLICY",
    "ContentError",
    "InvalidMediaType",
    "InvalidScanStatus",
    "MODERATOR_TIER",
    "NOSNIFF",
    "SCAN_FAILED",
    "SCAN_PASSED",
    "SCAN_SCANNING",
    "SCAN_STATUSES",
    "SECURITY_HEADERS",
    "blob_path",
    "content_dir",
    "ensure_table",
    "exists",
    "get_blob",
    "is_tombstoned",
    "may_read",
    "normalize_media_type",
    "open_blob",
    "router",
    "set_scan_status",
    "store_bytes",
    "store_stream",
]
