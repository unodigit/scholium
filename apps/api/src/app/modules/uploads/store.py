"""Persistent state for in-flight tus uploads (plugin: uploads).

Creation (``POST /v1/uploads``) records every upload here so the
resumable endpoints — the ``PATCH``/``HEAD`` of tus 1.0.0 core, and the
move into the content store once an upload completes — can pick the
upload up again after the creation response is gone.

The model is declared at import time: the module loader imports every
package under ``app.modules`` before ``db.Base.metadata.create_all``
runs, so the ``uploads`` table is created with the rest of the schema
without touching any shared file. ``create_all`` never alters a table that
already exists, so columns added after the table first shipped are added by
:func:`ensure_columns`, which the module's ``on_startup`` hook runs.
"""

from __future__ import annotations

import fcntl
import os
import re
import secrets
from pathlib import Path
from typing import BinaryIO, Optional

from sqlalchemy import BigInteger, Boolean, Column, DateTime, String, Text, func, inspect, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.db import Base
from app.settings import settings

#: An upload that has been created but has not yet received all its bytes.
STATE_PENDING = "pending"
#: Every declared byte has been received (set when the upload completes).
STATE_COMPLETED = "completed"

#: Subdirectory of ``CONTENT_DIR`` holding the bytes of uploads in flight.
#: No CID starts with a dot, so it can never collide with a stored blob, and
#: sharing the volume lets a finished upload move into the content store
#: without crossing filesystems.
STAGING_DIRNAME = ".uploads"

#: What :func:`_new_upload_id` produces (``secrets.token_urlsafe``).
_UPLOAD_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


class UploadBusy(Exception):
    """Another request is appending to this upload right now."""


def _new_upload_id() -> str:
    return secrets.token_urlsafe(18)


