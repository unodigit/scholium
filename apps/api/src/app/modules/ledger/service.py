"""Appending accepted records to the event log and notifying subscribers.

The ledger is the node's source of truth.  Every accepted record is appended
exactly once, in arrival order, and the row commits to its predecessor::

    from app.modules import ledger

    entry = ledger.append(envelope)          # envelope is the signed record
    entry.seq, entry.record_cid, entry.entry_hash

Modules that want to react to records subscribe by type::

    @ledger.subscribe("review.formal")
    def on_formal_review(entry):
        ...

    # or: ledger.subscribe("review.formal", on_formal_review)

Subscribers run in-process, synchronously, after the row has been committed.
A subscriber that raises is logged and skipped: one broken consumer never
rolls back a log entry or blocks the others.  ``"*"`` subscribes to every
record type.  Subscribing the same function twice to the same type is a
no-op, so re-importing a module is harmless.

What is persisted (``event_log``): ``seq`` (assigned by the database),
``record_cid``, ``record_type``, ``author_did``, ``body``, ``raw`` (the
canonical DAG-CBOR bytes the record id was computed over), ``sig`` (the
author's signature over those bytes, so an export can carry the signed
record), ``prev_hash``,
``entry_hash = sha256(prev_hash || record_cid || raw)``, ``received_at`` and
``origin_node``.  See :mod:`app.modules.ledger.hashing` for the chain rule and
:mod:`app.modules.ledger.origin` for how the node's DID is resolved.

``append`` trusts that the caller has already validated the record (the ingest
pipeline recomputes the CID before it appends).  Use the envelope's ``id`` as
the record CID when present; otherwise the CID is computed from the canonical
envelope.  Duplicate CIDs violate the table's UNIQUE constraint and raise
``sqlalchemy.exc.IntegrityError``.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any, Optional

from scholium_record_core import compute_record_id, record_bytes
from sqlalchemy import select, text

from app import db

from .hashing import GENESIS_PREV_HASH, compute_entry_hash
from .models import EventLog, ensure_table
from .origin import node_did

__all__ = [
    "RecordSubscriber",
    "WILDCARD",
    "append",
    "append_entry",
    "append_record",
    "clear_subscribers",
    "entries",
    "entry_by_cid",
    "latest",
    "subscribe",
    "subscribed_types",
    "subscriber_count",
    "unsubscribe",
]

logger = logging.getLogger(__name__)

#: ``record_type`` that subscribes to every appended record.
WILDCARD = "*"

RecordSubscriber = Callable[[EventLog], Any]

# Appending is serialised inside the process so that reading the previous hash
# and inserting the new row is one step.  RLock because a subscriber may itself
# append (e.g. a derived record), and notification happens after the lock is
# released, so this is belt and braces.
_append_lock = threading.RLock()

#: Transaction-level advisory lock key that serialises appends on PostgreSQL.
#: Fixed constant so every process sharing a database agrees on it.
_APPEND_LOCK_ID = 8_173_920_441_772_109

_subscribers: dict[str, list[RecordSubscriber]] = {}
_subscribers_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# Envelope handling
# --------------------------------------------------------------------------- #


def _utcnow() -> datetime:
    """Naive UTC "now": SQLite stores naive timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _normalise_envelope(envelope: Mapping[str, Any]) -> tuple[str, str, dict, str, bytes, Optional[str]]:
    """Return ``(record_type, author_did, body, record_cid, raw, sig)``.

    ``raw`` is the canonical DAG-CBOR encoding of the seven id-relevant
    envelope fields -- the bytes the record id commits to.  ``sig`` is the
    author's detached signature over those bytes when the envelope carries
    one; keeping it lets an export hand an offline verifier the signed record.
    Validation of the envelope's shape is delegated to
    :mod:`scholium_record_core`.
    """
    if not isinstance(envelope, Mapping):
        raise TypeError(f"a record envelope must be a mapping, got {type(envelope).__name__}")

    raw = record_bytes(envelope)
    record_type = envelope["type"]
    author_did = envelope["author"]
    body = envelope["body"]
    sig = envelope.get("sig")
    if sig is not None and not isinstance(sig, str):
        raise ValueError("envelope field 'sig' must be a string when present")

    record_cid = envelope.get("id")
    if record_cid is None:
        record_cid = compute_record_id(envelope)
    elif not isinstance(record_cid, str) or not record_cid:
        raise ValueError("envelope field 'id' must be a non-empty string when present")

    return record_type, author_did, dict(body), record_cid, raw, sig


