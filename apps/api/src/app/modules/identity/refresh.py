"""POST /v1/auth/refresh: rotate a refresh token (plugin: identity).

A refresh token issued by ``/v1/auth/verify`` is good for exactly one
refresh::

    POST /v1/auth/refresh
    {"refresh_token": "R1..."}          # exactly as /v1/auth/verify returned it

    200 OK
    Cache-Control: no-store
    {
      "access_token": "eyJ...",         # a fresh 15-minute access token
      "refresh_token": "R2..."          # R2 != R1: the token was rotated
    }

Rotation is server-side and one-shot: the presented token's SHA-256 hash is
looked up in ``refresh_tokens`` and the row is retired (``rotated`` flag)
before the new pair is issued, so presenting ``R1`` again::

    401 Unauthorized
    Content-Type: application/problem+json

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- the refresh token is unknown, expired, or was already rotated
  out (type :data:`INVALID_REFRESH_TOKEN_TYPE`).  The reason is not
  distinguished, so the endpoint cannot be probed for which tokens exist.
* ``422`` -- the body is not JSON with a string ``refresh_token`` (the
  standard validation problem).
"""

from __future__ import annotations

from fastapi import APIRouter, Response
from pydantic import BaseModel

from .service import InvalidRefreshToken, refresh_access

__all__ = [
    "INVALID_REFRESH_TOKEN_TYPE",
    "RefreshRequest",
    "RefreshResponse",
    "router",
]

#: Router for the refresh endpoint (mounted under ``/v1`` by the package router).
router = APIRouter(prefix="/auth", tags=["auth"])

#: Problem-details type URN for a refresh token that cannot be used.
INVALID_REFRESH_TOKEN_TYPE = "urn:scholium:problem:invalid-refresh-token"


class RefreshRequest(BaseModel):
    """Body of ``POST /v1/auth/refresh``."""

    refresh_token: str


class RefreshResponse(BaseModel):
    """Tokens issued by one refresh."""

    access_token: str
    refresh_token: str


def _unauthorized():
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.identity` half-initialized with no
    # `router` attribute and silently skip mounting it.  (Same reason as the
    # challenge and verify endpoints.)
    from app.errors import ProblemException

    return ProblemException(
        401,
        "The refresh token is invalid, expired, or was already used.",
        type=INVALID_REFRESH_TOKEN_TYPE,
    )


@router.post(
    "/refresh",
    response_model=RefreshResponse,
    summary="Rotate a refresh token, retiring the one presented",
)
def post_refresh(body: RefreshRequest, response: Response) -> RefreshResponse:
    """Retire ``refresh_token`` and issue a fresh access/refresh pair."""
    try:
        access_token, refresh_token = refresh_access(body.refresh_token)
    except InvalidRefreshToken as exc:
        raise _unauthorized() from exc
    # Both tokens are bearer secrets: never let a cache keep them.
    response.headers["Cache-Control"] = "no-store"
    return RefreshResponse(access_token=access_token, refresh_token=refresh_token)
