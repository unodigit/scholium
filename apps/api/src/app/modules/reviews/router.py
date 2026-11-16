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
  or one that updates the reviewer's earlier review against a newer version
  (``prev`` names it); see :mod:`app.modules.reviews.reveal`.
* ``GET /v1/papers/{paper_id}/reviews`` -- the reviews of a listed version,
  each with the reviewer's ``history`` of updates; see
  :mod:`app.modules.reviews.history`.
* ``GET /v1/profiles/{did}/reviews`` -- the revealed reviews the DID signed
  with their name, for public credit (feature 111).
* ``POST /v1/reviews/{cid}/response`` -- accept a signed ``review.response``
  from a paper author with one reply per rubric dimension and save it to
  ``review_responses``; see :mod:`app.modules.reviews.response`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Response

from app import db
from app.errors import ProblemException
from app.modules.ingest.service import ingest
from app.security import Principal, get_current_principal, require_tier, Tier

from . import coi, response as responses, reveal, service
from .errors import ReviewResponseNotAuthorized
from .escrow import seal_identity
from .models import Review, ensure_table, ensure_tables
from .route_guard import dedicated_ingest

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

    # Seal the caller's identity *before* the commit reaches the log.  A
    # missing or malformed committee key must refuse the commit with nothing
    # appended; doing it afterwards would leave an orphan record that counts
    # toward the paper's review activity and the report gate.
    sealed_identity = seal_identity(principal.did)

    # The record is pseudonymous; the access token is the only thing that says
    # who reviewed.  Store that identity sealed for the committee -- never in
    # plaintext -- under the review it belongs to, and do it *before* the
    # append: the escrow's UNIQUE token is what makes a person one reviewer (the
    # report gate counts people by it), so it must be taken before the commit
    # can reach the log.  Checking it first and writing it afterwards lets two
    # simultaneous commits by one person both through, each under its own
    # review key, and one person opens the gate alone.  Exactly one of them
    # gets the slot; the rest are refused here (409) with nothing appended.
    service.reserve_review_escrow(
        review_cid=fields.review_cid,
        reviewer_did=principal.did,
        paper_cid=fields.paper_cid,
        sealed_identity=sealed_identity,
    )
    try:
        # The pipeline validates the envelope and body, verifies the signature,
        # runs the handler (which refuses a second commit), and appends the
        # record.
        with dedicated_ingest():
            result = ingest(record)
    except BaseException:
        # Refused or failed before the log took it: the slot goes back, so this
        # person may still commit an acceptable review.
        service.release_review_escrow(fields.review_cid)
        raise
    # The ledger subscriber normally saved the review as it was appended; this
    # is a no-op then, and the one that reports a failure when it did not.
    service.apply_review_commit(record)

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

    A reviewer may also revise their review against a newer version of the
    paper: a ``review.formal`` whose ``prev`` is the cid of their earlier one
    and whose ``target`` is the newer version.  It is the same review, so it
    needs no new commit and carries no commitment; it must be signed by the
    same review key, have a complete rubric of its own, and replace a review
    nobody has replaced yet.  Like a first reveal it is refused (``409``) until
    two independent reviewers have committed on the version it targets.  The
    answer names the same ``review``, and
    ``GET /v1/papers/{id}/reviews`` serves both reviews in its history.

    A body with ``"signed": true`` asks for public credit: the caller's DID is
    written to the review's ``signed_by``, so ``GET /v1/profiles/{did}`` and
    ``GET /v1/profiles/{did}/reviews`` serve it once revealed.  Only the
    reviewer who sealed the review may sign it -- the escrow's uniqueness
    token is what proves it -- and anyone else is refused (``403``) before
    their record reaches the log.

    Failures are RFC 9457 problem details: ``401`` for a missing token or a bad
    signature, ``403`` for a caller below tier 3 or one who asks to sign a
    review they did not seal, ``409`` for a review that was revealed (or, for
    an update, replaced) already, and ``422`` for an incomplete rubric, a
    review that was never sealed, content that does not match its commitment,
    a target this node does not hold, or an update whose ``prev`` is not the
    reviewer's own earlier review of an older version.
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
    # A review signed with the caller's name is public credit, so only the
    # person who sealed it may claim it.  Checked before the append, so a
    # refused signature writes nothing.
    reveal.require_public_signature(fields, principal.did)

    # The pipeline validates the envelope and body, verifies the signature,
    # runs the handler (which matches the commitment and enforces the report
    # gate) and appends the record.
    with dedicated_ingest():
        result = ingest(record)
    # The ledger subscriber normally filled in the review as the record was
    # appended; this is a no-op then, and the one that reports a failure when
    # it did not.  The caller's DID is what a ``"signed": true`` review is
    # credited to.
    review = reveal.apply_review_reveal(record, signer_did=principal.did)

    return {
        "id": result.record_id,
        "target": fields.version_cid,
        "review": review.review_cid,
        "prev": fields.prev,
        "signed": fields.signed,
        "signed_by": review.signed_by,
        "signedBy": review.signed_by,
        "state": result.state,
        "anchor": result.anchor,
    }