def _chain_head(session: Any) -> tuple[int, bytes]:
    """``(seq, entry_hash)`` of the current last row; ``(0, genesis hash)`` when empty."""
    head = session.execute(
        select(EventLog.seq, EventLog.entry_hash).order_by(EventLog.seq.desc()).limit(1)
    ).first()
    if head is None:
        return 0, GENESIS_PREV_HASH
    return int(head.seq), bytes(head.entry_hash)


def _assigns_seq_explicitly(session: Any) -> bool:
    """Whether ``append`` must hand the database the ``seq`` it is to store.

    The log's ``seq`` is consecutive: ``verify_log`` reads a hole as a removed
    row, and ``GET /v1/sync/range`` serves the numbers as they are.  SQLite's
    ``AUTOINCREMENT`` takes its next value inside the insert's own
    transaction, so a failed or abandoned append leaves no trace.  A
    PostgreSQL identity column does not: ``nextval`` is not transactional, so
    an append that fails after drawing a value (a duplicate ``record_cid``, a
    dropped connection) would leave a hole in the log for ever.  On PostgreSQL
    the number is therefore the head plus one, read and written under the
    append lock, so it is consumed only by the commit that stores it.
    """
    return session.get_bind().dialect.name == "postgresql"


def _begin_write_transaction(session: Any) -> None:
    """Take the database's write lock before reading the chain head.

    On SQLite, pysqlite does not open a transaction for a plain ``SELECT``, so
    two processes appending at once could both read the same predecessor and
    fork the chain.  ``BEGIN IMMEDIATE`` acquires the write lock up front and
    serialises appends across processes (pytest-xdist workers share a database
    file, and so do multiple server processes with SQLite).  Other dialects
    rely on their own isolation level.
    """
    dialect = session.get_bind().dialect.name
    if dialect == "sqlite":
        session.execute(text("BEGIN IMMEDIATE"))
    elif dialect == "postgresql":
        session.execute(
            text("SELECT pg_advisory_xact_lock(:key)"), {"key": _APPEND_LOCK_ID}
        )


# --------------------------------------------------------------------------- #
# Appending
# --------------------------------------------------------------------------- #


def append(
    envelope: Mapping[str, Any],
    *,
    origin_node: Optional[str] = None,
    received_at: Optional[datetime] = None,
) -> EventLog:
    """Append one accepted record to the event log.

    ``envelope`` is the signed record.  ``origin_node`` defaults to
    :func:`~app.modules.ledger.origin.node_did`, and ``received_at`` to the
    current UTC time.  Returns the persisted :class:`EventLog` row (also
    usable as a read-only mapping) after subscribers have been notified.

    Raises ``ValueError``/``TypeError`` when the envelope is not a valid
    record, and ``sqlalchemy.exc.IntegrityError`` when its CID is already in
    the log.
    """
    record_type, author_did, body, record_cid, raw, sig = _normalise_envelope(envelope)
    when = received_at if received_at is not None else _utcnow()
    if when.tzinfo is not None:
        when = when.astimezone(timezone.utc).replace(tzinfo=None)
    origin = origin_node if origin_node is not None else node_did()

    ensure_table()

    with _append_lock:
        session = db.SessionLocal()
        # Keep the row's values readable after commit/close: callers and
        # subscribers routinely use the returned entry outside this function.
        session.expire_on_commit = False
        try:
            _begin_write_transaction(session)
            head_seq, prev_hash = _chain_head(session)
            entry = EventLog(
                seq=head_seq + 1 if _assigns_seq_explicitly(session) else None,
                record_cid=record_cid,
                record_type=record_type,
                author_did=author_did,
                body=body,
                raw=raw,
                sig=sig,
                prev_hash=prev_hash,
                entry_hash=compute_entry_hash(prev_hash, record_cid, raw),
                received_at=when,
                origin_node=origin,
            )
            session.add(entry)
            session.commit()
            seq = entry.seq
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    logger.debug("appended %s seq=%s cid=%s", record_type, seq, record_cid)
    _notify(entry)
    return entry


#: Alias for :func:`append`.
append_record = append
append_entry = append


# --------------------------------------------------------------------------- #
# Subscriptions
# --------------------------------------------------------------------------- #


def _check_record_type(record_type: object) -> str:
    if not isinstance(record_type, str) or not record_type.strip():
        raise ValueError(f"record type must be a non-empty string, got {record_type!r}")
    return record_type


