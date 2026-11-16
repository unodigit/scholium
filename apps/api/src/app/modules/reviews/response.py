"""Answer a formal review with a ``review.response`` (plugin: reviews, feature 114).

A ``review.response`` is the paper authors' side of the conversation: one
reply per rubric dimension, answering the reviewer point by point.  Like
every write on this API it is a client-signed record, signed with the
author's own Ed25519 key -- not the reviewer's pseudonymous per-paper key::

    POST /v1/reviews/{cid}/response
    Authorization: Bearer <the author's access token>

    {"v": 1, "type": "review.response", "author": "did:key:z6Mk...",
     "created": "2026-11-16T00:00:00Z", "prev": null,
     "body": {"review": "<review cid>",
              "items": [{"dimension": "soundness", "reply": "..."},
                        ... point by point ...]},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

The ``review.response`` body schema requires ``items`` and names the review
being answered in ``review`` (or ``reviewCid``); each item names its rubric
``dimension`` and carries the reply text in ``reply``, ``text`` or ``body``
(the schema accepts all three, and a bare string item is one unkeyed reply).

What the endpoint accepts
-------------------------

* The path ``{cid}`` names a review this node holds: the ``review.commit``
  cid (the ``review`` row's key) or the revealed ``review.formal`` cid
  (:func:`app.modules.reviews.service.resolve_review`).
* The record's body names that same review.
* The caller and the record's signer are the same person, and that person is
  on the paper's byline.  Anyone else -- another reviewer included -- is
  ``403``.

An accepted response runs through the standard ingest pipeline (envelope,
body schema, cid, signature, ledger), is saved to ``review_responses`` with
the dimension-to-reply mapping, and is served with its review by
``GET /v1/papers/{id}/reviews``.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.errors import ProblemException
from app.modules import submissions
from app.modules.ingest.errors import InvalidRecord

from .errors import ReviewResponseNotAuthorized
from .models import Review, ReviewResponse, ensure_tables
from .route_guard import require_dedicated_route
from .service import (
    _paper_authors_from_ledger,
    _paper_cid_for_version,
    is_review_author,
    resolve_review,
)

__all__ = [
    "ACCEPTED",
    "REVIEW_RESPONSE_MIN_TIER",
    "REVIEW_RESPONSE_TYPE",
    "ReviewResponseFields",
    "apply_review_response",
    "get_review_response",
    "handle_review_response",
    "is_paper_author",
    "list_review_responses",
    "persist_review_response",
    "response_fields",
]

logger = logging.getLogger(__name__)

#: The record type this endpoint accepts.
REVIEW_RESPONSE_TYPE = "review.response"

#: The state an accepted response reports back to the client.
ACCEPTED = "accepted"

#: Lowest *author* tier the ingest registry lets through.  Who may respond is
#: authorship of the paper -- an access-token caller whose DID is on the
#: byline -- not a trust tier, so the type itself is open to every author.
REVIEW_RESPONSE_MIN_TIER = 0

#: The spelling an unkeyed reply is stored under.  ``general`` is the schema's
#: extra slot for a reply that answers the review as a whole, and the fallback
#: for a bare-string item.
GENERAL_DIMENSION = "general"

#: Reply-text keys an item may use (the schema accepts all three).
_REPLY_KEYS = ("reply", "text", "body")

#: Review-identity keys a body may use (the schema accepts the first two).
_REVIEW_KEYS = ("review", "reviewCid", "review_cid")

_MAX_ECHO = 64


def _problem(loc: list[Any], message: str, kind: str, value: Any = None) -> dict[str, Any]:
    """One field error, shaped like the ingest pipeline's."""
    shown = value if isinstance(value, (str, int, float, bool, type(None))) else None
    if isinstance(shown, str) and len(shown) > _MAX_ECHO:
        shown = shown[: _MAX_ECHO - 3] + "..."
    return {"loc": loc, "msg": message, "type": kind, "input": shown}


@dataclass(frozen=True)
class ReviewResponseFields:
    """The parts of a ``review.response`` this plugin acts on, shape-checked."""

    #: cid of the ``review.response`` record (its ``id``).
    response_cid: str
    #: The review the body names: a ``review.commit`` or ``review.formal`` cid.
    review_cid: str
    #: ``{rubric dimension: reply text}`` -- the point-by-point answers.
    replies: dict[str, str]


