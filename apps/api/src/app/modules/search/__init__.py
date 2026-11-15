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

Feature 87 adds semantic search on top of the same listed-version projection::

    GET /v1/search/semantic?q=<text>[&limit=<1-100>]

returns listed versions ranked by cosine similarity between the query's
embedding and the embeddings stored in the ``embeddings`` table.  The embedder
is pluggable: the deterministic :class:`~.embedder.HashingEmbedder` by default,
:class:`~.embedder.OllamaEmbedder` when the ``OLLAMA_URL`` environment variable
is set (``OLLAMA_EMBED_MODEL`` picks the model)::

    search.semantic_search("pulsar timing").hits     # SemanticHit, best first
    search.get_embedder()                            # the embedder in force
    search.sync_embedding(version_cid)               # make the vector agree with paper_versions
    search.rebuild_embeddings()                      # ... for every version

The same two subscriptions that keep ``search_fts`` current keep ``embeddings``
current; the endpoint embeds any listed version that has no vector from the
embedder in force.  See :mod:`app.modules.search.embedder`,
:mod:`app.modules.search.embeddings` and :mod:`app.modules.search.semantic`.

The module loader mounts this package's ``router`` under ``/v1``.  It is built
by including each endpoint's own router, so the full-text endpoint (feature 86)
joins it with one more ``router.include_router(...)``.  The loader also creates
the FTS5 table and the ``embeddings`` table with the rest at ``create_app`` and
subscribes the index.  See :mod:`app.modules.search.index` for the FTS table and
its writes.
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI

from .embedder import (
    Embedder,
    EmbedderError,
    HashingEmbedder,
    OllamaEmbedder,
    cosine_similarity,
    get_embedder,
    set_embedder,
)
from .embeddings import (
    Embedding,
    StoredEmbedding,
    embed_versions,
    ensure_table as ensure_embeddings_table,
    get_embedding,
    put_embedding,
    rebuild_embeddings,
    remove_embedding,
    sync_embedding,
)
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
from .semantic import SemanticHit, SemanticResult, semantic_search
from .semantic_router import router as _semantic_router
from .subscribers import install, on_state_changed, on_version_record, uninstall

__all__ = [
    "BODY_SEPARATOR",
    "Embedder",
    "EmbedderError",
    "Embedding",
    "HashingEmbedder",
    "IndexedVersion",
    "OllamaEmbedder",
    "SemanticHit",
    "SemanticResult",
    "StoredEmbedding",
    "TABLE_NAME",
    "cosine_similarity",
    "embed_versions",
    "ensure_embeddings_table",
    "ensure_table",
    "get_embedder",
    "get_embedding",
    "get_entry",
    "install",
    "is_indexed",
    "on_state_changed",
    "on_startup",
    "on_version_record",
    "put_embedding",
    "rebuild_embeddings",
    "rebuild_index",
    "remove_embedding",
    "remove_entry",
    "router",
    "semantic_search",
    "set_embedder",
    "supported",
    "sync_embedding",
    "sync_version",
    "uninstall",
    "upsert_entry",
]

#: Mounted under ``/v1`` by the module loader.  One sub-router per endpoint.
router = APIRouter()
router.include_router(_semantic_router)


def on_startup(app: FastAPI) -> None:
    """Module-loader hook: make sure the tables exist and the index is subscribed.

    Runs on every ``create_app``, which matters because the subscriber
    registries are process-global and may have been cleared since this package
    was first imported.  Both steps are idempotent.
    """
    ensure_table()
    ensure_embeddings_table()
    install()


# Subscribe on import too, so the index is live for code that imports the
# package without building an app (scripts, tests).
install()
