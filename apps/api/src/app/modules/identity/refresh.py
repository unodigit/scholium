"""POST /v1/auth/refresh: rotate a refresh token (plugin: identity).

A refresh token issued by ``/v1/auth/verify`` is good for exactly one
refresh.  The browser flow sends no body: the token travels in the HttpOnly
``scholium_refresh`` cookie scoped to this path, and the rotated successor is
handed back the same way::

    POST /v1/auth/refresh                      # cookie: scholium_refresh=R1...

    200 OK
    Cache-Control: no-store
    Set-Cookie: scholium_refresh=R2...; HttpOnly; Max-Age=2592000;
                Path=/v1/auth/refresh; SameSite=strict; Secure
    {
      "access_token": "eyJ...",         # a fresh 15-minute access token
      "refresh_token": "R2..."          # R2 != R1: the token was rotated
    }

Non-browser clients may keep presenting the token in the JSON body exactly
as before (``{"refresh_token": "R1..."}``); when both are present the cookie
wins, because in the browser flow it is the only copy the client cannot
lose track of.

Presenting a token that was already retired -- rotated out, revoked by
logout, or revoked by a key rotation -- is treated as theft and revokes
every refresh token for the account before the request is refused, so a
stolen descendant dies with its ancestor.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- the refresh token is unknown, expired, or was already rotated
  out (type :data:`INVALID_REFRESH_TOKEN_TYPE`).  The reason is not
  distinguished, so the endpoint cannot be probed for which tokens exist.
  The cookie is cleared.
* ``422`` -- neither a refresh cookie nor a string ``refresh_token`` in the
  body was supplied.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from .cookies import (
    clear_refresh_cookie_headers,
    refresh_token_from_request,
    set_refresh_cookie,
)
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
    """Body of ``POST /v1/auth/refresh`` (optional in the cookie flow)."""

    refresh_token: Optional[str] = None


class RefreshResponse(BaseModel):
    """Tokens issued by one refresh."""

    access_token: str
    refresh_token: str


def _unauthorized(request: Request):
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
        # The token (and its family) is dead: drop the cookie with it.  The
        # header rides on the exception because FastAPI discards the injected
        # Response's headers when a handler raises.
        headers=clear_refresh_cookie_headers(request),
    )


def _missing_token():
    from app.errors import ProblemException

    return ProblemException(
        422,
        "A refresh token is required: the scholium_refresh cookie or a "
        "string 'refresh_token' in the body.",
        type=INVALID_REFRESH_TOKEN_TYPE,
        errors=[
            {
                "loc": ["body", "refresh_token"],
                "msg": "Field required",
                "type": "missing",
            }
        ],
    )


@router.post(
    "/refresh",
    response_model=RefreshResponse,
    summary="Rotate a refresh token, retiring the one presented",
)
def post_refresh(
    response: Response,
    request: Request,
    body: Optional[RefreshRequest] = None,
) -> RefreshResponse:
    """Retire the presented refresh token and issue a fresh access/refresh pair."""
    presented = refresh_token_from_request(request) or (
        body.refresh_token if body is not None else None
    )
    if not isinstance(presented, str) or not presented:
        raise _missing_token()
    try:
        access_token, refresh_token = refresh_access(presented)
    except InvalidRefreshToken as exc:
        raise _unauthorized(request) from exc
    # Both tokens are bearer secrets: never let a cache keep them.
    response.headers["Cache-Control"] = "no-store"
    set_refresh_cookie(response, request, refresh_token)
    return RefreshResponse(access_token=access_token, refresh_token=refresh_token)
