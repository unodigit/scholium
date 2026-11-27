"""Identity & access module (plugin: identity)."""

from __future__ import annotations

from fastapi import APIRouter

from . import same_site
from .challenge import (
    INVALID_DID_TYPE,
    ChallengeRequest,
    ChallengeResponse,
    router as challenge_router,
)
from .cookies import (
    DEFAULT_REFRESH_COOKIE_SAMESITE,
    REFRESH_COOKIE_MAX_AGE,
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_PATH,
    REFRESH_COOKIE_SAMESITE,
    clear_refresh_cookie,
    refresh_cookie_samesite,
    refresh_token_from_request,
    set_refresh_cookie,
)
from .document import (
    KEY_ROTATION_TYPE,
    DidDocument,
    KeyRotationEntry,
    resolve_did_document,
    router as document_router,
)
from .email_signin import router as email_signin_router
from .logout import (
    LOGOUT_UNAUTHENTICATED_TYPE,
    LogoutRequest,
    router as logout_router,
)
from .models import (
    Account,
    AccountKey,
    AuthChallenge,
    RefreshToken,
    ensure_account_keys_table,
    ensure_account_table,
    ensure_refresh_tokens_table,
    ensure_table,
)
from .refresh import (
    INVALID_REFRESH_TOKEN_TYPE,
    RefreshRequest,
    RefreshResponse,
    router as refresh_router,
)
from .service import (
    CHALLENGE_TTL,
    DEFAULT_REFRESH_REUSE_GRACE_SECONDS,
    InvalidDid,
    InvalidNonce,
    InvalidRefreshToken,
    InvalidSignature,
    NONCE_BYTES,
    REFRESH_REUSE_GRACE_SECONDS,
    REFRESH_TOKEN_TTL,
    install_key_rotation_subscriber,
    refresh_access,
    refresh_reuse_grace_seconds,
    revoke_refresh_token,
    revoke_refresh_tokens_for_did,
    active_key_for,
    active_signing_key,
    add_account_key,
    get_active_key,
    issue_challenge,
    issue_refresh_token,
    key_for,
    purge_expired_challenges,
    record_active_key,
    resolve_active_key,
    resolve_active_signing_key,
    resolve_key,
    resolve_signing_key,
    get_active_signing_key,
    active_signing_key_for,
    resolve_active_key_for,
    signing_key_for,
    get_key_for_did,
    resolve_active,
    resolve_active_signing_key_for_did,
    get_active_key_for,
    active_key_at,
    resolve_active_key_at,
    active_key,
    signing_key,
    get_signing_key,
    set_active_key,
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
router.include_router(document_router)
router.include_router(email_signin_router)
router.include_router(logout_router)
router.include_router(refresh_router)
router.include_router(verify_router)

# A key rotation (or a guardians recovery) landing in the event log must
# revoke every refresh token for the rotated DID.  Registered at import, the
# same way the appeals and moderation plugins install their subscribers; the
# ledger is imported inside the installer so package import order is free.
install_key_rotation_subscriber()

# The module loader calls this while assembling the app (``on_startup`` /
# ``startup`` hooks): warn when the configured web origins cannot send the
# refresh cookie because they are cross-site from the API.
on_startup = same_site.on_startup

__all__ = [
    "Account",
    "AccountKey",
    "AuthChallenge",
    "CHALLENGE_TTL",
    "ChallengeRequest",
    "ChallengeResponse",
    "DEFAULT_REFRESH_COOKIE_SAMESITE",
    "DEFAULT_REFRESH_REUSE_GRACE_SECONDS",
    "DidDocument",
    "INVALID_DID_TYPE",
    "INVALID_REFRESH_TOKEN_TYPE",
    "InvalidDid",
    "InvalidNonce",
    "InvalidRefreshToken",
    "InvalidSignature",
    "KEY_ROTATION_TYPE",
    "KeyRotationEntry",
    "LOGOUT_UNAUTHENTICATED_TYPE",
    "LogoutRequest",
    "NONCE_BYTES",
    "REFRESH_COOKIE_MAX_AGE",
    "REFRESH_COOKIE_NAME",
    "REFRESH_COOKIE_PATH",
    "REFRESH_COOKIE_SAMESITE",
    "REFRESH_REUSE_GRACE_SECONDS",
    "REFRESH_TOKEN_TTL",
    "RefreshRequest",
    "RefreshResponse",
    "RefreshToken",
    "VERIFY_FAILED_TYPE",
    "VerifyRequest",
    "VerifyResponse",
    "clear_refresh_cookie",
    "ensure_account_keys_table",
    "ensure_account_table",
    "ensure_refresh_tokens_table",
    "ensure_table",
    "install_key_rotation_subscriber",
    "on_startup",
    "refresh_access",
    "refresh_cookie_samesite",
    "refresh_reuse_grace_seconds",
    "refresh_token_from_request",
    "revoke_refresh_token",
    "revoke_refresh_tokens_for_did",
    "same_site",
    "active_key_for",
    "active_signing_key",
    "add_account_key",
    "get_active_key",
    "key_for",
    "purge_expired_challenges",
    "record_active_key",
    "resolve_active_key",
    "resolve_active_signing_key",
    "resolve_key",
    "resolve_signing_key",
    "set_active_key",
    "set_refresh_cookie",
    "get_active_signing_key",
    "active_signing_key_for",
    "resolve_active_key_for",
    "signing_key_for",
    "get_key_for_did",
    "resolve_active",
    "active_key",
    "signing_key",
    "get_signing_key",
    "resolve_active_signing_key_for_did",
    "get_active_key_for",
    "active_key_at",
    "resolve_active_key_at",
    "issue_challenge",
    "issue_refresh_token",
    "resolve_did_document",
    "router",
    "validate_did",
    "verify_signin",
]
