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
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    String,
    Text,
    case,
    func,
    insert,
    inspect,
    literal,
    select,
    text,
    update,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app import db
from app.db import Base
from app.settings import settings

from . import limits

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


#: The two independent per-DID allowances a creation can exhaust.
QUOTA_IN_FLIGHT = "in_flight"
QUOTA_DAILY = "daily"


class QuotaExceeded(Exception):
    """Creating the upload would take its owner past one of their quotas."""

    def __init__(
        self,
        *,
        quota_bytes: int,
        in_flight_bytes: int,
        requested_bytes: int,
        quota_kind: str = QUOTA_IN_FLIGHT,
        completed_bytes: int = 0,
    ) -> None:
        super().__init__(
            f"{in_flight_bytes} bytes in flight + {requested_bytes} requested exceeds the {quota_bytes}-byte "
            f"{quota_kind} quota"
        )
        self.quota_kind = quota_kind
        self.quota_bytes = quota_bytes
        self.in_flight_bytes = in_flight_bytes
        self.requested_bytes = requested_bytes
        #: Bytes completed inside the day, which only the daily allowance
        #: counts (zero for an in-flight breach).
        self.completed_bytes = completed_bytes


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
    #: When the bytes reached the content store (``cid`` was recorded). The
    #: orphan reaper measures its TTL, and the daily quota its window, from
    #: here. NULL on rows written before this column existed and on uploads
    #: that never completed; readers fall back to ``created_at``.
    completed_at = Column(DateTime(timezone=True), nullable=True)


#: Columns added to ``uploads`` after it first shipped: ``name -> DDL type``.
#: Every one must be nullable, since existing rows get NULL.
_ADDED_COLUMNS = {"cid": "VARCHAR(128)", "completed_at": "DATETIME"}


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


def requested_bytes(upload_length: Optional[int], kind: str) -> int:
    """What an upload holds in reserve: its declared length, or while that is deferred the most its kind allows."""
    return upload_length if upload_length is not None else limits.limit_for(kind)


def _reserved_bytes() -> ColumnElement:
    """SQL for :func:`requested_bytes` over the ``uploads`` table."""
    deferred = case(
        {kind: limits.limit_for(kind) for kind in (limits.KIND_PDF, limits.KIND_BUNDLE, limits.KIND_OTHER)},
        value=Upload.kind,
        else_=limits.BUNDLE_MAX_BYTES,
    )
    return func.coalesce(Upload.upload_length, deferred)


def _daily_bytes() -> ColumnElement:
    """What an in-flight upload really occupies for the daily allowance.

    Unlike :func:`_reserved_bytes`, which reserves the declared length (or the
    kind's maximum while deferred) to keep disk allocations bounded, the daily
    allowance measures bytes that exist: a deferred-length upload counts the
    bytes received so far, and grows its share as it streams.
    """
    return func.coalesce(Upload.upload_length, Upload.upload_offset)


def _in_flight_filter(owner_did: Optional[str]) -> list[ColumnElement]:
    # An upload is in flight until its bytes have moved into the content store
    # (that is what sets ``cid``): until then it holds staged bytes or may yet.
    owner = Upload.owner_did.is_(None) if owner_did is None else Upload.owner_did == owner_did
    return [owner, Upload.cid.is_(None)]


def bytes_in_flight(session: Session, owner_did: Optional[str]) -> int:
    """The bytes ``owner_did``'s unfinished uploads hold in reserve (see :func:`requested_bytes`)."""
    total = session.scalar(select(func.coalesce(func.sum(_reserved_bytes()), 0)).where(*_in_flight_filter(owner_did)))
    return int(total or 0)


def _utcnow() -> datetime:
    """Naive UTC "now": the table stores naive UTC timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_naive_utc(value: object) -> Optional[datetime]:
    """A stored timestamp as naive UTC; SQLite hands back strings, naive means UTC."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo is not None else value


