"""Accept, store and apply ``endorsement`` records (plugin: endorsements).

Feature 41: an ``endorsement`` record (``endorsee``, ``category``, optional
``expiry``) is accepted through the standard ingest pipeline only when its
*author* -- the endorser the signature authenticates -- holds trust tier 3
(Reviewer) or higher.  Accepting it has two effects:

* a row is written to the ``endorsements`` table, keyed by the record's cid;
* the endorsee's account is granted tier 2 (Author), unless it already holds
  a higher tier (an endorsement never demotes anyone).

The two effects happen in one transaction: a reader never sees the
endorsement without the tier grant, or the tier grant without the row.

::

    from app.modules import endorsements

    endorsements.account_tier("did:key:...")        # 0-4, 0 when unknown
    endorsements.save_endorsement(
        record_cid="bafyrei...",
        endorser_did="did:key:...",
        endorsee_did="did:key:...",
        category="cs.AI",
        expiry="2027-01-01T00:00:00Z",
    )

The handler registered with the ingest registry is :func:`handle_endorsement`.
It runs after the pipeline has validated the envelope, the body schema, the
cid and the signature, and after the duplicate check -- but before the record
is appended to the ledger, so raising a problem document there refuses the
record without side effects.

Feature 42 exposes the endorsement *for submission*:

* :func:`can_submit` is the gate other modules consult -- for example a
  ``paper.genesis`` handler asking whether its author may submit in every
  category it names::

      from app.modules.endorsements import can_submit

      can_submit("did:key:...", "cs.AI")   # True only for an active endorsement

* :func:`active_endorsements` backs ``GET /v1/me/endorsements``: every
  endorsement of one DID that has not expired, each carrying its expiry.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.errors import ProblemException
from app.modules.identity.models import Account, ensure_account_table
from app.modules.ingest.errors import InvalidRecord
from app.security import MAX_TIER, MIN_TIER, Tier

from .models import Endorsement, ensure_tables

__all__ = [
    "AUTHOR_TIER",
    "ENDORSEMENT_TYPE",
    "ENDORSER_MIN_TIER",
    "InsufficientEndorserTier",
    "account_tier",
    "active_endorsements",
    "can_submit",
    "handle_endorsement",
    "normalise_expiry",
    "save_endorsement",
]

#: The record type this plugin owns.
ENDORSEMENT_TYPE = "endorsement"

#: The lowest endorser tier that may issue an endorsement (tier 3 Reviewer).
ENDORSER_MIN_TIER = int(Tier.REVIEWER)

#: The tier an accepted endorsement grants its endorsee (tier 2 Author).
AUTHOR_TIER = int(Tier.AUTHOR)

INSUFFICIENT_TIER_TYPE = "urn:scholium:problem:insufficient-tier"


class InsufficientEndorserTier(ProblemException):
    """403: the record's author is below the endorser tier.

    The endorser is the record's *author*, not the caller relaying it: a
    record's authority comes from its signature (ingest verifies it against
    the author's active key), so the check here reads the author's account
    tier.
    """

    def __init__(self, author: object, tier: int) -> None:
        required = ENDORSER_MIN_TIER
        shown = author if isinstance(author, str) else repr(author)
        detail = (
            f"An endorsement may only be issued by {_describe(required)} or higher; "
            f"the endorser {shown} is {_describe(tier)}."
        )
        super().__init__(
            403,
            detail,
            type=INSUFFICIENT_TIER_TYPE,
            required_tier=required,
            caller_tier=tier,
            errors=[
                {
                    "loc": ["body", "author"],
                    "msg": detail,
                    "type": "insufficient_endorser_tier",
                    "input": shown,
                }
            ],
        )
        self.author = author
        self.required_tier = required
        self.caller_tier = tier


def _describe(tier: int) -> str:
    label = Tier(tier).label if MIN_TIER <= tier <= MAX_TIER else "unknown"
    return f"tier {tier} ({label})"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def account_tier(did: object) -> int:
    """Return ``did``'s trust tier, 0 when the account is missing or unreadable.

    A tier outside the 0-4 range in the ``accounts`` table is clamped into it,
    the way the profiles plugin reads the same column.  A missing ``accounts``
    table (a node whose identity plugin has not run yet) reads as 0 too.
    """
    if not isinstance(did, str) or not did:
        return 0
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            return 0
        tier = int(account.tier)
    return min(max(tier, int(MIN_TIER)), int(MAX_TIER))


def normalise_expiry(value: Any) -> Optional[datetime]:
    """Turn an endorsement body's ``expiry`` into a naive UTC timestamp.

    ``None`` and a missing value mean "no expiry" and stay ``None``.  An ISO
    8601 string (``Z`` or a numeric offset accepted) becomes a naive UTC
    ``datetime``, which is what the ``endorsements.expires_at`` column stores.
    Anything else raises :class:`~app.modules.ingest.errors.InvalidRecord`
    (422 problem details) located at ``body.expiry``.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid_expiry(value)

    text = value.strip()
    if not text:
        raise _invalid_expiry(value)
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise _invalid_expiry(value) from None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _invalid_expiry(value: Any) -> InvalidRecord:
    message = "The endorsement 'expiry' must be an ISO 8601 timestamp or null."
    return InvalidRecord(
        [
            {
                "loc": ["body", "expiry"],
                "msg": message,
                "type": "invalid_expiry",
                "input": value if not isinstance(value, str) or len(value) <= 64 else value[:61] + "...",
            }
        ],
        detail=message,
    )


