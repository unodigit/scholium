"""Flags plugin (plugin: flags).

Feature 77: a member can flag a paper, post or review via ``POST /v1/flags``
with a reason category.  The flag is saved to the ``flags`` table with status
``pending`` and is picked up by the moderation queue.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1``.
"""

from __future__ import annotations

from .models import Flag, ensure_table, ensure_tables
from .router import router
from .service import create_flag, get_flag, list_flags, save_flag

__all__ = [
    "Flag",
    "create_flag",
    "ensure_table",
    "ensure_tables",
    "get_flag",
    "list_flags",
    "router",
    "save_flag",
]