def _reply_from_item(item: Any, position: int) -> tuple[str, str]:
    """Return ``(dimension, reply)`` for one ``items`` entry.

    Raises:
        InvalidRecord: ``422`` when the item carries no non-empty reply text.
    """
    if isinstance(item, str):
        if item.strip():
            return GENERAL_DIMENSION, item
        raise InvalidRecord(
            [
                _problem(
                    ["body", "items", position],
                    "A response reply cannot be empty.",
                    "empty_reply",
                )
            ],
            detail="A response reply cannot be empty.",
        )

    if not isinstance(item, Mapping):
        raise InvalidRecord(
            [
                _problem(
                    ["body", "items", position],
                    "Each response item must be a reply string or an object.",
                    "invalid_item",
                )
            ],
            detail="Each response item must be a reply string or an object.",
        )

    dimension = item.get("dimension")
    if not isinstance(dimension, str) or not dimension.strip():
        dimension = GENERAL_DIMENSION
    dimension = dimension.strip()

    for key in _REPLY_KEYS:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return dimension, value

    raise InvalidRecord(
        [
            _problem(
                ["body", "items", position, "reply"],
                "A response item needs its reply text in 'reply', 'text' or 'body'.",
                "missing_reply",
            )
        ],
        detail="A response item needs its reply text in 'reply', 'text' or 'body'.",
    )


def _replies_from_body(body: Mapping[str, Any]) -> dict[str, str]:
    """The dimension-to-reply mapping the body states, or ``422`` when empty."""
    items = body.get("items")
    if not isinstance(items, list) or not items:
        raise InvalidRecord(
            [
                _problem(
                    ["body", "items"],
                    "A review.response needs at least one point-by-point reply in 'items'.",
                    "missing_items",
                    items,
                )
            ],
            detail="A review.response needs at least one point-by-point reply in 'items'.",
        )

    replies: dict[str, str] = {}
    for position, item in enumerate(items):
        dimension, reply = _reply_from_item(item, position)
        replies[dimension] = reply
    return replies


def response_fields(record: Mapping[str, Any]) -> ReviewResponseFields:
    """Shape-check a ``review.response`` and return the fields this plugin acts on.

    Every problem found is reported in one ``422``, each located at its field,
    so a client can fix a response in one pass.  The ingest pipeline's schema
    check still runs on top of this.

    Raises:
        InvalidRecord: ``422`` when the body is not an object, the record
            carries no ``id``, the body names no review, ``items`` is missing
            or empty, or an item carries no reply text.
    """
    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the review.response body must be an object"],
            detail="The review.response body must be a JSON object.",
        )

    response_cid = record.get("id")
    if not isinstance(response_cid, str) or not response_cid:
        message = "The review.response record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [_problem(["body", "id"], message, "missing_record_id")],
            detail=message,
        )

    review_cid: Any = None
    for key in _REVIEW_KEYS:
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            review_cid = value.strip()
            break
    if review_cid is None:
        message = (
            "The response needs the cid of the review it answers in 'review' "
            "(or 'reviewCid')."
        )
        raise InvalidRecord(
            [_problem(["body", "review"], message, "missing_review")],
            detail=message,
        )

    replies = _replies_from_body(body)
    if not replies:
        message = "A review.response needs at least one reply."
        raise InvalidRecord(
            [_problem(["body", "items"], message, "missing_replies")],
            detail=message,
        )

    return ReviewResponseFields(
        response_cid=response_cid,
        review_cid=review_cid,
        replies=replies,
    )


def _unknown_review(review_cid: str) -> ProblemException:
    """``422`` when a response names a review this node does not hold."""
    return ProblemException(
        422,
        f"The response answers review {review_cid!r}, which this node does not hold.",
        errors=[
            _problem(
                ["body", "review"],
                "The response names a review this node does not hold.",
                "unknown_review",
                review_cid,
            )
        ],
    )


def resolve_response_review(fields: ReviewResponseFields) -> Review:
    """The review ``fields`` answers, or ``422`` when this node holds no such review."""
    review = resolve_review(fields.review_cid)
    if review is None:
        raise _unknown_review(fields.review_cid)
    return review


