"""SQLAlchemy models for the reviews plugin's projection tables.

``review_invitations`` (``app_spec.xml``, ``database_schema/review_invitations``)::

    review_invitations(id TEXT PRIMARY KEY,
                      version_cid TEXT NOT NULL,
                      reviewer_did TEXT NOT NULL,
                      status TEXT NOT NULL)

One row per invitation from an author or tier-4 member to a tier-3 reviewer
for a paper (version).  ``id`` is the invitation's own identifier (returned
to the caller); ``version_cid`` is the paper version the invitation targets;
``reviewer_did`` the DID of the invited reviewer; ``status`` tracks the
invitation's lifecycle (``pending`` until the reviewer acts on it).

``review`` (``app_spec.xml``, ``database_schema/review``)::

    review(review_cid TEXT PRIMARY KEY,
           version_cid TEXT NOT NULL,
           review_key TEXT NOT NULL,
           nullifier BLOB NOT NULL,
           scores JSON,
           recommendation TEXT,
           confidence INTEGER,
           report_cid TEXT,
           signed_by TEXT,
           committed_at TIMESTAMP,
           revealed_at TIMESTAMP)

One row per committed review.  A ``review.commit`` creates it with the record's
cid, the target version, the pseudonymous review key and the reviewer's
nullifier; features 109-112 fill in the revealed columns.  ``nullifier`` is
stored as bytes -- the hex string a client sends is decoded first -- and is
what makes a second commitment by the same person on the same paper a
conflict.  The pseudonymity material (``review_key`` and ``nullifier``) is
never served by any endpoint; see :mod:`app.modules.profiles.views`.

``review_responses`` (``app_spec.xml``, ``database_schema/review_responses``)::

    review_responses(response_cid TEXT PRIMARY KEY,
                     review_cid TEXT NOT NULL,
                     replies JSON NOT NULL)

One row per ``review.response`` record: a paper author's point-by-point
answer to a formal review.  ``response_cid`` is the record's own cid,
``review_cid`` the ``review`` row it answers (the ``review.commit`` cid), and
``replies`` the rubric-dimension-to-reply mapping the record carries.  See
:mod:`app.modules.reviews.response`.

``review_escrows`` (``app_spec.xml``, ``database_schema/review_escrows``)::

    review_escrows(review_cid TEXT PRIMARY KEY,
                   sealed_identity BLOB NOT NULL,
                   uniqueness_token TEXT NOT NULL UNIQUE)

One row per committed review, holding the accountability link the node itself
cannot read.  ``sealed_identity`` is ``Enc(committee_public_key,
reviewer_did)`` -- a sealed box only the committee's private key opens -- and
``uniqueness_token`` is an HMAC over the reviewer DID and the paper cid, so a
second review by the same person on the same paper collides on the UNIQUE
constraint.  There is deliberately no ``reviewer_did`` column: the plaintext
mapping is never written.  See :mod:`app.modules.reviews.escrow`.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, LargeBinary, Text, JSON, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "Review",
    "ReviewEscrow",
    "ReviewInvitation",
    "ReviewRating",
    "ReviewResponse",
    "ensure_table",
    "ensure_tables",
]


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


class Review(db.Base):
    """One committed (sealed) review of a paper version."""

    __tablename__ = "review"

    #: cid of the ``review.commit`` record.
    review_cid = Column(Text, primary_key=True)
    #: cid of the ``paper.version`` the review targets.
    version_cid = Column(Text, nullable=False)
    #: The pseudonymous per-paper key the commitment is signed with.
    review_key = Column(Text, nullable=False)
    #: ``H(secret || paperId)``; the same reviewer and paper give the same value.
    nullifier = Column(LargeBinary, nullable=False)
    #: Revealed rubric, filled in by ``POST /v1/reviews/reveal``.
    scores = Column(JSON, nullable=True)
    recommendation = Column(Text, nullable=True)
    confidence = Column(Integer, nullable=True)
    report_cid = Column(Text, nullable=True)
    signed_by = Column(Text, nullable=True)
    #: When the ``review.commit`` record was dated (its ``created``).
    committed_at = Column(DateTime, nullable=True)
    #: When the formal review was revealed, or NULL while it stays sealed.
    revealed_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Review review_cid={self.review_cid!r} version_cid={self.version_cid!r} "
            f"revealed_at={self.revealed_at!r}>"
        )


class ReviewEscrow(db.Base):
    """One review's reviewer identity, sealed for the committee.

    ``sealed_identity`` is a libsodium sealed box of the reviewer DID to the
    committee public key.  ``uniqueness_token`` is the HMAC that lets the
    UNIQUE constraint refuse a second review by the same person on the same
    paper without storing who that person is.
    """

    __tablename__ = "review_escrows"

    #: cid of the ``review.commit`` this escrow belongs to.
    review_cid = Column(Text, primary_key=True)
    #: ``Enc(committee_public_key, reviewer_did)``; never the plaintext DID.
    sealed_identity = Column(LargeBinary, nullable=False)
    #: ``HMAC(reviewer_did || paper_cid)``; stable, non-reversible, UNIQUE.
    uniqueness_token = Column(Text, nullable=False, unique=True, index=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<ReviewEscrow review_cid={self.review_cid!r}>"



class ReviewRating(db.Base):
    """One tier-3 member's quality rating of a revealed review."""

    __tablename__ = "review_ratings"

    review_cid = Column(Text, nullable=False)
    rater_did = Column(Text, nullable=False)
    rating = Column(Integer, nullable=False)

    __mapper_args__ = {"primary_key": [review_cid, rater_did]}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ReviewRating review_cid={self.review_cid!r} "
            f"rater_did={self.rater_did!r} rating={self.rating!r}>"
        )


class ReviewResponse(db.Base):
    """One paper author's point-by-point response to a formal review."""

    __tablename__ = "review_responses"

    #: cid of the ``review.response`` record.
    response_cid = Column(Text, primary_key=True)
    #: cid of the ``review`` (``review.commit``) row this response answers.
    review_cid = Column(Text, nullable=False, index=True)
    #: ``{rubric dimension: reply text}`` as the record states it.
    replies = Column(JSON, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ReviewResponse response_cid={self.response_cid!r} "
            f"review_cid={self.review_cid!r}>"
        )

_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the plugin's tables if they do not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            for table in (
                ReviewInvitation.__table__,
                Review.__table__,
                ReviewEscrow.__table__,
                ReviewRating.__table__,
                ReviewResponse.__table__,
            ):
                try:
                    table.create(bind=db.engine, checkfirst=True)
                except (OperationalError, ProgrammingError):
                    # ``checkfirst`` is not atomic: another process (e.g. a
                    # second pytest-xdist worker) may have created it in between.
                    if not inspect(db.engine).has_table(table.name):
                        raise
            _table_engine = db.engine


ensure_tables = ensure_table