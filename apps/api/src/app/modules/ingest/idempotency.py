"""``Idempotency-Key`` handling for ``POST /v1/records`` (plugin: ingest).

A client that is unsure whether a submission arrived (a timeout, a dropped
connection) retries it.  Without help the retry is a ``409`` -- the record is
already in the log -- which says nothing about the first attempt's outcome.
With an ``Idempotency-Key`` header the retry gets the first attempt's answer::

    POST /v1/records
    Idempotency-Key: 6f1c...          -> 201 {"id": "bafyrei...", ...}
    POST /v1/records
    Idempotency-Key: 6f1c...          -> 201 {"id": "bafyrei...", ...}   (replayed)
                                         Idempotent-Replayed: true

:func:`execute` is the whole protocol; the router calls it with the key, the
submitted record and a callable that runs the ingest pipeline.

Semantics:

* **Only a ``201`` is remembered.**  A refused submission (``401``, ``409``,
  ``422`` ...) stores nothing, so a client can correct the record and retry
  under the same key.
* **A replay does no work.**  The stored body is returned as it was first
  sent: the handler does not run again and nothing is appended.  The state the
  handler reported the first time is therefore the state a retry sees, even if
  the record has moved on since.
* **A key belongs to one record.**  A stored key whose record ``id`` differs
  from the submitted one is :class:`~.errors.IdempotencyKeyReused` (``422``)
  instead of a replay: answering ``201`` to a record that never reached the
  ledger would silently lose it.  The ``id`` is the cid of the record's
  content, so "the same record" is exactly "the same ``id``".
* **Simultaneous retries run once.**  Requests with the same key in one
  process are serialised, so the second sees the first's stored response.
  Across processes the ledger's UNIQUE cid is the arbiter: a request that loses
  that race gets :class:`~.errors.DuplicateRecord` from the pipeline and is
  answered from the winner's stored response when it is there by then.
* **The replay is authenticated like any other request.**  The route checks the
  caller's access token before this module is reached, so a stored response is
  never served to an anonymous caller.
* **Keys are not scoped to a caller and never expire.**  The table's shape
  (``key`` alone is the primary key) and the spec define neither.  Because a key
  is bound to a record ``id``, another caller can only get the response for a
  record they submitted themselves, which is public in the log anyway.

The record is appended to the ledger by its own transaction (see
:func:`app.modules.ledger.append`), so the key row is written just after it,
not atomically with it.  A crash in that gap leaves a record without a key; its
retry is then the ordinary ``409``.  A failure to write the row after the record
was appended is logged but does not fail the request, because the submission
did succeed and the client should be told so.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app import db

from .errors import DuplicateRecord, IdempotencyKeyReused, InvalidIdempotencyKey
from .models import IdempotencyKey, ensure_table

__all__ = [
    "HEADER",
    "MAX_KEY_LENGTH",
    "REPLAYED_HEADER",
    "execute",
    "lookup",
    "normalise_key",
    "store",
]

logger = logging.getLogger(__name__)

#: The request header carrying the key.
HEADER = "Idempotency-Key"

#: Response header set (to ``true``) on a replayed response.
REPLAYED_HEADER = "Idempotent-Replayed"

#: Longest key accepted.  The key is client-chosen text that becomes a primary
#: key, so it is bounded; 255 fits a UUID, a hash or a ULID with room to spare.
MAX_KEY_LENGTH = 255


def normalise_key(value: str) -> str:
    """Return the key to store for header value ``value``.

    Surrounding whitespace is not part of the key.  A blank key, or one longer
    than :data:`MAX_KEY_LENGTH`, raises :class:`InvalidIdempotencyKey` (422).
    """
    key = value.strip()
    if not key:
        raise InvalidIdempotencyKey(value, f"The {HEADER} header must not be blank.")
    if len(key) > MAX_KEY_LENGTH:
        raise InvalidIdempotencyKey(
            value, f"The {HEADER} header must be at most {MAX_KEY_LENGTH} characters long."
        )
    return key


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #


def lookup(key: str) -> Optional[Any]:
    """Return the response stored for ``key``, or ``None`` when it was never seen."""
    ensure_table()
    with db.SessionLocal() as session:
        row = session.get(IdempotencyKey, key)
        return None if row is None else row.response


def _insert(key: str, response: Mapping[str, Any]) -> None:
    ensure_table()
    with db.SessionLocal() as session:
        session.add(
            IdempotencyKey(
                key=key,
                response=dict(response),
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )
        session.commit()


def store(key: str, response: Mapping[str, Any]) -> bool:
    """Persist ``response`` under ``key``; return whether this call wrote the row.

    ``False`` means the key was already stored (another process won the race
    to store it) or the database refused the write; the first stored response
    is never overwritten.  A refused write is logged, not raised: by the time
    this runs the record is already in the ledger.
    """
    try:
        _insert(key, response)
    except IntegrityError:
        return False
    except SQLAlchemyError:
        logger.warning("could not store the response for an Idempotency-Key", exc_info=True)
        return False
    return True


# --------------------------------------------------------------------------- #
# Per-key serialisation
# --------------------------------------------------------------------------- #


class _KeyedLocks:
    """One lock per key in use; a key's lock is dropped once nobody holds or awaits it."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, list[Any]] = {}  # key -> [lock, holders and waiters]

    @contextmanager
    def hold(self, key: str) -> Iterator[None]:
        with self._guard:
            entry = self._locks.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self._guard:
                entry[1] -= 1
                if entry[1] == 0:
                    del self._locks[key]


_locks = _KeyedLocks()


# --------------------------------------------------------------------------- #
# The protocol
# --------------------------------------------------------------------------- #


def _replayable(key: str, stored: Any, record: Mapping[str, Any]) -> Any:
    """Return ``stored`` if it answers ``record``; refuse a key used for another record."""
    if not isinstance(stored, Mapping) or stored.get("id") != record.get("id"):
        raise IdempotencyKeyReused(key)
    return stored


def execute(
    key: str,
    record: Mapping[str, Any],
    run: Callable[[], dict[str, Any]],
) -> tuple[Any, bool]:
    """Answer ``record`` under idempotency key ``key``; return ``(response, replayed)``.

    ``key`` is a value from :func:`normalise_key`.  ``run`` runs the ingest
    pipeline for ``record`` and returns the JSON body of its ``201``; it is
    called at most once per key, and only when the key has no stored response.
    Whatever ``run`` raises propagates and stores nothing.  Raises
    :class:`~.errors.IdempotencyKeyReused` when ``key`` is already stored for a
    record with another ``id``.
    """
    with _locks.hold(key):
        stored = lookup(key)
        if stored is not None:
            return _replayable(key, stored, record), True
        try:
            response = run()
        except DuplicateRecord:
            # The cid reached the log first.  If that was a request with this
            # key, it has stored (or is about to store) the answer; if not,
            # the 409 is the honest outcome.
            stored = lookup(key)
            if stored is None:
                raise
            return _replayable(key, stored, record), True
        store(key, response)
        return response, False