def _coerce_expiry(value: Any) -> Optional[datetime]:
    """Accept ``None``, an ISO 8601 string or a ``datetime`` for a stored expiry."""
    if value is None or isinstance(value, str):
        return normalise_expiry(value)
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        return value
    raise ValueError("expires_at must be a datetime, an ISO 8601 string or None")


def _body(record: Mapping[str, Any]) -> Mapping[str, Any]:
    body = record.get("body")
    return body if isinstance(body, Mapping) else {}


def _required_text(body: Mapping[str, Any], field: str) -> str:
    value = body.get(field)
    if not isinstance(value, str) or not value:
        message = f"The endorsement body requires a non-empty '{field}' string."
        raise InvalidRecord(
            [
                {
                    "loc": ["body", field],
                    "msg": message,
                    "type": "missing_endorsement_field",
                    "input": None,
                }
            ],
            detail=message,
        )
    return value


def handle_endorsement(record: Mapping[str, Any]) -> str:
    """Validate an endorsement and apply it; return the reported state.

    Called by the ingest pipeline after envelope/body/cid/signature checks,
    so this only adds what the generic pipeline cannot know:

    * the endorser -- the record's author -- must hold tier 3 or higher;
    * ``expiry``, when present, must be an ISO 8601 string (the shipped JSON
      Schema permits any string, so the format is checked here);
    * accepting the record writes the ``endorsements`` row and grants the
      endorsee tier 2.

    Raises :class:`InsufficientEndorserTier` (403) or
    :class:`~app.modules.ingest.errors.InvalidRecord` (422); either escapes
    ``POST /v1/records`` as an RFC 9457 problem document, and because the
    handler runs before the ledger append, the refused record is never stored.
    """
    author = record.get("author")
    tier = account_tier(author)
    if tier < ENDORSER_MIN_TIER:
        raise InsufficientEndorserTier(author, tier)

    body = _body(record)
    endorsee = _required_text(body, "endorsee")
    category = _required_text(body, "category")
    expires_at = normalise_expiry(body.get("expiry"))

    record_cid = record.get("id")
    if not isinstance(record_cid, str) or not record_cid:
        # Envelope validation in the pipeline guarantees this; direct callers
        # get the same 422 rather than an uncatchable database error.
        message = "The endorsement record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [
                {
                    "loc": ["body", "id"],
                    "msg": message,
                    "type": "missing_record_id",
                    "input": None,
                }
            ],
            detail=message,
        )

    save_endorsement(
        record_cid=record_cid,
        endorser_did=author,
        endorsee_did=endorsee,
        category=category,
        expires_at=expires_at,
    )
    return "accepted"


