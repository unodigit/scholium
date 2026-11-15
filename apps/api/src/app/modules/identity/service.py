"""Issue sign-in challenges and verify sign-ins (plugin: identity)."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from scholium_record_core import (
    did_key_from_public_key,
    public_key_from_did_key,
    decode_signature,
)

from app import db
from app.security import issue_access_token

from .models import (
    Account,
    AuthChallenge,
    RefreshToken,
    ensure_account_table,
    ensure_refresh_tokens_table,
    ensure_table,
)

__all__ = [
    "CHALLENGE_TTL",
    "InvalidDid",
    "InvalidNonce",
    "InvalidSignature",
    "NONCE_BYTES",
    "REFRESH_TOKEN_TTL",
    "issue_challenge",
    "issue_refresh_token",
    "validate_did",
    "verify_signin",
]

#: How long a challenge stays valid after it is issued.
CHALLENGE_TTL = timedelta(minutes=5)

#: Random bytes behind each nonce (256 bits; 43 characters once encoded).
NONCE_BYTES = 32

#: How long a refresh token stays valid.
REFRESH_TOKEN_TTL = timedelta(days=30)


class InvalidDid(ValueError):
    """The value is not a canonical Ed25519 did:key identifier."""


class InvalidNonce(ValueError):
    """The nonce is unknown, expired, already used, or not bound to this did."""


class InvalidSignature(ValueError):
    """The signature does not verify against the did's key."""


def validate_did(did: object) -> str:
    if not isinstance(did, str):
        raise InvalidDid("a did:key identifier must be a string")
    try:
        public_key = public_key_from_did_key(did)
    except ValueError as exc:
        raise InvalidDid("not a valid Ed25519 did:key identifier") from exc
    if did_key_from_public_key(public_key) != did:
        raise InvalidDid("not a canonical Ed25519 did:key identifier")
    return did


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def issue_challenge(did: str, *, now: Optional[datetime] = None) -> AuthChallenge:
    validate_did(did)
    issued_at = _utcnow() if now is None else _as_naive_utc(now)
    ensure_table()
    challenge = AuthChallenge(
        nonce=secrets.token_urlsafe(NONCE_BYTES),
        did=did,
        expires_at=issued_at + CHALLENGE_TTL,
        used=False,
    )
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        session.add(challenge)
        session.commit()
        session.expunge(challenge)
    return challenge


def issue_refresh_token(did: str, *, now: Optional[datetime] = None) -> str:
    """Create, persist and return a raw refresh token for ``did``."""
    ensure_refresh_tokens_table()
    issued_at = _utcnow() if now is None else _as_naive_utc(now)
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    with db.SessionLocal() as session:
        session.add(
            RefreshToken(
                token_hash=token_hash,
                did=did,
                expires_at=issued_at + REFRESH_TOKEN_TTL,
                rotated=False,
            )
        )
        session.commit()
    return raw


def verify_signin(
    did: str,
    nonce: str,
    signature: str,
    *,
    now: Optional[datetime] = None,
) -> tuple[str, str]:
    """Verify a sign-in and return ``(access_token, refresh_token)``.

    Raises:
        InvalidDid: ``did`` is not a canonical Ed25519 did:key.
        InvalidNonce: the nonce is unknown, expired, used, or not bound to ``did``.
        InvalidSignature: the signature does not verify.
    """
    validate_did(did)

    # Decode the signature up front; malformed input is an auth failure.
    try:
        raw_signature = decode_signature(signature)
    except ValueError as exc:
        raise InvalidSignature("signature is not a valid Ed25519 signature") from exc

    checked_at = _utcnow() if now is None else _as_naive_utc(now)

    ensure_table()
    ensure_account_table()
    ensure_refresh_tokens_table()

    with db.SessionLocal() as session:
        challenge = session.get(AuthChallenge, nonce)
        if challenge is None or challenge.did != did or challenge.used:
            raise InvalidNonce("nonce is invalid or already used")
        if challenge.expires_at <= checked_at:
            raise InvalidNonce("nonce has expired")

        public_key = public_key_from_did_key(did)
        try:
            VerifyKey(public_key).verify(nonce.encode("utf-8"), raw_signature)
        except BadSignatureError as exc:
            raise InvalidSignature("signature does not verify") from exc

        # Consume the nonce.
        challenge.used = True

        # Account: create on first sign-in at tier 0.
        account = session.get(Account, did)
        if account is None:
            account = Account(did=did, tier=0, created_at=checked_at)
            session.add(account)
        tier = int(account.tier)

        session.commit()

    # Issue tokens outside the session.
    access_token = issue_access_token(did, tier, now=checked_at)

    # Persist refresh token.
    raw_refresh = issue_refresh_token(did, now=checked_at)

    return access_token, raw_refresh
