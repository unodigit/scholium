"""POST /v1/auth/challenge: start a did:key sign-in (plugin: identity).

Sign-in is challenge-response.  The client asks for a nonce for the did:key it
wants to sign in as::

    POST /v1/auth/challenge
    {"did": "did:key:z6Mk..."}

    200 OK
    Cache-Control: no-store
    {
      "nonce": "q3V7...",                      # 256 random bits, URL-safe
      "did": "did:key:z6Mk...",
      "expires_at": "2026-11-15T09:35:12Z"     # five minutes after issue
    }

The nonce is saved in the ``auth_challenges`` table (unused, bound to that
did) and is good for one sign-in: ``POST /v1/auth/verify`` checks the client's
signature over it and consumes it.  Asking again issues a fresh, independent
nonce; earlier ones stay valid until they are used or expire.

The endpoint is unauthenticated by nature -- it runs before there is a token --
and does not reveal whether the did already has an account.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``422`` -- the body is not JSON with a string ``did`` (the standard
  validation problem), or ``did`` is not a canonical Ed25519 did:key (type
  :data:`INVALID_DID_TYPE`).  Nothing is saved.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, field_serializer

from .models import AuthChallenge
from .service import InvalidDid, issue_challenge

__all__ = [
    "INVALID_DID_TYPE",
    "ChallengeRequest",
    "ChallengeResponse",
    "router",
]

#: Router for the challenge endpoint (mounted under ``/v1`` by the package router).
router = APIRouter(prefix="/auth", tags=["auth"])

#: Problem-details type URN for a ``did`` that is not a canonical Ed25519 did:key.
INVALID_DID_TYPE = "urn:scholium:problem:invalid-did"


class ChallengeRequest(BaseModel):
    """Body of ``POST /v1/auth/challenge``."""

    did: str


class ChallengeResponse(BaseModel):
    """A freshly issued challenge."""

    model_config = ConfigDict(extra="forbid")

    #: Opaque single-use value the client signs to prove it holds the key.
    nonce: str
    #: The did:key the challenge was issued to.
    did: str
    #: UTC instant after which the nonce is refused (ISO 8601, ``Z`` suffix).
    expires_at: datetime

    @field_serializer("expires_at")
    def _serialise_expires_at(self, value: datetime) -> str:
        # auth_challenges stores naive UTC timestamps; serve one unambiguous instant.
        return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _invalid_did() -> HTTPException:
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.identity` half-initialized with no
    # `router` attribute and silently skip mounting it.  (Same reason as the
    # ledger and uploads plugins.)
    from app.errors import ProblemException

    # The offending value is deliberately not echoed back.
    return ProblemException(
        422,
        "'did' must be a canonical Ed25519 did:key identifier "
        "(for example did:key:z6Mk...).",
        type=INVALID_DID_TYPE,
    )


def serialise_challenge(challenge: AuthChallenge) -> ChallengeResponse:
    """Map one persisted row onto its wire form."""
    return ChallengeResponse(
        nonce=challenge.nonce,
        did=challenge.did,
        expires_at=challenge.expires_at,
    )


@router.post(
    "/challenge",
    response_model=ChallengeResponse,
    summary="Issue a single-use sign-in nonce for a did:key",
)
def post_challenge(body: ChallengeRequest, response: Response) -> ChallengeResponse:
    """Issue a nonce for ``did`` that expires in five minutes."""
    try:
        challenge = issue_challenge(body.did)
    except InvalidDid as exc:
        raise _invalid_did() from exc
    # The nonce is a bearer secret until it is used: never let a cache keep it.
    response.headers["Cache-Control"] = "no-store"
    return serialise_challenge(challenge)
