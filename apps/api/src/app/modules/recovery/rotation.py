"""The ``key.rotation`` record handler (plugin: recovery).

Feature 37: an account rotates its signing key by submitting a
``key.rotation`` record through the standard ingest pipeline
(``POST /v1/records``)::

    {"v": 1, "type": "key.rotation", "author": "did:key:z6MkOLD...",
     "created": "2026-11-15T09:00:00Z", "prev": null,
     "body": {"oldKey": "did:key:z6MkOLD...",
              "newKey": "did:key:z6MkNEW...",
              "reason": "new device"},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

The authorization *is* the signature.  Ingest checks it against the author's
currently active key (:func:`app.modules.ingest.service.active_signing_key`,
backed by the identity plugin's ``account_keys`` table) -- which for a
rotation is the **old** key: only the key about to be retired may spend
itself on the record that retires it.  A ``did:key`` is its own genesis key,
so an author who never rotated signs with the key their DID encodes, and a
rotation signed by any other key is refused with ``401`` before this handler
ever runs.

This module's handler then performs the hand-over in ``account_keys``, in one
transaction:

* every key window still open for the DID is closed at the rotation's
  effective instant (``active_until`` set), and
* the body's ``newKey`` is recorded in a fresh open row -- the active key.

>From that moment :func:`app.modules.identity.resolve_active_key` answers with
the new key, so the *next* record signed by the old key fails ingest's
signature check and is refused with ``401`` problem details
(:class:`app.modules.ingest.errors.InvalidRecordSignature`) -- the hand-over a
rotation promises.  The DID itself never changes: rows stay keyed to the
account's DID while the key material behind them moves on.

The effective instant is the body's ``effectiveAt`` when it names a past
moment (the author rotated earlier and the record caught up), and the instant
of acceptance otherwise: a future ``effectiveAt`` cannot authorize a key
before the proof that authorizes it was seen, so it is clamped to now.  A
DID's rows keep strictly increasing ``active_from`` values (the table's
primary key is ``(did, active_from)``), so two rotations arriving within the
same instant still land as distinct, ordered rows.

Errors are RFC 9457 problem details raised for the app-wide handlers:

* ``422`` -- ``body.newKey`` is not a canonical Ed25519 ``did:key`` and not
  raw Ed25519 public key material (hex or base64, 32 bytes), type
  :data:`~app.modules.recovery.problems.INVALID_KEY_ROTATION_TYPE`.  Nothing
  is recorded and no key window is touched.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select

from scholium_record_core import ED25519_PUBLIC_KEY_LENGTH

from app import db
from app.modules.identity.models import AccountKey, ensure_account_keys_table
from app.modules.identity.service import InvalidDid, validate_did

from . import problems

__all__ = [
    "KEY_ROTATION_TYPE",
    "InvalidNewKey",
    "apply_rotation",
    "handle_key_rotation",
    "validate_new_key",
]

#: The record type this module owns in the ingest registry.
KEY_ROTATION_TYPE = "key.rotation"


class InvalidNewKey(ValueError):
    """``body.newKey`` is not a key this node could ever verify against."""


def _utcnow() -> datetime:
    """Naive UTC now, the datetime shape ``account_keys`` stores."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _coerce_instant(value: Any) -> Optional[datetime]:
    """Coerce ``value`` (ISO string or datetime) to a naive UTC datetime."""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    if isinstance(value, str):
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
    return None


def _effective_instant(value: Any) -> datetime:
    """When a rotation takes effect: ``value`` when it names a past moment, else now."""
    claimed = _coerce_instant(value)
    now = _utcnow()
    if claimed is None or claimed > now:
        return now
    return claimed


def validate_new_key(new_key: Any) -> str:
    """Return ``new_key`` when it names a key that can become active.

    A new key is either a canonical Ed25519 ``did:key`` (the same identifiers
    sign-in and the guardians use) or raw Ed25519 public key material -- hex
    or base64 text decoding to 32 bytes, the formats ingest's signature check
    understands.  Anything else could never sign a verifiable record, so
    activating it would lock the account out; :class:`InvalidNewKey` refuses
    it instead.
    """
    if not isinstance(new_key, str) or not new_key.strip():
        raise InvalidNewKey("'newKey' must be a non-empty string.")

    if new_key.startswith("did:"):
        try:
            validate_did(new_key)
        except InvalidDid as exc:
            raise InvalidNewKey(f"'newKey' is {str(exc).lower()}") from exc
        return new_key

    text = new_key.strip()
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        raw = b""
    if len(raw) != ED25519_PUBLIC_KEY_LENGTH:
        for decode in (base64.urlsafe_b64decode, base64.b64decode):
            try:
                candidate = decode(text + "=" * (-len(text) % 4))
            except (binascii.Error, ValueError):
                continue
            if len(candidate) == ED25519_PUBLIC_KEY_LENGTH:
                raw = candidate
                break
    if len(raw) != ED25519_PUBLIC_KEY_LENGTH:
        raise InvalidNewKey(
            "'newKey' must be a canonical Ed25519 did:key or a raw Ed25519 "
            "public key (32 bytes, hex or base64)."
        )
    return new_key


def apply_rotation(did: str, new_key: str, *, effective_at: Any = None) -> datetime:
    """Record ``new_key`` as the active key for ``did`` in ``account_keys``.

    Every open key window for ``did`` is closed at the effective instant and
    the new key is inserted in a fresh open row, in one transaction.  Returns
    the instant the new key became active.
    """
    effective = _effective_instant(effective_at)
    ensure_account_keys_table()
    with db.SessionLocal() as session:
        rows = (
            session.execute(
                select(AccountKey).where(AccountKey.did == did).order_by(AccountKey.active_from)
            )
            .scalars()
            .all()
        )
        if rows and effective <= rows[-1].active_from:
            # Keep active_from strictly increasing (it is half of the primary
            # key), so two rotations in one instant still land as two rows.
            effective = rows[-1].active_from + timedelta(microseconds=1)
        for row in rows:
            if row.active_until is None and row.active_from < effective:
                row.active_until = effective
        session.add(AccountKey(did=did, public_key=new_key, active_from=effective, active_until=None))
        session.commit()
    return effective


def handle_key_rotation(record: Mapping[str, Any]) -> None:
    """The ingest handler for ``key.rotation`` records (feature 37).

    Runs after the pipeline has validated the envelope against the shipped
    ``key.rotation`` schema, recomputed the cid and verified the signature
    against the author's active (old) key.  Swaps ``account_keys`` over to
    the body's ``newKey``; refuses with ``422`` problem details when the new
    key is not a key at all, leaving every window untouched.  Reports no
    state, so the record is answered ``"accepted"`` like any other.
    """
    author = record.get("author")
    body = record.get("body")
    body = body if isinstance(body, Mapping) else {}
    new_key = body.get("newKey")

    problems_found: list[dict[str, Any]] = []
    if not isinstance(author, str) or not author:
        problems_found.append(
            {"loc": ["body", "author"], "msg": "The record's author is missing.", "type": "missing_author"}
        )
    try:
        validate_new_key(new_key)
    except InvalidNewKey as exc:
        problems_found.append(
            {"loc": ["body", "newKey"], "msg": str(exc), "type": "invalid_new_key"}
        )
    if problems_found:
        raise problems.invalid_key_rotation(problems_found)

    apply_rotation(author, new_key, effective_at=body.get("effectiveAt"))
    return None
