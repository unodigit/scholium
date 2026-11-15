"""Sealed-box escrow of review identities (feature 108).

A committed review is pseudonymous: it is signed by a per-paper review key and
carries a nullifier, so the ``review`` row says nothing about who wrote it.
Accountability still needs a link between the review and its author, but one
the node cannot read: the node stores
``Enc(committee_public_key, reviewer_did)`` -- a libsodium *sealed box* (an
ephemeral X25519 key agreement with the committee's public key, then
XSalsa20-Poly1305) -- and never the plaintext mapping.  Only the committee,
holding the matching private key, can open an escrow.

Uniqueness is tracked separately, by an HMAC token.  ``uniqueness_token`` is
``HMAC-SHA256(key, reviewer_did || paper_cid)`` under a key derived from the
application secret, so the token is stable for one person and one paper while
revealing neither: two reviews by the same person on the same paper collide on
the ``review_escrows.uniqueness_token`` UNIQUE constraint, and no lookup table
of DIDs is needed.  The token is scoped to the paper (not global) because a
reviewer may review many papers, just not the same paper twice.

The committee public key is ``COMMITTEE_PUBLIC_KEY`` (hex or base64, 32 bytes).
When it is unset outside production -- the development and test default -- a
deterministic development key is derived from ``JWT_SECRET`` so the escrow can
still be exercised end to end; production refuses to seal without a configured
key rather than fall back to one derived from another secret.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey, PublicKey, SealedBox

from app.settings import settings

__all__ = [
    "CommitteeKeyError",
    "EscrowDecryptionError",
    "committee_public_key",
    "open_identity",
    "seal_identity",
    "uniqueness_token",
]

#: 32 bytes is the X25519 key size (and the size of every key we accept).
_KEY_BYTES = 32

#: Domain separators, so material derived here can never be reused as, or
#: confused with, material derived for another purpose from the same secret.
_DEV_KEY_LABEL = b"scholium:review-escrow:committee-key:v1:"
_HMAC_KEY_LABEL = b"scholium:review-escrow:hmac-key:v1:"
_TOKEN_LABEL = b"scholium:review-escrow:uniqueness:v1"


class CommitteeKeyError(RuntimeError):
    """``COMMITTEE_PUBLIC_KEY`` is missing where it is required, or malformed."""


class EscrowDecryptionError(Exception):
    """The sealed identity is malformed, was tampered with, or is not ours."""


def _decode_key(text: str) -> bytes:
    """Decode a configured committee public key (hex or base64) to 32 bytes."""
    value = "".join(str(text).split())
    if value.lower().startswith("base64:"):
        value = value.split(":", 1)[1]
        try:
            raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        except (binascii.Error, ValueError) as exc:
            raise CommitteeKeyError("COMMITTEE_PUBLIC_KEY is not valid base64.") from exc
    elif value.lower().startswith("hex:"):
        try:
            raw = bytes.fromhex(value.split(":", 1)[1])
        except ValueError as exc:
            raise CommitteeKeyError("COMMITTEE_PUBLIC_KEY is not valid hex.") from exc
    else:
        try:
            raw = bytes.fromhex(value)
        except ValueError:
            try:
                raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
            except (binascii.Error, ValueError) as exc:
                raise CommitteeKeyError(
                    "COMMITTEE_PUBLIC_KEY must be 32 bytes of hex or base64."
                ) from exc
    if len(raw) != _KEY_BYTES:
        raise CommitteeKeyError(
            f"COMMITTEE_PUBLIC_KEY must decode to {_KEY_BYTES} bytes, got {len(raw)}."
        )
    return raw


def _development_committee_secret_key() -> PrivateKey:
    """The development-only committee key, derived from ``JWT_SECRET``.

    Used when ``COMMITTEE_PUBLIC_KEY`` is unset and the node is not in
    production.  Deriving it deterministically keeps escrows written before a
    restart openable by the same development process; the production path never
    reaches this helper (see :func:`committee_public_key`).
    """
    seed = hashlib.sha256(
        _DEV_KEY_LABEL + (settings.JWT_SECRET or "").encode("utf-8")
    ).digest()
    return PrivateKey(seed)


def committee_public_key() -> PublicKey:
    """The key reviewer identities are sealed to.

    Raises:
        CommitteeKeyError: in production when ``COMMITTEE_PUBLIC_KEY`` is unset
            or malformed.  Sealing to a key derived from another secret would
            silently give the node itself the power to open escrows.
    """
    configured = (settings.COMMITTEE_PUBLIC_KEY or "").strip()
    if configured:
        return PublicKey(_decode_key(configured))
    if settings.SCHOLIUM_ENV == "production":
        raise CommitteeKeyError(
            "COMMITTEE_PUBLIC_KEY must be set before a review can be escrowed "
            "in production."
        )
    return _development_committee_secret_key().public_key


def seal_identity(reviewer_did: str) -> bytes:
    """Seal ``reviewer_did`` to the committee public key and return the bytes.

    A sealed box draws a fresh ephemeral key pair for every call, so the same
    reviewer's two escrows do not look alike.  The plaintext is exactly the
    DID; nothing else is embedded.

    Raises:
        CommitteeKeyError: the committee key is missing or malformed.
        ValueError: ``reviewer_did`` is empty.
    """
    if not isinstance(reviewer_did, str) or not reviewer_did:
        raise ValueError("reviewer_did must be a non-empty string")
    return SealedBox(committee_public_key()).encrypt(reviewer_did.encode("utf-8"))


def open_identity(
    sealed_identity: bytes | bytearray | memoryview,
    secret_key: PrivateKey | bytes | bytearray | str,
) -> str:
    """Open a sealed identity with the committee private key.

    This is the committee's side of the escrow, not an API path: the node
    stores only the public key and cannot call this.  ``secret_key`` may be a
    :class:`nacl.public.PrivateKey` or its 32 raw bytes (hex or base64 text is
    also accepted for convenience).

    Raises:
        EscrowDecryptionError: the ciphertext is malformed, tampered with, or
            was sealed to a different key.
    """
    try:
        if isinstance(secret_key, (bytes, bytearray)):
            key = PrivateKey(bytes(secret_key))
        elif isinstance(secret_key, str):
            key = PrivateKey(_decode_key(secret_key))
        else:
            key = secret_key
        plaintext = SealedBox(key).decrypt(bytes(sealed_identity))
        return plaintext.decode("utf-8")
    except (CryptoError, ValueError, UnicodeDecodeError) as exc:
        raise EscrowDecryptionError(
            "The sealed reviewer identity could not be opened with this key."
        ) from exc


def uniqueness_token(reviewer_did: str, paper_cid: str) -> str:
    """Return the stable, non-reversible token that enforces one review per person and paper.

    The token is an HMAC under a key derived from ``JWT_SECRET``, so it cannot
    be reversed to the DID; it is deterministic for the pair, so the
    ``review_escrows.uniqueness_token`` UNIQUE constraint refuses a second
    review by the same person on the same paper even if that person presents a
    fresh nullifier.

    Raises:
        ValueError: either argument is empty.
    """
    if not isinstance(reviewer_did, str) or not reviewer_did:
        raise ValueError("reviewer_did must be a non-empty string")
    if not isinstance(paper_cid, str) or not paper_cid:
        raise ValueError("paper_cid must be a non-empty string")
    key = hmac.new(
        (settings.JWT_SECRET or "").encode("utf-8"), _HMAC_KEY_LABEL, hashlib.sha256
    ).digest()
    message = b"\x00".join(
        (_TOKEN_LABEL, reviewer_did.encode("utf-8"), paper_cid.encode("utf-8"))
    )
    return hmac.new(key, message, hashlib.sha256).hexdigest()