@router.get("/papers/{paper_id}/reviews")
def get_paper_reviews(paper_id: str) -> dict[str, Any]:
    """Return the formal reviews of a listed paper's resolved version.

    Report bodies stay hidden until two reviews are committed on the version or
    21 days have passed since the first commit; anonymous reviewers are labelled
    ``Reviewer A``, ``Reviewer B`` per paper.

    A reviewer who revised their review against a newer version (a
    ``review.formal`` whose ``prev`` names their earlier one) is one entry, not
    two: it shows their latest review as its own scores and recommendation, and
    carries every review of theirs, oldest version first, in ``history``.  The
    listing is as of the resolved version, so an older version's listing shows
    the reviews as they stood then.
    """
    from sqlalchemy import and_, or_

    from app.modules import submissions
    from app.modules.catalog.service import listed_versions, resolve as resolve_listed
    from . import history
    from .models import Review, ReviewResponse, ensure_tables

    ensure_tables()
    view = resolve_listed(paper_id)
    if view is None:
        raise _not_found(paper_id)

    version = view.version
    version_cid = version.version_cid

    # The listed versions up to this one, by number: the reviews a reader of
    # this version may see, an update of an earlier review among them.
    visible = {
        listed.version_cid: int(listed.n)
        for listed in listed_versions(view.paper)
        if int(listed.n) <= int(version.n)
    }
    visible[version_cid] = int(version.n)
    chains = history.paper_revisions(visible)
    # A reviewer who updated their review to this version is listed here, though
    # they sealed it on an earlier one.
    updated_keys = {
        key
        for key, chain in chains.items()
        if any(revision.version_cid == version_cid for revision in chain)
    }
    paper_versions = [
        known.version_cid for known in submissions.versions_for_paper(view.paper.paper_cid)
    ]

    # Committed review rows for this version, in commit order.
    wanted = [Review.version_cid == version_cid]
    if updated_keys:
        wanted.append(
            and_(Review.review_key.in_(updated_keys), Review.version_cid.in_(paper_versions))
        )
    with db.SessionLocal() as session:
        rows = (
            session.query(Review)
            .filter(or_(*wanted))
            .order_by(Review.committed_at, Review.review_cid)
            .all()
        )
        for row in rows:
            session.expunge(row)

    # The authors' point-by-point replies, keyed by the review they answer.
    responses_by_review: dict[str, list[ReviewResponse]] = {}
    review_cids = [row.review_cid for row in rows]
    if review_cids:
        with db.SessionLocal() as session:
            response_rows = (
                session.query(ReviewResponse)
                .filter(ReviewResponse.review_cid.in_(review_cids))
                .order_by(ReviewResponse.response_cid)
                .all()
            )
            for row in response_rows:
                session.expunge(row)
        for response_row in response_rows:
            responses_by_review.setdefault(response_row.review_cid, []).append(response_row)

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
        # The reviewer's reviews of this paper up to this version, oldest first;
        # the last is the one they stand on.
        reviewer_history = history.review_history(
            row, chains.get(row.review_key, []), report_allowed=gate_open
        )
        latest = reviewer_history[-1] if reviewer_history else None

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
            "report_cid": row.report_cid,
            "signed_by": row.signed_by,
            "version_cid": row.version_cid,
            "versionCid": row.version_cid,
            "version": visible.get(row.version_cid),
            "history": reviewer_history,
        }
        if latest is not None:
            # The review the reviewer stands on now: their latest, which is the
            # first one until they update it against a newer version.
            for key in (
                "revealed_at",
                "scores",
                "recommendation",
                "confidence",
                "report_cid",
                "version_cid",
                "versionCid",
                "version",
            ):
                item[key] = latest[key]
            item["reveal_cid"] = latest["formal_cid"]
            item["formal_cid"] = latest["formal_cid"]
            item["id"] = latest["formal_cid"]

        # The paper authors' point-by-point answers to this review.
        response_items = [
            {
                "response_cid": saved.response_cid,
                "responseCid": saved.response_cid,
                "cid": saved.response_cid,
                "id": saved.response_cid,
                "review_cid": saved.review_cid,
                "replies": saved.replies,
            }
            for saved in responses_by_review.get(row.review_cid, [])
        ]
        item["responses"] = response_items
        if response_items:
            item["response"] = response_items[0]
            item["replies"] = response_items[0]["replies"]

        # Serve the report body only when the gate is open (the history left
        # it out of each review otherwise); when closed, 'report' is
        # deliberately absent.
        if latest is not None and "report" in latest:
            item["report"] = latest["report"]

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


