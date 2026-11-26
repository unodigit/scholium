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

1. ``q`` is split into plain words (full-text query syntax is never passed
   through, so a query cannot be a syntax error) and matched as an implicit
   AND over the indexed fields -- ``title``, ``authors``, ``abstract`` and
   ``body`` on PostgreSQL, ``title``, ``abstract`` and ``body`` on SQLite's
   FTS5 index, which has no authors column.
2. Matches are ranked with the database's own relevance function: FTS5's BM25
   on SQLite and ``ts_rank_cd`` over the weighted ``tsvector`` on PostgreSQL.
   Both weight title over abstract over body (and authors between title and
   abstract on PostgreSQL), so the version that matches ``q`` most strongly
   comes first and a title match beats a body match on either dialect.  Ties
   are broken by ``version_cid`` so the order is stable.
3. The filters -- ``category`` (any of the paper's categories), ``status``
   (the paper's current status), ``has_code`` (a manifest file whose role is
   ``code``) and an inclusive ``listed_at`` date range -- narrow that ranked
   list.
4. Facet counts are disjunctive: the category counts are computed over every
   match that passes every filter *except* the category filter, and the status
   counts over every match that passes every filter *except* the status filter
   (the other filters still apply).  A selected value therefore still reports
   what widening that facet's OR would add, while with no value selected the
   counts are exactly the results' own.  Both count one hit per paper, across
   all matches (not just the page returned).

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
from app.modules.submissions import LISTED, Authorship, authorship_for, ensure_tables, versions_for_paper

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
    #: The version's authors, in byline order (Authorship rows).
    authors: list[Authorship] = field(default_factory=list)
    #: How many listed versions the paper has (for "v{n} of {total}").
    total_versions: int = 0


@dataclass(frozen=True)
class FacetCounts:
    """How many matches carry each category and each status.

    Each facet ignores its own filter and applies every other one, so the
    counts show what selecting a different value would add.
    """

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


def _postgres() -> bool:
    """Whether the configured database is PostgreSQL."""
    return getattr(db.engine.dialect, "name", "") == "postgresql"


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
#: ``version_cid`` (UNINDEXED), ``title``, ``authors``, ``abstract``, ``body``.
_BM25_WEIGHTS = "0.0, 10.0, 5.0, 5.0, 1.0"

#: ``ts_rank_cd`` weight array for PostgreSQL, in the order PostgreSQL names
#: them: ``{D, C, B, A}`` -- body 0.1, abstract 0.5, authors 0.5, title 1.0.
#: The same ratios as the BM25 weights above (title 10, abstract 5, body 1);
#: ``ts_rank_cd`` requires every weight to be in 0..1, so the BM25 numbers are
#: divided by ten.  Authors (weight ``B`` in the indexed ``tsvector``) sit
#: alongside the abstract.
_TSVECTOR_WEIGHTS = "'{0.1, 0.5, 0.5, 1.0}'::float4[]"

#: ``'simple'`` matches the index built by
#: :data:`app.modules.search.index.WEIGHTED_DOCUMENT`: case-folded words, no
#: stemming, ordered the way FTS5's ``unicode61`` tokenizer orders them.
_TSVECTOR_CONFIG = "'simple'::regconfig"

_RANKED_SELECT = """
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
        FROM ({match_rows}) AS f
        JOIN paper_versions AS pv ON pv.version_cid = f.version_cid
        LEFT JOIN papers AS p ON p.paper_cid = pv.paper_cid
        WHERE pv.state = :listed
        ORDER BY f.rank ASC, f.version_cid{collation} ASC
"""

#: The matching rows and their rank, per dialect.  Both report ``rank`` with
#: the FTS5 convention -- smaller is better -- so the shared outer query and
#: the ``-rank`` score the caller sees are the same on either dialect.
_MATCH_ROWS_SQLITE = f"""
            SELECT version_cid,
                   bm25({TABLE_NAME}, {_BM25_WEIGHTS}) AS rank
            FROM {TABLE_NAME}
            WHERE {TABLE_NAME} MATCH :match
"""

#: ``ts_rank_cd`` returns larger for better matches, so it is negated to keep
#: the FTS5 convention along with the outer ``ORDER BY f.rank ASC``.
_MATCH_ROWS_POSTGRES = f"""
            SELECT version_cid,
                   -ts_rank_cd(
                       {_TSVECTOR_WEIGHTS},
                       document,
                       plainto_tsquery({_TSVECTOR_CONFIG}, :match)
                   ) AS rank
            FROM {TABLE_NAME}
            WHERE document @@ plainto_tsquery({_TSVECTOR_CONFIG}, :match)
"""


def _ranked_rows(words: list[str]) -> list[Any]:
    """Every listed version matching every word in ``words``, best first.

    ``words`` are plain words (:func:`tokenize`), never query syntax: SQLite
    matches them as quoted FTS5 tokens ANDed together, PostgreSQL hands them
    to ``plainto_tsquery``, which does the same.  The rows carry the paper and
    version metadata the caller renders, exactly as on the other dialect.
    """
    if not words:
        return []
    if _postgres():
        # ``COLLATE "C"`` makes the tie-break byte order, the same order
        # SQLite's BINARY collation gives, so equal-ranked hits are returned
        # identically on both dialects.
        sql = text(
            _RANKED_SELECT.format(
                match_rows=_MATCH_ROWS_POSTGRES, collation=' COLLATE "C"'
            )
        )
        match = " ".join(words)
    else:
        expression = _match_expression(words)
        if expression is None:  # pragma: no cover - ``words`` is non-empty
            return []
        sql = text(_RANKED_SELECT.format(match_rows=_MATCH_ROWS_SQLITE, collation=""))
        match = expression
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
    row: Any,
    filters: SearchQuery,
    code_cache: dict[str, bool],
    *,
    ignore: Optional[str] = None,
) -> bool:
    """Whether one ranked row passes every filter.

    ``ignore`` names one facet -- ``"category"`` or ``"status"`` -- whose
    filter is skipped, so the facet's own counts can be computed over the
    matches that pass every *other* filter (see :func:`search_versions`).
    """
    if filters.categories and ignore != "category":
        paper_categories = set(_category_list(row.categories))
        if not paper_categories.intersection(filters.categories):
            return False
    if filters.statuses and ignore != "status":
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


