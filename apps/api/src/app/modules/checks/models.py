"""SQLAlchemy models for the checks plugin's tables.

``version_texts``
    the extracted text of a version, one row per paragraph.

``check_results``
    the version's automated check verdicts, one row per version::

        check_results(version_cid TEXT PRIMARY KEY,
                      similarity_pct REAL,
                      references_total INTEGER,
                      references_unresolved INTEGER,
                      metadata_match BOOLEAN)

    Every column except the key is nullable: checks run independently and a
    row fills in as each one completes, so a similarity check never has to
    wait for the reference or metadata checks to write theirs.

The ``version_texts`` table shape (``app_spec.xml``,
``database_schema/version_texts``)::

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

from sqlalchemy import Boolean, Column, Float, Integer, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "CheckResult",
    "VersionText",
    "ensure_check_results_table",
    "ensure_table",
]


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


class CheckResult(db.Base):
    """A version's automated check verdicts, one row per version.

    ``metadata_match`` is feature 68's verdict: whether the version's signed
    title appears in the first page text.  The other columns belong to the
    similarity and reference checks; keeping them on one row lets the
    moderation queue read a version's checks with a single lookup, and lets
    each check write its own column without overwriting the others.
    """

    __tablename__ = "check_results"

    version_cid = Column(Text, primary_key=True)
    similarity_pct = Column(Float, nullable=True)
    references_total = Column(Integer, nullable=True)
    references_unresolved = Column(Integer, nullable=True)
    metadata_match = Column(Boolean, nullable=True)

    #: Column names in table order, also the keys of the mapping view.
    COLUMN_NAMES = (
        "version_cid",
        "similarity_pct",
        "references_total",
        "references_unresolved",
        "metadata_match",
    )

    def to_dict(self) -> dict[str, object]:
        """Return the row as a plain ``dict`` keyed by column name."""
        return {name: getattr(self, name) for name in self.COLUMN_NAMES}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<CheckResult version_cid={self.version_cid!r} "
            f"metadata_match={self.metadata_match!r}>"
        )


# Same self-healing pattern as ``version_texts`` above: ``create_app`` covers
# the normal path, but the check helpers are also usable from scripts and
# tests that never build the app.
_check_results_lock = threading.Lock()
_check_results_engine: Optional[Engine] = None


def ensure_check_results_table() -> None:
    """Create the ``check_results`` table if it does not exist yet."""
    global _check_results_engine
    if _check_results_engine is db.engine:
        return
    with _check_results_lock:
        if _check_results_engine is not db.engine:
            try:
                CheckResult.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                if not inspect(db.engine).has_table(CheckResult.__tablename__):
                    raise
            _check_results_engine = db.engine
