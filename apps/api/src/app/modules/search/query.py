"""Ranked full-text search over ``search_fts`` (plugin: search, feature 86).

:func:`search_versions` answers ``GET /v1/search?q=``.  The index
(:mod:`app.modules.search.index`) holds one row per *listed* version, so the
hits are exactly the versions readers may see: a held, rejected or unlisted
version has no row and can never appear.

    result = search_versions("pulsar timing")
    result.total                          # every version that matched
    result.hits                           # the best ``limit`` of them, best first
    result.facets.category                # {"cs.CR": 3, "cs.LG": 1}
    result.facets.status                  # {"preprint": 3, "reviewed": 1}

How a query is answered
-----------------------

1. ``q`` is split into plain words (FTS5 query syntax is never passed
   through, so a query cannot be a syntax error) and matched as an implicit
   AND over the indexed ``title``, ``abstract`` and ``body``.
2. Matches are ranked with FTS5's BM25, title weighted over abstract over
   body: the version that matches ``q`` most strongly comes first, ties
   broken by ``version_cid`` so the order is stable.
3. The filters -- ``category`` (any of the paper's categories), ``status``
   (the paper's current status), ``has_code`` (a manifest file whose role is
   ``code``) and an inclusive ``listed_at`` date range -- narrow that ranked
   list.
4. Facet counts are computed over the *filtered* matches, across all of them
   (not just the page returned), so the caller can see what else narrowing by
   one more facet would find.

Every hit carries the paper metadata readers need to render a result: the
version and paper cids, the ``sch:`` short id, title, abstract, categories,
status, listed time and whether the version ships code.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import SimpleNamespace
from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import text

from app import db
from app.modules import ledger
from app.modules.submissions import LISTED, ensure_tables

from .index import TABLE_NAME, ensure_table

__all__ = [
    "FacetCounts",
    "SearchHit",
    "SearchQuery",
    "SearchResult",
    "search_versions",
    "tokenize",
    "version_has_code",
]

#: The phrase fragment of an FTS5 query is one or more words; anything else is
#: a separator.  Keeping only word characters means a caller's punctuation
#: (quotes, ``*``, ``:``, ``NEAR``...) is data, never FTS5 syntax.
_WORD = re.compile(r"[^\W_]+", re.UNICODE)


@dataclass(frozen=True)
class SearchHit:
    """One ranked version."""

    version_cid: str
    paper_cid: str
    short_id: Optional[str]
    n: int
    title: str
    abstract: str
    categories: list[str]
    status: Optional[str]
    listed_at: Optional[datetime]
    has_code: bool
    #: Relevance, higher is better (``-bm25``); comparable only within a query.
    score: float


@dataclass(frozen=True)
class FacetCounts:
    """How many filtered matches carry each category and each status."""

    category: dict[str, int] = field(default_factory=dict)
    status: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class SearchResult:
    """The answer to one query: the hits, the filtered total and the facets."""

    query: str
    total: int
    hits: list[SearchHit]
    facets: FacetCounts


@dataclass(frozen=True)
class SearchQuery:
    """The filters of one search, as the route parsed them."""

    categories: tuple[str, ...] = ()
    statuses: tuple[str, ...] = ()
    has_code: Optional[bool] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None


def tokenize(query: str) -> list[str]:
    """The plain words of ``query``, in order, de-duplicated."""
    seen: dict[str, None] = {}
    for word in _WORD.findall(query or ""):
        seen.setdefault(word, None)
    return list(seen)


def _match_expression(words: list[str]) -> Optional[str]:
    """An FTS5 MATCH expression for ``words``, or ``None`` when there are none.

    Each word is quoted, so it is matched as a literal token rather than
    parsed as FTS5 syntax.  Words are ANDed: every one must occur in the
    version's title, abstract or body.
    """
    if not words:
        return None
    return " AND ".join(f'"{word}"' for word in words)


def version_has_code(manifest_cid: Optional[str]) -> bool:
    """Whether the signed manifest lists a file whose ``role`` is ``code``.

    The manifest is read from the ledger by the cid the version names.  A
    version whose manifest this node does not hold -- or whose body cannot be
    read -- has no code.
    """
    if not isinstance(manifest_cid, str) or not manifest_cid:
        return False
    entry = ledger.entry_by_cid(manifest_cid)
    if entry is None:
        return False
    try:
        body = ledger.stored_envelope(entry).body
    except Exception:  # pragma: no cover - a corrupt row must not fail a search
        return False
    files = body.get("files") if isinstance(body, Mapping) else None
    if not isinstance(files, list):
        return False
    return any(
        isinstance(item, Mapping) and item.get("role") == "code" for item in files
    )


#: FTS5 BM25 column weights, in column order:
#: ``version_cid`` (UNINDEXED), ``title``, ``abstract``, ``body``.
_BM25_WEIGHTS = "0.0, 10.0, 5.0, 1.0"


def _ranked_rows(match: str) -> list[Any]:
    """Every listed version matching ``match``, best first, with its metadata."""
    sql = text(
        f"""
        SELECT f.version_cid AS version_cid,
               f.rank AS rank,
               pv.paper_cid AS paper_cid,
               pv.n AS n,
               pv.title AS title,
               pv.abstract AS abstract,
               pv.listed_at AS listed_at,
               pv.manifest_cid AS manifest_cid,
               p.short_id AS short_id,
               p.categories AS categories,
               p.status AS status
        FROM (
            SELECT version_cid,
                   bm25({TABLE_NAME}, {_BM25_WEIGHTS}) AS rank
            FROM {TABLE_NAME}
            WHERE {TABLE_NAME} MATCH :match
        ) AS f
        JOIN paper_versions AS pv ON pv.version_cid = f.version_cid
        LEFT JOIN papers AS p ON p.paper_cid = pv.paper_cid
        WHERE pv.state = :listed
        ORDER BY f.rank ASC, f.version_cid ASC
        """
    )
    with db.engine.connect() as connection:
        return list(connection.execute(sql, {"match": match, "listed": LISTED}))


def _category_list(value: Any) -> list[str]:
    """The paper's ``categories`` as a list.

    The query reads ``papers`` through raw SQL, where the JSON column comes
    back as the string SQLite stores rather than a decoded list, so decode it
    here.  An unreadable value yields no categories.
    """
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return []
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return []


def _listed_date(value: Any) -> Optional[date]:
    """The listing date of a raw-SQL ``listed_at`` value, or ``None``.

    Like ``categories``, a timestamp read through raw SQL comes back as the
    string SQLite stores rather than a ``datetime``, so parse it here.
    """
    when = _listed_at(value)
    return when.date() if when is not None else None


def _listed_at(value: Any) -> Optional[datetime]:
    """A raw-SQL ``listed_at`` value as a ``datetime``, or ``None``."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _passes(
    row: Any, filters: SearchQuery, code_cache: dict[str, bool]
) -> bool:
    """Whether one ranked row passes every filter."""
    if filters.categories:
        paper_categories = set(_category_list(row.categories))
        if not paper_categories.intersection(filters.categories):
            return False
    if filters.statuses:
        status = (row.status or "").lower()
        if status not in {s.lower() for s in filters.statuses}:
            return False
    if filters.date_from is not None or filters.date_to is not None:
        listed_on = _listed_date(row.listed_at)
        if listed_on is None:
            return False
        if filters.date_from is not None and listed_on < filters.date_from:
            return False
        if filters.date_to is not None and listed_on > filters.date_to:
            return False
    if filters.has_code is not None:
        if code_cache.get(row.version_cid) is None:
            code_cache[row.version_cid] = version_has_code(row.manifest_cid)
        if code_cache[row.version_cid] is not filters.has_code:
            return False
    return True


