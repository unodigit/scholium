"""SQLAlchemy models for the follows plugin (features 179 and 180).

``follows`` is the per-account set of categories a reader wants their
Following feed to cover::

    follows(did TEXT NOT NULL,
            category TEXT NOT NULL,
            PRIMARY KEY (did, category))

The pair is the primary key: following a category twice is the same fact, so
the database -- not only the handler's check -- makes ``PUT`` idempotent when
two requests race each other.

``saved_searches`` is the per-account set of searches a reader saved to re-run
later (feature 180; table shape from ``app_spec.xml``)::

    saved_searches(id TEXT PRIMARY KEY,
                   did TEXT NOT NULL,
                   query JSON NOT NULL)

Each ``POST /v1/me/saved-searches`` stores one row: a fresh ``id`` for the
save, the caller's ``did``, and the search's filters as one ``query`` JSON
object (the canonical form :func:`app.modules.follows.service.normalise_query`
produces).  Saving is additive: the same query saved twice is two rows, and
the reader deletes the copy they do not want.

Both models are declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers them in one pass.
:func:`ensure_tables` covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import JSON, Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["Follow", "SavedSearch", "ensure_table", "ensure_tables"]


class Follow(db.Base):
    """One category ``did`` follows."""

    __tablename__ = "follows"

    #: The followed account's ``did:`` identifier.
    did = Column(Text, primary_key=True, nullable=False)
    #: The category (``cs.AI``) the account follows.
    category = Column(Text, primary_key=True, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Follow did={self.did!r} category={self.category!r}>"


class SavedSearch(db.Base):
    """One search ``did`` saved to re-run later."""

    __tablename__ = "saved_searches"

    #: The save's own identifier (``ss_...``), returned by the route.
    id = Column(Text, primary_key=True, nullable=False)
    #: The reader who saved the search.
    did = Column(Text, nullable=False)
    #: The search's filters as one JSON object, e.g. ``{"q": "pulsar timing",
    #: "category": ["cs.CR"], "status": ["reviewed"], "has_code": true,
    #: "from": "2026-03-02", "to": "2026-04-01"}``.
    query = Column(JSON, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<SavedSearch id={self.id!r} did={self.did!r} query={self.query!r}>"


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their tables on first use.
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
        for table in (Follow.__table__, SavedSearch.__table__):
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
