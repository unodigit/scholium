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

Where the bytes of an upload in flight live
-------------------------------------------
Not on a local disk of this process: they are staged in the app-wide
:class:`~app.storage.base.ObjectStore` (:func:`app.storage.get_object_store`),
so any API replica, and the worker that runs the reaper, sees the same
bytes whichever ``STORAGE_BACKEND`` is in use. Every ``PATCH`` that delivers
bytes persists them as one *part* object::

    uploads/{id}/{start:019d}        <- the bytes from offset ``start`` to the end of that PATCH

The key is the byte offset the part starts at, zero-padded so the store's
ascending key order is the order of the bytes. A part is written *before* the
database offset moves past it, so the recorded offset never runs ahead of what
the store holds; a part the database never heard of (its request died first)
sits at or beyond the recorded offset, was never acknowledged, and is
replaced or deleted by the next request. Finishing the upload streams the
parts in order into the content store (:mod:`.finalize`) and deletes them;
discarding an upload (the reaper) deletes every key under ``uploads/{id}/``.

Appending needs mutual exclusion, and without a file to ``flock`` it is a
lease on the upload kept in the ``upload_leases`` table (:func:`acquire_lock`):
one holder at a time across processes, released on completion and expiring on
its own if its holder dies.

Uploads staged by an earlier release live in ``CONTENT_DIR/.uploads/{id}``;
they are still found and are moved into the object store the first time the
upload is appended to or finished, so an install needs no migration step.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
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
    delete,
    func,
    insert,
    inspect,
    literal,
    select,
    text,
    update,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app import db
from app.db import Base
from app.settings import settings
from app.storage import (
    ObjectNotFoundError,
    ObjectStore,
    ObjectStoreError,
    StoredObject,
    SupportsRead,
    get_object_store,
)
from app.storage.base import RawStream

from . import limits

logger = logging.getLogger(__name__)

#: An upload that has been created but has not yet received all its bytes.
STATE_PENDING = "pending"
#: Every declared byte has been received (set when the upload completes).
STATE_COMPLETED = "completed"

#: The key prefix every part of every upload in flight lives under (see the
#: module docstring); ``uploads/{id}/`` is one upload's.
PARTS_PREFIX = "uploads/"

#: Subdirectory of ``CONTENT_DIR`` in which earlier releases staged the bytes of
#: uploads in flight, one file per upload. Nothing writes there any more; what
#: is found there is adopted into the object store (:func:`verify_parts`) and
#: swept by the reaper once abandoned.
STAGING_DIRNAME = ".uploads"

#: What :func:`_new_upload_id` produces (``secrets.token_urlsafe``).
_UPLOAD_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

#: A part's file name: its start offset, zero-padded to the 19 digits of the
#: largest offset the ``upload_offset`` column holds (a signed 64-bit integer).
_PART_NAME = re.compile(r"[0-9]{19}")

#: How long a lease holds an upload without being renewed. A holder that dies
#: leaves the upload unwritable for at most this long.
LOCK_LEASE = timedelta(seconds=60)

#: A holder renews its lease when this many seconds have passed since it last did.
_RENEW_AFTER = 15.0


class UploadBusy(Exception):
    """Another request is appending to this upload right now."""


class LockLost(UploadBusy):
    """The lease on this upload lapsed and another request holds it now.

    A request that was stalled for longer than :data:`LOCK_LEASE` finds this
    out when it next renews; whatever it was about to write is left unwritten.
    """


class UploadBytesMissing(Exception):
    """The object store no longer holds the bytes this upload acknowledged.

    A part is gone, or the parts do not add up to the recorded offset. The
    upload cannot be finished or continued; the client starts a new one.
    """


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


class UploadLease(Base):
    """The lease that lets one request at a time append to (or finish, or reap) an upload.

    A table of its own rather than columns of ``uploads``: it is created whole
    by ``create_all`` wherever it is missing, so no existing database needs
    altering. A row exists only while someone holds the upload, or for at most
    :data:`LOCK_LEASE` after a holder died.
    """

    __tablename__ = "upload_leases"

    upload_id = Column(String(64), primary_key=True)
    #: Whoever holds the lease knows this; renewing and releasing need it.
    token = Column(String(64), nullable=False)
    #: Naive UTC, like every timestamp in this module.
    expires_at = Column(DateTime(timezone=True), nullable=False)


#: Columns added to ``uploads`` after it first shipped. Every one must be
#: nullable, since existing rows get NULL. Their DDL types come from the model
#: for whichever dialect runs (SQLite's ``DATETIME`` is not a PostgreSQL type).
_ADDED_COLUMNS = ("cid", "completed_at")


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
    for name in _ADDED_COLUMNS:
        if name in present:
            continue
        ddl_type = Upload.__table__.c[name].type.compile(dialect=bind.dialect)
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


