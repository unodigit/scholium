"""Content store module (plugin: content).

Feature 43: file bytes are kept through the app-wide ObjectStore
(:mod:`app.storage`, selected by ``STORAGE_BACKEND``) keyed by CID, and
every stored file is recorded in the ``blobs`` table with its ``cid``,
``size``, ``media_type`` and ``scan_status``::

    from app.modules import content

    blob = content.store_bytes(data, media_type="application/pdf")
    blob = content.store_stream(fileobj)          # constant memory
    content.get_blob(blob.cid)                    # the blobs row, or None
    with content.open_blob(blob.cid) as handle:   # streamed from the store
        handle.read()
    content.blob_size(blob.cid); content.delete_blob(blob.cid)
    with content.local_copy(blob.cid) as path:    # a real file, any backend
        ...
    content.blob_path(blob.cid)                   # fs backend helper only
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

The cid is the raw-codec CIDv1 sha2-256 file id of the bytes
(:func:`scholium_record_core.compute_file_id`), computed here from what was
actually written -- never accepted from a caller.  New blobs start in
``scanning``; only the sanitizer moves them to ``passed`` or ``failed``.
With the default ``fs`` backend the bytes live under ``CONTENT_DIR`` in the
layout this module has always written, so existing data is read as it
stands, byte for byte, with no migration.

Feature 44: the package also exports ``router``, which serves
``GET /v1/content/{cid}``: the bytes only once ``scan_status`` is ``passed``,
streamed from the object store -- a single-range ``Range`` request is
answered ``206`` with a ``Content-Range`` and every other header unchanged
-- with ``Content-Security-Policy: sandbox`` and
``X-Content-Type-Options: nosniff``, answering ``423`` while scanning and
``451`` for tombstoned (denylisted) content.  Bytes a paper version
references through its manifest are served publicly only once a referencing
version is ``listed``; until then they go only to that version's authors and
to moderators (:func:`app.modules.content.visibility.may_read`).  The module
loader discovers the router by convention.

Which manifests list a file is answered from an index, not by reading every
manifest in the ledger: :mod:`app.modules.content.refs` keeps it current from
a ledger subscriber and the ``on_startup`` backfill below.

See :mod:`app.modules.content.store` for the storage layout and write
guarantees, :mod:`app.modules.content.service` for the ``blobs`` row
semantics and :mod:`app.modules.content.router` for the HTTP surface.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import FastAPI
from sqlalchemy.exc import SQLAlchemyError

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
from . import refs
from .refs import ContentRef, ContentRefProgress
from .store import (
    blob_path,
    blob_size,
    content_dir,
    delete_blob,
    exists,
    local_copy,
    open_blob,
    open_range,
)
from .visibility import MODERATOR_TIER, may_read

logger = logging.getLogger(__name__)


def on_startup(app: Optional[FastAPI] = None) -> None:
    """Module-loader hook: subscribe the content-reference index and backfill it.

    Runs on every ``create_app``.  The ledger's subscriber registry is
    process-global and may have been cleared since the last one, so the
    subscription is installed again; :func:`refs.install` is idempotent.  The
    backfill indexes the manifests that predate the index (all of them, on the
    first start after it shipped) and is a no-op once the index is current.

    A backfill that fails (the database is busy, say) does not stop the node
    from starting: every download brings the index up to date itself before it
    trusts it, so nothing is served on the strength of an incomplete index.
    """
    refs.install()
    try:
        refs.backfill()
    except SQLAlchemyError:
        logger.warning(
            "could not backfill the content-reference index at startup; "
            "downloads will complete it",
            exc_info=True,
        )


__all__ = [
    "Blob",
    "BlobConflict",
    "BlobNotFound",
    "CONTENT_SECURITY_POLICY",
    "ContentError",
    "ContentRef",
    "ContentRefProgress",
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
    "blob_size",
    "content_dir",
    "delete_blob",
    "ensure_table",
    "exists",
    "get_blob",
    "is_tombstoned",
    "local_copy",
    "may_read",
    "normalize_media_type",
    "on_startup",
    "open_blob",
    "open_range",
    "refs",
    "router",
    "set_scan_status",
    "store_bytes",
    "store_stream",
]
