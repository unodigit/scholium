"""Operator settings for uploads (plugin: uploads).

* ``UPLOAD_TTL_SECONDS`` — how long an upload may stay incomplete before the
  periodic job deletes it (default 24 hours);
* ``UPLOAD_QUOTA_BYTES`` — how many bytes one account (DID) may have in flight
  at once (default twice the largest single upload, so a bundle of the maximum
  size and then some).

They are read from the environment on every call, so a change applies without
a restart and a test can set them. A value that is missing, not an integer, or
not positive is ignored in favour of the default: a typo must never switch the
protection off.
"""

from __future__ import annotations

import os
from datetime import timedelta
from typing import Optional

from . import limits

TTL_ENV = "UPLOAD_TTL_SECONDS"
QUOTA_ENV = "UPLOAD_QUOTA_BYTES"

DEFAULT_TTL = timedelta(hours=24)
DEFAULT_QUOTA_BYTES = 2 * limits.MAX_UPLOAD_BYTES


def _positive_int(name: str) -> Optional[int]:
    raw = os.getenv(name)
    if raw is None:
        return None
    try:
        value = int(raw.strip())
    except ValueError:
        return None
    return value if value > 0 else None


def upload_ttl() -> timedelta:
    """How old an incomplete upload may get before it is deleted."""
    seconds = _positive_int(TTL_ENV)
    if seconds is None:
        return DEFAULT_TTL
    try:
        return timedelta(seconds=seconds)
    except OverflowError:  # more seconds than a timedelta can hold
        return DEFAULT_TTL


def quota_bytes() -> int:
    """The most bytes one DID may have in flight across its incomplete uploads."""
    quota = _positive_int(QUOTA_ENV)
    return DEFAULT_QUOTA_BYTES if quota is None else quota
