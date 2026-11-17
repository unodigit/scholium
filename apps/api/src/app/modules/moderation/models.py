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
``target_cid`` is what the decision is about (a version; for a ``tombstone`` also
a paper or a file), ``action`` one of
``list``/``hold``/``reclassify``/``reject``/``delist``/``tombstone``, ``clause``
the id of the policy clause it cites and ``moderator_did`` the DID that signed it.
``decided_at`` is the instant the *record* is dated (``created``, in UTC), not
the instant this node received it, so the table is a pure projection of the
signed records and rebuilding it from the ledger yields the same rows.  The
reason stays in the record, which the ledger serves by ``decision_cid``.

``denylist`` (``app_spec.xml``, ``database_schema/denylist``)::

    denylist(cid TEXT PRIMARY KEY,
             decision_cid TEXT NOT NULL)

One row per tombstoned cid: ``cid`` is the content id whose bytes moderation
removed and ``decision_cid`` the ``moderation.decision`` (``action:
tombstone``) that removed it.  The content plugin reads this table *by name*
(``content.is_tombstoned``) to answer ``451`` and to refuse to serve, run or
export the bytes, so the column names here are a contract with it.  A row is
never updated or deleted by this plugin: the first decision to tombstone a cid
stays the one on record.

``moderation_hidden`` (see :mod:`app.modules.moderation.hides`)::

    moderation_hidden(cid TEXT PRIMARY KEY,
                      decision_cid TEXT NOT NULL)

One row per record a ``hide`` decision withdrew from public reads (a discussion
post, an annotation or a revealed review).  Like ``denylist`` it is a
projection of the signed ``moderation.decision`` records: the envelope and its
log entry stay, only the public *read* of the record's body is withheld.  A
``release`` decision (what an overturned appeal appends) removes the row.

The models are declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers them in one pass.
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
    "Denylist",
    "ModerationDecision",
    "ModerationHidden",
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


class Denylist(db.Base):
    """A cid moderation tombstoned, and the decision that did it."""

    __tablename__ = "denylist"

    cid = Column(Text, primary_key=True)
    decision_cid = Column(Text, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Denylist cid={self.cid!r} decision_cid={self.decision_cid!r}>"


class ModerationHidden(db.Base):
    """A record moderation hid from public reads, and the decision that did it."""

    __tablename__ = "moderation_hidden"

    cid = Column(Text, primary_key=True)
    decision_cid = Column(Text, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<ModerationHidden cid={self.cid!r} decision_cid={self.decision_cid!r}>"


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
        for table in (ModerationDecision.__table__, Denylist.__table__, ModerationHidden.__table__):
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
