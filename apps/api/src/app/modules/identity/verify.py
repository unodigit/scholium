"""POST /v1/auth/verify: check an Ed25519 signature over a nonce and issue tokens."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from .cookies import set_refresh_cookie
from .service import InvalidDid, InvalidNonce, InvalidSignature, verify_signin

__all__ = [
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


class VerifyRequest(BaseModel):
    """Body of ``POST /v1/auth/verify``."""

    did: str
    nonce: str
    signature: str


class VerifyResponse(BaseModel):
    """Tokens issued on a successful sign-in."""

    access_token: str
    refresh_token: str


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
    # The refresh token also travels as an HttpOnly cookie scoped to the
    # refresh path, so a browser never has to hold it in readable storage.
    set_refresh_cookie(response, request, refresh_token)
    return VerifyResponse(access_token=access_token, refresh_token=refresh_token)
