"""Ed25519 proof helpers for the recovery plugin.

Recovery approvals and guardian changes are authorized by a detached Ed25519
signature, not by the access token alone: a stolen token must not be enough to
complete a recovery or to redirect an account's guardians.  Both checks live
here so they agree on

* which key may sign -- the DID's *active* key, resolved through the identity
  plugin's ``account_keys`` table (:func:`app.modules.identity.resolve_active_key`),
  falling back to the DID's own genesis key when the DID itself is a
  ``did:key`` and has never rotated;
* which signature spellings are accepted -- unpadded base64url (the record
  envelope's form), 128-character hex, and base58btc multibase (``z...``);
* how the signed message is turned into bytes.  The canonical form is compact,
  key-sorted JSON, but a few other encodings that bind the same values are
  accepted too, mirroring :mod:`app.modules.orcid.present`'s tolerance for the
  presentations other nodes send.

Every check is a predicate that returns ``False`` rather than raising: the
callers turn a failed check into a ``403`` problem document.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Iterable, Iterator
from typing import Any, Sequence

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from scholium_record_core import ED25519_PUBLIC_KEY_LENGTH, decode_signature, public_key_from_did_key

__all__ = [
    "active_key_for",
    "canonical_json",
    "message_preimages",
    "raw_signatures",
    "verify_detached",
]


def active_key_for(did: str) -> str:
    """The key currently authorized to sign for ``did``.

    The identity plugin's resolver wins when it is installed; a DID it cannot
    answer for falls back to the DID itself, which is its own genesis key.
    """
    try:
        from app.modules.identity.service import resolve_active_key
    except (ImportError, AttributeError):
        return did
    try:
        key = resolve_active_key(did)
    except (LookupError, TypeError, ValueError):
        return did
    return key if isinstance(key, str) and key else did


def canonical_json(value: Any) -> bytes:
    """Compact, key-sorted JSON bytes -- the canonical message form."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def message_preimages(message: Any, *, aliases: Sequence[Any] = ()) -> list[bytes]:
    """The byte strings a detached signature may have been made over.

    ``message`` is the canonical structured value (usually a mapping).  Every
    alias is another equally binding spelling of the same values, so accepting
    any of them never lets a signature authorize different content.  Both the
    canonical JSON of ``message`` and of each alias are returned, ASCII-escaped
    and raw UTF-8, together with :func:`canonical_json` itself.
    """
    candidates: list[Any] = [message, *aliases]
    seen: set[bytes] = set()
    out: list[bytes] = []

    def add(raw: bytes) -> None:
        if raw not in seen:
            seen.add(raw)
            out.append(raw)

    for candidate in candidates:
        for ensure_ascii in (True, False):
            for sort_keys in (True, False):
                for separators in ((",", ":"), (", ", ": ")):
                    try:
                        add(
                            json.dumps(
                                candidate,
                                sort_keys=sort_keys,
                                separators=separators,
                                ensure_ascii=ensure_ascii,
                                default=str,
                            ).encode("utf-8")
                        )
                    except (TypeError, ValueError):
                        continue
    return out


def _public_keys(key: str) -> list[bytes]:
    """The raw Ed25519 public keys ``key`` may encode.

    ``key`` is whatever the active-key resolver returned: a ``did:key`` or raw
    Ed25519 material as hex or base64.  Nothing else can verify, so an
    unparseable key yields an empty list and every signature is refused.
    """
    if not isinstance(key, str) or not key.strip():
        return []
    text = key.strip()
    if text.startswith("did:"):
        try:
            return [public_key_from_did_key(text)]
        except (ValueError, TypeError):
            return []
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        raw = b""
    if len(raw) == ED25519_PUBLIC_KEY_LENGTH:
        return [raw]
    for decode in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            raw = decode(text + "=" * (-len(text) % 4))
        except (binascii.Error, ValueError):
            continue
        if len(raw) == ED25519_PUBLIC_KEY_LENGTH:
            return [raw]
    return []


def raw_signatures(signature: Any) -> Iterator[bytes]:
    """Decode every accepted spelling of ``signature`` into raw Ed25519 bytes."""
    if isinstance(signature, (bytes, bytearray)):
        try:
            yield decode_signature(signature)
        except ValueError:
            return
        return
    if not isinstance(signature, str):
        return
    text = signature.strip()
    if not text:
        return
    seen: set[bytes] = set()
    candidates = [text]
    # A detached compact JWS is "header..signature"; the signature is the last part.
    if text.count(".") == 2:
        candidates.append(text.rsplit(".", 1)[-1])
    for candidate in candidates:
        attempts: list[bytes] = []
        try:
            attempts.append(decode_signature(candidate))
        except ValueError:
            pass
        if len(candidate) == 128:
            try:
                attempts.append(bytes.fromhex(candidate))
            except (binascii.Error, ValueError):
                pass
        if candidate.startswith("z"):
            try:
                from multiformats import multibase

                raw = bytes(multibase.decode(candidate))
            except Exception:
                raw = b""
            if len(raw) == 64:
                attempts.append(raw)
        for raw in attempts:
            if raw not in seen:
                seen.add(raw)
                yield raw


def verify_detached(did: str, preimages: Iterable[bytes], signature: Any) -> bool:
    """True when ``signature`` is by ``did``'s active key over any preimage."""
    signatures = list(raw_signatures(signature))
    if not signatures:
        return False
    for public_key in _public_keys(active_key_for(did)):
        for preimage in preimages:
            for raw in signatures:
                try:
                    VerifyKey(public_key).verify(preimage, raw)
                except (BadSignatureError, ValueError):
                    continue
                return True
    return False