@router.get("/profiles/{did}/reviews")
def get_profile_reviews(did: str) -> dict[str, Any]:
    """Return the reviews ``did`` signed with their name, for public credit.

    Feature 111: a reviewer who reveals a review with ``"signed": true`` has
    their DID written to the review's ``signed_by``, and this route serves those
    reviews -- revealed only, so a signed review whose commitment is still
    sealed appears nowhere yet -- oldest reveal first.

    ``signed_by`` is the *account* DID the reveal was submitted with, not the
    pseudonymous review key the record is signed by; the escrow ties the two
    together.  The items carry the same public columns as the reviews on
    ``GET /v1/profiles/{did}``.  The route is public and answers ``200`` with an
    empty list for a DID that signed nothing.
    """
    ensure_tables()
    with db.SessionLocal() as session:
        rows = (
            session.query(Review)
            .filter(Review.signed_by == did, Review.revealed_at.is_not(None))
            .order_by(Review.revealed_at, Review.review_cid)
            .all()
        )
        for row in rows:
            session.expunge(row)

    reviews_out: list[dict[str, Any]] = []
    for row in rows:
        try:
            scores = row.scores
        except (TypeError, ValueError):  # pragma: no cover - undecodable JSON cell
            scores = None
        reviews_out.append(
            {
                "review_cid": row.review_cid,
                "version_cid": row.version_cid,
                "recommendation": row.recommendation,
                "confidence": row.confidence,
                "scores": scores,
                "report_cid": row.report_cid,
                "committed_at": (
                    row.committed_at.isoformat() if row.committed_at is not None else None
                ),
                "revealed_at": (
                    row.revealed_at.isoformat() if row.revealed_at is not None else None
                ),
            }
        )

    return {
        "did": did,
        "count": len(reviews_out),
        "reviews": reviews_out,
    }


@router.post("/reviews/{cid}/rating", status_code=201)
def rate_review(
    cid: str,
    payload: Any = Body(default=None),
    principal: Principal = Depends(require_tier(Tier.REVIEWER)),
) -> dict[str, Any]:
    """Record a tier-3 member's quality rating (1-5) of review ``cid``.

    The caller must be a tier-3 member who is neither the review's own author
    (its reviewer) nor an author of the paper the review targets.  The rating
    is stored in the ``review_ratings`` table.
    """
    ensure_tables()
    review = service.resolve_review(cid)
    if review is None:
        raise ProblemException(404, f"No review {cid!r}.")

    # Record-shaped body: a signed review.rating envelope.
    if isinstance(payload, dict) and payload.get("type") == "review.rating":
        # Authorization is enforced against the record's author, who must be
        # the caller: a rating is signed by the member casting it.
        author_did = payload.get("author")
        if not isinstance(author_did, str) or not author_did:
            raise ProblemException(422, "author is required")
        if author_did != principal.did:
            raise ProblemException(403, "The rating's author must be the caller.")
        # Target must match the path.
        body = payload.get("body")
        if isinstance(body, dict):
            target = body.get("review") or body.get("reviewCid") or body.get("review_cid")
            if isinstance(target, str) and target and target != review.review_cid and target != cid:
                raise ProblemException(422, "The rating targets a different review.")
        # Not the reviewer, not an author.
        paper_cid = None
        try:
            from app.modules.submissions.models import PaperVersion

            with db.SessionLocal() as session:
                pv = session.get(PaperVersion, review.version_cid)
                if pv is not None:
                    paper_cid = getattr(pv, "paper_cid", None)
        except Exception:
            paper_cid = None
        if paper_cid and service.is_review_author(author_did, review.version_cid):
            raise ProblemException(403, "An author of the paper may not rate its review.")
        if service.is_review_reviewer(author_did, review):
            raise ProblemException(403, "The reviewer of a review may not rate it.")
        # Run through the ingest pipeline (validates envelope/body/cid/sig).
        from app.modules.ingest.service import ingest

        with dedicated_ingest():
            result = ingest(payload)
        # The handler normally saved the row; ensure it exists.
        return {
            "id": result.record_id,
            "review_cid": review.review_cid,
            "reviewCid": review.review_cid,
            "rating": service.rating_value_from_body(body if isinstance(body, dict) else {}),
            "state": result.state,
            "anchor": result.anchor,
            "status": "recorded",
        }

    # Direct body: {"rating": N} (with common aliases).
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ProblemException(422, "body must be a JSON object.")
    rating = service.rating_value_from_body(payload)
    if rating is None:
        # maybe nested under "rating" already; try payload.get("rating")
        rating = service.rating_value_from_body({"rating": payload.get("rating")}) if "rating" in payload else None
    if rating is None or rating < 1 or rating > 5:
        raise ProblemException(422, "rating must be an integer from 1 to 5.")

    # Authorization: caller is neither reviewer nor author.
    if service.is_review_author(principal.did, review.version_cid):
        raise ProblemException(403, "An author of the paper may not rate its review.")
    if service.is_review_reviewer(principal.did, review):
        raise ProblemException(403, "The reviewer of a review may not rate it.")

    service.save_review_rating(review.review_cid, principal.did, rating)
    return {
        "review_cid": review.review_cid,
        "reviewCid": review.review_cid,
        "cid": review.review_cid,
        "id": review.review_cid,
        "rating": rating,
        "rater_did": principal.did,
        "rater": principal.did,
        "status": "recorded",
    }


