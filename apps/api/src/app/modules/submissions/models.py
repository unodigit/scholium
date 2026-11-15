"""SQLAlchemy model for the ``papers`` table (plugin: submissions).

Table (``app_spec.xml``, ``database_schema/papers``)::

    papers(paper_cid TEXT PRIMARY KEY,
           short_id TEXT NOT NULL UNIQUE,
           categories JSON NOT NULL,
           licence TEXT NOT NULL,
           status TEXT NOT NULL,
           latest_version_cid TEXT,
           listed_at TIMESTAMP,
           claimed BOOLEAN DEFAULT TRUE)

One row per paper.  ``paper_cid`` is the cid of the paper's ``paper.genesis``
record, so the row is keyed by the signed record that created it and replaying
that record can never create a second paper.  ``short_id`` is the ``sch:`` id
derived from that cid.  ``latest_version_cid`` and ``listed_at`` stay NULL until
a version of the paper is accepted and listed; ``claimed`` is false only for a
paper imported on its authors' behalf and not yet claimed by one of them.

The model is declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.  :func:`ensure_tables`
covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import JSON, Boolean, Column, DateTime, Text, inspect, true
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "DEFAULT_LICENCE",
    "INITIAL_STATUS",
    "Paper",
    "ensure_tables",
]

#: The licence a paper is stored under when its genesis names none: CC BY 4.0,
#: spelled the way the signed records and the submit UI spell it (SPDX-style).
DEFAULT_LICENCE = "CC-BY-4.0"

#: The status of a paper nothing has happened to yet.  It is the status the
#: ``status`` plugin computes for a paper with no review, notice or moderation
#: record, so a freshly accepted genesis already agrees with a recompute.
INITIAL_STATUS = "preprint"


class Paper(db.Base):
    """One paper, created by its accepted ``paper.genesis`` record."""

    __tablename__ = "papers"

    paper_cid = Column(Text, primary_key=True)
    short_id = Column(Text, nullable=False, unique=True)
    categories = Column(JSON, nullable=False)
    licence = Column(
        Text, nullable=False, default=DEFAULT_LICENCE, server_default=DEFAULT_LICENCE
    )
    status = Column(Text, nullable=False, default=INITIAL_STATUS)
    latest_version_cid = Column(Text, nullable=True)
    listed_at = Column(DateTime, nullable=True)
    claimed = Column(Boolean, nullable=False, default=True, server_default=true())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Paper paper_cid={self.paper_cid!r} short_id={self.short_id!r} "
            f"status={self.status!r}>"
        )


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their table on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create the ``papers`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        try:
            Paper.__table__.create(bind=db.engine, checkfirst=True)
        except (OperationalError, ProgrammingError):
            # ``checkfirst`` is not atomic: another process (e.g. a second
            # pytest-xdist worker) may have created the table in between.
            if not inspect(db.engine).has_table(Paper.__tablename__):
                raise
        _table_engine = db.engine
