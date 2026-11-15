"""Persistence for the advisory AI pre-review (``ai_reviews`` table)."""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, JSON, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["AIReview", "ensure_ai_reviews_table"]


class AIReview(db.Base):
    """One node-signed advisory AI pre-review for one version."""

    __tablename__ = "ai_reviews"

    review_cid = Column(Text, primary_key=True)
    version_cid = Column(Text, nullable=False)
    models = Column(JSON, nullable=False)
    prompt_set_hash = Column(Text, nullable=False)
    findings = Column(JSON, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AIReview review_cid={self.review_cid!r} "
            f"version_cid={self.version_cid!r}>"
        )


_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_ai_reviews_table() -> None:
    """Create the ``ai_reviews`` table if it is missing."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        try:
            AIReview.__table__.create(bind=db.engine, checkfirst=True)
        except (OperationalError, ProgrammingError):
            if not inspect(db.engine).has_table(AIReview.__table__.name):
                raise
        _table_engine = db.engine
