"""HTTP route for the ``me`` plugin (feature 126).

The module loader mounts this router under ``/v1``, so this package serves:

``GET /v1/me/dashboard``
    The signed-in caller's home screen, in one document::

        {
          "did": "did:key:z6Mk...",
          "needs_attention": {
            "count": 2,
            "consents_to_sign": [
              {"kind": "consent_to_sign",
               "summary": "Sign your co-author consent for sch:xxxx-xxxx-xxxx",
               "reason": null,
               "paper": "sch:xxxx-xxxx-xxxx", "shortId": "sch:xxxx-xxxx-xxxx",
               "paperCid": "bafyrei...",
               "version": 1, "versionCid": "bafyrei...",
               "version_cid": "bafyrei...",
               "title": "A paper whose co-author has not signed",
               "link": "/consent/bafyrei...", "createdAt": null,
               "role": ["Conceptualization"],
               "creditRoles": ["Conceptualization"], "status": "waiting"}
            ],
            "review_invitations": [
              {"kind": "review_invitation", ..., "invitationId": "inv-1",
               "id": "inv-1", "status": "pending"}
            ],
            "author_replies": [
              {"kind": "author_reply", ..., "reviewCid": "bafyrei...",
               "responseCid": "bafyrei...", "responses": [...]}
            ],
            "moderation_outcomes": [
              {"kind": "moderation_outcome", ..., "decisionCid": "bafyrei...",
               "action": "hold", "clause": "2.1", "source": "decision"}
            ],
            "items": [ ... every entry above, flat, in dashboard order ... ]
          },
          "my_papers": [
            {"paper": "sch:xxxx-xxxx-xxxx", "shortId": "sch:xxxx-xxxx-xxxx",
             "paperCid": "bafyrei...", "title": "...", "status": "preprint",
             "categories": ["cs.CR"], "role": "author",
             "versionCount": 1, "latestVersion": 1,
             "latestVersionCid": "bafyrei...", "state": "awaiting_consent",
             "reviewCount": 0, "revealedCount": 0,
             "listedAt": null, "claimed": true, "link": "/p/sch:xxxx-xxxx-xxxx"}
          ],
          "my_reviews": [
            {"reviewCid": "bafyrei...", "state": "sealed",
             "sealed": true, "revealed": false,
             "paper": "sch:...", "paperCid": "bafyrei...",
             "version": 1, "versionCid": "bafyrei...", "title": "...",
             "committedAt": "2026-11-16T10:00:00",
             "revealedAt": null, "recommendation": null, "confidence": null,
             "scores": null, "signedBy": null,
             "authorReplied": false, "awaitingAuthor": false,
             "responseCount": 0, "link": "/review/sch:..."}
          ]
        }

    ``needs_attention`` groups the four categories the feature names
    (``consents_to_sign``, ``review_invitations``, ``author_replies``,
    ``moderation_outcomes``) and also offers ``items``, the same entries as one
    flat list, so a client may render either shape.  Every entry names the
    paper and version it is about by the ``sch:`` short id, the genesis cid,
    the version cid and the title.

    ``my_papers`` lists the papers the caller signed or is a listed author of,
    with the stored lifecycle status, the latest version's state and the
    paper's committed and revealed review counts.  ``my_reviews`` lists the
    reviews the caller wrote -- found through the review escrow token, so the
    node never stores a plaintext DID-to-review mapping -- with state
    ``sealed`` or ``revealed`` and whether the authors have replied.  The
    pseudonymity material (``review_key``, ``nullifier``) is never served.

    Any signed-in member may read their own dashboard; it names nobody else's
    work.  No or unusable token: ``401`` problem details with a
    ``WWW-Authenticate`` challenge, from ``app.security.get_current_principal``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.security import Principal, get_current_principal

from .service import build_dashboard

__all__ = ["router"]

#: Router the module loader mounts under ``/v1``.
router = APIRouter(prefix="/me", tags=["me"])


@router.get(
    "/dashboard",
    summary="The caller's home screen: needs attention, my papers, my reviews",
)
def my_dashboard(
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """Return the authenticated caller's dashboard."""
    return build_dashboard(principal.did)
