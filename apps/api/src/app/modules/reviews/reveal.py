"""Reveal a sealed review as a ``review.formal`` (plugin: reviews, feature 109).

A review is a two-step commit-reveal.  ``POST /v1/reviews/commit`` seals it as
a ``review.commit`` (feature 107); ``POST /v1/reviews/reveal`` opens it as a
``review.formal``.  Both are signed by the reviewer's pseudonymous per-paper
review key, so the signature identifies the *sealed review*, not the person.

What a reveal must satisfy
--------------------------

* **A complete rubric.**  ``scores`` holds one ``{"score": 1-5,
  "justification": "..."}`` entry for each of soundness, evidence,
  reproducibility, novelty, clarity and limitations; ``confidence`` and
  ``recommendation`` are required too.  The record schema is looser than this
  (it takes a bare integer for a dimension and does not require a
  justification); the endpoint holds the line the review form does: a score
  without a justification, or free text without scores, is not a formal review
  (``422``).
* **A matching commitment.**  There must be a sealed review signed by the same
  review key on the same version, and the revealed review must be the one that
  was sealed (``422``): the record's ``commitment`` is the commit's, *and* the
  revealed content hashes to it (see :func:`commitment_digest`).  Checking the
  field alone would let a reviewer copy the commitment string onto different
  content; checking the content alone would not tie the reveal to its commit.
* **Once.**  A sealed review is revealed once (``409``).

Updating a revealed review (feature 112)
----------------------------------------

A paper gets new versions, and a reviewer may revise their review against one.
The update is a ``review.formal`` whose envelope ``prev`` is the cid of the
reviewer's earlier ``review.formal`` and whose ``target`` is a newer version of
the same paper.  It is the same review, not a second one -- a person still
reviews a paper once -- so nothing is committed again: the sealed review the
earlier reveal opened stands behind the whole chain.  What an update must
satisfy:

* the same complete rubric as any reveal (``422``);
* ``prev`` names a ``review.formal`` signed by the *same review key*; a
  reviewer cannot replace someone else's review (``422``), and a ``prev`` that
  names nothing this node holds is refused rather than ignored (``422``);
* ``target`` is a newer version of the paper the earlier review is of (``422``);
* the earlier review is replaced once, so the history stays a line (``409``).

An update carries no commitment: the commitment's job is to stop a reviewer
changing their review after seeing the others', and the review being updated is
already open.  A ``commitment`` an update does carry is not checked.  A
``prev`` that names the reviewer's own ``review.commit`` is the ordinary reveal
linking back to its commit, and is treated as one.

An update writes no row.  The ``review`` row stays as the commit and first
reveal left it, and the history is read from the signed ``review.formal``
records themselves (see :mod:`app.modules.reviews.history`), which is also how
``status.compute`` reads it.

The commitment scheme
---------------------

The record schema says only that ``commitment`` is the "commitment from the
matching review.commit record".  This plugin fixes the hash: the commitment is
the lowercase hex SHA-256 of the canonical JSON of the review body with its own
``commitment`` field left out -- keys sorted, no insignificant whitespace,
UTF-8, non-ASCII characters written as themselves.  Everything else in the
body is sealed: the scores, the report, the review key, the nullifier.  A
reviewer who wants the commitment to resist guessing from a short report adds a
random ``salt`` to the body; it is sealed like any other field.

What a reveal saves
-------------------

The ``review`` row the commit created is filled in: ``scores`` (the six entries
as given), ``recommendation`` (normalised, see :func:`normalise_recommendation`),
``confidence`` (an integer, see :data:`CONFIDENCE_LEVELS`), ``report_cid`` (only
when the review carries a ``reportCid``; an inline ``report`` stays in the
record, since the content store is public) and ``revealed_at`` (the record's
``created``).  ``signed_by`` is left alone: signing a review with a name is
feature 111.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import update

from app import db
from app.errors import ProblemException
from app.modules.ingest.errors import InvalidRecord

from .errors import (
    ReviewAlreadyRevealed,
    ReviewAlreadyUpdated,
    ReviewCommitmentMismatch,
    ReviewNotCommitted,
    ReviewUpdateInvalid,
    UnknownReviewTarget,
)
from .models import Review, ensure_tables
from .service import (
    REVIEW_COMMIT_TYPE,
    _created_at,
    entry_prev,
    find_review_on_paper,
    formal_entries,
    resolve_review_target,
    version_number,
)

__all__ = [
    "CONFIDENCE_LEVELS",
    "RECOMMENDATIONS",
    "REVEALED",
    "REVIEW_FORMAL_TYPE",
    "REVIEW_REVEAL_MIN_TIER",
    "RUBRIC_DIMENSIONS",
    "ReviewRevealFields",
    "apply_review_reveal",
    "commitment_digest",
    "find_sealed_review",
    "handle_review_reveal",
    "normalise_recommendation",
    "persist_review_reveal",
    "review_reveal_fields",
]

logger = logging.getLogger(__name__)

#: The record type a reveal accepts.
REVIEW_FORMAL_TYPE = "review.formal"

#: The state an accepted reveal reports back to the client.
REVEALED = "revealed"

#: Lowest *author* tier the ingest registry lets through.  Like a commit, a
#: ``review.formal`` is signed by a pseudonymous review key with no account row
#: (tier 0); who may review is the endpoint's ``require_tier(3)``.
REVIEW_REVEAL_MIN_TIER = 0

#: The six mandatory rubric dimensions (``review.formal`` schema), in the order
#: the review form shows them.
RUBRIC_DIMENSIONS: tuple[str, ...] = (
    "soundness",
    "evidence",
    "reproducibility",
    "novelty",
    "clarity",
    "limitations",
)

#: How a verbal confidence is stored in the integer ``review.confidence``
#: column: the ends and the middle of the 1-5 scale an integer confidence uses.
CONFIDENCE_LEVELS: Mapping[str, int] = {"low": 1, "medium": 3, "high": 5}

#: The verdicts the record schema allows, after :func:`normalise_recommendation`.
#: ``status.compute`` reads the same spellings.
RECOMMENDATIONS: frozenset[str] = frozenset(
    {
        "sound",
        "sound_as_is",
        "accept",
        "accept_as_is",
        "minor_revisions",
        "minor_revision",
        "major_concerns",
        "major_revision",
        "fundamentally_flawed",
        "reject",
    }
)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")

_MIN_SCORE, _MAX_SCORE = 1, 5
_MAX_ECHO = 64

_FREE_TEXT_ONLY = (
    "A formal review needs rubric scores with a justification for "
    + ", ".join(RUBRIC_DIMENSIONS[:-1])
    + f" and {RUBRIC_DIMENSIONS[-1]}; a free-text report alone is not a formal review."
)


# --------------------------------------------------------------------------- #
# The commitment
# --------------------------------------------------------------------------- #


def commitment_digest(body: Mapping[str, Any]) -> str:
    """The commitment a reviewer seals for ``body``: SHA-256 over its canonical JSON.

    ``body`` is the review as it will be revealed; its own ``commitment`` field
    is not part of what is sealed (it cannot contain its own hash).  Returns
    lowercase hex.
    """
    sealed = {key: value for key, value in body.items() if key != "commitment"}
    canonical = json.dumps(
        sealed, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _same_commitment(left: str, right: str) -> bool:
    """Whether two commitments are the same value (hex is case-insensitive)."""
    return left.strip().lower() == right.strip().lower()


# --------------------------------------------------------------------------- #
# Reading a reveal
# --------------------------------------------------------------------------- #


def normalise_recommendation(value: Any) -> Optional[str]:
    """``value`` as a lowercase snake_case verdict the schema allows, or ``None``.

    ``"Minor revisions"``, ``"minor revisions"`` and ``"minor_revisions"`` are
    one verdict; anything outside :data:`RECOMMENDATIONS` is ``None``.
    """
    if not isinstance(value, str):
        return None
    normalised = _NON_ALNUM.sub("_", value.strip().lower()).strip("_")
    return normalised if normalised in RECOMMENDATIONS else None


def _confidence(value: Any) -> Optional[int]:
    """``value`` as the integer 1-5 stored in ``review.confidence``, or ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if _MIN_SCORE <= value <= _MAX_SCORE else None
    if isinstance(value, str):
        return CONFIDENCE_LEVELS.get(value.strip().lower())
    return None


