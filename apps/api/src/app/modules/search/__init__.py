"""Full-text search index module (plugin: search).

Feature 85: each *listed* version's title, abstract and text is saved into the
SQLite FTS5 table ``search_fts``, kept current by subscriptions::

    from app.modules import search

    search.get_entry(version_cid)       # IndexedVersion(title, abstract, body) or None
    search.is_indexed(version_cid)
    search.sync_version(version_cid)    # make the index agree with paper_versions
    search.rebuild_index()              # ... for every version

The index is a projection of ``paper_versions``: a version is in it exactly
while its ``state`` is ``listed``.  Listing a version (or re-listing it after
an appeal) writes its row; ``held``, ``rejected`` and every state before
``listed`` leave no row, so an unlisted draft is never searchable.  ``body`` is
the version's ``version_texts`` paragraphs (the ``checks`` plugin), so text
saved before the version is listed is what gets indexed; call
:func:`sync_version` to pick up text saved afterwards.

Two subscriptions drive it (see :mod:`app.modules.search.subscribers`): the
ledger's ``paper.version`` records, and the submissions plugin's
``version.state_changed`` event.  The second is needed because listing is a
state transition the node makes, not a signed record, so it never reaches the
ledger.

The table is ``search_fts(version_cid UNINDEXED, title, abstract, body)``.
Only SQLite has FTS5; on another database the plugin does nothing.

This package exposes no ``router``: the search endpoints are features 86 and
87.  The module loader still discovers it, which creates the FTS5 table with
the rest at ``create_app`` and subscribes the index.  See
:mod:`app.modules.search.index` for the table and its writes.
"""

from __future__ import annotations

from fastapi import FastAPI

from .index import (
    BODY_SEPARATOR,
    TABLE_NAME,
    IndexedVersion,
    ensure_table,
    get_entry,
    is_indexed,
    rebuild_index,
    remove_entry,
    supported,
    sync_version,
    upsert_entry,
)
from .subscribers import install, on_state_changed, on_version_record, uninstall

__all__ = [
    "BODY_SEPARATOR",
    "IndexedVersion",
    "TABLE_NAME",
    "ensure_table",
    "get_entry",
    "install",
    "is_indexed",
    "on_state_changed",
    "on_startup",
    "on_version_record",
    "rebuild_index",
    "remove_entry",
    "supported",
    "sync_version",
    "uninstall",
    "upsert_entry",
]


def on_startup(app: FastAPI) -> None:
    """Module-loader hook: make sure the table exists and the index is subscribed.

    Runs on every ``create_app``, which matters because the subscriber
    registries are process-global and may have been cleared since this package
    was first imported.  Both steps are idempotent.
    """
    ensure_table()
    install()


# Subscribe on import too, so the index is live for code that imports the
# package without building an app (scripts, tests).
install()
