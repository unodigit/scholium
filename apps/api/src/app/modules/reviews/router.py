"""HTTP routes for the reviews plugin.

The module loader mounts this router under ``/v1``, so this package serves:

* ``POST /v1/papers/{paper_id}/review-invitations`` -- save an invitation to
  the ``review_invitations`` table.
* ``GET /v1/papers/{paper_id}/coi-check`` -- the conflict-of-interest checks
  (not an author, no co-authorship in 3 years, different institution) for the
  calling reviewer; see :mod:`app.modules.reviews.coi`.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Response

from app.errors import ProblemException
from app.security import Principal, get_current_principal, Tier

from . import coi, service
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