def subscribe(record_type: str, fn: Optional[RecordSubscriber] = None) -> Any:
    """Register ``fn`` to be called with every appended record of ``record_type``.

    Works as ``subscribe(record_type, fn)`` (returning ``fn``) or as a
    decorator, ``@subscribe(record_type)``.  ``"*"`` subscribes to every type.
    Registering the same function twice for the same type is a no-op.

    Raises ``ValueError`` for an empty record type and ``TypeError`` when the
    subscriber is not callable.
    """
    key = _check_record_type(record_type)

    def _add(callback: RecordSubscriber) -> RecordSubscriber:
        if not callable(callback):
            raise TypeError(f"a ledger subscriber must be callable, got {type(callback).__name__}")
        with _subscribers_lock:
            bucket = _subscribers.setdefault(key, [])
            if callback not in bucket:
                bucket.append(callback)
        return callback

    return _add if fn is None else _add(fn)


def unsubscribe(record_type: str, fn: Optional[RecordSubscriber] = None) -> None:
    """Remove ``fn`` (or every subscriber when ``fn`` is ``None``) for a type."""
    with _subscribers_lock:
        if fn is None:
            _subscribers.pop(record_type, None)
            return
        bucket = _subscribers.get(record_type)
        if bucket is None:
            return
        # Compare with ``!=`` rather than ``is not`` so a bound method
        # (``obj.on_record``) can be removed even though each attribute access
        # creates a fresh object.
        _subscribers[record_type] = [callback for callback in bucket if callback != fn]
        if not _subscribers[record_type]:
            del _subscribers[record_type]


def clear_subscribers() -> None:
    """Remove every subscriber.  Intended for tests and process teardown."""
    with _subscribers_lock:
        _subscribers.clear()


def subscriber_count(record_type: str) -> int:
    """How many subscribers are registered for ``record_type`` (exact match)."""
    with _subscribers_lock:
        return len(_subscribers.get(record_type, ()))


def subscribed_types() -> list[str]:
    """The record types that have at least one subscriber, sorted."""
    with _subscribers_lock:
        return sorted(key for key, bucket in _subscribers.items() if bucket)


def _notify(entry: EventLog) -> None:
    with _subscribers_lock:
        callbacks = list(_subscribers.get(entry.record_type, ()))
        callbacks += list(_subscribers.get(WILDCARD, ()))

    for callback in callbacks:
        try:
            callback(entry)
        except Exception:
            logger.exception(
                "ledger subscriber %r failed for %s seq=%s",
                callback,
                entry.record_type,
                entry.seq,
            )


# --------------------------------------------------------------------------- #
# Reading (used by the sync endpoints and by tests)
# --------------------------------------------------------------------------- #


def latest() -> Optional[EventLog]:
    """Return the most recently appended entry, or ``None`` for an empty log."""
    ensure_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        entry = session.execute(
            select(EventLog).order_by(EventLog.seq.desc()).limit(1)
        ).scalar_one_or_none()
        if entry is not None:
            session.expunge(entry)
        return entry


def entry_by_cid(record_cid: str) -> Optional[EventLog]:
    """Return the entry for ``record_cid``, or ``None`` when it is unknown."""
    ensure_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        entry = session.execute(
            select(EventLog).where(EventLog.record_cid == record_cid)
        ).scalar_one_or_none()
        if entry is not None:
            session.expunge(entry)
        return entry


def entries(
    *,
    after: Optional[int] = None,
    through: Optional[int] = None,
    limit: Optional[int] = None,
) -> list[EventLog]:
    """Return log entries in ``seq`` order, optionally bounded by ``seq``.

    ``after`` is exclusive and ``through`` inclusive, matching the sync
    range's ``from``/``to`` semantics.
    """
    ensure_table()
    statement = select(EventLog).order_by(EventLog.seq)
    # ``seq`` is a 32-bit column on PostgreSQL: a bound the type cannot hold
    # (the sync endpoint passes whatever integer the caller sent) selects the
    # whole log or none of it, as it does on SQLite.
    if after is not None:
        statement = statement.where(EventLog.seq > db.clamp_int32(after))
    if through is not None:
        statement = statement.where(EventLog.seq <= db.clamp_int32(through))
    if limit is not None:
        statement = statement.limit(limit)
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        rows = list(session.execute(statement).scalars())
        for row in rows:
            session.expunge(row)
        return rows