# --------------------------------------------------------------------------- #
# The lease
# --------------------------------------------------------------------------- #


class UploadLock:
    """A held lease on one upload (see :func:`acquire_lock`); also a context manager.

    Blocking database I/O: call it from a worker thread.
    """

    def __init__(self, upload_id: str, token: str) -> None:
        self.upload_id = upload_id
        self._token = token
        self._renewed_at = time.monotonic()

    def due(self) -> bool:
        """Whether enough time has passed since the last renewal that :meth:`touch` would renew."""
        return time.monotonic() - self._renewed_at >= _RENEW_AFTER

    def renew(self) -> None:
        """Extend the lease by :data:`LOCK_LEASE`.

        Raises:
            LockLost: another request took the upload over after the lease lapsed.
        """
        with db.SessionLocal() as session:
            renewed = session.execute(
                update(UploadLease)
                .where(UploadLease.upload_id == self.upload_id, UploadLease.token == self._token)
                .values(expires_at=_utcnow() + LOCK_LEASE)
            ).rowcount
            session.commit()
        if renewed != 1:
            raise LockLost(self.upload_id)
        self._renewed_at = time.monotonic()

    def touch(self) -> None:
        """Renew the lease if it has been a while: cheap enough to call on every chunk."""
        if self.due():
            self.renew()

    def release(self) -> None:
        """Give the upload up; a no-op when the lease was lost, and it never takes anyone else's."""
        with db.SessionLocal() as session:
            session.execute(
                delete(UploadLease).where(UploadLease.upload_id == self.upload_id, UploadLease.token == self._token)
            )
            session.commit()

    def __enter__(self) -> "UploadLock":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()


def acquire_lock(upload_id: str) -> UploadLock:
    """Take the exclusive lease on ``upload_id``: what a ``PATCH``, the reaper and finishing an upload hold.

    The lease is one row in ``upload_leases``, inserted or taken over from an
    expired holder in a single statement each, so of any number of concurrent
    callers (in any number of processes) exactly one gets it. It is not waited
    for: a stalled client must not pin a worker thread. Holders keep it with
    :meth:`UploadLock.touch` while they work and :meth:`UploadLock.release` it
    when done.

    Raises:
        UploadBusy: someone holds the upload.
        ValueError: ``upload_id`` is not one of our ids.
    """
    _check_upload_id(upload_id)
    token = secrets.token_urlsafe(18)
    now = _utcnow()
    expires_at = now + LOCK_LEASE
    with db.SessionLocal() as session:
        took_over = session.execute(
            update(UploadLease)
            .where(UploadLease.upload_id == upload_id, UploadLease.expires_at < now)
            .values(token=token, expires_at=expires_at)
        ).rowcount
        if not took_over:
            session.add(UploadLease(upload_id=upload_id, token=token, expires_at=expires_at))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise UploadBusy(upload_id) from None
    return UploadLock(upload_id, token)


# --------------------------------------------------------------------------- #
# The parts
# --------------------------------------------------------------------------- #


def _object_store() -> ObjectStore:
    """The object store ``settings.STORAGE_BACKEND`` selects (read on every call)."""
    return get_object_store()


def _check_upload_id(upload_id: str) -> None:
    if not isinstance(upload_id, str) or not _UPLOAD_ID.fullmatch(upload_id):
        raise ValueError(f"not an upload id: {upload_id!r}")


def parts_prefix(upload_id: str) -> str:
    """The key prefix of every part of ``upload_id``: ``uploads/{id}/``.

    Raises:
        ValueError: if ``upload_id`` is not one of our ids, which is what keeps
            a client-supplied id from naming a key outside the uploads' own.
    """
    _check_upload_id(upload_id)
    return f"{PARTS_PREFIX}{upload_id}/"


def part_key(upload_id: str, start: int) -> str:
    """The key of the part of ``upload_id`` that starts at byte ``start``.

    Raises:
        ValueError: if ``upload_id`` is not one of our ids or ``start`` is not a valid offset.
    """
    if isinstance(start, bool) or not isinstance(start, int) or not 0 <= start < 10**19:
        raise ValueError(f"not a byte offset: {start!r}")
    return f"{parts_prefix(upload_id)}{start:019d}"


