"""HTTP routes for the discussion plugin.

The module loader mounts this router under ``/v1``, so the routes below serve:

* ``GET  /v1/papers/{id}/threads`` -- the paper's threads, each with its
  replies, ordered by helpful votes (most first) then time (oldest first)::

      {
        "paper": "sch:xxxx-xxxx-xxxx",
        "paper_cid": "bafyrei...",
        "count": 3,
        "threads": [
          {"post_cid": "bafyrei...", "author": "did:key:...", "text": "...",
           "helpful": 2, "replies": [{"post_cid": "bafyrei...", ...}]},
          ...
        ]
      }

  Reading is public, like reading a record.  When the request carries an
  access token, posts by DIDs that caller has muted are omitted.

* ``POST /v1/papers/{id}/threads`` -- accept a signed ``discussion.post`` and
  answer ``201`` with its cid.  Only tier-1 (Member) and above may post.

* ``POST /v1/posts/{cid}/helpful`` -- mark a post helpful; ``201`` the first
  time, ``409`` when the same member repeats it.  A vote only reorders the
  thread and never changes the paper's status.

* ``POST /v1/me/mutes`` -- mute another DID for the caller; ``201``.

Failures are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no usable access token where one is required;
* ``403`` -- the caller is below tier 1;
* ``404`` -- no such post;
* ``409`` -- the caller already marked the post helpful;
* ``422`` -- the submitted record is not a ``discussion.post`` or is invalid.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.errors import ProblemException
from app.modules.ingest.service import ingest
from app.security import (
    InvalidAccessToken,
    Principal,
    Tier,
    decode_access_token,
    get_current_principal,
    require_tier,
)

from . import service

__all__ = ["router"]

router = APIRouter(tags=["discussion"])

#: Bearer credentials for routes that read differently when signed in.
_optional_bearer = HTTPBearer(auto_error=False)


def _optional_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_optional_bearer),
) -> Optional[Principal]:
    """The caller when the request carries a usable token, otherwise ``None``.

    Reading a paper's threads is public; a token is only needed to apply the
    caller's mutes.  A token that is present but unusable is ignored rather
    than turning a readable page into a ``401``.
    """
    if credentials is None:
        return None
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken:
        return None


def _first(payload: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


# --------------------------------------------------------------------------- #
# Threads
# --------------------------------------------------------------------------- #


@router.get(
    "/papers/{paper_id}/threads",
    summary="List a paper's discussion threads and their replies",
)
def get_threads(
    paper_id: str,
    principal: Optional[Principal] = Depends(_optional_principal),
) -> dict[str, Any]:
    """Return the paper's threads, replies ordered by helpful votes then time."""
    ref = service.resolve_paper(paper_id)
    if ref is None:
        raise ProblemException(404, f"No paper {paper_id!r}.")
    return service.threads_for(ref, viewer_did=None if principal is None else principal.did)


@router.post(
    "/papers/{paper_id}/threads",
    status_code=201,
    summary="Submit a signed discussion.post",
    dependencies=[Depends(require_tier(int(Tier.MEMBER)))],
)
def post_thread(
    paper_id: str,
    record: dict[str, Any] = Body(..., description="The signed discussion.post envelope."),
) -> dict[str, Any]:
    """Accept a signed ``discussion.post``; answer ``201`` with its cid."""
    if record.get("type") != service.DISCUSSION_POST_TYPE:
        raise ProblemException(
            422,
            f"This endpoint accepts {service.DISCUSSION_POST_TYPE!r} records, "
            f"got {record.get('type')!r}.",
            errors=[
                {
                    "loc": ["body", "type"],
                    "msg": "The record must be a discussion.post.",
                    "type": "wrong_record_type",
                    "input": record.get("type"),
                }
            ],
        )

    ref = service.resolve_paper(paper_id)
    if ref is None:
        raise ProblemException(404, f"No paper {paper_id!r}.")

    result = ingest(record)
    # The ledger subscriber normally persists the row; this also records the
    # canonical paper key when the URL resolved better than the record body.
    service.persist_record(record, paper_key=ref.paper_cid)

    paper = ref.short_id or ref.paper_cid
    return {
        "id": result.record_id,
        "cid": result.record_id,
        "post_cid": result.record_id,
        "postCid": result.record_id,
        "state": result.state,
        "anchor": result.anchor,
        "paper": paper,
        "paper_cid": ref.paper_cid,
        "paperCid": ref.paper_cid,
    }


# --------------------------------------------------------------------------- #
# Helpful votes (feature 101)
# --------------------------------------------------------------------------- #


@router.post(
    "/posts/{post_cid}/helpful",
    status_code=201,
    summary="Mark a discussion post helpful",
)
def mark_helpful(
    post_cid: str,
    principal: Principal = Depends(require_tier(int(Tier.MEMBER))),
) -> dict[str, Any]:
    """Record one member's helpful mark; a repeat by the same member is ``409``."""
    post, created = service.mark_helpful(post_cid, principal.did)
    if post is None:
        raise ProblemException(404, f"No discussion post {post_cid!r}.")
    if not created:
        raise ProblemException(
            409,
            f"The caller has already marked post {post_cid!r} helpful.",
            type=service.ALREADY_HELPFUL_TYPE,
        )
    return {
        "post_cid": post_cid,
        "postCid": post_cid,
        "cid": post_cid,
        "id": post_cid,
        "helpful": int(post.helpful or 0),
        "status": "recorded",
    }


# --------------------------------------------------------------------------- #
# Mutes (feature 102)
# --------------------------------------------------------------------------- #

_MUTE_KEYS = (
    "did",
    "muted_did",
    "mutedDid",
    "muted",
    "did_to_mute",
    "didToMute",
    "blocked_did",
    "blockedDid",
    "target",
    "target_did",
    "targetDid",
)


@router.post(
    "/me/mutes",
    status_code=201,
    summary="Mute another DID in discussion",
)
def create_mute(
    payload: Any = Body(default=None),
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """Mute a DID for the caller so the caller's thread reads omit their posts."""
    muted = _first(payload, _MUTE_KEYS)
    if muted is None:
        raise ProblemException(422, "A DID to mute is required.")
    muted = str(muted).strip()
    if not muted:
        raise ProblemException(422, "A DID to mute is required.")
    if muted == principal.did:
        raise ProblemException(422, "A member cannot mute themselves.")
    service.mute(principal.did, muted)
    return {
        "muter": principal.did,
        "muter_did": principal.did,
        "muted": muted,
        "muted_did": muted,
        "did": muted,
        "status": "muted",
    }
