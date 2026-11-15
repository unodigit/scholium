"""Identity & access module (plugin: identity)."""

from __future__ import annotations

from fastapi import APIRouter

from .challenge import (
    INVALID_DID_TYPE,
    ChallengeRequest,
    ChallengeResponse,
    router as challenge_router,
)
from .models import (
    Account,
    AuthChallenge,
    RefreshToken,
    ensure_account_table,
    ensure_refresh_tokens_table,
    ensure_table,
)
from .service import (
    CHALLENGE_TTL,
    InvalidDid,
    InvalidNonce,
    InvalidSignature,
    NONCE_BYTES,
    REFRESH_TOKEN_TTL,
    issue_challenge,
    issue_refresh_token,
    validate_did,
    verify_signin,
)
from .verify import (
    VERIFY_FAILED_TYPE,
    VerifyRequest,
    VerifyResponse,
    router as verify_router,
)

#: Router the module loader mounts under ``/v1``.
router = APIRouter()
router.include_router(challenge_router)
router.include_router(verify_router)

__all__ = [
    "Account",
    "AuthChallenge",
    "CHALLENGE_TTL",
    "ChallengeRequest",
    "ChallengeResponse",
    "INVALID_DID_TYPE",
    "InvalidDid",
    "InvalidNonce",
    "InvalidSignature",
    "NONCE_BYTES",
    "REFRESH_TOKEN_TTL",
    "RefreshToken",
    "VERIFY_FAILED_TYPE",
    "VerifyRequest",
    "VerifyResponse",
    "ensure_account_table",
    "ensure_refresh_tokens_table",
    "ensure_table",
    "issue_challenge",
    "issue_refresh_token",
    "router",
    "validate_did",
    "verify_signin",
]
