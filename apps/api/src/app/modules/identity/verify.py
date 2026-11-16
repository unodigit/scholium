"""POST /v1/auth/verify: check an Ed25519 signature over a nonce and issue tokens.

A successful sign-in answers with the access token and its lifetime; the
long-lived refresh token is delivered *only* as the ``HttpOnly``
``scholium_refresh`` cookie (see :mod:`app.modules.identity.cookies`), so page
JavaScript can never read it::

    POST /v1/auth/verify {"did": ..., "nonce": ..., "signature": ...}

    200 OK
    Cache-Control: no-store
    Set-Cookie: scholium_refresh=<raw>; HttpOnly; Max-Age=2592000;
                Path=/v1/auth; SameSite=Lax; Secure
    {
      "access_token": "eyJ...",
      "expires_in": 900                  # seconds until the access token expires
    }

Python and other non-browser clients read the refresh token from the
``Set-Cookie`` response header and may present it in a JSON body to
``/v1/auth/refresh`` exactly as before.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from app.security import ACCESS_TOKEN_TTL

from .cookies import set_refresh_cookie
from .service import InvalidDid, InvalidNonce, InvalidSignature, verify_signin

__all__ = [
    "ACCESS_TOKEN_EXPIRES_IN",
    "VERIFY_FAILED_TYPE",
    "VerifyRequest",
    "VerifyResponse",
    "router",
]

#: Router for the verify endpoint (mounted under ``/v1`` by the package router).
router = APIRouter(prefix="/auth", tags=["auth"])

#: Problem-details type URN for a sign-in that cannot be authenticated.
VERIFY_FAILED_TYPE = "urn:scholium:problem:authentication-failed"

INVALID_DID_TYPE = "urn:scholium:problem:invalid-did"

#: Lifetime of the access token in the response body, in seconds.
ACCESS_TOKEN_EXPIRES_IN = int(ACCESS_TOKEN_TTL.total_seconds())


class VerifyRequest(BaseModel):
    """Body of ``POST /v1/auth/verify``."""

    did: str
    nonce: str
    signature: str


class VerifyResponse(BaseModel):
    """Tokens issued on a successful sign-in.

    Only the access token and its expiry: the refresh token travels in the
    ``HttpOnly`` cookie and never in a body a script can read.
    """

    access_token: str
    expires_in: int


def _invalid_did():
    from app.errors import ProblemException
    return ProblemException(
        422,
        "'did' must be a canonical Ed25519 did:key identifier "
        "(for example did:key:z6Mk...).",
        type=INVALID_DID_TYPE,
    )


def _unauthorized():
    from app.errors import ProblemException
    return ProblemException(
        401,
        "The sign-in could not be verified.",
        type=VERIFY_FAILED_TYPE,
    )


@router.post(
    "/verify",
    response_model=VerifyResponse,
    summary="Verify a signed nonce and issue access and refresh tokens",
)
def post_verify(body: VerifyRequest, response: Response, request: Request) -> VerifyResponse:
    try:
        access_token, refresh_token = verify_signin(body.did, body.nonce, body.signature)
    except InvalidDid as exc:
        raise _invalid_did() from exc
    except (InvalidNonce, InvalidSignature) as exc:
        raise _unauthorized() from exc
    response.headers["Cache-Control"] = "no-store"
    # The refresh token travels only as an HttpOnly cookie scoped to the auth
    # path, so a browser never has to hold it in readable storage.
    set_refresh_cookie(response, request, refresh_token)
    return VerifyResponse(
        access_token=access_token, expires_in=ACCESS_TOKEN_EXPIRES_IN
    )