class Upload(Base):
    """One tus upload resource: ``/v1/uploads/{id}``."""

    __tablename__ = "uploads"

    id = Column(String(64), primary_key=True, default=_new_upload_id)
    #: The declared total size in bytes; NULL while the length is deferred.
    upload_length = Column(BigInteger, nullable=True)
    #: True when the client used ``Upload-Defer-Length: 1``.
    defer_length = Column(Boolean, nullable=False, default=False)
    #: How many bytes have been received so far.
    upload_offset = Column(BigInteger, nullable=False, default=0)
    #: The raw ``Upload-Metadata`` header, kept verbatim for later turns.
    upload_metadata = Column(Text, nullable=False, default="")
    #: ``pdf``, ``bundle`` or ``other`` — decides the size limit applied.
    kind = Column(String(16), nullable=False, default="other")
    #: ``pending`` until every declared byte has arrived, then ``completed``.
    state = Column(String(16), nullable=False, default=STATE_PENDING)
    #: The DID of the caller, when the creation request was authenticated.
    owner_did = Column(String(256), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: The raw-codec CID of the bytes once the completed upload has been moved
    #: into the content store; NULL until then. Its presence is what says the
    #: staged file is gone and the upload can only be answered, not appended to.
    cid = Column(String(128), nullable=True)


#: Columns added to ``uploads`` after it first shipped: ``name -> DDL type``.
#: Every one must be nullable, since existing rows get NULL.
_ADDED_COLUMNS = {"cid": "VARCHAR(128)"}


def ensure_columns(bind: Engine) -> list[str]:
    """Add any :data:`_ADDED_COLUMNS` a pre-existing ``uploads`` table lacks.

    ``create_all`` skips a table that exists, so a database created before a
    column was added would otherwise fail every upload query with "no such
    column". A missing table is left alone (``create_all`` is about to build it
    whole). Returns the names of the columns it added; safe to call repeatedly.
    """
    inspector = inspect(bind)
    if not inspector.has_table(Upload.__tablename__):
        return []
    present = {column["name"] for column in inspector.get_columns(Upload.__tablename__)}
    added = []
    for name, ddl_type in _ADDED_COLUMNS.items():
        if name in present:
            continue
        with bind.begin() as connection:
            connection.execute(text(f"ALTER TABLE {Upload.__tablename__} ADD COLUMN {name} {ddl_type}"))
        added.append(name)
    return added


def create_upload(
    session: Session,
    *,
    upload_length: Optional[int],
    defer_length: bool = False,
    upload_metadata: str = "",
    kind: str = "other",
    owner_did: Optional[str] = None,
) -> Upload:
    """Persist a freshly created tus upload resource and return it."""
    upload = Upload(
        id=_new_upload_id(),
        upload_length=upload_length,
        defer_length=defer_length,
        upload_offset=0,
        upload_metadata=upload_metadata,
        kind=kind,
        state=STATE_PENDING,
        owner_did=owner_did,
    )
    session.add(upload)
    session.commit()
    session.refresh(upload)
    return upload


def get_upload(session: Session, upload_id: str) -> Optional[Upload]:
    """Return the upload with ``upload_id``, or ``None`` when it does not exist."""
    return session.get(Upload, upload_id)


def advance_offset(
    session: Session,
    upload_id: str,
    *,
    expected_offset: int,
    new_offset: int,
    upload_length: Optional[int] = None,
) -> bool:
    """Record that bytes ``expected_offset`` .. ``new_offset`` were received.

    This is a compare-and-swap: the row only moves when its offset is still
    ``expected_offset``, so a writer that lost a race can never move it
    backwards or past bytes someone else wrote. Returns whether it moved.

    ``upload_length`` fixes the total size of an upload that was created with
    ``Upload-Defer-Length``; it is ignored once a length is known. The upload
    becomes ``completed`` as soon as ``new_offset`` reaches its length.
    """
    upload = session.get(Upload, upload_id)
    if upload is None:
        return False
    values: dict[str, object] = {"upload_offset": new_offset}
    length = upload.upload_length
    if length is None and upload_length is not None:
        length = values["upload_length"] = upload_length
    if length is not None and new_offset == length:
        values["state"] = STATE_COMPLETED
    result = session.execute(
        update(Upload).where(Upload.id == upload_id, Upload.upload_offset == expected_offset).values(**values)
    )
    session.commit()
    return result.rowcount == 1


def record_cid(session: Session, upload_id: str, cid: str) -> bool:
    """Record that ``upload_id``'s bytes now live in the content store as ``cid``.

    Also marks the upload ``completed``: having its bytes stored is the end of
    an upload, including a zero-length one that never advanced its offset.
    Recording is idempotent for the same ``cid``; an upload already stored
    under a different one is left alone. Returns whether the upload now has
    exactly this ``cid``.
    """
    result = session.execute(
        update(Upload)
        .where(Upload.id == upload_id, (Upload.cid.is_(None)) | (Upload.cid == cid))
        .values(cid=cid, state=STATE_COMPLETED)
    )
    session.commit()
    return result.rowcount == 1


def staging_dir() -> Path:
    """Where in-flight upload bytes live, from ``settings.CONTENT_DIR`` (read on every call)."""
    configured = settings.CONTENT_DIR
    if not configured or not configured.strip():
        # ``Path("")`` is the current directory: refuse rather than scatter
        # bytes wherever the process happens to have been started.
        raise RuntimeError("CONTENT_DIR is not configured")
    return Path(configured) / STAGING_DIRNAME


def staged_path(upload_id: str) -> Path:
    """Where the bytes received so far for ``upload_id`` live (whether or not any have arrived).

    Raises:
        ValueError: if ``upload_id`` is not one of our ids, which is what keeps
            a client-supplied id from naming a path outside the staging directory.
    """
    if not _UPLOAD_ID.fullmatch(upload_id):
        raise ValueError(f"not an upload id: {upload_id!r}")
    return staging_dir() / upload_id


def open_staged(upload_id: str) -> BinaryIO:
    """Open the staged bytes of ``upload_id`` for reading and writing, exclusively.

    The file is created empty if no bytes have arrived yet. The caller holds an
    exclusive lock on it until it closes the returned file, so two requests can
    never interleave their writes into one upload.

    Raises:
        UploadBusy: if another request holds the upload (it is not waited for:
            a stalled client must not pin a worker thread).
    """
    path = staged_path(upload_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UploadBusy(upload_id) from None
        return os.fdopen(fd, "r+b")
    except BaseException:
        os.close(fd)
        raise


def discard_staged(upload_id: str) -> None:
    """Delete the staged bytes of ``upload_id``; a no-op when there are none.

    Best effort: the bytes are either already safe in the content store or not
    wanted, so failing to free the space must not fail the request.
    """
    try:
        staged_path(upload_id).unlink()
    except OSError:
        pass