def _facets(rows: list[Any]) -> FacetCounts:
    """Count the filtered matches per category and per status."""
    categories: dict[str, int] = {}
    statuses: dict[str, int] = {}
    for row in rows:
        for category in _category_list(row.categories):
            categories[str(category)] = categories.get(str(category), 0) + 1
        if row.status:
            statuses[str(row.status)] = statuses.get(str(row.status), 0) + 1
    return FacetCounts(
        category=_ordered(categories),
        status=_ordered(statuses),
    )


def _ordered(counts: dict[str, int]) -> dict[str, int]:
    """Facet buckets most common first, then alphabetically."""
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


_BARE_ID_PATTERN = re.compile(
    r"^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$", re.IGNORECASE
)


def _short_id_for_query(query: str) -> Optional[str]:
    """A canonical ``sch:`` short id when ``query`` is an id (bare or prefixed).

    Returns ``None`` when ``query`` is not id-shaped or its checksum is bad, so
    an ordinary search is unaffected.
    """
    from scholium_record_core import parse_short_id

    candidate = query.strip()
    candidates: list[str] = []
    if _BARE_ID_PATTERN.fullmatch(candidate):
        candidates.append("sch:" + candidate)
    candidates.append(candidate)
    for value in candidates:
        try:
            return parse_short_id(value)
        except ValueError:
            continue
    return None


