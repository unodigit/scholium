"""Problem-details refusals for review commitments (RFC 9457).

A ``review.commit`` that is not a well-formed record (no ``target``, no
``nullifier``, no ``commitment``) is refused by the ingest pipeline's own
``InvalidRecord`` before any handler here runs.  These are the refusals only
the reviews plugin can make: the target must be a version this node holds, the
caller may not be an author of the paper, and one person reviews a paper once.

Revealing a review adds three more: there must be a sealed review to reveal
(``422``), the revealed content must be what was sealed (``422``), and a
review is revealed once (``409``).

Updating a revealed review (a ``review.formal`` whose ``prev`` names the
reviewer's earlier one, against a newer version) adds two: the ``prev`` link
must be one the reviewer may make (``422``), and a review is replaced once
(``409``).
"""

from __future__ import annotations

from typing import Any

from app.errors import ProblemException

__all__ = [
    "REVIEW_ALREADY_COMMITTED",
    "REVIEW_ALREADY_REVEALED",
    "REVIEW_ALREADY_UPDATED",
    "REVIEW_COMMITMENT_MISMATCH",
    "REVIEW_NOT_AUTHORIZED",
    "REVIEW_NOT_COMMITTED",
    "REVIEW_RESPONSE_NOT_AUTHORIZED",
    "REVIEW_UPDATE_INVALID",
    "UNKNOWN_REVIEW_TARGET",
    "ReviewAlreadyCommitted",
    "ReviewAlreadyRevealed",
    "ReviewAlreadyUpdated",
    "ReviewCommitmentMismatch",
    "ReviewNotAuthorized",
    "ReviewNotCommitted",
    "ReviewResponseNotAuthorized",
    "ReviewUpdateInvalid",
    "UnknownReviewTarget",
]

UNKNOWN_REVIEW_TARGET = "urn:scholium:problem:unknown-review-target"
REVIEW_NOT_AUTHORIZED = "urn:scholium:problem:review-not-authorized"
REVIEW_ALREADY_COMMITTED = "urn:scholium:problem:review-already-committed"
REVIEW_NOT_COMMITTED = "urn:scholium:problem:review-not-committed"
REVIEW_COMMITMENT_MISMATCH = "urn:scholium:problem:review-commitment-mismatch"
REVIEW_ALREADY_REVEALED = "urn:scholium:problem:review-already-revealed"
REVIEW_UPDATE_INVALID = "urn:scholium:problem:review-update-invalid"
REVIEW_ALREADY_UPDATED = "urn:scholium:problem:review-already-updated"
REVIEW_RESPONSE_NOT_AUTHORIZED = "urn:scholium:problem:review-response-not-authorized"

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


class ReviewNotCommitted(ProblemException, LookupError):
    """There is no sealed review for this review key on this version: ``422``.

    A review is revealed against the commitment it was sealed with, so a
    ``review.formal`` signed by a key that never committed to this version has
    nothing to match.
    """

    def __init__(self, review_key: object, target: object) -> None:
        self.review_key = review_key
        self.target = target
        shown = _clip(target if isinstance(target, str) else repr(target))
        message = (
            "There is no sealed review by this review key on "
            f"{shown!r}; commit the review with POST /v1/reviews/commit before "
            "revealing it."
        )
        super().__init__(
            422,
            message,
            type=REVIEW_NOT_COMMITTED,
            errors=[
                {
                    "loc": ["body", "target"],
                    "msg": message,
                    "type": "review_not_committed",
                    "input": shown,
                }
            ],
        )


class ReviewCommitmentMismatch(ProblemException, ValueError):
    """The revealed review is not the one that was sealed: ``422``.

    ``kind`` says which half of the match failed: ``commitment_mismatch`` when
    the record's ``commitment`` is not the commit's, ``content_mismatch`` when
    the commitment is the commit's but the revealed content does not hash to
    it (the sealed review was altered after the fact).  Neither digest is
    echoed: the commit's is public, but the one computed from the revealed
    content would let a client probe the scheme for nothing.
    """

    def __init__(self, kind: str, message: str) -> None:
        self.kind = kind
        super().__init__(
            422,
            message,
            type=REVIEW_COMMITMENT_MISMATCH,
            errors=[
                {
                    "loc": ["body", "commitment"],
                    "msg": message,
                    "type": kind,
                    "input": None,
                }
            ],
        )


class ReviewAlreadyRevealed(ProblemException, ValueError):
    """The sealed review has been revealed already: ``409``.

    A commitment opens once.  The cid of the sealed review is carried as the
    ``review`` extension member; it is a public record, so naming it
    discloses nothing.
    """

    def __init__(self, review_cid: object) -> None:
        self.review_cid = review_cid
        message = (
            "This sealed review has already been revealed; a commitment can "
            "be opened once."
        )
        super().__init__(
            409,
            message,
            type=REVIEW_ALREADY_REVEALED,
            review=review_cid,
        )


class ReviewUpdateInvalid(ProblemException, ValueError):
    """An updated ``review.formal`` links to something it may not: ``422``.

    ``kind`` says what is wrong with the update; ``loc`` is the field it is
    wrong at (``prev`` unless the fault is the target):

    * ``unknown_prev`` -- ``prev`` names no ``review.formal`` this node holds;
    * ``prev_not_by_reviewer`` -- ``prev`` names a review signed by another
      review key, which a reviewer may not replace;
    * ``prev_other_paper`` -- ``prev`` names a review of a different paper;
    * ``not_a_newer_version`` -- the update does not target a newer version
      than the review it replaces.
    """

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        loc: tuple[str, ...] = ("prev",),
        value: object = None,
    ) -> None:
        self.kind = kind
        super().__init__(
            422,
            message,
            type=REVIEW_UPDATE_INVALID,
            errors=[
                {
                    "loc": list(loc),
                    "msg": message,
                    "type": kind,
                    "input": _clip(value),
                }
            ],
        )


class ReviewAlreadyUpdated(ProblemException, ValueError):
    """The review was already replaced by an update: ``409``.

    A review is replaced once, so the history stays a line.  The cid of the
    update that holds the slot is carried as the ``update`` extension member,
    and ``review`` is the cid being replaced; both are public records, so
    naming them discloses nothing.  The reviewer's next update names the
    latest review in its ``prev``.
    """

    def __init__(self, review_cid: object, update_cid: object) -> None:
        self.review_cid = review_cid
        self.update_cid = update_cid
        message = (
            "This review has already been updated; point 'prev' at the "
            "reviewer's latest review to update it again."
        )
        super().__init__(
            409,
            message,
            type=REVIEW_ALREADY_UPDATED,
            review=review_cid,
            update=update_cid,
        )


class ReviewResponseNotAuthorized(ProblemException, PermissionError):
    """The caller may not answer this review because they did not write the paper: ``403``.

    A ``review.response`` is the paper authors' reply to their reviewers, so
    the record must be signed by -- and submitted by -- someone on the paper's
    byline.  Every other signed-in member is refused, reviewers included.
    """

    def __init__(self, caller: object, review_cid: object) -> None:
        self.caller = caller
        self.review_cid = review_cid
        shown = _clip(caller if isinstance(caller, str) else repr(caller))
        message = (
            "Only an author of the paper may respond to its review; "
            f"{shown} is not listed on this paper's byline."
        )
        super().__init__(
            403,
            message,
            type=REVIEW_RESPONSE_NOT_AUTHORIZED,
            review=review_cid,
        )