def part_starts(upload_id: str) -> list[int]:
    """The start offsets of the parts the object store holds for ``upload_id``, ascending.

    Whether they were acknowledged is the database's to say (see :func:`verify_parts`).
    """
    prefix = parts_prefix(upload_id)
    starts = []
    for key in _object_store().list(prefix):
        name = key[len(prefix):]
        if _PART_NAME.fullmatch(name):
            starts.append(int(name))
    return sorted(starts)


class _Keepalive:
    """A reader that ticks ``tick`` before every read: how a long write keeps the lease alive."""

    def __init__(self, source: SupportsRead, tick: Callable[[], None]) -> None:
        self._source = source
        self._tick = tick

    def read(self, size: int = -1, /) -> bytes:
        self._tick()
        return self._source.read(size)


def write_part(
    upload_id: str,
    start: int,
    stream: SupportsRead,
    *,
    keepalive: Optional[Callable[[], None]] = None,
) -> StoredObject:
    """Persist everything ``stream`` yields as the part of ``upload_id`` starting at byte ``start``.

    The part is stored whole or not at all, and replaces whatever part (an
    unacknowledged one a dead request left) already starts there. Call it
    *before* :func:`advance_offset`, never after, so the recorded offset never
    runs ahead of the bytes. ``keepalive`` is called before each read of
    ``stream``, so a slow store cannot let the caller's lease lapse.

    Raises:
        ObjectStoreError, OSError: the store could not take the bytes; nothing was stored.
    """
    source: SupportsRead = _Keepalive(stream, keepalive) if keepalive is not None else stream
    return _object_store().put_stream(part_key(upload_id, start), source)


def verify_parts(upload_id: str, offset: int) -> None:
    """Make the parts in the object store agree with the recorded ``offset``, before appending at it.

    Parts that start at or beyond ``offset`` hold bytes nobody acknowledged (the
    request that wrote them died before recording them) and are deleted. What is
    left must account for exactly ``offset`` bytes: it starts at byte 0 and the
    last part ends at ``offset``. The caller holds the upload's lease.

    An upload staged by an earlier release has no parts, only a file in
    ``CONTENT_DIR/.uploads``; its first ``offset`` bytes are moved into the
    object store as the first part here.

    Raises:
        UploadBytesMissing: acknowledged bytes are gone from the store.
    """
    objects = _object_store()
    starts = part_starts(upload_id)
    for start in starts:
        if start >= offset:
            objects.delete(part_key(upload_id, start))
    kept = [start for start in starts if start < offset]
    if offset == 0:
        return
    if not kept:
        if _adopt_legacy_staged(upload_id, offset):
            return
        raise UploadBytesMissing(f"upload {upload_id} has no stored bytes but acknowledged {offset}")
    last = kept[-1]
    try:
        end = last + objects.size(part_key(upload_id, last))
    except ObjectNotFoundError:
        raise UploadBytesMissing(f"upload {upload_id} lost its part at {last}") from None
    if kept[0] != 0 or end != offset:
        raise UploadBytesMissing(
            f"upload {upload_id} holds bytes {kept[0]}..{end} but acknowledged {offset}"
        )


class PartsReader:
    """The parts of an upload, in order, as one binary stream of exactly ``size`` bytes.

    What :mod:`.finalize` hands the content store, which hashes the bytes as it
    stores them, so a file of any size passes through in constant memory. Each
    part is opened as it is reached and closed once read. Parts that start at
    or beyond ``size`` were never acknowledged and are skipped.

    Reading raises :class:`UploadBytesMissing` the moment the parts stop adding
    up -- a part missing, a gap or an overlap between parts, or fewer or more
    than ``size`` bytes in all -- so a damaged upload is never stored under the
    hash of what happened to be left. ``keepalive`` is called before each read.
    Blocking I/O: call it from a worker thread.
    """

    def __init__(
        self, upload_id: str, size: int, *, keepalive: Optional[Callable[[], None]] = None
    ) -> None:
        self._upload_id = upload_id
        self._size = size
        self._keepalive = keepalive
        self._objects = _object_store()
        self._starts = [start for start in part_starts(upload_id) if start < size]
        self._next = 0
        self._position = 0
        self._current: Optional[BinaryIO] = None
        self._complete = False

    def read(self, size: int = -1, /) -> bytes:
        """Up to ``size`` bytes (``b""`` only at the end); all that is left when ``size`` is negative."""
        if size is None or size < 0:
            chunks = []
            while chunk := self.read(1024 * 1024):
                chunks.append(chunk)
            return b"".join(chunks)
        while not self._complete:
            if self._keepalive is not None:
                self._keepalive()
            if self._current is None and not self._open_next():
                self._finish()
                break
            assert self._current is not None
            data = self._current.read(size)
            if data:
                self._position += len(data)
                return data
            self._close_current()
        return b""

    def _open_next(self) -> bool:
        if self._next >= len(self._starts):
            return False
        start = self._starts[self._next]
        if start != self._position:
            raise UploadBytesMissing(
                f"upload {self._upload_id} has bytes up to {self._position} but its next part starts at {start}"
            )
        try:
            self._current = self._objects.open(part_key(self._upload_id, start))
        except ObjectNotFoundError:
            raise UploadBytesMissing(f"upload {self._upload_id} lost its part at {start}") from None
        self._next += 1
        return True

    def _finish(self) -> None:
        if self._position != self._size:
            raise UploadBytesMissing(
                f"upload {self._upload_id} holds {self._position} bytes but acknowledged {self._size}"
            )
        self._complete = True

    def _close_current(self) -> None:
        if self._current is not None:
            self._current.close()
            self._current = None

    def close(self) -> None:
        self._close_current()

    def __enter__(self) -> "PartsReader":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


