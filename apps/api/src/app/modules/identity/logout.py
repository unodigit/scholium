"""POST /v1/auth/logout: revoke the caller's refresh token (plugin: identity).

Logging out retires a refresh token so it can never be exchanged for another
token pair.  The browser flow sends nothing but the HttpOnly ``scholium_refresh``
cookie -- the in-memory access token is gone after a reload, which is exactly
when a user clicks "sign out"::

    POST /v1/auth/logout                      # cookie: scholium_refresh=R1...

    204 No Content
    Cache-Control: no-store
    Set-Cookie: scholium_refresh=; Max-Age=0; Path=/v1/auth; ...

The cookie identifies the refresh-token family (every live refresh token of
the DID it was issued to), and the whole family is retired, so a stale copy of
the cookie cannot leave its live successor behind.  An ``Authorization`` header
is optional: a stale or expired bearer token never blocks a logout the cookie
can serve.

Non-browser clients keep presenting the token in the JSON body (read from
verify's ``Set-Cookie`` header)::

    POST /v1/auth/logout
    {"refresh_token": "R1..."}

or may identify themselves by access token alone, in which case every live
refresh token belonging to that DID is retired::

    POST /v1/auth/logout
    Authorization: Bearer eyJ...

    204 No Content

Revocation is server-side and idempotent: the presented token's SHA-256 hash
is looked up in ``refresh_tokens`` and the rows are marked ``rotated``, which
is the state ``/v1/auth/refresh`` refuses.  A token that is unknown or was
already revoked is not an error -- the end state the caller asked for already
holds -- so logout still answers ``204``.  This also means the endpoint cannot
be probed for which refresh tokens exist.  Every ``204`` clears the cookie.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no credential was supplied (no refresh cookie, no ``refresh_token``
  in the body, and no valid access token in the ``Authorization`` header), or
  the bearer token is not a valid access token and nothing else identifies the
  caller.
* ``422`` -- a JSON body was sent without a string ``refresh_token`` (the
  standard validation problem).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.security import InvalidAccessToken, decode_access_token

from .cookies import clear_refresh_cookie, refresh_token_from_request
from .service import (
    revoke_refresh_token,
    revoke_refresh_token_family,
    revoke_refresh_tokens_for_did,
)

__all__ = [
    "LOGOUT_UNAUTHENTICATED_TYPE",
    "LogoutRequest",
    "router",
]

#: Router for the logout endpoint (mounted under ``/v1`` by the package router).
router = APIRouter(prefix="/auth", tags=["auth"])

#: Problem-details type URN for a logout with no credential at all.
LOGOUT_UNAUTHENTICATED_TYPE = "urn:scholium:problem:unauthenticated"

_bearer = HTTPBearer(auto_error=False)


class LogoutRequest(BaseModel):
    """Body of ``POST /v1/auth/logout``."""

    refresh_token: str


def _unauthorized():
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.identity` half-initialized with no
    # `router` attribute and silently skip mounting it.
    from app.errors import ProblemException

    return ProblemException(
        401,
        "Logging out requires the refresh cookie, a refresh token in the "
        "body, or an 'Authorization: Bearer <access token>' header.",
        type=LOGOUT_UNAUTHENTICATED_TYPE,
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post(
    "/logout",
    status_code=204,
    response_class=Response,
    summary="Revoke the caller's refresh token",
)
def post_logout(
    request: Request,
    body: Optional[LogoutRequest] = None,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Response:
    """Revoke the cookie's token family, the body's token, or the bearer's tokens."""
    cookie_token = refresh_token_from_request(request)

    if cookie_token is None and body is None and credentials is None:
        raise _unauthorized()

    if cookie_token is not None:
        # The browser flow: the HttpOnly cookie is the credential, the bearer
        # (long gone after a reload) is optional.  The whole family goes, so a
        # stale cookie cannot strand its live successor.  Idempotent: an
        # unknown or already-revoked token is still "logged out".
        revoke_refresh_token_family(cookie_token)

    if body is not None:
        revoke_refresh_token(body.refresh_token)
    elif credentials is not None:
        try:
            principal = decode_access_token(credentials.credentials)
        except InvalidAccessToken as exc:
            # A stale bearer must not turn a logout the cookie can serve into
            # an error; it only fails when it was the sole credential.
            if cookie_token is None:
                raise _unauthorized() from exc
        else:
            # The whole family goes, which covers the HttpOnly cookie too.
            revoke_refresh_tokens_for_did(principal.did)

    response = Response(status_code=204, headers={"Cache-Control": "no-store"})
    clear_refresh_cookie(response, request)
    return response
