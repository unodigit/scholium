"""SQLAlchemy models for the recovery plugin.

Tables (``app_spec.xml``, ``database_schema``):

* ``guardians`` -- the five recovery guardians each account has chosen. One row
  per guardian: ``did`` is the account that chose them, ``guardian_did`` the
  guardian, ``position`` the guardian's index (0-4) in the list the account
  submitted.

``(did, position)`` is the primary key, so an account can never hold more than
five guardians, and ``(did, guardian_did)`` is unique, so it can never name the
same guardian twice.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Integer, PrimaryKeyConstraint, Text, UniqueConstraint, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["Guardian", "ensure_table"]


class Guardian(db.Base):
    """One recovery guardian chosen by one account."""

    __tablename__ = "guardians"

    did = Column(Text, nullable=False)
    guardian_did = Column(Text, nullable=False)
    position = Column(Integer, nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("did", "position"),
        UniqueConstraint("did", "guardian_did", name="uq_guardians_did_guardian_did"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Guardian did={self.did!r} position={self.position} guardian_did={self.guardian_did!r}>"


# Self-healing table creation, mirroring the other modules: the table is
# created on first use against whichever engine is current.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``guardians`` table if it does not exist yet."""
    global _table_engine
    engine = db.engine
    if _table_engine is engine:
        return
    with _table_lock:
        if _table_engine is not engine:
            try:
                Guardian.__table__.create(bind=engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # Another worker may have created it between the check and the create.
                if not inspect(engine).has_table(Guardian.__tablename__):
                    raise
            _table_engine = engine
