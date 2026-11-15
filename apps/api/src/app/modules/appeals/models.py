"""SQLAlchemy model for the appeals plugin.

``appeals`` (the saved projection of ``appeal`` records)::

    appeals(appeal_cid TEXT PRIMARY KEY,
            decision_cid TEXT NOT NULL UNIQUE,
            appellant_did TEXT NOT NULL,
            grounds TEXT NOT NULL,
            status TEXT NOT NULL,
            filed_at TIMESTAMP NOT NULL)

One row per accepted ``appeal`` record.  ``appeal_cid`` is the record's content
id -- the key the panel (``appeal_panels.appeal_cid``) and the panel's
``appeal.decision`` point at -- so replaying the same record can never add a
second row.  ``decision_cid`` is the ``moderation.decision`` being appealed and
carries a UNIQUE constraint: **a decision can be appealed once**, and the
database, not only the handler's check, is what makes that true when two
appeals race each other.

``appellant_did`` is the DID that signed the appeal, ``grounds`` the reason
the record gives, and ``status`` where the appeal stands (``pending`` until a
panel decides it).  ``filed_at`` is the instant the *record* is dated
(``created``, in UTC), not the instant this node received it, so the table is a
pure projection of the signed records.

The model is declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
:func:`ensure_tables` covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, DateTime, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "Appeal",
    "ensure_table",
    "ensure_tables",
]


class Appeal(db.Base):
    """One accepted ``appeal`` record."""

    __tablename__ = "appeals"

    appeal_cid = Column(Text, primary_key=True)
    decision_cid = Column(Text, nullable=False, unique=True)
    appellant_did = Column(Text, nullable=False)
    grounds = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="pending")
    filed_at = Column(DateTime, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Appeal appeal_cid={self.appeal_cid!r} decision_cid={self.decision_cid!r} "
            f"appellant_did={self.appellant_did!r} status={self.status!r}>"
        )


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their table on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create the plugin's tables if they do not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        for table in (Appeal.__table__,):
            try:
                table.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table in between.
                if not inspect(db.engine).has_table(table.name):
                    raise
        _table_engine = db.engine


#: Alias matching sibling plugins that expose a singular ``ensure_table``.
ensure_table = ensure_tables