def save_endorsement(
    *,
    record_cid: str,
    endorser_did: str,
    endorsee_did: str,
    category: str,
    expires_at: Any = None,
) -> Endorsement:
    """Store one endorsement and grant the endorsee tier 2 in one transaction.

    ``expires_at`` may be a ``datetime`` or an ISO 8601 string (or ``None``).
    Writing is idempotent per ``record_cid``: applying the same record twice
    leaves a single row and does not change the tier again.

    Two endorsements for an endorsee who has no account row yet can race to
    create that account; the loser's transaction is rolled back whole and the
    retry finds the winner's row, exactly like :mod:`app.modules.profiles`.
    """
    if not isinstance(record_cid, str) or not record_cid:
        raise ValueError("a non-empty record_cid is required")
    if not isinstance(endorser_did, str) or not endorser_did:
        raise ValueError("a non-empty endorser_did is required")
    if not isinstance(endorsee_did, str) or not endorsee_did:
        raise ValueError("a non-empty endorsee_did is required")
    if not isinstance(category, str) or not category:
        raise ValueError("a non-empty category is required")
    expires = _coerce_expiry(expires_at)

    ensure_tables()
    ensure_account_table()

    for attempt in (1, 2):
        with db.SessionLocal() as session:
            try:
                row = session.get(Endorsement, record_cid)
                if row is None:
                    row = Endorsement(
                        record_cid=record_cid,
                        endorser_did=endorser_did,
                        endorsee_did=endorsee_did,
                        category=category,
                        expires_at=expires,
                    )
                    session.add(row)
                _grant_author(session, endorsee_did)
                session.commit()
                session.refresh(row)
                return row
            except IntegrityError:
                session.rollback()
                if attempt == 2:
                    raise
    raise AssertionError("unreachable")  # pragma: no cover


def _grant_author(session: Any, did: str) -> None:
    """Set ``did``'s account tier to at least :data:`AUTHOR_TIER`."""
    account = session.get(Account, did)
    if account is None:
        session.add(Account(did=did, tier=AUTHOR_TIER, created_at=_utcnow()))
    elif int(account.tier) < AUTHOR_TIER:
        account.tier = AUTHOR_TIER


# --------------------------------------------------------------------------- #
# Submission rights (feature 42)
# --------------------------------------------------------------------------- #


def _as_naive_utc(value: Optional[datetime]) -> datetime:
    """Return ``value`` (default: now) as the naive UTC the columns store."""
    if value is None:
        return _utcnow()
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _active_clause(moment: datetime) -> Any:
    """SQL predicate matching endorsements that have not expired at ``moment``."""
    return (Endorsement.expires_at.is_(None)) | (Endorsement.expires_at > moment)


def can_submit(did: object, category: object, *, now: Optional[datetime] = None) -> bool:
    """Return whether ``did`` may submit in ``category`` right now.

    Submission rights are conferred by an endorsement, not by a trust tier: a
    DID may submit in a category exactly when an *active* endorsement of that
    DID for that category exists.  An endorsement is active until its
    ``expires_at``; one without an expiry never lapses.  An endorsement of
    another DID, of another category or one that has expired does not count.

    Missing, empty or non-string arguments answer ``False`` rather than
    raising, so a caller can test untrusted record fields directly::

        can_submit(record["author"], category)   # False unless endorsed

    ``now`` (naive or aware UTC) exists for tests; it defaults to the current
    instant.
    """
    if not isinstance(did, str) or not did:
        return False
    if not isinstance(category, str) or not category:
        return False

    ensure_tables()
    moment = _as_naive_utc(now)
    with db.SessionLocal() as session:
        found = (
            session.query(Endorsement.record_cid)
            .filter(
                Endorsement.endorsee_did == did,
                Endorsement.category == category,
                _active_clause(moment),
            )
            .first()
        )
    return found is not None


def active_endorsements(
    did: object, *, now: Optional[datetime] = None
) -> list[Endorsement]:
    """Return ``did``'s unexpired endorsements, ordered by category then cid.

    Expired endorsements are left out, so every row returned is one the
    endorsee may still rely on.  A caller DID that is missing, empty or not a
    string has no endorsements.  ``now`` defaults to the current instant and
    exists for tests.
    """
    if not isinstance(did, str) or not did:
        return []

    ensure_tables()
    moment = _as_naive_utc(now)
    with db.SessionLocal() as session:
        return (
            session.query(Endorsement)
            .filter(
                Endorsement.endorsee_did == did,
                _active_clause(moment),
            )
            .order_by(Endorsement.category, Endorsement.record_cid)
            .all()
        )
