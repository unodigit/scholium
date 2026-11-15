"""SQLAlchemy model for user notifications.

Table shape (see ``app_spec.xml``)::

    notifications(id INTEGER PRIMARY KEY,
                  did TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  payload JSON NOT NULL,
                  read BOOLEAN DEFAULT FALSE)

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Boolean, Column, Integer, JSON, Text, false, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db


class Notification(db.Base):
    """One notification addressed to a DID."""

    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True)
    did = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)
    payload = Column(JSON, nullable=False)
    read = Column(Boolean, nullable=False, default=False, server_default=false())


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  ``notify`` may also be called from
# tests/scripts that never build the app, so make sure the table exists before
# the first write (the same self-healing pattern as ``app.jobs``).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``notifications`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                Notification.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(Notification.__tablename__):
                    raise
            _table_engine = db.engine
