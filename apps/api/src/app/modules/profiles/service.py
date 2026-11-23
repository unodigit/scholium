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

Email verification (feature 178) rides along here.  Every save leaves the
stored address *pending*: :func:`save_profile` records the address's
fingerprint in ``profile_email_verification``, ``send_verification_email``
mails a signed link, and :func:`mark_email_verified` redeems it.
:func:`email_verified` is what the tier-1 promotion (feature 34) consults.
Saving a different address clears any earlier verification, and erasure
deletes the row.
"""

from __future__ import annotations

import hmac
import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from scholium_record_core import did_key_from_signing_key, sign_record
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import db

from .crypto import new_key, open_profile, seal_profile
from .models import Profile, ProfileEmailVerification, ProfileKey, ensure_tables
from .verification import (
    EMAIL_VERIFICATION_KIND,
    build_verification_link,
    email_fingerprint,
    issue_verification_token,
    verify_verification_token,
)

__all__ = [
    "EmailVerification",
    "EmailVerificationError",
    "EmailVerificationTokenError",
    "InvalidEmailVerificationToken",
    "ProfileData",
    "ProfileNotFound",
    "email_verified",
    "erase_profile",
    "is_email_verified",
    "mark_email_verified",
    "read_profile",
    "save_profile",
    "send_verification_email",
]

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProfileData:
    """The personal fields held in ``profile.enc_blob``."""

    name: str
    affiliation: str
    email: str


@dataclass(frozen=True)
class EmailVerification:
    """The outcome of redeeming an email verification link."""

    did: str
    email: str
    verified_at: datetime


class EmailVerificationError(Exception):
    """Base class for a verification link that cannot be redeemed."""


class ProfileNotFound(EmailVerificationError):
    """There is no saved (readable) profile whose address could be verified."""


class InvalidEmailVerificationToken(EmailVerificationError):
    """The token is malformed, expired, forged, or meant for another address."""


# ``EmailVerificationTokenError`` is a descriptive alias kept for callers that
# prefer the longer name; both refer to the same failure.
EmailVerificationTokenError = InvalidEmailVerificationToken


def _new_key_ref() -> str:
    return f"pk_{uuid.uuid4().hex}"


def _mark_email_pending(session: Session, did: str, email: str) -> None:
    """Record ``did``'s current address as pending (or keep it verified).

    Called inside the save transaction.  A row for a *different* address is
    rewritten and loses its ``verified_at``: the old address's verification
    must never carry over to the new one.
    """
    fingerprint = email_fingerprint(did, email)
    row = session.get(ProfileEmailVerification, did)
    if row is None:
        session.add(
            ProfileEmailVerification(
                did=did,
                email_fingerprint=fingerprint,
                verified_at=None,
            )
        )
    elif not hmac.compare_digest(row.email_fingerprint, fingerprint):
        row.email_fingerprint = fingerprint
        row.verified_at = None


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
                # A save with a new address starts a new verification; a save
                # that keeps the current address leaves an existing one alone.
                _mark_email_pending(session, did, data.email)
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


def erase_profile(did: str) -> None:
    """Crypto-shred ``did``'s profile and record the erasure on the event log.

    Deletes the per-object key that opens ``profile.enc_blob`` (the blob itself
    is left in place, permanently unreadable) and the email-verification row,
    then appends an ``erasure.request`` record naming ``did`` in
    ``body.subject``.  The node authors and signs the record with its own
    ``did:key`` (as it does every record it issues on a member's behalf): the
    member holds no key here and signs nothing, and an unsigned record would
    make the node's own export fail ``scholium verify`` and ``scholium
    rebuild``.  A node with no signing key still shreds the profile, but
    appends no record -- never an unsigned one -- and says so in the log.  A
    later :func:`save_profile` starts over under a fresh key, unverified, which
    un-erases.
    """
    _require_did(did)
    ensure_tables()

    with db.SessionLocal() as session:
        profile = session.get(Profile, did)
        if profile is not None:
            key_row = session.get(ProfileKey, profile.key_ref)
            if key_row is not None:
                session.delete(key_row)
        verification = session.get(ProfileEmailVerification, did)
        if verification is not None:
            session.delete(verification)
        if profile is not None or verification is not None:
            session.commit()

    from .views import ERASURE_RECORD_TYPE

    from app.modules import ledger

    key = ledger.node_signing_key()
    if key is None:
        logger.warning(
            "the node has no signing key: erased the profile of %s but appended no "
            "erasure.request, because an unsigned record would fail verification",
            did,
        )
        return

    ledger.append(
        sign_record(
            {
                "v": 1,
                "type": ERASURE_RECORD_TYPE,
                "author": did_key_from_signing_key(key),
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": None,
                "body": {"subject": did, "basis": "data-subject-request"},
                "proofs": [],
            },
            key,
        )
    )


# --------------------------------------------------------------------------- #
# Email verification (feature 178)
# --------------------------------------------------------------------------- #


def _settle_verification_notices(
    did: str,
    *,
    keep_id: Optional[int] = None,
    facts: Optional[dict[str, Any]] = None,
) -> None:
    """Mark ``did``'s unread email-verification notices read, except ``keep_id``.

    Only the newest link is worth acting on: a fresh notice supersedes the
    earlier ones (a profile saved twice must not ask for the same address
    twice), and redeeming a link settles the reminder entirely.  Best-effort by
    design -- an inbox that cannot be tidied must not fail the save or the
    verification.

    ``facts`` records why the notice was settled, as
    :func:`~app.modules.notifications.resolve_for_subject` writes them: a new
    payload dict -- ``superseded`` when a newer link replaced it, ``verified``
    when the link was redeemed.  The client words the notice from those facts,
    so a superseded notice never reads as a confirmation.
    """
    try:
        from app.modules.notifications import Notification, list_notifications

        settled = [
            notification.id
            for notification in list_notifications(did)
            if getattr(notification, "kind", None) == EMAIL_VERIFICATION_KIND
            and not getattr(notification, "read", True)
            and not (keep_id is not None and getattr(notification, "id", None) == keep_id)
        ]
        if not settled:
            return

        session = db.SessionLocal()
        try:
            rows = (
                session.query(Notification)
                .filter(Notification.id.in_(settled), Notification.did == did)
                .all()
            )
            for row in rows:
                if facts:
                    # A new dict: the JSON column only notices a reassignment.
                    row.payload = {**dict(row.payload), **facts}
                row.read = True
            session.commit()
        finally:
            session.close()
    except Exception:
        pass


def send_verification_email(
    did: str,
    email: str,
    *,
    now: Optional[datetime] = None,
) -> Optional[dict[str, Any]]:
    """Email ``did`` a verification link for ``email``; return the payload sent.

    This is best-effort by design: a save must succeed even when the mail
    transport, or the notifications plugin itself, is unavailable.  ``None``
    means "could not hand the message to notifications" -- the profile is
    still saved and a later PUT mints a fresh link.

    A fresh notice settles the DID's earlier unread ones, so saving the same
    address twice leaves one reminder (carrying the newest link) rather than a
    stack of identical ones.
    """
    _require_did(did)
    token = issue_verification_token(did, email, now=now)
    link = build_verification_link(did, token)
    payload: dict[str, Any] = {"email": email, "link": link, "did": did}

    try:
        from app.modules.notifications import notify
    except Exception:  # pragma: no cover - the plugin is a declared dependency
        logger.exception("notifications plugin unavailable; email verification link not sent")
        return None

    try:
        notification = notify(did, EMAIL_VERIFICATION_KIND, payload)
    except Exception:
        logger.exception("could not send the email verification link for %s", did)
        return None
    _settle_verification_notices(did, keep_id=getattr(notification, "id", None), facts={"superseded": True})
    return payload


def mark_email_verified(
    did: str,
    token: str,
    *,
    now: Optional[datetime] = None,
) -> EmailVerification:
    """Redeem a verification ``token`` for ``did``'s stored address.

    Raises :class:`ProfileNotFound` when there is no readable profile (never
    saved, or erased) and :class:`InvalidEmailVerificationToken` for anything
    else that makes the link unusable.  Verifying an already-verified address
    is idempotent.
    """
    _require_did(did)
    ensure_tables()

    profile = read_profile(did)
    if profile is None:
        raise ProfileNotFound(f"there is no profile to verify for {did!r}")
    if not verify_verification_token(token, did, profile.email, now=now):
        raise InvalidEmailVerificationToken("the email verification link is invalid or has expired")

    verified_at = now or datetime.now(timezone.utc)
    fingerprint = email_fingerprint(did, profile.email)
    with db.SessionLocal() as session:
        row = session.get(ProfileEmailVerification, did)
        if row is None:
            # A profile saved before this feature shipped has no row yet; a
            # valid token bound to its current address is proof enough.
            session.add(
                ProfileEmailVerification(
                    did=did,
                    email_fingerprint=fingerprint,
                    verified_at=verified_at,
                )
            )
        else:
            row.email_fingerprint = fingerprint
            row.verified_at = verified_at
        session.commit()

    # The verification notification no longer needs attention; it records that
    # the address was in fact confirmed.
    _settle_verification_notices(did, facts={"verified": True})

    return EmailVerification(did=did, email=profile.email, verified_at=verified_at)


def email_verified(did: str) -> bool:
    """Return whether ``did``'s *current* stored address has been proven.

    This is the check tier 1 (Member) requires, next to an ORCID credential
    (feature 34).  False when there is no profile, when the address is still
    pending, or when a later save changed the address and cleared it.
    """
    _require_did(did)
    ensure_tables()

    profile = read_profile(did)
    if profile is None:
        return False
    with db.SessionLocal() as session:
        row = session.get(ProfileEmailVerification, did)
        if row is None or row.verified_at is None:
            return False
        return hmac.compare_digest(row.email_fingerprint, email_fingerprint(did, profile.email))


#: Descriptive alias for callers that prefer a verb-first predicate.
is_email_verified = email_verified
