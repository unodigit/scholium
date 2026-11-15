"""What keeps ``search_fts`` current: the subscriptions (plugin: search).

Two in-process subscriptions feed the index, and both do the same thing --
:func:`~.index.sync_version` for the version they were told about::

    ledger.subscribe("paper.version", on_version_record)
    subscribe_version_state_changed(on_state_changed)

``paper.version`` on the ledger
    The subscription the spec names.  The ledger notifies it once a
    ``paper.version`` record is in the event log, and the record's cid is the
    version's id.  A version is accepted into ``awaiting_consent``, so for a
    fresh submission this finds nothing to index and makes sure nothing is
    there; it matters for a record whose version this node already holds as
    listed (a replay, or a version restored before the record was logged).

``version.state_changed`` from the submissions plugin
    What actually *lists* a version.  Listing is a decision the node makes
    about a version it already holds -- ``paper_versions.state`` becoming
    ``listed`` -- not a new signed record, so it never passes through the
    ledger (see :mod:`app.modules.submissions.events` for why).  This is
    therefore the subscription that indexes a version when it is listed and
    drops it when it is ``held`` or ``rejected``.

Neither handler trusts the notification's content: the version's state is read
from ``paper_versions``, so the index only ever holds versions the database
says are listed.

The same two handlers also keep the ``embeddings`` table (feature 87) current
-- :func:`~.embeddings.sync_embedding` for the same version -- so a listed
version is embedded when it is listed and its vector is deleted when it is
held or rejected.  They are the *same* subscriptions rather than two more, so
one notification drives both projections.  The full-text write goes first and
an embedder that cannot answer (Ollama configured but down) only costs the
vector: it is logged, never raised, and the search endpoint embeds whatever is
missing the next time it runs.

Both dispatchers log and skip a subscriber that raises, so an index failure
never rolls back a log entry or a transition.  The price is that the index can
miss a notification; :func:`~.index.rebuild_index` and
:func:`~.embeddings.rebuild_embeddings` repair that.

The registries are process-global and tests (and ``create_app``) clear and
rebuild them, so :func:`install` is idempotent and is called both when this
package is imported and from its ``on_startup`` hook.
"""

from __future__ import annotations

import logging
from typing import Any

from app.modules import ledger
from app.modules.ingest import PAPER_VERSION_TYPE
from app.modules.submissions import (
    subscribe_version_state_changed,
    unsubscribe_version_state_changed,
)

from .embeddings import sync_embedding
from .index import supported, sync_version

__all__ = [
    "install",
    "on_state_changed",
    "on_version_record",
    "uninstall",
]

logger = logging.getLogger(__name__)


def _sync_embedding(version_cid: str) -> None:
    """Reconcile the version's embedding; an embedder failure is logged, not raised."""
    try:
        sync_embedding(version_cid)
    except Exception:
        logger.warning(
            "could not update the embedding of %s; search will retry", version_cid, exc_info=True
        )


def on_version_record(entry: Any) -> None:
    """Ledger subscriber: reconcile the version a ``paper.version`` record created."""
    try:
        sync_version(entry.record_cid)
    finally:
        _sync_embedding(entry.record_cid)


def on_state_changed(event: Any) -> None:
    """``version.state_changed`` subscriber: index a listed version, drop any other."""
    try:
        sync_version(event.version_cid)
    finally:
        _sync_embedding(event.version_cid)


def install() -> bool:
    """Subscribe the index to the ledger and to version state changes (idempotent).

    Returns ``False``, subscribing nothing, when the database has no FTS5
    (anything but SQLite).
    """
    if not supported():
        logger.info("search index not installed: the database is not SQLite")
        return False
    ledger.subscribe(PAPER_VERSION_TYPE, on_version_record)
    subscribe_version_state_changed(on_state_changed)
    return True


def uninstall() -> None:
    """Remove both subscriptions.  Intended for tests."""
    ledger.unsubscribe(PAPER_VERSION_TYPE, on_version_record)
    unsubscribe_version_state_changed(on_state_changed)


