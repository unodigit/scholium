"""SQLAlchemy model for the append-only event log.

Table shape (``app_spec.xml``, ``database_schema/event_log``)::

    event_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,
              record_cid TEXT NOT NULL UNIQUE,
              record_type TEXT NOT NULL,
              author_did TEXT NOT NULL,
              body JSON NOT NULL,
              raw BLOB NOT NULL,
              prev_hash BLOB NOT NULL,
              entry_hash BLOB NOT NULL,
              received_at TIMESTAMP NOT NULL,
              origin_node TEXT NOT NULL)

``raw`` holds the canonical DAG-CBOR bytes of the record (the bytes the
record id is computed over); ``prev_hash`` and ``entry_hash`` are 32-byte
SHA-256 digests.  Rows are never updated or deleted -- a later feature adds
database triggers that enforce that.

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.

For convenience a row also behaves like a read-only mapping, so subscribers
and callers can use either ``entry.body`` or ``entry["body"]``.
"""

from __future__ import annotations

import threading
from typing import Any, Iterator, Optional

from sqlalchemy import Column, DateTime, Integer, JSON, LargeBinary, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["EventLog", "LedgerEntry", "ensure_table"]


class EventLog(db.Base):
    """One accepted record appended to the node's event log."""

    __tablename__ = "event_log"
    # Match the spec's ``seq INTEGER PRIMARY KEY AUTOINCREMENT``: SQLite then
    # never reuses a rowid, so a deleted-and-recreated log entry could not
    # impersonate an earlier ``seq``.
    __table_args__ = {"sqlite_autoincrement": True}

    seq = Column(Integer, primary_key=True, autoincrement=True)
    record_cid = Column(Text, nullable=False, unique=True)
    record_type = Column(Text, nullable=False, index=True)
    author_did = Column(Text, nullable=False)
    body = Column(JSON, nullable=False)
    raw = Column(LargeBinary, nullable=False)
    prev_hash = Column(LargeBinary, nullable=False)
    entry_hash = Column(LargeBinary, nullable=False)
    received_at = Column(DateTime, nullable=False)
    origin_node = Column(Text, nullable=False)

    #: Column names in table order, also the keys of the mapping view.
    COLUMN_NAMES = (
        "seq",
        "record_cid",
        "record_type",
        "author_did",
        "body",
        "raw",
        "prev_hash",
        "entry_hash",
        "received_at",
        "origin_node",
    )

    # -- read-only mapping view ------------------------------------------- #

    def to_dict(self) -> dict[str, Any]:
        """Return the row as a plain ``dict`` keyed by column name."""
        return {name: getattr(self, name) for name in self.COLUMN_NAMES}

    def __getitem__(self, key: str) -> Any:
        if key not in self.COLUMN_NAMES:
            raise KeyError(key)
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        if key not in self.COLUMN_NAMES:
            return default
        return getattr(self, key)

    def keys(self) -> list[str]:
        return list(self.COLUMN_NAMES)

    def values(self) -> list[Any]:
        return [getattr(self, name) for name in self.COLUMN_NAMES]

    def items(self) -> list[tuple[str, Any]]:
        return [(name, getattr(self, name)) for name in self.COLUMN_NAMES]

    def __iter__(self) -> Iterator[str]:
        return iter(self.COLUMN_NAMES)

    def __contains__(self, key: object) -> bool:
        return key in self.COLUMN_NAMES

    # -- conveniences ------------------------------------------------------ #

    @property
    def entry_hash_hex(self) -> str:
        """``entry_hash`` as lowercase hexadecimal."""
        return bytes(self.entry_hash).hex()

    @property
    def prev_hash_hex(self) -> str:
        """``prev_hash`` as lowercase hexadecimal."""
        return bytes(self.prev_hash).hex()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<EventLog seq={self.seq} type={self.record_type!r} "
            f"cid={self.record_cid!r}>"
        )


#: Alias: a persisted log entry.
LedgerEntry = EventLog


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  ``append`` may also be called from
# tests/scripts that never build the app, so make sure the table exists before
# the first append (the same self-healing pattern as ``app.jobs`` and the
# notifications module).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``event_log`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                EventLog.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(EventLog.__tablename__):
                    raise
            _table_engine = db.engine