@router.post("/reviews/{cid}/response", status_code=201)
def respond_to_review(
    cid: str,
    record: dict[str, Any] = Body(..., description="The signed review.response envelope."),
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """Accept a paper author's point-by-point ``review.response``.

    ``{cid}`` names the review being answered -- its ``review.commit`` cid or
    its revealed ``review.formal`` cid.  The record is signed by the author's
    own key, and the access token must belong to that same author: only
    someone on the paper's byline may answer its reviews (``403`` otherwise,
    reviewers and other members included).

    The body carries one reply per rubric dimension in ``items``; the replies
    are saved to ``review_responses`` and served with the review by
    ``GET /v1/papers/{id}/reviews``.

    Failures are RFC 9457 problem details: ``401`` for a missing token or a
    bad signature, ``403`` when the caller is not a paper author (or the record
    is signed by someone else), ``404`` when ``{cid}`` is no review here, and
    ``422`` for a malformed response or a body naming a different review.
    """
    if record.get("type") != responses.REVIEW_RESPONSE_TYPE:
        raise ProblemException(
            422,
            f"This endpoint accepts {responses.REVIEW_RESPONSE_TYPE!r} records, "
            f"got {record.get('type')!r}.",
            errors=[
                {
                    "loc": ["body", "type"],
                    "msg": f"The record must be a {responses.REVIEW_RESPONSE_TYPE}.",
                    "type": "wrong_record_type",
                    "input": record.get("type"),
                }
            ],
        )

    ensure_tables()
    review = service.resolve_review(cid)
    if review is None:
        raise ProblemException(404, f"No review {cid!r}.")

    # Shape-check the body, and make sure it answers the review under the path.
    fields = responses.response_fields(record)
    named = responses.resolve_response_review(fields)
    if named.review_cid != review.review_cid:
        raise ProblemException(
            422,
            "The response answers a different review than the one in the path.",
            errors=[
                {
                    "loc": ["body", "review"],
                    "msg": "The response must answer the review in the path.",
                    "type": "review_mismatch",
                    "input": fields.review_cid,
                }
            ],
        )

    # The signed record and the bearer token must name the same paper author.
    signer = record.get("author")
    if signer != principal.did or not responses.is_paper_author(principal.did, review):
        raise ReviewResponseNotAuthorized(principal.did, review.review_cid)

    # The pipeline validates the envelope and body, verifies the signature,
    # runs the handler (which re-checks the review and its author) and appends.
    with dedicated_ingest():
        result = ingest(record)
    # The ledger subscriber normally saved the response as it was appended;
    # this is a no-op then, and the one that reports a failure when it did not.
    saved = responses.apply_review_response(record)

    return {
        "id": result.record_id,
        "response_cid": saved.response_cid,
        "responseCid": saved.response_cid,
        "review_cid": saved.review_cid,
        "reviewCid": saved.review_cid,
        "review": saved.review_cid,
        "replies": saved.replies,
        "state": result.state,
        "anchor": result.anchor,
        "status": "recorded",
    }

