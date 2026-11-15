"""The young-author limit on starting papers (plugin: submissions, feature 51).

A tier-2 (Author) account younger than 90 days may start **one**
``paper.genesis`` per week.  Older accounts, and accounts of a higher tier,
are not limited by this rule: the limit exists to keep a newly-endorsed author
from filling the node with papers while their endorsement is fresh.

The window is rolling: a genesis may be accepted again once the previous one
is at least :data:`GENESIS_WINDOW` old.  Its start is the ledger's
``received_at`` -- the moment this node accepted the earlier record -- not the
``created`` field the author signed, which a client controls.

The refusal is a ``429`` problem document naming the instant the next genesis
becomes allowed (:class:`~.errors.GenesisRateLimited`).  As with every other
ingest-handler refusal, it happens before the ledger append, so a refused
record stores nothing.

The age and history reads are deliberately tolerant: a missing ``accounts``
or ``event_log`` table means "no account age / no earlier genesis", so a node
whose plugins are not loaded does not fail a submission for a limit it cannot
evaluate.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from app import db
from app.modules.ingest import PAPER_GENESIS_TYPE
from app.security import Tier

from .errors import GenesisRateLimited

__all__ = [
    "GENESIS_WEEKLY_LIMIT",
    "GENESIS_WINDOW",
    "YOUNG_ACCOUNT_MAX_AGE",
    "YOUNG_AUTHOR_TIER",
    "account_created_at",
    "enforce_genesis_quota",
    "is_young_author",
    "newest_recent_genesis",
]

#: Most genesis records a limited account may have accepted in one window.
GENESIS_WEEKLY_LIMIT = 1

#: How long one accepted genesis blocks the next one: one week, rolling.
GENESIS_WINDOW = timedelta(days=7)

#: An account is young until it is this old.  The same 90-day horizon the
#: app-wide write throttle uses for new accounts.
YOUNG_ACCOUNT_MAX_AGE = timedelta(days=90)

#: The only tier this rule limits: tier 2 (Author).  Higher tiers are trusted
#: with more papers; lower tiers cannot submit a genesis at all.
YOUNG_AUTHOR_TIER = int(Tier.AUTHOR)


# --------------------------------------------------------------------------- #
# Time helpers
# --------------------------------------------------------------------------- #


def _utcnow() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime) -> datetime:
    """``value`` as naive UTC (SQLite hands back naive timestamps meaning UTC)."""
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _moment(now: Optional[datetime]) -> datetime:
    """The instant a check runs at, defaulting to now, as naive UTC."""
    return _utcnow() if now is None else _naive_utc(now)


# --------------------------------------------------------------------------- #
# Account age
# --------------------------------------------------------------------------- #


def account_created_at(author: object) -> Optional[datetime]:
    """Return ``author``'s account creation time as naive UTC, or ``None``.

    An author with no account row, an unreadable timestamp or no identity
    plugin has no known age and is treated as young by :func:`is_young_author`
    -- the strict side of the rule, the way the write throttle treats an
    unknown account.
    """
    if not isinstance(author, str) or not author:
        return None
    try:
        from app.modules.identity.models import Account, ensure_account_table
    except ImportError:
        return None
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, author)
        if account is None or account.created_at is None:
            return None
        return _naive_utc(account.created_at)


def is_young_author(author: object, tier: int, *, now: Optional[datetime] = None) -> bool:
    """True when ``author`` is a tier-2 account younger than 90 days.

    A higher tier is never limited, and neither is an account known to be at
    least 90 days old.  An account whose age cannot be read counts as young.
    """
    if int(tier) != YOUNG_AUTHOR_TIER:
        return False
    created_at = account_created_at(author)
    if created_at is None:
        return True
    return _moment(now) - created_at < YOUNG_ACCOUNT_MAX_AGE


# --------------------------------------------------------------------------- #
# Accepted genesis records
# --------------------------------------------------------------------------- #


def newest_recent_genesis(
    author: object,
    *,
    exclude_cid: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Optional[datetime]:
    """The newest ``paper.genesis`` this author had accepted inside the window.

    ``received_at`` values come from the ledger, so a record that was refused
    -- and therefore never appended -- cannot block a later attempt.  A record
    whose cid is ``exclude_cid`` is ignored: that is the very paper being
    retried, not a second genesis.

    Returns ``None`` when there is no such record (or no ledger to read).
    """
    if not isinstance(author, str) or not author:
        return None
    try:
        from app.modules.ledger.models import EventLog, ensure_table
    except ImportError:
        return None
    ensure_table()
    moment = _moment(now)
    cutoff = moment - GENESIS_WINDOW
    with db.SessionLocal() as session:
        query = session.query(EventLog.received_at).filter(
            EventLog.author_did == author,
            EventLog.record_type == PAPER_GENESIS_TYPE,
            EventLog.received_at > cutoff,
        )
        if exclude_cid is not None:
            query = query.filter(EventLog.record_cid != exclude_cid)
        received = [_naive_utc(value) for (value,) in query.all() if value is not None]
    return max(received) if received else None


def enforce_genesis_quota(
    author: object,
    tier: int,
    *,
    paper_cid: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    """Refuse a genesis when a young tier-2 author already started one this week.

    Raises:
        GenesisRateLimited: ``429`` problem details whose ``next_allowed_at``
            (and ``next_allowed_date`` alias) is the earlier genesis's
            ``received_at`` plus :data:`GENESIS_WINDOW`.
    """
    moment = _moment(now)
    if not is_young_author(author, tier, now=moment):
        return
    newest = newest_recent_genesis(author, exclude_cid=paper_cid, now=moment)
    if newest is None:
        return
    next_allowed = newest + GENESIS_WINDOW
    if next_allowed <= moment:
        return
    raise GenesisRateLimited(
        next_allowed,
        now=moment,
        limit=GENESIS_WEEKLY_LIMIT,
        window_seconds=int(GENESIS_WINDOW.total_seconds()),
    )
