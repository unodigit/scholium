"""SQLAlchemy models for the moderation plugin.

``moderation_decisions`` (``app_spec.xml``, ``database_schema/moderation_decisions``)::

    moderation_decisions(decision_cid TEXT PRIMARY KEY,
                         target_cid TEXT NOT NULL,
                         action TEXT NOT NULL,
                         clause TEXT NOT NULL,
                         moderator_did TEXT NOT NULL,
                         decided_at TIMESTAMP NOT NULL)

One row per accepted ``moderation.decision`` record.  ``decision_cid`` is the
record's content id, so replaying the same record can never add a second row.
``target_cid`` is the version the decision is about, ``action`` one of
``list``/``hold``/``reclassify``/``reject``/``delist``, ``clause`` the id of the
policy clause it cites and ``moderator_did`` the DID that signed it.
``decided_at`` is the instant the *record* is dated (``created``, in UTC), not
the instant this node received it, so the table is a pure projection of the
signed records and rebuilding it from the ledger yields the same rows.  The
reason stays in the record, which the ledger serves by ``decision_cid``.

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
    "ModerationDecision",
    "ensure_table",
    "ensure_tables",
]


class ModerationDecision(db.Base):
    """One accepted ``moderation.decision`` record."""

    __tablename__ = "moderation_decisions"

    decision_cid = Column(Text, primary_key=True)
    target_cid = Column(Text, nullable=False)
    action = Column(Text, nullable=False)
    clause = Column(Text, nullable=False)
    moderator_did = Column(Text, nullable=False)
    decided_at = Column(DateTime, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ModerationDecision decision_cid={self.decision_cid!r} "
            f"target_cid={self.target_cid!r} action={self.action!r} "
            f"clause={self.clause!r}>"
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
        for table in (ModerationDecision.__table__,):
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
