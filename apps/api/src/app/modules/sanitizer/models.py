"""SQLAlchemy model for the ``scan_reports`` table.

Table shape (``app_spec.xml``, ``database_schema/scan_reports``)::

    scan_reports(cid TEXT NOT NULL,
                 check_name TEXT NOT NULL,
                 result TEXT NOT NULL,
                 detail TEXT)

One row per file per check.  ``cid`` is the file id of the bytes that were
scanned (the raw-codec CIDv1 from :mod:`scholium_record_core.file_id`),
``check_name`` names the check that produced the row (``javascript``,
``embedded_files``, ...), ``result`` is :data:`RESULT_FAILED` or
:data:`RESULT_PASSED`, and ``detail`` is a human-readable explanation that
never contains the file's bytes.

The spec declares no primary key.  ``(cid, check_name)`` is used as a
composite key here so a check has exactly one current verdict per file:
re-scanning the same content updates the row instead of piling up duplicate
findings.  That also gives the table a stable identity for the ORM while
keeping exactly the columns the spec names.

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "RESULT_FAILED",
    "RESULT_PASSED",
    "RESULTS",
    "ScanReport",
    "ensure_table",
]

#: A check found something that must stop the file being served.
RESULT_FAILED = "failed"
#: A check found nothing wrong.
RESULT_PASSED = "passed"

RESULTS = (RESULT_FAILED, RESULT_PASSED)


class ScanReport(db.Base):
    """The verdict of one scan check for one file."""

    __tablename__ = "scan_reports"

    cid = Column(Text, primary_key=True)
    check_name = Column(Text, primary_key=True)
    result = Column(Text, nullable=False)
    detail = Column(Text, nullable=True)

    #: Column names in table order, also the keys of the mapping view.
    COLUMN_NAMES = ("cid", "check_name", "result", "detail")

    def to_dict(self) -> dict[str, object]:
        """Return the row as a plain ``dict`` keyed by column name."""
        return {name: getattr(self, name) for name in self.COLUMN_NAMES}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ScanReport cid={self.cid!r} check={self.check_name!r} "
            f"result={self.result!r}>"
        )


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  The report helpers may also be used
# from tests/scripts that never build the app, so make sure the table exists
# before the first write (the same self-healing pattern as the content,
# ledger and notifications modules).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``scan_reports`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                ScanReport.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(ScanReport.__tablename__):
                    raise
            _table_engine = db.engine
