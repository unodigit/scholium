"""SQLAlchemy model for the follows plugin (feature 179).

``follows`` is the per-account set of categories a reader wants their
Following feed to cover::

    follows(did TEXT NOT NULL,
            category TEXT NOT NULL,
            PRIMARY KEY (did, category))

The pair is the primary key: following a category twice is the same fact, so
the database -- not only the handler's check -- makes ``PUT`` idempotent when
two requests race each other.

The model is declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
:func:`ensure_tables` covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["Follow", "ensure_table", "ensure_tables"]


class Follow(db.Base):
    """One category ``did`` follows."""

    __tablename__ = "follows"

    #: The followed account's ``did:`` identifier.
    did = Column(Text, primary_key=True, nullable=False)
    #: The category (``cs.AI``) the account follows.
    category = Column(Text, primary_key=True, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Follow did={self.did!r} category={self.category!r}>"


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their table on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create the plugin's table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        table = Follow.__table__
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
