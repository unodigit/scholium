"""Problem-details refusals for review commitments (RFC 9457).

A ``review.commit`` that is not a well-formed record (no ``target``, no
``nullifier``, no ``commitment``) is refused by the ingest pipeline's own
``InvalidRecord`` before any handler here runs.  These are the refusals only
the reviews plugin can make: the target must be a version this node holds, the
caller may not be an author of the paper, and one person reviews a paper once.
"""

from __future__ import annotations

from typing import Any

from app.errors import ProblemException

__all__ = [
    "REVIEW_ALREADY_COMMITTED",
    "REVIEW_NOT_AUTHORIZED",
    "UNKNOWN_REVIEW_TARGET",
    "ReviewAlreadyCommitted",
    "ReviewNotAuthorized",
    "UnknownReviewTarget",
]

UNKNOWN_REVIEW_TARGET = "urn:scholium:problem:unknown-review-target"
REVIEW_NOT_AUTHORIZED = "urn:scholium:problem:review-not-authorized"
REVIEW_ALREADY_COMMITTED = "urn:scholium:problem:review-already-committed"

_MAX_ECHO = 64


def _clip(value: Any) -> Any:
    """Echo a client-supplied string clipped, so a huge one cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


class UnknownReviewTarget(ProblemException, LookupError):
    """``body.target`` is not a version this node holds: ``422``.

    A review commits to a ``paper.version``.  The version is resolved through
    the submissions projection first and the event log second, so a version
    whose handler has not indexed it can still be reviewed.
    """

    def __init__(self, target: object) -> None:
        self.target = target
        shown = _clip(target if isinstance(target, str) else repr(target))
        message = (
            f"The review targets {shown!r}, which is not a paper version this "
            "node holds."
        )
        super().__init__(
            422,
            message,
            type=UNKNOWN_REVIEW_TARGET,
            errors=[
                {
                    "loc": ["body", "target"],
                    "msg": message,
                    "type": "unknown_review_target",
                    "input": shown,
                }
            ],
        )


class ReviewNotAuthorized(ProblemException, PermissionError):
    """The caller is an author of the paper: ``403``.

    An author may not review their own paper.  Author is checked against the
    *caller* -- whoever the access token says they are -- because the record
    itself is signed by the pseudonymous per-paper review key and therefore
    says nothing about the reviewer's public identity.
    """

    def __init__(self, author: object, paper_cid: object) -> None:
        self.author = author
        self.paper_cid = paper_cid
        shown = _clip(author if isinstance(author, str) else repr(author))
        message = (
            "An author of a paper may not review it; "
            f"{shown} is listed as an author of the paper this review targets."
        )
        super().__init__(
            403,
            message,
            type=REVIEW_NOT_AUTHORIZED,
            paper_cid=paper_cid,
        )


class ReviewAlreadyCommitted(ProblemException, ValueError):
    """This reviewer has committed a review of this paper already: ``409``.

    The nullifier is deterministic -- ``H(secret || paperId)`` -- so the same
    person committing again on the same paper carries the same one.  The cid
    of the review that holds the slot is carried as the ``review`` extension
    member; it is a public record, so naming it discloses nothing.
    """

    def __init__(self, paper_cid: object, review_cid: object = None) -> None:
        self.paper_cid = paper_cid
        self.review_cid = review_cid
        shown = _clip(paper_cid if isinstance(paper_cid, str) else repr(paper_cid))
        message = (
            f"This reviewer has already committed a review of paper {shown!r}; "
            "a person may commit one review per paper."
        )
        super().__init__(
            409,
            message,
            type=REVIEW_ALREADY_COMMITTED,
            paper_cid=paper_cid,
            review=review_cid,
        )
