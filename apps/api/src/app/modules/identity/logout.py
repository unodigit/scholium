"""POST /v1/auth/logout: revoke the caller's refresh token (plugin: identity).

Logging out retires a refresh token so it can never be exchanged for another
token pair::

    POST /v1/auth/logout
    {"refresh_token": "R1..."}          # read from verify's Set-Cookie header

    204 No Content
    Cache-Control: no-store

The token may instead be identified by the caller's access token, in which
case every live refresh token belonging to that DID is retired::

    POST /v1/auth/logout
    Authorization: Bearer eyJ...

    204 No Content

Revocation is server-side and idempotent: the presented token's SHA-256 hash
is looked up in ``refresh_tokens`` and the row is marked ``rotated``, which is
the state ``/v1/auth/refresh`` refuses.  A token that is unknown or was
already revoked is not an error -- the end state the caller asked for already
holds -- so logout still answers ``204``.  This also means the endpoint cannot
be probed for which refresh tokens exist.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no credential was supplied (neither a ``refresh_token`` in the
  body nor a valid access token in the ``Authorization`` header), or the
  bearer token is not a valid access token.
* ``422`` -- a JSON body was sent without a string ``refresh_token`` (the
  standard validation problem).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.security import InvalidAccessToken, decode_access_token

from .cookies import clear_refresh_cookie
from .service import revoke_refresh_token, revoke_refresh_tokens_for_did

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
        "Logging out requires a refresh token in the body or an "
        "'Authorization: Bearer <access token>' header.",
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
    """Revoke the presented refresh token, or every token for the bearer."""
    if body is not None:
        # Idempotent: an unknown or already-revoked token is still "logged out".
        revoke_refresh_token(body.refresh_token)
        response = Response(status_code=204, headers={"Cache-Control": "no-store"})
        clear_refresh_cookie(response, request)
        return response

    if credentials is not None:
        try:
            principal = decode_access_token(credentials.credentials)
        except InvalidAccessToken as exc:
            raise _unauthorized() from exc
        # The whole family goes, which covers the HttpOnly refresh cookie too.
        revoke_refresh_tokens_for_did(principal.did)
        response = Response(status_code=204, headers={"Cache-Control": "no-store"})
        clear_refresh_cookie(response, request)
        return response

    raise _unauthorized()
