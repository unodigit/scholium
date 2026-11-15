"""Issue sign-in challenges (plugin: identity).

A challenge is a single-use random nonce bound to one did:key.  The client
proves it holds the key by signing the nonce, which a later step
(``POST /v1/auth/verify``) checks and marks used::

    from app.modules import identity

    challenge = identity.issue_challenge("did:key:z6Mk...")
    challenge.nonce        # 43 URL-safe characters, 256 bits of entropy
    challenge.expires_at   # naive UTC, five minutes after issue
    challenge.used         # False

Guarantees of :func:`issue_challenge`:

* the nonce comes from :mod:`secrets` (the OS CSPRNG) and is never derived
  from the did or the clock, so it cannot be predicted or replayed for
  another did;
* the row is committed before the function returns, so a nonce a caller
  holds is always one the database knows about;
* only a **canonical Ed25519 did:key** is accepted -- the one kind of
  identifier sign-in can verify a signature for.  Anything else raises
  :class:`InvalidDid` and writes nothing.

Rows are returned detached from any session, with every attribute loaded.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from scholium_record_core import did_key_from_public_key, public_key_from_did_key

from app import db

from .models import AuthChallenge, ensure_table

__all__ = [
    "CHALLENGE_TTL",
    "NONCE_BYTES",
    "InvalidDid",
    "issue_challenge",
    "validate_did",
]

#: How long a challenge stays valid after it is issued.
CHALLENGE_TTL = timedelta(minutes=5)

#: Random bytes behind each nonce (256 bits; 43 characters once encoded).
NONCE_BYTES = 32


class InvalidDid(ValueError):
    """The value is not a canonical Ed25519 did:key identifier."""


def validate_did(did: object) -> str:
    """Return ``did`` if it is a canonical Ed25519 did:key, else raise.

    "Canonical" means the string is exactly what
    :func:`~scholium_record_core.did_key_from_public_key` produces for the key
    it encodes.  Surrounding whitespace, a ``#fragment`` (a did:key *URL*, not
    a did) and any other spelling are rejected rather than normalised, so the
    did stored on a challenge is byte-for-byte the one the client sent and the
    one sign-in later compares the signing key against.

    Today :func:`~scholium_record_core.public_key_from_did_key` already
    refuses every non-canonical spelling (checked by fuzzing), so the final
    round-trip comparison is a backstop: it keeps this guarantee even if the
    decoder is ever made more lenient.

    Raises:
        InvalidDid: for anything else.
    """
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
    """Current UTC instant as a naive datetime (the column convention)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def issue_challenge(did: str, *, now: Optional[datetime] = None) -> AuthChallenge:
    """Create, save and return a fresh challenge for ``did``.

    ``now`` is the issue instant (naive values are taken as UTC); it defaults
    to the current time and exists so tests can pin the clock.

    Raises:
        InvalidDid: ``did`` is not a canonical Ed25519 did:key; nothing is
            saved.
    """
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
