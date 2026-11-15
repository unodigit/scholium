"""SQLAlchemy models for the endorsements plugin.

Table (``app_spec.xml``, ``database_schema``)::

    endorsements(record_cid TEXT PRIMARY KEY,
                 endorser_did TEXT NOT NULL,
                 endorsee_did TEXT NOT NULL,
                 category TEXT NOT NULL,
                 expires_at TIMESTAMP)

One row per accepted ``endorsement`` record.  ``record_cid`` is the record's
content id, so the row is keyed by the signed record that produced it and a
replay of the same record can never apply twice.  ``expires_at`` is NULL when
the endorsement carries no expiry.

The model is declared on the application's shared declarative base so
``main.create_app`` creates the table after the module loader has imported
this package.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, DateTime, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["Endorsement", "ensure_tables"]


class Endorsement(db.Base):
    """One tier-3 endorsement of a DID for a category."""

    __tablename__ = "endorsements"

    record_cid = Column(Text, primary_key=True)
    endorser_did = Column(Text, nullable=False)
    endorsee_did = Column(Text, nullable=False)
    category = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Endorsement record_cid={self.record_cid!r} "
            f"endorser_did={self.endorser_did!r} "
            f"endorsee_did={self.endorsee_did!r} "
            f"category={self.category!r}>"
        )


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their table on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create the ``endorsements`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        try:
            Endorsement.__table__.create(bind=db.engine, checkfirst=True)
        except (OperationalError, ProgrammingError):
            # ``checkfirst`` is not atomic: another process (e.g. a second
            # pytest-xdist worker) may have created the table in between.
            if not inspect(db.engine).has_table(Endorsement.__tablename__):
                raise
        _table_engine = db.engine