def is_paper_author(caller_did: object, review: Review) -> bool:
    """Whether ``caller_did`` is on the byline of the paper ``review`` targets.

    The submissions projection is the primary source (``authorship`` rows);
    the event log and its genesis/version signers are the fallback, so a paper
    whose byline was not indexed can still be answered by its author.
    """
    if not isinstance(caller_did, str) or not caller_did or review is None:
        return False
    try:
        if is_review_author(caller_did, review.version_cid):
            return True
    except Exception:  # pragma: no cover - defensive: a broken projection
        pass

    paper_cid = _paper_cid_for_version(review.version_cid)
    if isinstance(paper_cid, str) and paper_cid:
        try:
            if caller_did in _paper_authors_from_ledger(paper_cid):
                return True
        except Exception:  # pragma: no cover - defensive: a broken ledger
            pass
        try:
            if caller_did in submissions.paper_authors(paper_cid):
                return True
        except Exception:  # pragma: no cover - defensive: a broken projection
            pass
    return False


def handle_review_response(record: Mapping[str, Any]) -> str:
    """Validate a ``review.response``; return the state it will be saved with.

    Runs before the record is appended to the ledger, so a refusal stores
    nothing.  Nothing is saved here either: the ``review_responses`` row is
    written by :func:`apply_review_response` once the record is in the log.

    Raises:
        ProblemException: ``422`` -- submitted through ``POST /v1/records``
            instead of the review response endpoint.
        InvalidRecord: ``422`` -- a malformed response.
        ProblemException: ``422`` -- the review it answers is not on this node.
        ReviewResponseNotAuthorized: ``403`` -- the signer is not a paper author.
    """
    require_dedicated_route(REVIEW_RESPONSE_TYPE, "POST /v1/reviews/{cid}/response")
    fields = response_fields(record)
    review = resolve_response_review(fields)
    author = record.get("author")
    if not is_paper_author(author, review):
        raise ReviewResponseNotAuthorized(author, review.review_cid)
    return ACCEPTED


def get_review_response(response_cid: object) -> Optional[ReviewResponse]:
    """The saved response with this cid, or ``None``."""
    if not isinstance(response_cid, str) or not response_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(ReviewResponse, response_cid)
        if row is not None:
            session.expunge(row)
        return row


def list_review_responses(review_cid: object) -> list[ReviewResponse]:
    """Every saved response to ``review_cid``, in cid order."""
    if not isinstance(review_cid, str) or not review_cid:
        return []
    ensure_tables()
    with db.SessionLocal() as session:
        rows = list(
            session.query(ReviewResponse)
            .filter(ReviewResponse.review_cid == review_cid)
            .order_by(ReviewResponse.response_cid)
            .all()
        )
        for row in rows:
            session.expunge(row)
        return rows


def apply_review_response(record: Mapping[str, Any]) -> ReviewResponse:
    """Save the response to ``review_responses``; return its row.

    Idempotent per response cid: a response that already has its row is
    returned as it is, so the ledger subscriber and the endpoint may both call
    this for the same record.  The record is validated again first, so no row
    exists for a response the handler would have refused.

    Raises:
        InvalidRecord: ``422`` -- a malformed response.
        ProblemException: ``422`` -- the review it answers is not on this node.
    """
    fields = response_fields(record)
    review = resolve_response_review(fields)

    existing = get_review_response(fields.response_cid)
    if existing is not None:
        return existing

    row = ReviewResponse(
        response_cid=fields.response_cid,
        review_cid=review.review_cid,
        replies=fields.replies,
    )
    with db.SessionLocal() as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            # This very record was saved by another writer between the check
            # above and now; its row is this record's row.
            saved = session.get(ReviewResponse, fields.response_cid)
            if saved is not None:
                session.expunge(saved)
                return saved
            raise
        session.refresh(row)
        session.expunge(row)
    return row


def persist_review_response(entry: Any) -> None:
    """Ledger subscriber: save every ``review.response`` once it is in the log.

    A response can reach the log without a review of this node behind it --
    appended directly by another plugin's fixtures, for one -- and there is
    then nothing to attach it to; that is noted, not an error.  Anything else
    is logged by the ledger and does not undo the append; the endpoint applies
    the response again and reports a real failure to its caller.
    """
    if getattr(entry, "record_type", None) != REVIEW_RESPONSE_TYPE:
        return
    from app.modules import ledger

    try:
        apply_review_response(ledger.stored_envelope(entry).model_dump())
    except ProblemException as exc:
        logger.info(
            "review.response %s did not answer a review on this node: %s",
            getattr(entry, "record_cid", None),
            exc.detail,
        )
