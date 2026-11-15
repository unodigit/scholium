"""SQLAlchemy model for the ``review_invitations`` table.

Table shape (``app_spec.xml``, ``database_schema/review_invitations``)::

    review_invitations(id TEXT PRIMARY KEY,
                      version_cid TEXT NOT NULL,
                      reviewer_did TEXT NOT NULL,
                      status TEXT NOT NULL)

One row per invitation from an author or tier-4 member to a tier-3 reviewer
for a paper (version).  ``id`` is the invitation's own identifier (returned
to the caller); ``version_cid`` is the paper version the invitation targets;
``reviewer_did`` the DID of the invited reviewer; ``status`` tracks the
invitation's lifecycle (``pending`` until the reviewer acts on it).
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["ReviewInvitation", "ensure_table", "ensure_tables"]


class ReviewInvitation(db.Base):
    """One invitation to review a paper version."""

    __tablename__ = "review_invitations"

    id = Column(Text, primary_key=True)
    version_cid = Column(Text, nullable=False)
    reviewer_did = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="pending")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ReviewInvitation id={self.id!r} version_cid={self.version_cid!r} "
            f"reviewer_did={self.reviewer_did!r} status={self.status!r}>"
        )


_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``review_invitations`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                ReviewInvitation.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                if not inspect(db.engine).has_table(ReviewInvitation.__tablename__):
                    raise
            _table_engine = db.engine


ensure_tables = ensure_table