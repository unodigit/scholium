"""POST /v1/auth/refresh: rotate a refresh token (plugin: identity).

A refresh token issued by ``/v1/auth/verify`` is good for exactly one
refresh.  The browser flow sends no body: the token travels in the HttpOnly
``scholium_refresh`` cookie scoped to the auth path, and the rotated successor
is handed back the same way::

    POST /v1/auth/refresh                      # cookie: scholium_refresh=R1...

    200 OK
    Cache-Control: no-store
    Set-Cookie: scholium_refresh=R2...; HttpOnly; Max-Age=2592000;
                Path=/v1/auth; SameSite=Lax; Secure
    {
      "access_token": "eyJ...",         # a fresh 15-minute access token
      "expires_in": 900                 # seconds until it expires
    }

The JSON body never carries the refresh token: only the ``HttpOnly`` cookie
does.  Non-browser clients keep presenting the token in the JSON body exactly
as before (``{"refresh_token": "R1..."}``, read from the ``Set-Cookie`` header
of the sign-in response); when both are present the cookie wins, because in
the browser flow it is the only copy the client cannot lose track of.

A token presented again within the reuse grace window
(``REFRESH_REUSE_GRACE_SECONDS``, default 30 seconds) of its rotation returns
the same successor refresh token -- two tabs refreshing together must not sign
the user out.  The access token alongside it is minted afresh for the replay:
no access token is ever stored, so none can be replayed.  Presenting a retired token after that window -- rotated out, revoked by
logout, or revoked by a key rotation -- is treated as theft and revokes every
refresh token for the account before the request is refused, so a stolen
descendant dies with its ancestor.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- the refresh token is unknown, expired, or was already rotated
  out beyond its grace window (type :data:`INVALID_REFRESH_TOKEN_TYPE`).  The
  reason is not distinguished, so the endpoint cannot be probed for which
  tokens exist.  The cookie is cleared.
* ``401`` -- no refresh cookie and no body at all: the ordinary signed-out
  page load (type :data:`NO_SESSION_TYPE`).  It answers the same status as a
  dead cookie, which is what the web session bootstrap reads as "signed out".
* ``422`` -- a body was sent but carries no string ``refresh_token`` (and
  there is no cookie), or is not valid JSON / the wrong shape.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from app.security import ACCESS_TOKEN_TTL

from .cookies import (
    clear_refresh_cookie_headers,
    refresh_token_from_request,
    set_refresh_cookie,
)
from .service import InvalidRefreshToken, refresh_access

__all__ = [
    "ACCESS_TOKEN_EXPIRES_IN",
    "INVALID_REFRESH_TOKEN_TYPE",
    "NO_SESSION_TYPE",
    "RefreshRequest",
    "RefreshResponse",
    "router",
]

#: Router for the refresh endpoint (mounted under ``/v1`` by the package router).
router = APIRouter(prefix="/auth", tags=["auth"])

#: Problem-details type URN for a refresh token that cannot be used.
INVALID_REFRESH_TOKEN_TYPE = "urn:scholium:problem:invalid-refresh-token"

#: Problem-details type URN for a refresh with no cookie and no body: the
#: caller simply is not signed in (nothing was presented, so nothing was wrong).
NO_SESSION_TYPE = "urn:scholium:problem:no-session"

#: Lifetime of the access token in the response body, in seconds.
ACCESS_TOKEN_EXPIRES_IN = int(ACCESS_TOKEN_TTL.total_seconds())


class RefreshRequest(BaseModel):
    """Body of ``POST /v1/auth/refresh`` (optional in the cookie flow)."""

    refresh_token: Optional[str] = None


class RefreshResponse(BaseModel):
    """Tokens issued by one refresh.

    Only the access token and its expiry: the rotated refresh token travels in
    the ``HttpOnly`` cookie and never in a body a script can read.
    """

    access_token: str
    expires_in: int


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


def _no_session():
    from app.errors import ProblemException

    # No Set-Cookie: the browser holds no refresh cookie, so there is
    # nothing to clear.
    return ProblemException(
        401,
        "There is no session to refresh: the request carries no "
        "scholium_refresh cookie.",
        type=NO_SESSION_TYPE,
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
    cookie_token = refresh_token_from_request(request)
    if cookie_token is None and body is None:
        # Nothing presented at all -- the signed-out page load, not a
        # malformed request.
        raise _no_session()
    presented = cookie_token or (body.refresh_token if body is not None else None)
    if not isinstance(presented, str) or not presented:
        # A body was sent, but it names no token: malformed.
        raise _missing_token()
    try:
        access_token, refresh_token = refresh_access(presented)
    except InvalidRefreshToken as exc:
        raise _unauthorized(request) from exc
    # Both tokens are bearer secrets: never let a cache keep them.
    response.headers["Cache-Control"] = "no-store"
    set_refresh_cookie(response, request, refresh_token)
    return RefreshResponse(
        access_token=access_token, expires_in=ACCESS_TOKEN_EXPIRES_IN
    )