def _priority_rows(short_id: str) -> list[Any]:
    """The listed versions of the paper named by ``short_id``, as FTS-like rows."""
    from app.modules import submissions

    submissions.ensure_tables()
    paper = submissions.get_paper_by_short_id(short_id)
    if paper is None:
        return []
    rows: list[Any] = []
    for version in submissions.versions_for_paper(paper.paper_cid):
        if getattr(version, "state", None) != LISTED:
            continue
        rows.append(
            SimpleNamespace(
                version_cid=version.version_cid,
                paper_cid=version.paper_cid,
                n=version.n,
                title=version.title,
                abstract=version.abstract,
                listed_at=version.listed_at,
                manifest_cid=version.manifest_cid,
                short_id=paper.short_id,
                categories=paper.categories,
                status=paper.status,
                rank=-1000.0,
            )
        )
    return rows


def search_versions(query: str, limit: int = 20, **filters: Any) -> SearchResult:
    """The ranked listed versions matching ``query``, with facets.

    ``limit`` caps the returned hits; ``filters`` are the keywords of
    :class:`SearchQuery` (``categories``, ``statuses``, ``has_code``,
    ``date_from``, ``date_to``).
    """
    criteria = SearchQuery(**filters)
    words = tokenize(query)
    match = _match_expression(words)

    ensure_tables()
    if not ensure_table():
        return SearchResult(query=query, total=0, hits=[], facets=FacetCounts())

    code_cache: dict[str, bool] = {}
    priority: list[Any] = []
    short_id = _short_id_for_query(query)
    if short_id is not None:
        priority = _priority_rows(short_id)

    fts_rows: list[Any] = []
    if match is not None:
        fts_rows = _ranked_rows(match)

    priority_ids = {row.version_cid for row in priority}
    rest = [row for row in fts_rows if row.version_cid not in priority_ids]

    matched_priority = [row for row in priority if _passes(row, criteria, code_cache)]
    matched_rest = [row for row in rest if _passes(row, criteria, code_cache)]
    matched = matched_priority + matched_rest
    facets = _facets(matched)

    hits: list[SearchHit] = []
    for row in matched[: max(limit, 0)]:
        if row.version_cid not in code_cache:
            code_cache[row.version_cid] = version_has_code(row.manifest_cid)
        hits.append(
            SearchHit(
                version_cid=row.version_cid,
                paper_cid=row.paper_cid,
                short_id=row.short_id,
                n=row.n,
                title=row.title,
                abstract=row.abstract,
                categories=_category_list(row.categories),
                status=row.status,
                listed_at=_listed_at(row.listed_at),
                has_code=code_cache[row.version_cid],
                score=round(-float(getattr(row, "rank", 0.0)), 6),
            )
        )
    return SearchResult(query=query, total=len(matched), hits=hits, facets=facets)
