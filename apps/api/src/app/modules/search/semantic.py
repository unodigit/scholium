"""Rank listed versions by embedding similarity to a query (plugin: search).

:func:`semantic_search` is what ``GET /v1/search/semantic`` serves::

    result = semantic_search("pulsar timing")
    result.embedder                      # the embedder whose vectors were compared
    for hit in result.hits:              # best first
        hit.version_cid, hit.score, hit.title, ...

How a query is answered:

1. The query is embedded with the embedder in force.
2. Every version whose ``state`` is ``listed`` -- read from ``paper_versions``
   at that moment, so a held or rejected version can never appear whatever the
   ``embeddings`` table says -- is paired with its stored vector.
3. A listed version with no usable vector (none stored, unreadable, from
   another embedder, or of another dimension) is embedded now and stored, so a
   version is never skipped for want of a vector and vectors from different
   spaces are never compared.
4. The versions are ordered by cosine similarity, best first, ties broken by
   ``version_cid`` so the order is stable, and the best ``limit`` are described.

There is no minimum score: this is nearest-neighbour ranking, so a query that
resembles nothing still returns the closest versions, with low scores the
caller can judge.  The one exception is a query that has no features at all
(the hashing embedder drops stopwords, so "the of and" embeds to the zero
vector): similarity is undefined, so it matches nothing.

Raises :class:`~.embedder.EmbedderError` when the embedder cannot be reached;
the route answers that with ``503``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from app import db
from app.modules.submissions import (
    LISTED,
    Authorship,
    Paper,
    PaperVersion,
    authorship_for,
    ensure_tables,
    versions_for_paper,
)

from .embedder import cosine_similarity, get_embedder
from .embeddings import Embedding, decode_vector, embed_versions, ensure_table

__all__ = ["SemanticHit", "SemanticResult", "semantic_search"]


@dataclass(frozen=True)
class SemanticHit:
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
    score: float
    #: The version's authors, in byline order (Authorship rows).
    authors: list[Authorship] = field(default_factory=list)
    #: How many listed versions the paper has (for "v{n} of {total}").
    total_versions: int = 0


@dataclass(frozen=True)
class SemanticResult:
    """The answer to one query: the embedder used and the ranked hits."""

    query: str
    embedder: str
    hits: list[SemanticHit]


def semantic_search(query: str, limit: int = 10) -> SemanticResult:
    """The ``limit`` listed versions closest to ``query``, best first."""
    ensure_tables()
    ensure_table()
    embedder = get_embedder()
    query_vector = embedder.embed([query])[0]
    if math.sumprod(query_vector, query_vector) == 0.0:
        return SemanticResult(query, embedder.name, [])

    with db.SessionLocal() as session:
        rows = session.execute(
            select(PaperVersion.version_cid, PaperVersion.paper_cid, PaperVersion.n, Embedding.vector)
            .outerjoin(Embedding, Embedding.version_cid == PaperVersion.version_cid)
            .where(PaperVersion.state == LISTED)
        ).all()

    version_paper: dict[str, str] = {}
    version_number: dict[str, int] = {}
    vectors: dict[str, tuple[float, ...]] = {}
    stale: list[str] = []
    for version_cid, paper_cid, n, blob in rows:
        version_paper[version_cid] = paper_cid
        version_number[version_cid] = int(n)
        stored = decode_vector(blob)
        if (
            stored is not None
            and stored.embedder == embedder.name
            and len(stored.vector) == len(query_vector)
        ):
            vectors[version_cid] = stored.vector
        else:
            stale.append(version_cid)
    for version_cid, vector in embed_versions(stale, embedder).items():
        if len(vector) == len(query_vector):
            vectors[version_cid] = vector

    # One hit per paper: keep its latest listed version (highest ``n``) among
    # the listed versions that have a usable vector, rather than ranking every
    # version of a multi-version paper as a separate hit.
    latest_by_paper: dict[str, str] = {}
    for cid in vectors:
        paper_cid = version_paper[cid]
        n = version_number[cid]
        current = latest_by_paper.get(paper_cid)
        if current is None or n > version_number[current] or (
            n == version_number[current] and cid < current
        ):
            latest_by_paper[paper_cid] = cid

    ranked = sorted(
        (
            (cosine_similarity(query_vector, vectors[cid]), cid)
            for cid in latest_by_paper.values()
        ),
        key=lambda scored: (-scored[0], scored[1]),
    )[: max(limit, 0)]
    return SemanticResult(query, embedder.name, _describe(ranked))


def _describe(ranked: list[tuple[float, str]]) -> list[SemanticHit]:
    """Attach each ranked version's metadata, keeping the rank order.

    A version unlisted since it was ranked is dropped.  The paper row is joined
    loosely: a version whose paper this node does not hold still ranks.
    """
    if not ranked:
        return []
    scores = {cid: score for score, cid in ranked}
    with db.SessionLocal() as session:
        rows = session.execute(
            select(PaperVersion, Paper)
            .outerjoin(Paper, Paper.paper_cid == PaperVersion.paper_cid)
            .where(PaperVersion.version_cid.in_(scores), PaperVersion.state == LISTED)
        ).all()
    described = {}
    for version, paper in rows:
        try:
            total_versions = len(
                [v for v in versions_for_paper(version.paper_cid) if getattr(v, "state", None) == LISTED]
            )
        except Exception:
            total_versions = int(version.n or 0)
        if total_versions < int(version.n or 0):
            total_versions = int(version.n or 0)
        described[version.version_cid] = SemanticHit(
            version_cid=version.version_cid,
            paper_cid=version.paper_cid,
            short_id=paper.short_id if paper is not None else None,
            n=version.n,
            title=version.title,
            abstract=version.abstract,
            categories=list(paper.categories or []) if paper is not None else [],
            status=paper.status if paper is not None else None,
            listed_at=version.listed_at,
            score=scores[version.version_cid],
            authors=authorship_for(version.version_cid),
            total_versions=total_versions,
        )
    return [described[cid] for _, cid in ranked if cid in described]
