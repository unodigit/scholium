"""Per-object encryption for profile data.

Every profile is sealed under its own random 256-bit key.  The ciphertext goes
to ``profile.enc_blob`` and the key to ``profile_keys`` (see ``models``), so
deleting the key row makes the blob permanently unreadable -- the
crypto-shredding that erasure relies on.

Blob layout (``VERSION`` is bumped if this ever changes)::

    version (1 byte) || nonce (12 bytes) || AES-256-GCM ciphertext+tag

The plaintext is the compact, key-sorted JSON of the profile fields.  The
owning DID is authenticated as associated data, so a blob copied onto another
DID's row (or a tampered one) fails to open instead of decrypting to someone
else's details.

A fresh random nonce is drawn for every seal.  A profile is re-sealed only when
its owner saves it, so the number of encryptions under one key stays orders of
magnitude below the point where random 96-bit nonces become a risk.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

__all__ = [
    "KEY_BYTES",
    "NONCE_BYTES",
    "VERSION",
    "ProfileDecryptionError",
    "new_key",
    "open_profile",
    "seal_profile",
]

KEY_BYTES = 32
NONCE_BYTES = 12
VERSION = b"\x01"
_AAD_PREFIX = b"scholium:profile:v1:"


class ProfileDecryptionError(Exception):
    """The blob is malformed, was tampered with, or does not belong to this DID/key."""


def new_key() -> bytes:
    """Return a fresh random 256-bit key."""
    return AESGCM.generate_key(bit_length=KEY_BYTES * 8)


def _aad(did: str) -> bytes:
    return _AAD_PREFIX + did.encode("utf-8")


def seal_profile(key: bytes, did: str, fields: Mapping[str, Any]) -> bytes:
    """Encrypt ``fields`` for ``did`` under ``key`` and return the ``enc_blob`` bytes."""
    plaintext = json.dumps(dict(fields), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), _aad(did))
    return VERSION + nonce + ciphertext


def open_profile(key: bytes, did: str, blob: bytes) -> dict[str, Any]:
    """Decrypt an ``enc_blob`` written by :func:`seal_profile`.

    Raises :class:`ProfileDecryptionError` for a wrong key, a blob that belongs
    to another DID, tampering, or a blob in an unknown format.
    """
    blob = bytes(blob)
    header = len(VERSION) + NONCE_BYTES
    if len(blob) <= header or blob[: len(VERSION)] != VERSION:
        raise ProfileDecryptionError("The profile blob is not in a known format.")
    nonce = blob[len(VERSION) : header]
    try:
        plaintext = AESGCM(key).decrypt(nonce, blob[header:], _aad(did))
        fields = json.loads(plaintext.decode("utf-8"))
    except (InvalidTag, ValueError) as exc:  # ValueError covers bad key sizes and bad JSON/UTF-8
        raise ProfileDecryptionError("The profile blob could not be decrypted.") from exc
    if not isinstance(fields, dict):
        raise ProfileDecryptionError("The profile blob does not hold a profile.")
    return fields
