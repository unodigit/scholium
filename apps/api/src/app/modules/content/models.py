"""SQLAlchemy model for the ``blobs`` table.

Table shape (``app_spec.xml``, ``database_schema/blobs``)::

    blobs(cid TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          media_type TEXT,
          scan_status TEXT NOT NULL)

One row per distinct file content: ``cid`` is the raw-codec CIDv1 of the
bytes (see :mod:`scholium_record_core.file_id`), ``size`` their length and
``media_type`` the bare ``type/subtype`` the uploader declared, if any.
``scan_status`` tracks the sanitizer's verdict -- bytes are served only once
it is :data:`SCAN_PASSED`.

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import BigInteger, Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "Blob",
    "SCAN_FAILED",
    "SCAN_PASSED",
    "SCAN_SCANNING",
    "SCAN_STATUSES",
    "ensure_table",
]

#: Stored but not yet cleared by the sanitizer.  Every new blob starts here.
SCAN_SCANNING = "scanning"
#: The sanitizer found nothing wrong; the bytes may be served.
SCAN_PASSED = "passed"
#: The sanitizer rejected the bytes.
SCAN_FAILED = "failed"

SCAN_STATUSES = (SCAN_SCANNING, SCAN_PASSED, SCAN_FAILED)


class Blob(db.Base):
    """The record of one file's bytes in the content directory."""

    __tablename__ = "blobs"

    cid = Column(Text, primary_key=True)
    # The spec says INTEGER, which is 32 bits on PostgreSQL; a bundle may be
    # 5 GiB, so use a 64-bit column (still an INTEGER-affinity one on SQLite).
    size = Column(BigInteger, nullable=False)
    media_type = Column(Text, nullable=True)
    scan_status = Column(Text, nullable=False, default=SCAN_SCANNING)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Blob cid={self.cid!r} size={self.size} "
            f"media_type={self.media_type!r} scan_status={self.scan_status!r}>"
        )


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  The store may also be used from
# tests/scripts that never build the app, so make sure the table exists before
# the first write (the same self-healing pattern as the ledger and
# notifications modules).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``blobs`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                Blob.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(Blob.__tablename__):
                    raise
            _table_engine = db.engine
