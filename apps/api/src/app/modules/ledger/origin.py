"""The node identity recorded as the origin of log entries.

``origin_node`` says which node accepted and appended a record.  It is
resolved, in order, from:

1. the value passed explicitly to :func:`~app.modules.ledger.append`;
2. the ``NODE_DID`` / ``ORIGIN_NODE`` / ``SCHOLIUM_NODE_DID`` environment
   variables (the first non-empty one wins);
3. a ``did:key`` derived from the node Ed25519 key at ``NODE_KEY_PATH`` when
   that file exists and can be read;
4. :data:`DEFAULT_ORIGIN_NODE`.

Step 3 reads the same key file feature 14 uses for the signed sync head
(:func:`node_signing_key` returns the key itself, for signing).  Neither
function ever creates the file: a node that has no key yet still gets a
stable, explicit placeholder rather than an error, because appending to the
log must not depend on key provisioning.
"""

from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path
from typing import Optional

from multiformats import multibase
from nacl.signing import SigningKey

from app.settings import settings

__all__ = [
    "DEFAULT_ORIGIN_NODE",
    "ED25519_MULTICODEC_PREFIX",
    "did_key_from_public_key",
    "node_did",
    "node_signing_key",
]

#: Placeholder origin used when no node identity is configured.
DEFAULT_ORIGIN_NODE = "did:key:local"

#: Multicodec prefix for an Ed25519 public key inside a ``did:key`` (0xed 0x01).
ED25519_MULTICODEC_PREFIX = b"\xed\x01"

_ENV_NAMES = ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID")


def did_key_from_public_key(public_key: bytes) -> str:
    """Return the ``did:key`` identifier for a 32-byte Ed25519 public key."""
    if not isinstance(public_key, (bytes, bytearray, memoryview)):
        raise TypeError(f"public key must be bytes, got {type(public_key).__name__}")
    key = bytes(public_key)
    if len(key) != 32:
        raise ValueError(f"an Ed25519 public key is 32 bytes, got {len(key)}")
    return "did:key:" + multibase.encode(ED25519_MULTICODEC_PREFIX + key, "base58btc")


def _signing_key_from_file_data(data: bytes) -> Optional[SigningKey]:
    """Best-effort extraction of the Ed25519 signing key encoded by ``data``.

    Accepts a raw seed (32 bytes), a raw Ed25519 secret key (64 bytes, the
    seed followed by the public key), or a text encoding of either (base64 or
    hex).  Returns ``None`` when the contents are not recognised.
    """
    candidates: list[bytes] = []

    def _add(value: bytes) -> None:
        if value and value not in candidates:
            candidates.append(value)

    # Text encodings take precedence over the raw bytes: a key file that
    # holds hex or base64 text must not be misread as a raw 32/64-byte key
    # just because its ASCII length happens to be 32 or 64.
    text: Optional[str] = None
    try:
        text = data.strip().decode("ascii")
    except (UnicodeDecodeError, AttributeError):
        text = None

    if text is not None:
        try:
            _add(bytes.fromhex(text))
        except ValueError:
            pass
        try:
            _add(base64.b64decode(text, validate=True))
        except (binascii.Error, ValueError):
            pass

    # Fall back to the raw bytes when no text encoding produced a usable
    # key.  This keeps binary seed/key files (which may happen to be valid
    # ASCII control bytes) working.
    if not candidates:
        stripped = data.strip()
        if len(stripped) in (32, 64):
            _add(stripped)
        elif len(data) in (32, 64):
            _add(data)

    for candidate in candidates:
        if len(candidate) == 32:
            # A bare 32 bytes is ambiguous (seed or public key); treat it as a
            # seed, the usual way an Ed25519 private key is stored.
            return SigningKey(candidate)
        if len(candidate) == 64:
            # libsodium's secret key layout: seed || public key.
            return SigningKey(candidate[:32])
    return None


def _decode_key_file(data: bytes) -> Optional[bytes]:
    """The 32-byte Ed25519 public key of the key encoded by ``data``, if any."""
    key = _signing_key_from_file_data(data)
    if key is None:
        return None
    return key.verify_key.encode()


def _public_key_from_path(path: str) -> Optional[bytes]:
    data = Path(path).expanduser().read_bytes()
    return _decode_key_file(data)


def node_did(key_path: Optional[str] = None) -> str:
    """Return this node's DID as recorded in ``origin_node``.

    ``key_path`` overrides ``settings.NODE_KEY_PATH``; it is only consulted
    when no environment override is set.
    """
    for name in _ENV_NAMES:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()

    try:
        public_key = _public_key_from_path(key_path or settings.NODE_KEY_PATH)
    except (OSError, ValueError):
        public_key = None
    if public_key is not None:
        return did_key_from_public_key(public_key)
    return DEFAULT_ORIGIN_NODE


def node_signing_key(key_path: Optional[str] = None) -> Optional[SigningKey]:
    """Return this node's Ed25519 signing key, or ``None`` when unavailable.

    The key is read from ``key_path`` or ``settings.NODE_KEY_PATH`` (the
    ``NODE_KEY_PATH`` setting) on every call, so rotating the file takes
    effect without a restart.  Unlike :func:`node_did`, the ``NODE_DID``-style
    environment overrides are not consulted: they name a DID, not a key, and a
    signature must be made by -- and verify against -- the key itself.

    Returns ``None`` when the file is missing, unreadable or does not hold a
    recognisable Ed25519 key; the file is never created.
    """
    try:
        data = Path(key_path or settings.NODE_KEY_PATH).expanduser().read_bytes()
    except OSError:
        return None
    return _signing_key_from_file_data(data)
