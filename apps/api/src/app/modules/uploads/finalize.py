"""Moving a completed upload into the content store (plugin: uploads).

Once the last byte of an upload has arrived, its staged parts (one object per
``PATCH`` under ``uploads/{id}/``, see :mod:`.store`) are streamed, in order, into
the content plugin, which hashes them as they pass, files the bytes under their
raw-codec CIDv1 and records them in ``blobs`` (``scan_status`` ``scanning`` — the
sanitizer decides later whether it may be served). The upload row then remembers
the CID and every part is deleted, so the bytes exist once, under their content
address.

The steps are ordered so that a crash at any point can be repaired by running
the move again, which is what a client does when it retries its final ``PATCH``:

1. store the bytes (idempotent: the same bytes always give the same CID);
2. record the CID on the upload (idempotent for the same CID);
3. delete the parts (best effort).

Before step 2 the upload is complete but unfinished and still has its parts;
after it, the upload answers every ``PATCH`` with its CID and nothing else.
This is blocking object-store and database I/O: call it from a worker thread.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Optional

from app.db import SessionLocal
from app.modules import content

from . import limits, store

#: Upload-Metadata keys that may declare the payload's media type, best first.
#: ``filetype`` is what tus-js-client and Uppy send.
_MEDIA_TYPE_KEYS = (
    "filetype",
    "content_type",
    "content-type",
    "contenttype",
    "media_type",
    "media-type",
    "mediatype",
    "mime_type",
    "mime-type",
    "mimetype",
    "mime",
    "type",
)


class CidNotRecorded(Exception):
    """The upload row refused the CID: it is gone, or already stored under a different one."""


def declared_media_type(upload_metadata: str) -> Optional[str]:
    """The media type the client declared in ``Upload-Metadata``, or ``None``.

    Only a value that is a well-formed ``type/subtype`` counts. A malformed or
    absent one is ignored rather than refused: the bytes were uploaded
    successfully, and the media type is a hint the content store may do without.
    Nothing is guessed from a file name or the upload's size class.
    """
    metadata = limits.parse_upload_metadata(upload_metadata)
    for key in _MEDIA_TYPE_KEYS:
        value = metadata.get(key)
        if not value:
            continue
        try:
            media_type = content.normalize_media_type(value)
        except content.InvalidMediaType:
            continue
        if media_type is not None:
            return media_type
    return None


def move_into_content_store(
    upload_id: str,
    upload_metadata: str,
    size: int,
    *,
    keepalive: Optional[Callable[[], None]] = None,
) -> str:
    """Store the ``size`` bytes of the upload's parts in the content store and return their raw CID.

    The parts are read in order as one stream (:class:`.store.PartsReader`) and
    the content store computes the CID from what passes; ``size`` is the number
    of bytes the upload acknowledged, which the parts must add up to exactly.
    The caller holds the upload's lease, and ``keepalive`` (called as the parts
    are read) is how a long move keeps it. On return the CID is recorded on the
    upload row and the parts are gone.

    Raises:
        store.UploadBytesMissing: acknowledged bytes are gone from the object
            store; nothing was stored and the upload can never be finished.
        store.LockLost: the lease lapsed while the bytes were being read.
        OSError, app.storage.ObjectStoreError: the object store (or the content
            store) could not be read or written; nothing was recorded and the
            upload can be finished again.
        sqlalchemy.exc.SQLAlchemyError: the database could not be updated; the
            bytes are stored but the upload does not know it yet.
        content.ContentError: the content store refused the bytes.
    """
    media_type = declared_media_type(upload_metadata)
    with store.PartsReader(upload_id, size, keepalive=keepalive) as parts:
        blob = content.store_stream(parts, media_type=media_type)

    session = SessionLocal()
    try:
        recorded = store.record_cid(session, upload_id, blob.cid)
    finally:
        session.close()
    if not recorded:
        raise CidNotRecorded(f"upload {upload_id} could not be recorded as stored under {blob.cid}")

    store.discard_parts(upload_id)
    return blob.cid