def _matched_rows(
    priority: list[Any],
    rest: list[Any],
    filters: SearchQuery,
    code_cache: dict[str, bool],
    *,
    ignore: Optional[str] = None,
) -> list[Any]:
    """The priority hits then the ranked hits that pass ``filters``."""
    return [
        row for row in priority if _passes(row, filters, code_cache, ignore=ignore)
    ] + [
        row for row in rest if _passes(row, filters, code_cache, ignore=ignore)
    ]


def _representatives(matched: list[Any]) -> list[Any]:
    """One hit per paper: its latest listed version among ``matched``.

    A multi-version paper appears once, so the results, the total and both
    facet counts all count one hit per paper.
    """
    by_paper: dict[str, list[Any]] = {}
    for row in matched:
        by_paper.setdefault(row.paper_cid, []).append(row)
    paper_min_index: dict[str, int] = {}
    for paper_cid, rows in by_paper.items():
        paper_min_index[paper_cid] = min(matched.index(row) for row in rows)
    representatives: list[Any] = []
    for paper_cid, rows in by_paper.items():
        # prefer highest n, then smallest version_cid
        candidates = sorted(
            rows,
            key=lambda r: (-int(getattr(r, "n", 0)), str(getattr(r, "version_cid", ""))),
        )
        representatives.append(candidates[0])
    representatives.sort(
        key=lambda r: (paper_min_index[r.paper_cid], str(getattr(r, "version_cid", "")))
    )
    return representatives


def _category_counts(rows: list[Any]) -> dict[str, int]:
    """Count the papers in ``rows`` per category (a paper counts once each)."""
    categories: dict[str, int] = {}
    for row in rows:
        for category in _category_list(row.categories):
            categories[str(category)] = categories.get(str(category), 0) + 1
    return _ordered(categories)


def _status_counts(rows: list[Any]) -> dict[str, int]:
    """Count the papers in ``rows`` per status (a paper counts once)."""
    statuses: dict[str, int] = {}
    for row in rows:
        if row.status:
            statuses[str(row.status)] = statuses.get(str(row.status), 0) + 1
    return _ordered(statuses)


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
    listed = [
        version
        for version in submissions.versions_for_paper(paper.paper_cid)
        if getattr(version, "state", None) == LISTED
    ]
    if not listed:
        return []
    version = max(listed, key=lambda v: (int(v.n),))
    return [
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
    ]


def search_versions(query: str, limit: int = 20, **filters: Any) -> SearchResult:
    """The ranked listed versions matching ``query``, with facets.

    ``limit`` caps the returned hits; ``filters`` are the keywords of
    :class:`SearchQuery` (``categories``, ``statuses``, ``has_code``,
    ``date_from``, ``date_to``).
    """
    criteria = SearchQuery(**filters)
    words = tokenize(query)

    ensure_tables()
    if not ensure_table():
        return SearchResult(query=query, total=0, hits=[], facets=FacetCounts())

    code_cache: dict[str, bool] = {}
    priority: list[Any] = []
    short_id = _short_id_for_query(query)
    if short_id is not None:
        priority = _priority_rows(short_id)

    fts_rows: list[Any] = []
    if words:
        fts_rows = _ranked_rows(words)

    priority_ids = {row.version_cid for row in priority}
    rest = [row for row in fts_rows if row.version_cid not in priority_ids]

    matched = _representatives(_matched_rows(priority, rest, criteria, code_cache))

    # Facets are disjunctive (D2): each facet counts the matches that pass
    # every filter except its own, so a selected value still shows what
    # widening its OR would add.  With no value selected, every filter applies
    # and the counts are exactly the results' own.
    category_rows = matched
    if criteria.categories:
        category_rows = _representatives(
            _matched_rows(priority, rest, criteria, code_cache, ignore="category")
        )
    status_rows = matched
    if criteria.statuses:
        status_rows = _representatives(
            _matched_rows(priority, rest, criteria, code_cache, ignore="status")
        )
    facets = FacetCounts(
        category=_category_counts(category_rows),
        status=_status_counts(status_rows),
    )

    hits: list[SearchHit] = []
    for row in matched[: max(limit, 0)]:
        if row.version_cid not in code_cache:
            code_cache[row.version_cid] = version_has_code(row.manifest_cid)
        try:
            total_versions = len(
                [v for v in versions_for_paper(row.paper_cid) if getattr(v, "state", None) == LISTED]
            )
        except Exception:
            total_versions = int(getattr(row, "n", 0) or 0)
        if total_versions < int(getattr(row, "n", 0) or 0):
            total_versions = int(getattr(row, "n", 0) or 0)
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
                authors=authorship_for(row.version_cid),
                total_versions=total_versions,
            )
        )
    return SearchResult(query=query, total=len(matched), hits=hits, facets=facets)
