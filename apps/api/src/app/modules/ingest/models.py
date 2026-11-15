"""SQLAlchemy model for stored idempotent responses (plugin: ingest).

Table shape (``app_spec.xml``, ``database_schema/idempotency_keys``)::

    idempotency_keys(key TEXT PRIMARY KEY,
                     response JSON NOT NULL,
                     created_at TIMESTAMP NOT NULL)

``key`` is the client's ``Idempotency-Key`` header value, ``response`` is the
JSON body of the ``201`` that ``POST /v1/records`` answered the first time it
saw that key, and ``created_at`` is when the row was written (naive UTC, like
the event log's ``received_at``).

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.  :func:`ensure_table`
covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, DateTime, JSON, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["IdempotencyKey", "ensure_table"]


class IdempotencyKey(db.Base):
    """One ``Idempotency-Key`` and the response it was answered with."""

    __tablename__ = "idempotency_keys"

    key = Column(Text, primary_key=True)
    response = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False)


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  The ingest service may also be called
# from tests/scripts that never build the app, so make sure the table exists
# before the first read or write (the same self-healing pattern as the ledger).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``idempotency_keys`` table if it is missing."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                IdempotencyKey.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(IdempotencyKey.__tablename__):
                    raise
            _table_engine = db.engine
