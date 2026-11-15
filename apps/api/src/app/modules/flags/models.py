"""SQLAlchemy model for the ``flags`` table.

Table shape (``app_spec.xml``, ``database_schema/flags``)::

    flags(id TEXT PRIMARY KEY,
          target_cid TEXT NOT NULL,
          reporter_did TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL,
          decision_cid TEXT)

One row per user-submitted flag against a paper, post, review or version.
``id`` is the flag's own identifier (returned to the reporter and used as
``{id}`` in ``GET /v1/flags/{id}``); ``target_cid`` is the record id of the
flagged object; ``reporter_did`` the DID of the account that filed it;
``reason`` is the reason category; ``status`` tracks the flag's lifecycle
(``pending`` until a moderator acts on it); ``decision_cid`` links the
moderation decision that resolved it, when one exists.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["Flag", "ensure_table", "ensure_tables"]


class Flag(db.Base):
    """One user-submitted flag."""

    __tablename__ = "flags"

    id = Column(Text, primary_key=True)
    target_cid = Column(Text, nullable=False)
    reporter_did = Column(Text, nullable=False)
    reason = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="pending")
    decision_cid = Column(Text, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Flag id={self.id!r} target_cid={self.target_cid!r} "
            f"reporter_did={self.reporter_did!r} reason={self.reason!r} "
            f"status={self.status!r} decision_cid={self.decision_cid!r}>"
        )


_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``flags`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                Flag.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                if not inspect(db.engine).has_table(Flag.__tablename__):
                    raise
            _table_engine = db.engine
ensure_tables = ensure_table
