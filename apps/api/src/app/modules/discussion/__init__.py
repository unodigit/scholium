"""Discussion plugin (plugin: discussion).

Features 99-102 own the paper discussion surface:

* an accepted ``discussion.post`` record is persisted to the
  ``discussion_posts`` table (feature 99);
* ``POST /v1/papers/{id}/threads`` accepts a signed ``discussion.post`` from a
  tier-1 (Member) caller and answers ``201`` with the post cid (feature 100);
* ``GET /v1/papers/{id}/threads`` returns the paper's threads with replies
  ordered by helpful votes then time (features 99 and 101);
* ``POST /v1/posts/{cid}/helpful`` marks a post helpful once -- a repeat by
  the same member is ``409`` -- and only reorders the thread (feature 101);
* ``POST /v1/me/mutes`` mutes a DID so that caller's thread reads omit their
  posts (feature 102).

Persistence hangs off the ledger: importing this package subscribes to
``discussion.post``, so a post is saved whichever endpoint accepted it.  The
record type is a tier-1 action (REV-1) wherever it is registered: this package
and the annotations plugin both register it at tier 1 when nothing has yet, so
the first one loaded wins and the other leaves its registration alone.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1``.
"""

from __future__ import annotations

from app.security import Tier

from .models import DiscussionPost, HelpfulVote, Mute, ensure_table, ensure_tables
from .router import router
from .service import (
    DISCUSSION_POST_TYPE,
    PaperRef,
    handle_record,
    mark_helpful,
    mute,
    muted_dids,
    persist_entry,
    persist_record,
    resolve_paper,
    sync_from_ledger,
    threads_for,
)

__all__ = [
    "DISCUSSION_POST_TYPE",
    "DiscussionPost",
    "HelpfulVote",
    "Mute",
    "PaperRef",
    "ensure_table",
    "ensure_tables",
    "handle_record",
    "mark_helpful",
    "mute",
    "muted_dids",
    "persist_entry",
    "persist_record",
    "resolve_paper",
    "router",
    "sync_from_ledger",
    "threads_for",
]


def _install_ledger_subscriber() -> None:
    """Persist every ``discussion.post`` once it is committed to the log."""
    from app.modules import ledger

    ledger.subscribe(DISCUSSION_POST_TYPE, persist_entry)


def _ensure_record_type() -> None:
    """Register the record type at tier 1 when the annotations plugin has not done so.

    The annotations plugin registers ``discussion.post`` at tier 1 too -- an
    inline annotation is a discussion post, and posting is a tier-1 action --
    and the module loader imports it first.  Leave an existing registration
    untouched rather than conflict with it; registration here is only needed
    on a node built without the annotations plugin.
    """
    from app.modules import ingest

    if ingest.get(DISCUSSION_POST_TYPE) is None:
        ingest.register(DISCUSSION_POST_TYPE, handle_record, min_tier=int(Tier.MEMBER))


_install_ledger_subscriber()
_ensure_record_type()
