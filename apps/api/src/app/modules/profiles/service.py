"""Saving and reading encrypted profiles.

::

    from app.modules.profiles import ProfileData, read_profile, save_profile

    save_profile(did, ProfileData(name="Ada", affiliation="Engine Co.", email="ada@example.org"))
    read_profile(did)   # ProfileData(...), or None when there is no readable profile

``save_profile`` is an upsert.  A DID's first save mints a random per-object key
and stores it in ``profile_keys``; later saves re-encrypt under the same key
with a fresh nonce.  The blob, the key and the ``key_ref`` that links them are
written in one transaction, so a reader never finds a blob whose key is
missing because of a half-finished save.

If a profile row's key is gone -- which is what erasure leaves behind -- the
blob is unreadable for good: :func:`read_profile` answers ``None``, and a later
:func:`save_profile` starts over under a brand-new key instead of resurrecting
anything.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass
from typing import Optional

from sqlalchemy.exc import IntegrityError

from app import db

from .crypto import new_key, open_profile, seal_profile
from .models import Profile, ProfileKey, ensure_tables

__all__ = ["ProfileData", "read_profile", "save_profile"]


@dataclass(frozen=True)
class ProfileData:
    """The personal fields held in ``profile.enc_blob``."""

    name: str
    affiliation: str
    email: str


def _new_key_ref() -> str:
    return f"pk_{uuid.uuid4().hex}"


def _require_did(did: str) -> str:
    if not isinstance(did, str) or not did.strip():
        raise ValueError("a non-empty did is required")
    return did


def save_profile(did: str, data: ProfileData) -> ProfileData:
    """Encrypt ``data`` for ``did`` and store it, replacing any earlier profile."""
    _require_did(did)
    ensure_tables()

    # Two first-time saves for one DID can race to insert the same primary key.
    # The loser's transaction (including its freshly minted key) is rolled back
    # whole, and the retry then finds the winner's row and updates it.
    for attempt in (1, 2):
        with db.SessionLocal() as session:
            try:
                profile = session.get(Profile, did)
                key_row = session.get(ProfileKey, profile.key_ref) if profile is not None else None
                if key_row is None:
                    key_row = ProfileKey(key_ref=_new_key_ref(), key=new_key())
                    session.add(key_row)

                blob = seal_profile(key_row.key, did, asdict(data))
                if profile is None:
                    session.add(Profile(did=did, enc_blob=blob, key_ref=key_row.key_ref))
                else:
                    profile.enc_blob = blob
                    profile.key_ref = key_row.key_ref
                session.commit()
                return data
            except IntegrityError:
                session.rollback()
                if attempt == 2:
                    raise
    raise AssertionError("unreachable")  # pragma: no cover


def read_profile(did: str) -> Optional[ProfileData]:
    """Return the decrypted profile for ``did``, or None if there is none to read.

    ``None`` covers both "never saved" and "key deleted" (erased).  A blob that
    is present but fails to decrypt raises
    :class:`~app.modules.profiles.crypto.ProfileDecryptionError`: that is
    corruption, not erasure, and must not be mistaken for it.
    """
    _require_did(did)
    ensure_tables()

    with db.SessionLocal() as session:
        profile = session.get(Profile, did)
        if profile is None:
            return None
        key_row = session.get(ProfileKey, profile.key_ref)
        if key_row is None:
            return None
        fields = open_profile(key_row.key, did, profile.enc_blob)

    return ProfileData(
        name=fields.get("name", ""),
        affiliation=fields.get("affiliation", ""),
        email=fields.get("email", ""),
    )