def discard_parts(upload_id: str, *, best_effort: bool = True) -> int:
    """Delete every part of ``upload_id`` (and any file an earlier release staged for it); how many went.

    Every key under ``uploads/{id}/`` goes, whatever its name. Nothing there is
    wanted once the bytes are safe in the content store or the upload is
    abandoned, so by default a store that cannot delete them is logged, not
    raised: failing to free the space must not fail the request. The reaper
    asks for ``best_effort=False`` so it keeps the upload's row, and tries
    again on its next pass, rather than lose track of bytes it did not delete.

    Raises:
        ObjectStoreError, OSError: the store could not delete them (only when not ``best_effort``).
    """
    removed = 0
    try:
        objects = _object_store()
        for key in list(objects.list(parts_prefix(upload_id))):
            objects.delete(key)
            removed += 1
        removed += _discard_legacy_staged(upload_id)
    except (ObjectStoreError, OSError):
        if not best_effort:
            raise
        logger.warning("could not delete the staged parts of upload %s", upload_id, exc_info=True)
    return removed


def discard_staged(upload_id: str) -> None:
    """Delete every staged part of ``upload_id``, best effort: the name earlier releases gave :func:`discard_parts`."""
    discard_parts(upload_id)


def staged_upload_ids() -> list[str]:
    """The ids of every upload that has at least one part in the object store, in key order."""
    seen: dict[str, None] = {}
    for key in _object_store().list(PARTS_PREFIX):
        _, _, rest = key.partition("/")
        upload_id, slash, name = rest.partition("/")
        if slash and name and _UPLOAD_ID.fullmatch(upload_id):
            seen[upload_id] = None
    return list(seen)


# --------------------------------------------------------------------------- #
# Uploads staged by an earlier release
# --------------------------------------------------------------------------- #


def legacy_staging_dir() -> Optional[Path]:
    """``CONTENT_DIR/.uploads``, where earlier releases staged uploads in flight; ``None`` without a ``CONTENT_DIR``.

    Read on every call. Nothing creates it any more.
    """
    configured = settings.CONTENT_DIR
    if not configured or not configured.strip():
        return None
    return Path(configured) / STAGING_DIRNAME


def legacy_staged_path(upload_id: str) -> Optional[Path]:
    """Where an earlier release staged ``upload_id``'s bytes, if it was staged under that release.

    Raises:
        ValueError: if ``upload_id`` is not one of our ids.
    """
    _check_upload_id(upload_id)
    directory = legacy_staging_dir()
    return directory / upload_id if directory is not None else None


def _adopt_legacy_staged(upload_id: str, offset: int) -> bool:
    """Move the first ``offset`` bytes of an earlier release's staged file into the object store as part 0.

    Returns ``False`` when there is no such file or it holds fewer than
    ``offset`` bytes (acknowledged bytes are gone). Bytes the file holds past
    ``offset`` were never acknowledged and are dropped with it. The file goes
    only once the part is stored, so a crash in between repeats the move.
    """
    path = legacy_staged_path(upload_id)
    if path is None:
        return False
    try:
        handle = open(path, "rb")
    except OSError:
        return False
    with handle:
        if os.fstat(handle.fileno()).st_size < offset:
            return False
        _object_store().put_stream(part_key(upload_id, 0), RawStream(handle, limit=offset))  # type: ignore[arg-type]
    _discard_legacy_staged(upload_id)
    return True


def _discard_legacy_staged(upload_id: str) -> int:
    """Delete the file an earlier release staged for ``upload_id``, if any; ``1`` if it went."""
    path = legacy_staged_path(upload_id)
    if path is None:
        return 0
    try:
        path.unlink()
    except FileNotFoundError:
        return 0
    return 1
