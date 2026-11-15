"""SQLAlchemy model for the ``version_texts`` table.

Table shape (``app_spec.xml``, ``database_schema/version_texts``)::

    version_texts(version_cid TEXT NOT NULL,
                  paragraph_id TEXT NOT NULL,
                  position INTEGER NOT NULL,
                  text TEXT NOT NULL)

One row per paragraph of a version's text.  ``paragraph_id`` is the sha256 of
the normalized paragraph text (see :mod:`app.modules.checks.paragraphs`), so it
is *not* unique within a version -- a paragraph the author repeats ("Table 1.")
occurs twice with one id.  The row's identity is therefore ``(version_cid,
position)``, which is also what keeps a version's paragraphs in reading order
and lets a version's rows be read with a single index range scan.

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Integer, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["VersionText", "ensure_table"]


class VersionText(db.Base):
    """One paragraph of the extracted text of a version."""

    __tablename__ = "version_texts"

    version_cid = Column(Text, primary_key=True)
    paragraph_id = Column(Text, nullable=False)
    # 0-based index of the paragraph in reading order.
    position = Column(Integer, primary_key=True, autoincrement=False)
    text = Column(Text, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<VersionText version_cid={self.version_cid!r} "
            f"position={self.position} paragraph_id={self.paragraph_id!r}>"
        )


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  The service may also be used from
# tests/scripts that never build the app, so make sure the table exists before
# the first use (the same self-healing pattern as the content, ledger and
# notifications modules).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``version_texts`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                VersionText.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(VersionText.__tablename__):
                    raise
            _table_engine = db.engine