def account_created_at(owner_did: str) -> Optional[datetime]:
    """``accounts.created_at`` for ``owner_did``, or ``None`` when it is unknown.

    A missing row, a missing ``accounts`` table and an unreachable database all
    give ``None``, which the quota rules treat as a brand-new account: the
    strict end. Errors are swallowed because an upload's size allowance must not
    depend on the account plugin's table being readable.
    """
    if not owner_did:
        return None
    try:
        with db.engine.connect() as connection:
            row = connection.execute(
                text("SELECT created_at FROM accounts WHERE did = :did"), {"did": owner_did}
            ).first()
    except SQLAlchemyError:
        return None
    return _as_naive_utc(row[0]) if row is not None else None


def completed_bytes(session: Session, owner_did: Optional[str], *, since: datetime) -> int:
    """Bytes ``owner_did`` completed since ``since``, whatever any record names.

    The daily allowance measures what an account uploads, not what becomes
    paper: anyone can post a record naming any CID, so letting a reference
    free the allowance would let a second account free the first's. Rows
    completed before ``completed_at`` existed fall back to ``created_at``.

    The owner filter matches :func:`bytes_in_flight`, so an unowned legacy
    upload (``owner_did`` NULL) is counted with the NULL owner's usage rather
    than leaking out of every account's quota.
    """
    owner = Upload.owner_did.is_(None) if owner_did is None else Upload.owner_did == owner_did
    completed_at = func.coalesce(Upload.completed_at, Upload.created_at)
    total = session.scalar(
        select(func.coalesce(func.sum(func.coalesce(Upload.upload_length, 0)), 0)).where(
            owner,
            Upload.cid.is_not(None),
            completed_at >= since,
        )
    )
    return int(total or 0)


def _daily_in_flight(session: Session, owner_did: Optional[str], *, exclude_upload_id: Optional[str] = None) -> int:
    """Bytes ``owner_did``'s unfinished uploads hold for the daily allowance.

    A deferred-length upload counts what it has received (``_daily_bytes``),
    and ``exclude_upload_id`` leaves one upload out so its own share can be
    compared against the allowance as it grows.
    """
    owner = Upload.owner_did.is_(None) if owner_did is None else Upload.owner_did == owner_did
    filters = [owner, Upload.cid.is_(None)]
    if exclude_upload_id is not None:
        filters.append(Upload.id != exclude_upload_id)
    total = session.scalar(select(func.coalesce(func.sum(_daily_bytes()), 0)).where(*filters))
    return int(total or 0)


def daily_usage(
    session: Session,
    owner_did: Optional[str],
    *,
    exclude_upload_id: Optional[str] = None,
    since: datetime,
) -> tuple[int, int]:
    """``(completed bytes, in-flight bytes)`` for one owner's day."""
    return (
        completed_bytes(session, owner_did, since=since),
        _daily_in_flight(session, owner_did, exclude_upload_id=exclude_upload_id),
    )


def daily_usage_for(
    owner_did: Optional[str],
    *,
    exclude_upload_id: Optional[str] = None,
    since: datetime,
) -> tuple[int, int]:
    """``daily_usage`` in a session of its own (for callers outside the database layer)."""
    session = db.SessionLocal()
    try:
        return daily_usage(session, owner_did, exclude_upload_id=exclude_upload_id, since=since)
    finally:
        session.close()


def completed_bytes_for(owner_did: Optional[str], *, since: datetime) -> int:
    """``completed_bytes`` in a session of its own (for callers outside the database layer)."""
    session = db.SessionLocal()
    try:
        return completed_bytes(session, owner_did, since=since)
    finally:
        session.close()