def _problem(loc: list[Any], message: str, kind: str, value: Any = None) -> dict[str, Any]:
    """One field error, shaped like the ones FastAPI and the ingest pipeline report."""
    shown = value if isinstance(value, (str, int, float, bool, type(None))) else None
    if isinstance(shown, str) and len(shown) > _MAX_ECHO:
        shown = shown[: _MAX_ECHO - 3] + "..."
    return {"loc": loc, "msg": message, "type": kind, "input": shown}


def _dimension_problems(dimension: str, scores: Mapping[str, Any]) -> list[dict[str, Any]]:
    """What is wrong with one rubric entry; empty when it is a scored, justified one."""
    loc = ["body", "scores", dimension]
    if dimension not in scores:
        return [
            _problem(
                loc,
                f"The review has no {dimension} score; all six rubric dimensions are required.",
                "missing_dimension",
            )
        ]
    entry = scores[dimension]
    if not isinstance(entry, Mapping):
        return [
            _problem(
                loc,
                f"The {dimension} entry must be an object with a 'score' from "
                f"{_MIN_SCORE} to {_MAX_SCORE} and a 'justification'.",
                "invalid_dimension",
                entry,
            )
        ]

    problems: list[dict[str, Any]] = []
    score = entry.get("score")
    if (
        isinstance(score, bool)
        or not isinstance(score, int)
        or not _MIN_SCORE <= score <= _MAX_SCORE
    ):
        problems.append(
            _problem(
                [*loc, "score"],
                f"The {dimension} score must be an integer from {_MIN_SCORE} to {_MAX_SCORE}.",
                "invalid_score",
                score,
            )
        )
    justification = entry.get("justification")
    if not isinstance(justification, str) or not justification.strip():
        problems.append(
            _problem(
                [*loc, "justification"],
                f"The {dimension} score needs a justification.",
                "missing_justification",
                justification,
            )
        )
    return problems


