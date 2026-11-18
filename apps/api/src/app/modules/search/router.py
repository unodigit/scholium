"""``GET /v1/search`` -- ranked full-text search with facets (plugin: search).

The module loader mounts the package's ``router`` under ``/v1``.  The route::

    GET /v1/search?q=<text>[&category=...][&status=...][&has_code=true]
                   [&from=YYYY-MM-DD][&to=YYYY-MM-DD][&limit=<1-100>]

answers ``200`` with the listed versions matching ``q``, best first, the
facet counts of everything that matched, and the papers' metadata::

    {"query": "pulsar timing",
     "total": 12,
     "results": [{"version_cid": ..., "paper_cid": ..., "short_id": "sch:...",
                  "n": 2, "title": ..., "abstract": ..., "categories": [...],
                  "status": "preprint", "listed_at": ..., "has_code": true,
                  "score": 1.23}, ...],
     "facets": {"category": {"cs.CR": 7, "cs.LG": 5},
                "status": {"preprint": 9, "reviewed": 3}}}

Filters narrow the ranked list *and* the facet counts:

* ``category`` -- the paper is filed under the category (repeatable, OR);
* ``status`` -- the paper's current status (repeatable, OR);
* ``has_code`` -- whether the version's signed manifest lists a ``code`` file;
* ``from`` / ``to`` (also spelled ``date_from`` / ``date_to``) -- inclusive
  bounds on the version's listing date.

Only versions whose state is ``listed`` are ever returned.  The search is
public (no token), like the rest of reading.  A missing or blank ``q`` is
``422`` problem details.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.modules.catalog.router import AuthorOut, _author_out

from .query import SearchHit, search_versions

__all__ = [
    "DEFAULT_LIMIT",
    "MAX_LIMIT",
    "MAX_QUERY_CHARS",
    "FacetsOut",
    "SearchHitOut",
    "SearchOut",
    "router",
]

DEFAULT_LIMIT = 20
MAX_LIMIT = 100
#: Longer queries are refused rather than silently truncated.
MAX_QUERY_CHARS = 2000

router = APIRouter(prefix="/search", tags=["search"])


class SearchHitOut(BaseModel):
    version_cid: str
    paper_cid: str
    short_id: Optional[str] = None
    n: int
    title: str
    abstract: str
    #: The version's authors, in byline order.
    authors: list[AuthorOut]
    categories: list[str]
    status: Optional[str] = None
    listed_at: Optional[datetime] = None
    #: Whether the version's manifest lists a file whose role is ``code``.
    has_code: bool
    #: Relevance within this query (higher is better).
    score: float
    #: How many listed versions the paper has (for "v{n} of {total}").
    total: Optional[int] = None
    total_versions: Optional[int] = None
    versions: Optional[int] = None


class FacetsOut(BaseModel):
    #: ``{category: number of matching papers filed under it}``.
    category: dict[str, int]
    #: ``{status: number of matching papers with it}``.
    status: dict[str, int]


class SearchOut(BaseModel):
    query: str
    #: Every version that matched the query and the filters (not just the page).
    total: int
    results: list[SearchHitOut]
    facets: FacetsOut


def _out(hit: SearchHit) -> SearchHitOut:
    return SearchHitOut(
        version_cid=hit.version_cid,
        paper_cid=hit.paper_cid,
        short_id=hit.short_id,
        n=hit.n,
        title=hit.title,
        abstract=hit.abstract,
        authors=[_author_out(row) for row in hit.authors],
        categories=hit.categories,
        status=hit.status,
        listed_at=hit.listed_at,
        has_code=hit.has_code,
        score=hit.score,
        total=hit.total_versions,
        total_versions=hit.total_versions,
        versions=hit.total_versions,
    )


@router.get("", response_model=SearchOut)
def search(
    q: str = Query(
        ...,
        max_length=MAX_QUERY_CHARS,
        description="What to look for; matched against every listed version's text.",
    ),
    category: list[str] = Query(
        default_factory=list,
        description="Keep papers filed under any of these categories.",
    ),
    status: list[str] = Query(
        default_factory=list,
        description="Keep papers whose current status is any of these.",
    ),
    has_code: Optional[bool] = Query(
        None, description="Keep versions that do (true) or do not (false) ship code."
    ),
    date_from: Optional[date] = Query(
        None, alias="from", description="Earliest listing date, inclusive."
    ),
    date_to: Optional[date] = Query(
        None, alias="to", description="Latest listing date, inclusive."
    ),
    date_from_alias: Optional[date] = Query(
        None, alias="date_from", description="Alias of ``from``."
    ),
    date_to_alias: Optional[date] = Query(
        None, alias="date_to", description="Alias of ``to``."
    ),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Most results to return."),
) -> SearchOut:
    """Listed versions ranked by relevance to ``q``, with facet counts."""
    query = q.strip()
    if not query:
        raise HTTPException(status_code=422, detail="q must not be blank.")
    earliest = date_from if date_from is not None else date_from_alias
    latest = date_to if date_to is not None else date_to_alias
    result = search_versions(
        query,
        limit=limit,
        categories=tuple(c for c in category if c),
        statuses=tuple(s for s in status if s),
        has_code=has_code,
        date_from=earliest,
        date_to=latest,
    )
    return SearchOut(
        query=result.query,
        total=result.total,
        results=[_out(hit) for hit in result.hits],
        facets=FacetsOut(
            category=result.facets.category,
            status=result.facets.status,
        ),
    )