def create_upload(
    session: Session,
    *,
    upload_length: Optional[int],
    defer_length: bool = False,
    upload_metadata: str = "",
    kind: str = "other",
    owner_did: Optional[str] = None,
    quota_bytes: Optional[int] = None,
    daily_quota_bytes: Optional[int] = None,
    completed_bytes: int = 0,
) -> Upload:
    """Persist a freshly created tus upload resource and return it.

    With ``quota_bytes`` the upload is only created if ``owner_did``'s bytes in
    flight, plus what this upload reserves, stay within it. With
    ``daily_quota_bytes`` it is only created if the caller's bytes in flight
    plus ``completed_bytes`` (everything the caller completed in the day, see
    :func:`completed_bytes`) and what this upload declares stay within that
    allowance too. Either failure raises
    :class:`QuotaExceeded` and stores nothing. Every check and the insert are
    one statement, so concurrent creations cannot both pass them.
    """
    upload_id = _new_upload_id()
    if quota_bytes is None and daily_quota_bytes is None:
        session.add(
            Upload(
                id=upload_id,
                upload_length=upload_length,
                defer_length=defer_length,
                upload_offset=0,
                upload_metadata=upload_metadata,
                kind=kind,
                state=STATE_PENDING,
                owner_did=owner_did,
            )
        )
        session.commit()
    else:
        wanted = requested_bytes(upload_length, kind)
        in_flight = (
            select(func.coalesce(func.sum(_reserved_bytes()), 0)).where(*_in_flight_filter(owner_did)).scalar_subquery()
        )
        # The daily allowance measures real bytes, so a deferred-length upload
        # starts with a zero share (and is bounded as it streams; see the
        # ``PATCH`` path) while a declared one takes its whole length now.
        daily_in_flight = (
            select(func.coalesce(func.sum(_daily_bytes()), 0))
            .where(*_in_flight_filter(owner_did))
            .scalar_subquery()
        )
        wanted_daily = upload_length if upload_length is not None else 0
        within: list[ColumnElement] = []
        if quota_bytes is not None:
            within.append(in_flight + wanted <= quota_bytes)
        if daily_quota_bytes is not None:
            within.append(daily_in_flight + completed_bytes + wanted_daily <= daily_quota_bytes)
        row = select(
            literal(upload_id, String(64)),
            literal(upload_length, BigInteger),
            literal(defer_length, Boolean),
            literal(0, BigInteger),
            literal(upload_metadata, Text),
            literal(kind, String(16)),
            literal(STATE_PENDING, String(16)),
            literal(owner_did, String(256)),
        ).where(*within)
        columns = ["id", "upload_length", "defer_length", "upload_offset", "upload_metadata", "kind", "state", "owner_did"]
        stored = session.execute(insert(Upload).from_select(columns, row)).rowcount
        if stored != 1:
            in_flight_bytes = bytes_in_flight(session, owner_did)
            quota_kind = QUOTA_DAILY if daily_quota_bytes is not None and (
                quota_bytes is None or in_flight_bytes + wanted <= quota_bytes
            ) else QUOTA_IN_FLIGHT
            quota = daily_quota_bytes if quota_kind == QUOTA_DAILY else quota_bytes
            session.rollback()
            raise QuotaExceeded(
                quota_kind=quota_kind,
                quota_bytes=int(quota or 0),
                in_flight_bytes=in_flight_bytes,
                requested_bytes=wanted,
                completed_bytes=completed_bytes if quota_kind == QUOTA_DAILY else 0,
            )
        session.commit()
    upload = session.get(Upload, upload_id)
    assert upload is not None
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
    under a different one is left alone. ``completed_at`` is stamped the first
    time the CID is recorded, so retrying a final ``PATCH`` cannot extend the
    orphan TTL. Returns whether the upload now has exactly this ``cid``.
    """
    result = session.execute(
        update(Upload)
        .where(Upload.id == upload_id, (Upload.cid.is_(None)) | (Upload.cid == cid))
        .values(cid=cid, state=STATE_COMPLETED, completed_at=func.coalesce(Upload.completed_at, _utcnow()))
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