def _rubric_problems(body: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Everything wrong with the rubric part of a revealed review."""
    scores = body.get("scores")
    if scores is None:
        problems = [_problem(["body", "scores"], _FREE_TEXT_ONLY, "missing_scores")]
    elif not isinstance(scores, Mapping):
        problems = [
            _problem(
                ["body", "scores"],
                "The scores must be an object with one entry per rubric dimension.",
                "invalid_scores",
            )
        ]
    else:
        problems = [
            problem
            for dimension in RUBRIC_DIMENSIONS
            for problem in _dimension_problems(dimension, scores)
        ]

    confidence = body.get("confidence")
    if confidence is None:
        problems.append(
            _problem(["body", "confidence"], "The review needs a confidence.", "missing_confidence")
        )
    elif _confidence(confidence) is None:
        problems.append(
            _problem(
                ["body", "confidence"],
                f"The confidence must be an integer from {_MIN_SCORE} to {_MAX_SCORE} "
                "or one of low, medium, high.",
                "invalid_confidence",
                confidence,
            )
        )

    recommendation = body.get("recommendation")
    if recommendation is None:
        problems.append(
            _problem(
                ["body", "recommendation"],
                "The review needs a recommendation.",
                "missing_recommendation",
            )
        )
    elif normalise_recommendation(recommendation) is None:
        problems.append(
            _problem(
                ["body", "recommendation"],
                "The recommendation must be one of the verdicts the review.formal schema allows.",
                "invalid_recommendation",
                recommendation,
            )
        )
    return problems


@dataclass(frozen=True)
class ReviewRevealFields:
    """The parts of a ``review.formal`` this plugin acts on, shape-checked."""

    #: cid of the ``review.formal`` record (its ``id``).
    reveal_cid: str
    #: cid of the ``paper.version`` under review (``body.target``).
    version_cid: str
    #: cid of that version's paper (its genesis record).
    paper_cid: str
    #: The review key that signed the record: the sealed review's key.
    review_key: str
    #: The commitment the record claims to open.  ``None`` when it carries none,
    #: which only an update of an earlier review may do (see :attr:`prev`).
    commitment: Optional[str]
    #: The envelope's ``prev``: the cid of the earlier review this one updates,
    #: or ``None`` for a first reveal.
    prev: Optional[str]
    #: The six rubric entries, ``{dimension: {"score": int, "justification": str}}``.
    scores: dict[str, dict[str, Any]]
    #: The verdict, normalised (see :func:`normalise_recommendation`).
    recommendation: str
    #: Confidence as the integer 1-5 the ``review`` table stores.
    confidence: int
    #: ``body.reportCid`` when the report is carried by reference, else ``None``.
    report_cid: Optional[str]
    #: The instant the record is dated (``created``), not when it arrived.
    revealed_at: datetime


def review_reveal_fields(record: Mapping[str, Any]) -> ReviewRevealFields:
    """Shape-check a ``review.formal`` and return the fields this plugin acts on.

    Every problem found is reported in one ``422``, each located at its field,
    so a client can fix a form in one pass.  This is stricter than the record
    schema about the rubric (see the module docstring); the ingest pipeline's
    schema check still runs on top of it.

    Raises:
        InvalidRecord: ``422`` when the body is not an object, the rubric is
            incomplete (no scores, a dimension missing, a score outside 1-5, a
            missing justification), ``confidence`` or ``recommendation`` is
            missing or not one the schema allows, ``commitment`` is missing,
            ``target`` is missing, ``reviewKey`` names a key other than the
            signer's, or ``created`` is not an instant.
        UnknownReviewTarget: ``422`` when ``target`` is not a version here.
    """
    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the review.formal body must be an object"],
            detail="The review.formal body must be a JSON object.",
        )

    reveal_cid = record.get("id")
    if not isinstance(reveal_cid, str) or not reveal_cid:
        message = "The review.formal record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [_problem(["body", "id"], message, "missing_record_id")],
            detail=message,
        )

    problems = _rubric_problems(body)

    target = body.get("target")
    if not isinstance(target, str) or not target.strip():
        problems.append(
            _problem(
                ["body", "target"],
                "The review needs the cid of the paper version under review in 'target'.",
                "invalid_target",
                target,
            )
        )

    prev = record.get("prev")
    if prev is not None and (not isinstance(prev, str) or not prev.strip()):
        problems.append(
            _problem(
                ["prev"],
                "The review's 'prev' must be null, or the cid of the earlier review it updates.",
                "invalid_prev",
                prev,
            )
        )
        prev = None

    commitment = body.get("commitment")
    has_commitment = isinstance(commitment, str) and bool(commitment.strip())
    # A first reveal opens a commitment; an update (it has a ``prev``) opens
    # nothing, its earlier review is open already.  Whether a ``prev`` makes
    # this an update is for the handler to say once it has looked at it.
    if not has_commitment and prev is None:
        problems.append(
            _problem(
                ["body", "commitment"],
                "A revealed review must carry the commitment from its review.commit in 'commitment'.",
                "missing_commitment",
                commitment,
            )
        )

    review_key = record.get("author")
    claimed_key = body.get("reviewKey")
    if claimed_key is not None and claimed_key != review_key:
        problems.append(
            _problem(
                ["body", "reviewKey"],
                "The review names a review key other than the one that signed it.",
                "review_key_mismatch",
                claimed_key,
            )
        )
    if not isinstance(review_key, str) or not review_key:
        problems.append(
            _problem(["author"], "The record needs its review key as 'author'.", "missing_author")
        )

    if problems:
        raise InvalidRecord(problems, detail=problems[0]["msg"])

    version_cid, paper_cid = resolve_review_target(target.strip())
    scores = {
        dimension: {
            "score": body["scores"][dimension]["score"],
            "justification": body["scores"][dimension]["justification"],
        }
        for dimension in RUBRIC_DIMENSIONS
    }
    report_cid = body.get("reportCid")
    return ReviewRevealFields(
        reveal_cid=reveal_cid,
        version_cid=version_cid,
        paper_cid=paper_cid,
        review_key=review_key,
        commitment=commitment.strip() if has_commitment else None,
        prev=prev,
        scores=scores,
        recommendation=normalise_recommendation(body["recommendation"]),  # type: ignore[arg-type]
        confidence=_confidence(body["confidence"]),  # type: ignore[arg-type]
        report_cid=report_cid if isinstance(report_cid, str) and report_cid else None,
        revealed_at=_created_at(record, subject="review"),
    )


# --------------------------------------------------------------------------- #
# Finding and matching the sealed review
# --------------------------------------------------------------------------- #


def find_sealed_review(review_key: str, version_cid: str) -> Optional[Review]:
    """The review this key sealed on this version, or ``None``.

    A review key is per paper and a person commits once per paper, so a key and
    a version name one review; if the rows ever say otherwise, the earliest
    commit holds the slot.
    """
    ensure_tables()
    with db.SessionLocal() as session:
        row = (
            session.query(Review)
            .filter(Review.review_key == review_key, Review.version_cid == version_cid)
            .order_by(Review.committed_at, Review.review_cid)
            .first()
        )
        if row is not None:
            session.expunge(row)
        return row


def _sealed_commitment(review: Review) -> Optional[str]:
    """The commitment the ``review.commit`` carries, read from the event log."""
    from app.modules import ledger

    entry = ledger.entry_by_cid(review.review_cid)
    body = getattr(entry, "body", None)
    if not isinstance(body, Mapping):
        return None
    for key in ("commitment", "commitmentHash"):
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _require_sealed_review(fields: ReviewRevealFields) -> Review:
    """The sealed review this reveal opens, or ``422``."""
    review = find_sealed_review(fields.review_key, fields.version_cid)
    if review is None:
        raise ReviewNotCommitted(fields.review_key, fields.version_cid)
    return review


def _check_commitment(record: Mapping[str, Any], fields: ReviewRevealFields, review: Review) -> None:
    """Refuse (``422``) unless the revealed review is the one that was sealed.

    Two things must hold: the record's ``commitment`` is the commit's, and the
    revealed content hashes to it.
    """
    if fields.commitment is None:
        # Only an update may go without one, and it never gets here.
        message = "A revealed review must carry the commitment from its review.commit in 'commitment'."
        raise InvalidRecord(
            [_problem(["body", "commitment"], message, "missing_commitment")],
            detail=message,
        )
    sealed = _sealed_commitment(review)
    if sealed is None:
        # The row exists but the log holds no commitment for it: nothing to match.
        raise ReviewNotCommitted(fields.review_key, fields.version_cid)
    if not _same_commitment(fields.commitment, sealed):
        raise ReviewCommitmentMismatch(
            "commitment_mismatch",
            "The review's commitment is not the one its review.commit sealed.",
        )
    if not _same_commitment(commitment_digest(record["body"]), sealed):
        raise ReviewCommitmentMismatch(
            "content_mismatch",
            "The revealed review is not the content its commitment seals.",
        )


# --------------------------------------------------------------------------- #
# Updating a revealed review
# --------------------------------------------------------------------------- #


def _earlier_review(fields: ReviewRevealFields) -> Optional[Any]:
    """The logged ``review.formal`` this reveal updates, or ``None`` for a first reveal.

    ``prev`` names one of three things.  Nothing: an ordinary reveal.  The
    reviewer's ``review.commit``: also an ordinary reveal, linked back to the
    commit it opens.  A ``review.formal``: an update, returned here for
    :func:`_require_update` to check.  Any other ``prev`` -- a cid this node
    does not hold, or a record that is not a review -- is refused rather than
    ignored, since the reviewer meant to link to something.

    Raises:
        ReviewUpdateInvalid: ``422`` -- ``prev`` is none of those.
    """
    if fields.prev is None:
        return None
    from app.modules import ledger

    entry = ledger.entry_by_cid(fields.prev)
    record_type = getattr(entry, "record_type", None)
    if record_type == REVIEW_FORMAL_TYPE:
        return entry
    if record_type == REVIEW_COMMIT_TYPE:
        return None
    raise ReviewUpdateInvalid(
        "unknown_prev",
        "The review's 'prev' must name the reviewer's earlier review.formal "
        "that this one updates, or be null; this node holds no such review.",
        value=fields.prev,
    )


def _replacement(prev: str, review_key: str, own_cid: str) -> Optional[Any]:
    """The update that already replaced review ``prev``, or ``None``.

    The earliest other ``review.formal`` by this key that names ``prev``.  When
    ``own_cid`` is in the log already (the ledger subscriber and the endpoint
    check *after* the append) only an update logged before it counts, so the
    record that took the slot is never refused for having taken it.
    """
    from app.modules import ledger

    own = ledger.entry_by_cid(own_cid)
    for entry in formal_entries(review_key):
        if entry.record_cid == own_cid:
            continue
        if own is not None and entry.seq > own.seq:
            continue
        if entry_prev(entry) == prev:
            return entry
    return None


def _require_update(fields: ReviewRevealFields, earlier: Any) -> Review:
    """Check an update against the review it replaces; return the sealed review.

    Raises:
        ReviewUpdateInvalid: ``422`` -- ``earlier`` is not this reviewer's, is of
            another paper, or is not of an older version than this review's.
        ReviewNotCommitted: ``422`` -- this key sealed no review on the paper.
        ReviewAlreadyUpdated: ``409`` -- ``earlier`` was replaced already.
    """
    prev = fields.prev
    if earlier.author_did != fields.review_key:
        raise ReviewUpdateInvalid(
            "prev_not_by_reviewer",
            "The review it updates was signed by another review key; a "
            "reviewer can only update their own review.",
            value=prev,
        )

    earlier_body = earlier.body if isinstance(earlier.body, Mapping) else {}
    earlier_target = earlier_body.get("target")
    try:
        if not isinstance(earlier_target, str) or not earlier_target.strip():
            raise UnknownReviewTarget(earlier_target)
        earlier_version, earlier_paper = resolve_review_target(earlier_target.strip())
    except UnknownReviewTarget:
        raise ReviewUpdateInvalid(
            "unknown_prev",
            "The review it updates targets a version this node does not hold.",
            value=prev,
        ) from None
    if earlier_paper != fields.paper_cid:
        raise ReviewUpdateInvalid(
            "prev_other_paper",
            "The review it updates is a review of a different paper.",
            value=prev,
        )

    new_n = version_number(fields.version_cid)
    old_n = version_number(earlier_version)
    if new_n is None or old_n is None or new_n <= old_n:
        raise ReviewUpdateInvalid(
            "not_a_newer_version",
            "An updated review must target a newer version of the paper than "
            "the review it updates.",
            loc=("body", "target"),
            value=fields.version_cid,
        )

    sealed = find_review_on_paper(fields.review_key, fields.paper_cid)
    if sealed is None:
        raise ReviewNotCommitted(fields.review_key, earlier_version)

    replacement = _replacement(prev, fields.review_key, fields.reveal_cid)
    if replacement is not None:
        raise ReviewAlreadyUpdated(prev, replacement.record_cid)
    return sealed


# --------------------------------------------------------------------------- #
# The ingest handler, the projection and the ledger subscriber
# --------------------------------------------------------------------------- #


def handle_review_reveal(record: Mapping[str, Any]) -> str:
    """Validate a ``review.formal``; return the state it will be saved with.

    Runs before the record is appended to the ledger, so a refusal stores
    nothing.  Nothing is saved here either: the ``review`` row is filled in by
    :func:`apply_review_reveal` once the record is in the log.

    A ``review.formal`` whose ``prev`` names the reviewer's earlier one is an
    update against a newer version, checked by :func:`_require_update` instead
    of against a commitment.

    Raises:
        InvalidRecord, UnknownReviewTarget: ``422`` -- an incomplete rubric or
            another malformed field.
        ReviewNotCommitted: ``422`` -- this key sealed no review on the version
            (or, for an update, on the paper).
        ReviewAlreadyRevealed: ``409`` -- the sealed review was revealed already.
        ReviewCommitmentMismatch: ``422`` -- not the sealed content.
        ReviewUpdateInvalid: ``422`` -- an update that links to something it may not.
        ReviewAlreadyUpdated: ``409`` -- the earlier review was replaced already.
    """
    fields = review_reveal_fields(record)
    earlier = _earlier_review(fields)
    if earlier is not None:
        _require_update(fields, earlier)
        return REVEALED
    review = _require_sealed_review(fields)
    if review.revealed_at is not None:
        raise ReviewAlreadyRevealed(review.review_cid)
    _check_commitment(record, fields, review)
    return REVEALED


def apply_review_reveal(record: Mapping[str, Any]) -> Review:
    """Fill in the sealed review's revealed columns; return its row.

    Idempotent: a review that is already revealed is returned as it is, so the
    ledger subscriber and the endpoint may both call this for the same record.
    The record is validated again first -- including its commitment -- so no
    row is filled in for a reveal the handler would have refused.

    An update fills in nothing: the row is the review the reviewer sealed, and
    the update's content lives in its signed record, which the reviews listing
    reads.  The row is returned, so an update answers with the same review cid
    as the review it revises.

    Raises:
        InvalidRecord, UnknownReviewTarget, ReviewNotCommitted,
        ReviewCommitmentMismatch, ReviewUpdateInvalid, ReviewAlreadyUpdated:
        as for :func:`handle_review_reveal`.
    """
    fields = review_reveal_fields(record)
    earlier = _earlier_review(fields)
    if earlier is not None:
        return _require_update(fields, earlier)
    review = _require_sealed_review(fields)
    if review.revealed_at is not None:
        return review
    _check_commitment(record, fields, review)

    with db.SessionLocal() as session:
        # Conditional on the review still being sealed, so two writers racing
        # to open it cannot both fill it in.
        session.execute(
            update(Review)
            .where(Review.review_cid == review.review_cid, Review.revealed_at.is_(None))
            .values(
                scores=fields.scores,
                recommendation=fields.recommendation,
                confidence=fields.confidence,
                report_cid=fields.report_cid,
                revealed_at=fields.revealed_at,
            )
        )
        session.commit()
        saved = session.get(Review, review.review_cid)
        if saved is None:  # pragma: no cover - the row was read a moment ago
            raise ReviewNotCommitted(fields.review_key, fields.version_cid)
        session.expunge(saved)
    return saved


def persist_review_reveal(entry: Any) -> None:
    """Ledger subscriber: fill in the sealed review once its reveal is in the log.

    A ``review.formal`` can reach the log without a sealed review of this node
    behind it -- appended directly by another plugin's fixtures, for one -- and
    there is then nothing to fill in; that is noted, not an error.  Anything
    else is logged by the ledger and does not undo the append; the endpoint
    applies the reveal again and reports a real failure to its caller.
    """
    if getattr(entry, "record_type", None) != REVIEW_FORMAL_TYPE:
        return
    from app.modules import ledger

    try:
        apply_review_reveal(ledger.stored_envelope(entry).model_dump())
    except ProblemException as exc:
        logger.info(
            "review.formal %s did not open a sealed review: %s",
            getattr(entry, "record_cid", None),
            exc.detail,
        )
