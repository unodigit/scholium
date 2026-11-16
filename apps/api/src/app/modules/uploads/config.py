"""Operator settings for uploads (plugin: uploads).

* ``UPLOAD_TTL_SECONDS`` — how long an upload may stay *incomplete* before the
  periodic job deletes it (default 24 hours);
* ``UPLOAD_ORPHAN_TTL_SECONDS`` — how long a *completed* upload may go with no
  manifest naming its bytes before the periodic job deletes it and its bytes
  (default 7 days);
* ``UPLOAD_QUOTA_BYTES`` — how many bytes one account (DID) may have in flight
  at once (default twice the largest single upload, so a bundle of the maximum
  size and then some);
* ``UPLOAD_DAILY_QUOTA_BYTES`` — how many bytes one account younger than
  :data:`NEW_ACCOUNT_MAX_AGE` may hold in flight *plus* finish without any
  manifest referencing them, in a rolling day (default 2 GiB: Phase 1's
  pilot accounts are all young);
* ``UPLOAD_DAILY_QUOTA_BYTES_ESTABLISHED`` — the same allowance for an account
  at least :data:`NEW_ACCOUNT_MAX_AGE` old (default 20 GiB, which leaves room
  for the 5 GiB bundle cap many times over).

They are read from the environment on every call, so a change applies without
a restart and a test can set them. A value that is missing, not an integer, or
not positive is ignored in favour of the default: a typo must never switch the
protection off.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from . import limits

TTL_ENV = "UPLOAD_TTL_SECONDS"
#: ``UPLOAD_ORPHAN_TTL_SECONDS`` is the documented spelling; the shorter
#: ``UPLOAD_ORPHAN_TTL`` is accepted too (same unit: seconds).
ORPHAN_TTL_ENV = "UPLOAD_ORPHAN_TTL_SECONDS"
ORPHAN_TTL_ALIAS_ENV = "UPLOAD_ORPHAN_TTL"
QUOTA_ENV = "UPLOAD_QUOTA_BYTES"
DAILY_QUOTA_ENV = "UPLOAD_DAILY_QUOTA_BYTES"
ESTABLISHED_DAILY_QUOTA_ENV = "UPLOAD_DAILY_QUOTA_BYTES_ESTABLISHED"

DEFAULT_TTL = timedelta(hours=24)
DEFAULT_ORPHAN_TTL = timedelta(days=7)
DEFAULT_QUOTA_BYTES = 2 * limits.MAX_UPLOAD_BYTES

GIB = 1024**3
#: What a young account may add to the content store in a day.
DEFAULT_DAILY_QUOTA_BYTES = 2 * GIB
#: What an established account may add to the content store in a day.  It is
#: comfortably above the 5 GiB single-upload cap, which stays in force.
DEFAULT_ESTABLISHED_DAILY_QUOTA_BYTES = 20 * GIB

#: Accounts younger than this get the young-account allowance.  It is the same
#: horizon the write throttle uses for new accounts (``app.middleware``).
NEW_ACCOUNT_MAX_AGE = timedelta(days=90)

#: The rolling window the daily allowances are measured over.
DAILY_WINDOW = timedelta(days=1)


def _positive_int(name: str) -> Optional[int]:
    raw = os.getenv(name)
    if raw is None:
        return None
    try:
        value = int(raw.strip())
    except ValueError:
        return None
    return value if value > 0 else None


def _configured_timedelta(name: str, default: timedelta) -> timedelta:
    seconds = _positive_int(name)
    if seconds is None:
        return default
    try:
        return timedelta(seconds=seconds)
    except OverflowError:  # more seconds than a timedelta can hold
        return default


def upload_ttl() -> timedelta:
    """How old an incomplete upload may get before it is deleted."""
    return _configured_timedelta(TTL_ENV, DEFAULT_TTL)


def orphan_ttl() -> timedelta:
    """How old a completed upload may get without a manifest before it is deleted."""
    seconds = _positive_int(ORPHAN_TTL_ENV)
    if seconds is None:
        seconds = _positive_int(ORPHAN_TTL_ALIAS_ENV)
    if seconds is None:
        return DEFAULT_ORPHAN_TTL
    try:
        return timedelta(seconds=seconds)
    except OverflowError:  # more seconds than a timedelta can hold
        return DEFAULT_ORPHAN_TTL


def quota_bytes() -> int:
    """The most bytes one DID may have in flight across its incomplete uploads."""
    quota = _positive_int(QUOTA_ENV)
    return DEFAULT_QUOTA_BYTES if quota is None else quota


def _established(created_at: Optional[datetime], now: Optional[datetime]) -> bool:
    """Whether an account is old enough for the established-account allowance."""
    if created_at is None:
        return False  # unknown age is the strict end: a new account
    current = now if now is not None else datetime.now(timezone.utc)
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current - created_at >= NEW_ACCOUNT_MAX_AGE


def daily_quota_bytes(
    account_created_at: Optional[datetime] = None,
    *,
    now: Optional[datetime] = None,
) -> int:
    """The bytes one DID may hold in flight plus finish unreferenced in a day.

    ``account_created_at`` is ``accounts.created_at`` for the uploader; a
    ``None`` (no account row, an unreadable timestamp) counts as brand new and
    gets the strict, young-account allowance.
    """
    if _established(account_created_at, now):
        configured = _positive_int(ESTABLISHED_DAILY_QUOTA_ENV)
        if configured is None:
            # A single ``UPLOAD_DAILY_QUOTA_BYTES`` is an operator's explicit
            # cap and applies to every account; the established-specific
            # setting only exists to size the two tiers differently.
            configured = _positive_int(DAILY_QUOTA_ENV)
        return DEFAULT_ESTABLISHED_DAILY_QUOTA_BYTES if configured is None else configured
    configured = _positive_int(DAILY_QUOTA_ENV)
    return DEFAULT_DAILY_QUOTA_BYTES if configured is None else configured
