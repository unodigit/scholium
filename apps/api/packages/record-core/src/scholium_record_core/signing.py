"""Ed25519 signing and verification over the canonical envelope bytes.

A Scholium record is signed by its author's Ed25519 key.  The signature
is made over :func:`scholium_record_core.envelope.record_bytes` -- the
canonical DAG-CBOR encoding of the seven content fields ``v``, ``type``,
``author``, ``created``, ``prev``, ``body`` and ``proofs`` -- exactly the
bytes the record id is hashed over, mirroring the envelope rule::

    sig = Ed25519-sign(record_bytes(envelope), author_seed)

``id`` and ``sig`` never appear in the signed bytes, so signing or
re-signing a record never invalidates another author's view of it, and
any change to a content field -- a tampered ``body`` above all -- makes
the signature fail.  Signatures are 64 raw bytes carried as unpadded
base64url strings in the envelope's ``sig`` member.

Authors are identified by `did:key` (Ed25519): the base58btc multibase
(``z``) encoding of the 34-byte string ``0xed 0x01 || public_key`` --
the ``ed25519-pub`` multicodec header followed by the raw 32-byte public
key -- behind the ``did:key:`` prefix, e.g. ``did:key:z6Mk...``.

Verification is a predicate: every :func:`verify_envelope` and
:func:`verify_record` failure -- tampered bytes, wrong key, malformed
signature or did, invalid envelope -- returns ``False`` rather than
raising.  Signing, which must not half-succeed, raises ``ValueError``.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey
from multiformats import multibase

from .envelope import compute_record_id, record_bytes

#: Byte length of a raw Ed25519 public key.
ED25519_PUBLIC_KEY_LENGTH = 32

#: Byte length of an Ed25519 seed (the ``SigningKey`` input).
ED25519_SEED_LENGTH = 32

#: Byte length of a raw Ed25519 signature.
ED25519_SIGNATURE_LENGTH = 64

#: ``ed25519-pub`` multicodec header (code 0xed, varint-encoded).
ED25519_MULTICODEC = b"\xed\x01"

#: Prefix every Ed25519 did:key starts with (``z`` = base58btc multibase).
DID_KEY_PREFIX = "did:key:z"

#: did:key prefix without the multibase character.
DID_KEY_SCHEME_PREFIX = "did:key:"

#: Text encoding of the ``sig`` envelope member.
SIG_ENCODING = "base64url-unpadded"

_BASE64URL_ALPHABET = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)


def _coerce_signing_key(signing_key: SigningKey | bytes | bytearray) -> SigningKey:
    """Return ``signing_key`` as a :class:`nacl.signing.SigningKey`.

    Accepts a ``SigningKey`` directly or a raw 32-byte seed.
    """
    if isinstance(signing_key, SigningKey):
        return signing_key
    if isinstance(signing_key, (bytes, bytearray)):
        if len(signing_key) != ED25519_SEED_LENGTH:
            raise ValueError(
                f"an Ed25519 seed must be {ED25519_SEED_LENGTH} bytes, "
                f"got {len(signing_key)}"
            )
        return SigningKey(bytes(signing_key))
    raise ValueError(
        "signing_key must be a nacl.signing.SigningKey or a "
        f"{ED25519_SEED_LENGTH}-byte seed, got {type(signing_key).__name__}"
    )


def did_key_from_public_key(public_key: bytes | bytearray) -> str:
    """Return the did:key identifier of a raw Ed25519 public key.

    The identifier is ``did:key:z`` followed by the base58btc encoding
    of ``ED25519_MULTICODEC || public_key``.

    Raises:
        ValueError: if ``public_key`` is not 32 bytes.
    """
    if not isinstance(public_key, (bytes, bytearray)) or (
        len(public_key) != ED25519_PUBLIC_KEY_LENGTH
    ):
        got = (
            f"{len(public_key)} bytes"
            if isinstance(public_key, (bytes, bytearray))
            else f"{type(public_key).__name__}"
        )
        raise ValueError(
            f"an Ed25519 public key must be {ED25519_PUBLIC_KEY_LENGTH} "
            f"bytes, got {got}"
        )
    multikey = ED25519_MULTICODEC + bytes(public_key)
    return DID_KEY_SCHEME_PREFIX + multibase.encode(multikey, "base58btc")


def public_key_from_did_key(did: str) -> bytes:
    """Return the raw Ed25519 public key encoded by a did:key identifier.

    Inverse of :func:`did_key_from_public_key`.  Only base58btc
    (``did:key:z...``) Ed25519 identifiers are accepted.

    Raises:
        ValueError: if ``did`` is not a string, is not a ``did:key:z...``
            identifier, is not valid base58btc, or does not encode an
            Ed25519 public key.
    """
    if not isinstance(did, str):
        raise ValueError(
            f"a did:key identifier must be a string, got {type(did).__name__}"
        )
    if not did.startswith(DID_KEY_PREFIX):
        raise ValueError(
            f"not an Ed25519 did:key identifier (expected {DID_KEY_PREFIX!r} "
            f"prefix): {did!r}"
        )
    try:
        decoded = multibase.decode(did[len(DID_KEY_SCHEME_PREFIX) :])
    except Exception as exc:  # multibase raises KeyError/ValueError variants
        raise ValueError(f"did:key identifier is not valid base58btc: {exc}") from exc
    if (
        len(decoded) != len(ED25519_MULTICODEC) + ED25519_PUBLIC_KEY_LENGTH
        or not decoded.startswith(ED25519_MULTICODEC)
    ):
        raise ValueError(
            "did:key identifier does not encode an Ed25519 public key "
            f"(expected the ed25519-pub multicodec header and "
            f"{ED25519_PUBLIC_KEY_LENGTH} key bytes)"
        )
    return decoded[len(ED25519_MULTICODEC) :]


def is_ed25519_did_key(did: Any) -> bool:
    """Return True when ``did`` is a valid Ed25519 did:key identifier."""
    if not isinstance(did, str):
        return False
    try:
        public_key_from_did_key(did)
    except ValueError:
        return False
    return True


def did_key_from_signing_key(
    signing_key: SigningKey | bytes | bytearray,
) -> str:
    """Return the did:key identifier of an Ed25519 signing key or seed."""
    key = _coerce_signing_key(signing_key)
    return did_key_from_public_key(bytes(key.verify_key))


def encode_signature(signature: bytes | bytearray) -> str:
    """Return a raw 64-byte Ed25519 signature as unpadded base64url."""
    if not isinstance(signature, (bytes, bytearray)) or (
        len(signature) != ED25519_SIGNATURE_LENGTH
    ):
        got = (
            f"{len(signature)} bytes"
            if isinstance(signature, (bytes, bytearray))
            else f"{type(signature).__name__}"
        )
        raise ValueError(
            f"an Ed25519 signature must be {ED25519_SIGNATURE_LENGTH} "
            f"bytes, got {got}"
        )
    return base64.urlsafe_b64encode(bytes(signature)).rstrip(b"=").decode("ascii")


def decode_signature(signature: str | bytes | bytearray) -> bytes:
    """Return the raw 64 signature bytes carried by ``signature``.

    Accepts the envelope's text form (unpadded base64url; a trailing
    ``=`` padding is tolerated) or 64 raw bytes.

    Raises:
        ValueError: if ``signature`` is neither form or not 64 bytes.
    """
    if isinstance(signature, (bytes, bytearray)):
        raw = bytes(signature)
        if len(raw) != ED25519_SIGNATURE_LENGTH:
            raise ValueError(
                f"an Ed25519 signature must be {ED25519_SIGNATURE_LENGTH} "
                f"bytes, got {len(raw)}"
            )
        return raw
    if isinstance(signature, str):
        text = signature.strip()
        stripped = text.rstrip("=")
        if (
            len(text) - len(stripped) > 2
            or not stripped
            or not set(stripped) <= _BASE64URL_ALPHABET
        ):
            raise ValueError(
                "signature must be unpadded base64url text, "
                f"got {signature!r}"
            )
        try:
            raw = base64.b64decode(
                stripped + "=" * (-len(stripped) % 4),
                altchars=b"-_",
                validate=True,
            )
        except (binascii.Error, ValueError) as exc:
            raise ValueError(
                f"signature is not valid base64url: {exc}"
            ) from exc
        if len(raw) != ED25519_SIGNATURE_LENGTH:
            raise ValueError(
                f"an Ed25519 signature must be {ED25519_SIGNATURE_LENGTH} "
                f"bytes, got {len(raw)}"
            )
        return raw
    raise ValueError(
        "signature must be base64url text or raw bytes, "
        f"got {type(signature).__name__}"
    )


def sign_envelope(
    envelope: Mapping[str, Any],
    signing_key: SigningKey | bytes | bytearray,
) -> str:
    """Sign the canonical bytes of ``envelope`` with an Ed25519 key.

    Returns the signature as unpadded base64url, ready for the
    envelope's ``sig`` member.  The signed bytes are exactly
    :func:`record_bytes` -- the DAG-CBOR encoding of the seven content
    fields -- so ``id`` and ``sig`` members on ``envelope`` are ignored.

    Raises:
        ValueError: if the envelope is not canonically encodable or the
            key is not an Ed25519 signing key or 32-byte seed.
    """
    key = _coerce_signing_key(signing_key)
    data = record_bytes(envelope)
    return encode_signature(bytes(key.sign(data).signature))


def verify_envelope(
    envelope: Mapping[str, Any],
    signature: str | bytes | bytearray,
    did_key: str | bytes | bytearray | None = None,
) -> bool:
    """Return True when ``signature`` authenticates ``envelope``.

    The signature is checked over :func:`record_bytes` -- the same
    canonical DAG-CBOR bytes the record id is hashed over.  ``did_key``
    is the signer: a did:key identifier, a raw 32-byte public key, or
    ``None`` to use the envelope's own ``author``.  A record whose body
    (or any other content field) was tampered with after signing
    verifies to ``False``; changing ``id`` or ``sig`` members alone does
    not change the outcome.

    Every failure mode -- invalid envelope, unparseable signature or
    did, wrong key, bad signature -- returns ``False``; nothing raises.
    """
    try:
        data = record_bytes(envelope)
        raw_signature = decode_signature(signature)
        if did_key is None:
            did_key = envelope["author"]
        if isinstance(did_key, str):
            public_key = public_key_from_did_key(did_key)
        elif isinstance(did_key, (bytes, bytearray)):
            public_key = bytes(did_key)
            if len(public_key) != ED25519_PUBLIC_KEY_LENGTH:
                return False
        else:
            return False
        VerifyKey(public_key).verify(data, raw_signature)
    except (ValueError, KeyError, TypeError, BadSignatureError):
        return False
    return True


def sign_record(
    envelope: Mapping[str, Any],
    signing_key: SigningKey | bytes | bytearray,
) -> dict[str, Any]:
    """Return ``envelope`` completed into a signed record.

    The result carries every original member plus a fresh ``id``
    (:func:`compute_record_id`) and ``sig``
    (:func:`sign_envelope`).  The envelope's ``author``, when present,
    must be the signing key's did:key -- signing as somebody else is a
    bug, not a feature.

    Raises:
        ValueError: if the envelope is invalid or its ``author`` is a
            did:key other than the signing key's.
    """
    if not isinstance(envelope, Mapping):
        raise ValueError(
            f"envelope must be a mapping, got {type(envelope).__name__}"
        )
    key = _coerce_signing_key(signing_key)
    signer_did = did_key_from_signing_key(key)
    author = envelope.get("author")
    if author is not None and author != signer_did:
        raise ValueError(
            f"envelope author {author!r} is not the signing key ({signer_did!r})"
        )
    record = dict(envelope)
    record["author"] = signer_did
    record["id"] = compute_record_id(record)
    record["sig"] = sign_envelope(record, key)
    return record


def verify_record(record: Mapping[str, Any]) -> bool:
    """Return True when ``record`` is a complete, intact signed record.

    Checks that ``id`` matches the recomputed record id and that ``sig``
    verifies over the canonical bytes against the record's ``author``
    did:key.  A tampered body fails both checks; the function returns
    ``False`` for every failure, mirroring :func:`verify_envelope`.
    """
    try:
        if not isinstance(record, Mapping):
            return False
        if compute_record_id(record) != record.get("id"):
            return False
    except (ValueError, KeyError, TypeError):
        return False
    return verify_envelope(record, record.get("sig"))
