"""Tier-1 (Member) promotion (plugin: orcid, feature 34).

An account starts at tier 0 (Reader) when it first signs in.  It becomes a
tier-1 Member once **both** of these are true:

* an email exists for the DID and its owner has proven it (``profile`` saved,
  link redeemed -- :func:`app.modules.profiles.email_verified`, feature 178);
* an ORCID ownership credential bound to the DID exists in ``credentials``
  (features 32/33).

The ORCID link is the last step of onboarding, so this module promotes the
account right after it issues that credential: :func:`promote_if_eligible` runs
from :func:`app.modules.orcid.service.issue_orcid_credential`, in the same
request that saves the credential.  It is also exported so a caller that has
just completed the *other* half of the pair can ask for the same check.

Rules, in one place:

* only an account whose row says tier 0 is promoted -- an account an operator
  raised to tier 2, 3 or 4 is never moved back down;
* the promotion is an ``UPDATE ... WHERE tier = 0``, so two concurrent links
  cannot promote an account twice or clobber a higher tier set meanwhile;
* a missing ``accounts`` row is left alone: an account at tier 0 is one that
  has signed in, and this module does not mint accounts;
* a withdrawn credential (``revoked``/``suspended``) does not count as a
  linked ORCID, matching what ``GET /v1/profiles/{did}`` shows;
* the email must be *verified* (feature 178), not merely stored.

Nothing here is fatal to the ORCID link: the credential is already committed
when the check runs, so a failure to read the profiles plugin is logged and the
account simply stays at tier 0 until the check can run again.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import func, select, update

from app import db

from .models import Credential, ensure_tables as ensure_credential_tables

__all__ = [
    "MEMBER_TIER",
    "READER_TIER",
    "has_orcid_credential",
    "promotion_eligible",
    "promote_if_eligible",
]

logger = logging.getLogger(__name__)

#: Trust tier of a Member: signed in, a proven email and a linked ORCID.
MEMBER_TIER = 1

#: Trust tier every account is created at on first sign-in.
READER_TIER = 0

#: Credential statuses that mean the iD is no longer linked.  Mirrors the
#: ``_WITHDRAWN_STATUSES`` the profiles plugin applies when it reads a DID's
#: linked ORCID, so the tier and the public profile never disagree.
_WITHDRAWN_STATUSES = frozenset({"revoked", "suspended"})


def _require_did(did: object) -> Optional[str]:
    """Return ``did`` when it is a usable DID string, else ``None``."""
    if not isinstance(did, str) or not did.strip():
        return None
    return did


def has_orcid_credential(did: str) -> bool:
    """Return whether ``did`` holds a current ORCID ownership credential.

    A row whose ``kind`` names ORCID (our issuer writes ``"orcid"``, but the
    column is free text) counts; a ``revoked`` or ``suspended`` row does not.
    A missing ``credentials`` table reads as "no credential", which is right
    for a node that has never issued one.
    """
    did = _require_did(did)
    if did is None:
        return False

    ensure_credential_tables()
    query = select(Credential.status).where(
        Credential.did == did,
        func.lower(Credential.kind).contains("orcid"),
    )
    with db.SessionLocal() as session:
        for status in session.execute(query).scalars():
            if status is None or str(status).strip().lower() not in _WITHDRAWN_STATUSES:
                return True
    return False


def _email_verified(did: str) -> bool:
    """Return whether ``did``'s current stored address has been proven.

    Delegates to the profiles plugin (feature 178), which owns the encrypted
    profile and its verification row.  Imported lazily so this plugin does not
    pull in another plugin's router at import time.  Any failure to read it
    counts as "not verified": a promotion must never be granted on a check
    that could not run.
    """
    try:
        from app.modules.profiles import email_verified
    except Exception:  # pragma: no cover - profiles is a declared dependency
        logger.exception("profiles plugin unavailable; cannot check the email for %s", did)
        return False

    try:
        return bool(email_verified(did))
    except Exception:
        logger.exception("could not check whether %s has a verified email", did)
        return False


def promotion_eligible(did: str, *, email_verified: Optional[bool] = None) -> bool:
    """Return whether ``did`` has met both tier-1 conditions.

    ``email_verified`` lets a caller that has just checked the profile pass the
    answer in; when omitted, the profiles plugin is consulted.
    """
    did = _require_did(did)
    if did is None:
        return False
    if not has_orcid_credential(did):
        return False
    verified = _email_verified(did) if email_verified is None else bool(email_verified)
    return verified


def promote_if_eligible(did: str, *, email_verified: Optional[bool] = None) -> bool:
    """Save tier 1 to ``did``'s ``accounts`` row when both conditions hold.

    Returns ``True`` only when this call moved an existing tier-0 row to tier 1;
    ``False`` covers "not eligible", "no account row", and "already promoted"
    (or raised by an operator), which are all no-ops.  The update is
    conditional on the row still being at tier 0, so it can never lower a
    higher tier, even when it races another promotion.
    """
    if not promotion_eligible(did, email_verified=email_verified):
        return False

    from app.modules.identity.models import Account, ensure_account_table

    ensure_account_table()
    with db.SessionLocal() as session:
        result = session.execute(
            update(Account)
            .where(Account.did == did, Account.tier == READER_TIER)
            .values(tier=MEMBER_TIER)
        )
        session.commit()
        return result.rowcount == 1
