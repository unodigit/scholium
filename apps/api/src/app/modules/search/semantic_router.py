"""``GET /v1/search/semantic`` (plugin: search).

The module loader mounts the package's ``router`` under ``/v1``.  The route::

    GET /v1/search/semantic?q=<text>[&limit=<1-100>]

answers ``200`` with the listed versions closest in meaning to ``q``, best
first, each with its cosine similarity ``score``::

    {"query": "...", "embedder": "hashing-v1-1024",
     "results": [{"version_cid": ..., "paper_cid": ..., "short_id": "sch:...",
                  "n": 2, "title": ..., "abstract": ..., "categories": [...],
                  "status": "preprint", "listed_at": ..., "score": 0.61}, ...]}

Only versions whose state is ``listed`` are ever returned.  The search is public
(no token), like the rest of reading.  Failures, as RFC 9457 problem details:

* ``q`` missing, blank or too long, or ``limit`` outside 1-100: ``422``.
* The embedder cannot be reached (Ollama configured but down): ``503`` -- the
  stored vectors cannot be compared with a vector from another embedder, so
  there is nothing sensible to fall back to.

See :mod:`app.modules.search.embedder` for how ``embedder`` is chosen and
:mod:`app.modules.search.semantic` for the ranking.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .embedder import EmbedderError
from .semantic import SemanticHit, semantic_search

__all__ = ["DEFAULT_LIMIT", "MAX_LIMIT", "MAX_QUERY_CHARS", "SemanticResultOut", "SemanticSearchOut", "router"]

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 10
MAX_LIMIT = 100
#: Longer queries are refused rather than silently truncated by an embedder.
MAX_QUERY_CHARS = 2000

router = APIRouter(prefix="/search", tags=["search"])


class SemanticResultOut(BaseModel):
    version_cid: str
    paper_cid: str
    short_id: Optional[str] = None
    n: int
    title: str
    abstract: str
    categories: list[str]
    status: Optional[str] = None
    listed_at: Optional[datetime] = None
    #: Cosine similarity with the query, -1..1 (higher is closer).
    score: float


class SemanticSearchOut(BaseModel):
    query: str
    #: The embedder whose vectors were compared (e.g. ``hashing-v1-1024``).
    embedder: str
    results: list[SemanticResultOut]


def _out(hit: SemanticHit) -> SemanticResultOut:
    return SemanticResultOut(
        version_cid=hit.version_cid,
        paper_cid=hit.paper_cid,
        short_id=hit.short_id,
        n=hit.n,
        title=hit.title,
        abstract=hit.abstract,
        categories=hit.categories,
        status=hit.status,
        listed_at=hit.listed_at,
        score=round(hit.score, 6),
    )


# A plain ``def``: it embeds and queries synchronously, so FastAPI runs it in
# its thread pool instead of blocking the event loop on an Ollama round trip.
@router.get("/semantic", response_model=SemanticSearchOut)
def semantic(
    q: str = Query(..., max_length=MAX_QUERY_CHARS, description="What to look for, in plain words."),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Most results to return."),
) -> SemanticSearchOut:
    """Listed versions ranked by cosine similarity of their embeddings to ``q``."""
    query = q.strip()
    if not query:
        raise HTTPException(status_code=422, detail="q must not be blank.")
    try:
        result = semantic_search(query, limit)
    except EmbedderError as exc:
        logger.warning("semantic search unavailable: %s", exc)
        raise HTTPException(
            status_code=503, detail="The embedding service is unavailable; try again shortly."
        ) from exc
    return SemanticSearchOut(
        query=query,
        embedder=result.embedder,
        results=[_out(hit) for hit in result.hits],
    )
