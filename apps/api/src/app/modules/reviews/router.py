"""HTTP routes for the reviews plugin.

The module loader mounts this router under ``/v1``, so this package serves:

* ``POST /v1/papers/{paper_id}/review-invitations`` -- save an invitation to
  the ``review_invitations`` table.
* ``GET /v1/papers/{paper_id}/coi-check`` -- the conflict-of-interest checks
  (not an author, no co-authorship in 3 years, different institution) for the
  calling reviewer; see :mod:`app.modules.reviews.coi`.
* ``POST /v1/reviews/commit`` -- accept a signed ``review.commit`` from a
  tier-3 member, once per person and paper, and escrow the caller's identity
  as a sealed box for the committee; see :mod:`app.modules.reviews.service`
  and :mod:`app.modules.reviews.escrow`.
* ``POST /v1/reviews/reveal`` -- accept a signed ``review.formal`` that opens
  a sealed review: a complete rubric, and content that matches the commitment;
  see :mod:`app.modules.reviews.reveal`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Response

from app import db
from app.errors import ProblemException
from app.modules.ingest.service import ingest
from app.security import Principal, get_current_principal, require_tier, Tier

from . import coi, reveal, service
from .models import ensure_table, ensure_tables

__all__ = ["router"]

router = APIRouter(tags=["reviews"])


def _not_found(paper_id: str) -> ProblemException:
    from app.errors import ProblemException

    return ProblemException(404, f"No paper {paper_id!r} on this node.")


@router.post("/papers/{paper_id}/review-invitations", status_code=201)
def create_review_invitation(
    paper_id: str,
    payload: Any = Body(default=None),
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """Save a review invitation for ``paper_id``."""
    ensure_tables()
    if not isinstance(payload, dict):
        payload = {}
    paper = service.resolve_paper(paper_id)
    if paper is None:
        # Also try resolving through version id / cid handled in service.
        paper = service.resolve_paper(paper_id)
    if paper is None:
        raise _not_found(paper_id)

    # Authorization: author of the paper or tier-4 member.
    if not service.is_author_or_moderator(principal.did, paper, principal.tier):
        raise ProblemException(403, "Only an author of the paper or a tier-4 member may invite a reviewer.")

    reviewer, version_hint, status = service.parse_payload(payload)
    if reviewer is None:
        raise ProblemException(422, "reviewer is required")
    reviewer = str(reviewer).strip()
    if not reviewer:
        raise ProblemException(422, "reviewer is required")

    # Validate reviewer is a tier-3 reviewer in the paper category.
    if not service.is_tier3_reviewer(reviewer, paper):
        raise ProblemException(403, "The invitee must be a tier-3 reviewer in the paper category.")

    paper_obj, version = service.resolve_version(paper_id, version_hint)
    if version is None and paper_obj is not None:
        # fallback latest version
        paper_obj, version = service.resolve_version(paper_id, None)
    if version is None:
        # No version exists; cannot create invitation.
        raise ProblemException(404, f"No version for paper {paper_id!r}.")

    status = (status or "pending")
    if not isinstance(status, str) or not status.strip():
        status = "pending"
    status = status.strip()

    invitation = service.create_invitation(
        paper_id=paper_id,
        version_cid=version.version_cid,
        reviewer_did=reviewer,
        status=status,
    )
    return {
        "id": invitation.id,
        "invitation_id": invitation.id,
        "invitationId": invitation.id,
        "version_cid": invitation.version_cid,
        "versionCid": invitation.version_cid,
        "reviewer_did": invitation.reviewer_did,
        "reviewer": invitation.reviewer_did,
        "reviewerDid": invitation.reviewer_did,
        "status": invitation.status,
        "paper": getattr(paper, "short_id", None),
    }


@router.get("/papers/{paper_id}/coi-check")
def get_coi_check(
    paper_id: str,
    response: Response,
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """Return the three conflict-of-interest checks for the calling reviewer.

    Any signed-in caller may ask: the answer is about the caller and the
    paper, and it names no one else.  The checks are advisory -- they never
    refuse the request, a conflict shows up as ``"passed": false``.
    """
    paper = service.resolve_paper(paper_id)
    if paper is None:
        raise _not_found(paper_id)
    # The answer depends on who asks and on the profiles as they stand now.
    response.headers["Cache-Control"] = "private, no-store"
    return coi.check_conflicts(paper, principal.did).as_dict()


@router.post("/reviews/commit", status_code=201)
def commit_review(
    record: dict[str, Any] = Body(..., description="The signed review.commit envelope."),
    principal: Principal = Depends(require_tier(Tier.REVIEWER)),
) -> dict[str, Any]:
    """Accept a signed ``review.commit`` from a tier-3 member, once per paper.

    The commitment is signed by the reviewer's pseudonymous per-paper review
    key, so the record itself says nothing about the caller's identity.  The
    access token supplies that: only a tier-3 member may commit, an author of
    the paper may not (``403``), and the nullifier in the body -- the same for
    this person and this paper every time -- makes a second commitment a
    ``409``.

    An accepted commit goes through the standard ingest pipeline (envelope,
    body schema, cid, signature, ledger) and is saved to the ``review`` table
    with status ``committed``, awaiting ``POST /v1/reviews/reveal``.  The
    caller's DID is saved alongside it in ``review_escrows`` only as a sealed
    box for the committee, with the HMAC uniqueness token guarding one review
    per person and paper.

    Failures are RFC 9457 problem details: ``401`` for a missing token or a bad
    signature, ``403`` for a caller below tier 3 or listed as an author,
    ``409`` for a second review by the same person on the same paper, and
    ``422`` for an invalid record or a target this node does not hold.
    """
    if record.get("type") != service.REVIEW_COMMIT_TYPE:
        raise ProblemException(
            422,
            f"This endpoint accepts {service.REVIEW_COMMIT_TYPE!r} records, "
            f"got {record.get('type')!r}.",
            errors=[
                {
                    "loc": ["body", "type"],
                    "msg": f"The record must be a {service.REVIEW_COMMIT_TYPE}.",
                    "type": "wrong_record_type",
                    "input": record.get("type"),
                }
            ],
        )

    ensure_tables()
    # Shape-check before trusting the body enough to name the paper, then
    # refuse an author's own review before anything reaches the ledger.
    fields = service.review_commit_fields(record)
    service.require_not_author(principal.did, fields.paper_cid)
    # The escrow token is keyed by the *authenticated* DID, so it refuses a
    # second review even when the commit carries a fresh nullifier.  Checked
    # before the append so a refused repeat writes nothing.
    service.require_unique_reviewer(principal.did, fields.paper_cid)

    # The pipeline validates the envelope and body, verifies the signature,
    # runs the handler (which refuses a second commit), and appends the record.
    result = ingest(record)
    # The ledger subscriber normally saved the review as it was appended; this
    # is a no-op then, and the one that reports a failure when it did not.
    service.apply_review_commit(record)
    # The record is pseudonymous; the access token is the only thing that says
    # who reviewed.  Store that identity sealed for the committee -- never in
    # plaintext -- under the review it belongs to.
    service.save_review_escrow(
        review_cid=fields.review_cid,
        reviewer_did=principal.did,
        paper_cid=fields.paper_cid,
    )

    return {
        "id": result.record_id,
        "target": fields.version_cid,
        "state": result.state,
        "anchor": result.anchor,
    }


@router.post("/reviews/reveal", status_code=201)
def reveal_review(
    record: dict[str, Any] = Body(..., description="The signed review.formal envelope."),
    principal: Principal = Depends(require_tier(Tier.REVIEWER)),
) -> dict[str, Any]:
    """Accept a signed ``review.formal`` that opens a sealed review.

    Like the commit it opens, the record is signed by the reviewer's
    pseudonymous per-paper review key; the access token says only that a tier-3
    member is asking.  What makes the reveal acceptable is the record itself:

    * a complete rubric -- a ``{score, justification}`` for each of soundness,
      evidence, reproducibility, novelty, clarity and limitations, each score
      1-5, plus a confidence and a recommendation.  Free text alone, with no
      scores, is not a formal review;
    * a commitment that matches -- the review key must have sealed a review on
      this version, the record must carry that commit's ``commitment``, and the
      revealed content must hash to it (see
      :func:`app.modules.reviews.reveal.commitment_digest`).

    An accepted reveal goes through the standard ingest pipeline (envelope,
    body schema, cid, signature, ledger) and fills in the ``review`` row the
    commit created: scores, recommendation, confidence and ``revealed_at``.

    Failures are RFC 9457 problem details: ``401`` for a missing token or a bad
    signature, ``403`` for a caller below tier 3, ``409`` for a review that was
    revealed already, and ``422`` for an incomplete rubric, a review that was
    never sealed, content that does not match its commitment, or a target this
    node does not hold.
    """
    if record.get("type") != reveal.REVIEW_FORMAL_TYPE:
        raise ProblemException(
            422,
            f"This endpoint accepts {reveal.REVIEW_FORMAL_TYPE!r} records, "
            f"got {record.get('type')!r}.",
            errors=[
                {
                    "loc": ["body", "type"],
                    "msg": f"The record must be a {reveal.REVIEW_FORMAL_TYPE}.",
                    "type": "wrong_record_type",
                    "input": record.get("type"),
                }
            ],
        )

    ensure_tables()
    # Shape-check first: an incomplete rubric is refused here with every
    # problem located at its field, before the signature is even looked at.
    # Whether a sealed review exists, and whether this is it, is decided by the
    # handler once the pipeline has verified who signed the record.
    fields = reveal.review_reveal_fields(record)

    # The pipeline validates the envelope and body, verifies the signature,
    # runs the handler (which matches the commitment) and appends the record.
    result = ingest(record)
    # The ledger subscriber normally filled in the review as the record was
    # appended; this is a no-op then, and the one that reports a failure when
    # it did not.
    review = reveal.apply_review_reveal(record)

    return {
        "id": result.record_id,
        "target": fields.version_cid,
        "review": review.review_cid,
        "state": result.state,
        "anchor": result.anchor,
    }


@router.get("/papers/{paper_id}/reviews")
def get_paper_reviews(paper_id: str) -> dict[str, Any]:
    """Return the formal reviews of a listed paper's resolved version.

    Report bodies stay hidden until two reviews are committed on the version or
    21 days have passed since the first commit; anonymous reviewers are labelled
    ``Reviewer A``, ``Reviewer B`` per paper.
    """
    from app.modules import ledger
    from app.modules.catalog.service import resolve as resolve_listed
    from .models import Review, ensure_tables

    ensure_tables()
    view = resolve_listed(paper_id)
    if view is None:
        raise _not_found(paper_id)

    version = view.version
    version_cid = version.version_cid

    # Committed review rows for this version, in commit order.
    with db.SessionLocal() as session:
        rows = (
            session.query(Review)
            .filter(Review.version_cid == version_cid)
            .order_by(Review.committed_at, Review.review_cid)
            .all()
        )
        for row in rows:
            session.expunge(row)

    # Map each review key to its revealed review.formal record (latest wins).
    formal_by_key: dict[str, Any] = {}
    for entry in ledger.entries():
        if getattr(entry, "record_type", None) != "review.formal":
            continue
        body = getattr(entry, "body", None)
        if not isinstance(body, dict):
            continue
        if body.get("target") != version_cid:
            continue
        author = getattr(entry, "author_did", None)
        if isinstance(author, str) and author:
            formal_by_key[author] = entry

    # Gate: open once two reviews are committed, or 21 days after the first.
    committed_times = [r.committed_at for r in rows if r.committed_at is not None]
    first_commit = min(committed_times) if committed_times else None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    gate_open = len(rows) >= 2 or (
        first_commit is not None
        and now >= first_commit + timedelta(days=21)
    )

    reviews_out: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        letter = chr(ord("A") + index) if index < 26 else str(index + 1)
        label = f"Reviewer {letter}"
        formal = formal_by_key.get(row.review_key)
        formal_body: dict[str, Any] = {}
        if formal is not None:
            fb = getattr(formal, "body", None)
            if isinstance(fb, dict):
                formal_body = fb

        item: dict[str, Any] = {
            "review_cid": row.review_cid,
            "reviewCid": row.review_cid,
            "label": label,
            "reviewer": label,
            "reviewer_label": label,
            "committed_at": (
                row.committed_at.isoformat() if row.committed_at is not None else None
            ),
            "revealed_at": (
                row.revealed_at.isoformat() if row.revealed_at is not None else None
            ),
            "scores": row.scores,
            "recommendation": row.recommendation,
            "confidence": row.confidence,
            "report_cid": row.report_cid or formal_body.get("reportCid") or formal_body.get("report_cid"),
            "signed_by": row.signed_by,
        }
        if formal is not None:
            item["reveal_cid"] = getattr(formal, "record_cid", None)
            item["formal_cid"] = getattr(formal, "record_cid", None)
            item["id"] = getattr(formal, "record_cid", None)

        # Serve the report body only when the gate is open.
        if gate_open and row.revealed_at is not None:
            report = formal_body.get("report")
            if isinstance(report, str):
                item["report"] = report
            report_cid = item.get("report_cid")
            # Preserve a possible content-stored body reference only.
        # When closed, 'report' is deliberately absent.

        reviews_out.append(item)

    return {
        "paper": getattr(view.paper, "short_id", None),
        "shortId": getattr(view.paper, "short_id", None),
        "paperCid": getattr(view.paper, "paper_cid", None),
        "versionCid": version_cid,
        "version_cid": version_cid,
        "version": getattr(version, "n", None),
        "n": getattr(version, "n", None),
        "reviews": reviews_out,
        "gate_open": gate_open,
    }
