"""Storing file bytes and recording them in the ``blobs`` table.

::

    from app.modules import content

    blob = content.store_bytes(data, media_type="application/pdf")
    blob.cid, blob.size, blob.media_type, blob.scan_status   # "scanning"

    blob = content.store_stream(open(path, "rb"))             # constant memory
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

Order matters.  The bytes are written first and the ``blobs`` row only
afterwards, because other features treat a row as proof the bytes exist (a
manifest is accepted when its files are in ``blobs``).  A crash in between
leaves an unreferenced file, which the next store of the same bytes adopts;
it can never leave a row without its file.

Storing is idempotent.  The same bytes always get the same cid, and storing
them again changes nothing except filling in a ``media_type`` that was still
unknown: in particular it never resets a ``scan_status``, so re-uploading a
file the sanitizer already cleared (or rejected) does not undo the verdict.

Rows are returned detached from any session, with every attribute loaded.
"""

from __future__ import annotations

import re
from collections.abc import Buffer
from typing import Optional

from sqlalchemy.exc import IntegrityError

from app import db

from . import store
from .errors import BlobConflict, BlobNotFound, InvalidMediaType, InvalidScanStatus
from .models import SCAN_SCANNING, SCAN_STATUSES, Blob, ensure_table

__all__ = [
    "get_blob",
    "normalize_media_type",
    "set_scan_status",
    "store_bytes",
    "store_stream",
]

# Mirrors the manifest's rule for ``mediaType`` (scholium_record_core.manifest):
# a bare lowercase RFC 6838 ``type/subtype``, no parameters, no wildcards.  A
# test keeps the two in agreement.  This value is later sent back as a
# ``Content-Type`` header, so it must never carry anything but token characters.
_MEDIA_TYPE_PATTERN = re.compile(
    r"[a-z0-9][a-z0-9!#$&^_.+\-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+\-]{0,126}"
)

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


def normalize_media_type(value: Optional[str]) -> Optional[str]:
    """Reduce a declared media type to the bare form stored in ``blobs``.

    ``None`` and the empty string mean "not declared" and give ``None``.
    Parameters (``; charset=utf-8``) are dropped and case is folded, so
    ``Application/PDF; charset=binary`` becomes ``application/pdf``.

    Raises:
        InvalidMediaType: if what remains is not a valid ``type/subtype``.
    """
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise InvalidMediaType(
            f"media type must be a string, got {type(value).__name__}"
        )
    essence = value.split(";", 1)[0].strip().lower()
    if _MEDIA_TYPE_PATTERN.fullmatch(essence) is None:
        raise InvalidMediaType(
            f"media type {_show(value)} is not a valid type/subtype"
        )
    return essence


def store_bytes(data: Buffer, *, media_type: Optional[str] = None) -> Blob:
    """Store ``data`` in the blob directory and record it in ``blobs``.

    Args:
        data: the file's exact bytes (``bytes``, ``bytearray``, ``memoryview``).
        media_type: the declared media type, if known; see
            :func:`normalize_media_type`.

    Raises:
        InvalidMediaType: if ``media_type`` is malformed (nothing is stored).
        TypeError: if ``data`` is not bytes-like.
    """
    declared = normalize_media_type(media_type)
    ensure_table()
    return _record(store.write_bytes(data), declared)


def store_stream(stream: store.SupportsRead, *, media_type: Optional[str] = None) -> Blob:
    """Store everything read from the binary ``stream`` and record it in ``blobs``.

    The stream is consumed in :data:`~.store.CHUNK_SIZE` pieces, so a
    multi-gigabyte upload never has to fit in memory.  Errors are those of
    :func:`store_bytes`; a text-mode stream raises :class:`TypeError`.
    """
    declared = normalize_media_type(media_type)
    ensure_table()
    return _record(store.write_stream(stream), declared)


def get_blob(cid: str) -> Optional[Blob]:
    """The ``blobs`` row for file id ``cid``, or ``None`` when there is none.

    A ``cid`` that is not even a well-formed file id has no row, so it also
    gives ``None``.
    """
    ensure_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        blob = session.get(Blob, cid) if isinstance(cid, str) else None
        if blob is not None:
            session.expunge(blob)
        return blob


def set_scan_status(cid: str, status: str) -> Blob:
    """Record the sanitizer's verdict for ``cid`` and return the updated row.

    Raises:
        InvalidScanStatus: if ``status`` is not one of
            :data:`~.models.SCAN_STATUSES`.
        BlobNotFound: if ``cid`` has no row.
    """
    if status not in SCAN_STATUSES:
        raise InvalidScanStatus(
            f"scan status {_show(status)} must be one of {', '.join(SCAN_STATUSES)}"
        )
    ensure_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        blob = session.get(Blob, cid) if isinstance(cid, str) else None
        if blob is None:
            raise BlobNotFound(f"no blob with cid {_show(cid)}")
        blob.scan_status = status
        session.commit()
        session.expunge(blob)
        return blob


def _record(stored: store.StoredFile, media_type: Optional[str]) -> Blob:
    """Insert the ``blobs`` row for freshly stored bytes, or reconcile an existing one."""
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        blob = session.get(Blob, stored.cid)
        if blob is None:
            created = Blob(
                cid=stored.cid,
                size=stored.size,
                media_type=media_type,
                scan_status=SCAN_SCANNING,
            )
            session.add(created)
            try:
                session.commit()
            except IntegrityError:
                # A concurrent store of the same bytes inserted the row first;
                # fall through and treat theirs as the existing one.
                session.rollback()
                blob = session.get(Blob, stored.cid)
            else:
                session.expunge(created)
                return created

        if blob is None:  # pragma: no cover - the row we conflicted with vanished
            raise BlobConflict(f"blob {stored.cid} disappeared while being recorded")
        if blob.size != stored.size:
            raise BlobConflict(
                f"blob {stored.cid} is recorded with size {blob.size} but "
                f"{stored.size} bytes were stored"
            )
        if blob.media_type is None and media_type is not None:
            blob.media_type = media_type
            session.commit()
        session.expunge(blob)
        return blob
