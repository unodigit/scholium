"""Persistence for the advisory AI pre-review (``ai_reviews`` table)."""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, JSON, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "AIReview",
    "AIReviewRebuttal",
    "AIReviewAssessment",
    "ensure_ai_reviews_table",
    "ensure_ai_review_rebuttals_table",
    "ensure_ai_review_assessments_table",
]


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


class AIReviewRebuttal(db.Base):
    """One author rebuttal attached to one finding of one advisory review."""

    __tablename__ = "ai_review_rebuttals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    review_cid = Column(Text, nullable=False)
    finding_id = Column(Text, nullable=False)
    author_did = Column(Text, nullable=False)
    text = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AIReviewRebuttal id={self.id!r} review_cid={self.review_cid!r} "
            f"finding_id={self.finding_id!r}>"
        )


class AIReviewAssessment(db.Base):
    """One tier-3 reviewer's assessment (confirmed/wrong) of one finding."""

    __tablename__ = "ai_review_assessments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    review_cid = Column(Text, nullable=False)
    finding_id = Column(Text, nullable=False)
    reviewer_did = Column(Text, nullable=False)
    verdict = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AIReviewAssessment id={self.id!r} review_cid={self.review_cid!r} "
            f"finding_id={self.finding_id!r} verdict={self.verdict!r}>"
        )


def _make_ensure(model_class, attr_name):
    lock = threading.Lock()
    engine_holder = {"engine": None}

    def ensure():
        global_engine = engine_holder
        if engine_holder["engine"] is db.engine:
            return
        with lock:
            if engine_holder["engine"] is db.engine:
                return
            try:
                model_class.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                if not inspect(db.engine).has_table(model_class.__table__.name):
                    raise
            engine_holder["engine"] = db.engine

    return ensure


ensure_ai_reviews_table_base = _make_ensure(AIReview, "ai_reviews")
ensure_ai_review_rebuttals_table = _make_ensure(AIReviewRebuttal, "ai_review_rebuttals")
ensure_ai_review_assessments_table = _make_ensure(AIReviewAssessment, "ai_review_assessments")


def ensure_ai_reviews_table() -> None:
    ensure_ai_reviews_table_base()
    ensure_ai_review_rebuttals_table()
    ensure_ai_review_assessments_table()

# Preserve original module-level lock/engine globals name for compatibility.
_table_lock = threading.Lock()
_table_engine = None
