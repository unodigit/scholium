"""Flags plugin (plugin: flags).

Feature 77: a member can flag a paper, post or review via ``POST /v1/flags``
with a reason category.  The flag is saved to the ``flags`` table with status
``pending`` and is picked up by the moderation queue.

``GET /v1/flags`` lists flags for moderators (tier 4): the open ones by
default, filterable by ``state`` and ``target``.  A moderation decision settles
the open flags on its target and links its cid -- see
:mod:`app.modules.moderation.flag_sync`, which this package imports so that the
ledger subscription exists whenever flags do.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1``.
"""

from __future__ import annotations

from .models import Flag, ensure_table, ensure_tables
from .router import router
from .service import (
    DECIDED,
    FLAG_DECIDED_KIND,
    PENDING,
    create_flag,
    decide_flag,
    decide_flags_for_target,
    flag_decided_payload,
    get_flag,
    list_flags,
    save_flag,
)

__all__ = [
    "DECIDED",
    "FLAG_DECIDED_KIND",
    "Flag",
    "PENDING",
    "create_flag",
    "decide_flag",
    "decide_flags_for_target",
    "ensure_table",
    "ensure_tables",
    "flag_decided_payload",
    "get_flag",
    "list_flags",
    "router",
    "save_flag",
]

# Settle flags when a moderation decision is made.  Imported last: the sync
# module imports this package's service, which must be loaded by now.
from app.modules.moderation import flag_sync  # noqa: E402,F401
