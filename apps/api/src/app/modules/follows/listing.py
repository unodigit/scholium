"""The ``following`` tab of ``GET /v1/papers`` (plugin: follows, feature 179).

:func:`list_following` answers one page of the public catalog restricted to the
papers filed under any category the caller follows.  It deliberately reuses the
catalog plugin's ordering and cursor helpers (:mod:`app.modules.catalog.listing`)
rather than reimplementing them, so:

* ``sort`` means exactly what it means on the ``latest`` tab -- ``newest``,
  ``recently_updated`` or ``recently_reviewed``, newest first, with the same
  total-order tie-break on the paper's cid;
* ``cursor`` is the same opaque, keyset cursor, so walking the Following feed
  never repeats or skips a paper when another paper is listed meanwhile;
* the page is rendered from the same :class:`~app.modules.catalog.listing.CatalogEntry`
  objects, so a row carries the fields ``GET /v1/papers`` already defines.

A paper filed under two followed categories appears once.  Following no
categories yields an empty page rather than an error.  An optional ``category``
narrows the feed further to that one category (and is empty unless the caller
follows it).
"""

from __future__ import annotations

from typing import Optional

from app.modules.catalog import listing as catalog

from .service import followed_categories

__all__ = ["list_following"]


def list_following(
    did: str,
    *,
    category: Optional[str] = None,
    sort: str = "newest",
    cursor: Optional[str] = None,
    limit: int = catalog.DEFAULT_LIMIT,
) -> catalog.CatalogPage:
    """One page of the listed papers in the categories ``did`` follows.

    ``category`` optionally narrows the feed to one followed category, ``sort``
    is one of the catalog's sorts, ``cursor`` a ``next_cursor`` an earlier page
    of the *same sort* returned, and ``limit`` the page size (clamped to
    ``1..MAX_LIMIT``).

    Raises:
        ValueError: ``sort`` is not one of the catalog's sorts.
        catalog.InvalidCursor: ``cursor`` was not issued for ``sort``.
    """
    if sort not in catalog.SORTS:
        raise ValueError(f"unknown sort {sort!r}")
    after = catalog._decode_cursor(cursor, sort) if cursor else None
    page_size = max(1, min(int(limit), catalog.MAX_LIMIT))

    followed = followed_categories(did)
    if category is not None:
        followed = [name for name in followed if name == category]

    # ``_candidates`` filters one exact category, so a set of follows is the
    # union of those lists.  Deduplicate by paper cid: one paper may be filed
    # under several of the followed categories and must appear once.
    candidates: dict[str, catalog._Candidate] = {}
    for name in followed:
        for candidate in catalog._candidates("latest", name):
            candidates.setdefault(candidate.paper_cid, candidate)
    ordered_candidates = list(candidates.values())

    if sort == "recently_reviewed":
        reviewed = catalog._review_instants(ordered_candidates)
        ordered_candidates = [
            catalog._Candidate(
                candidate.paper_cid,
                candidate.first_listed,
                candidate.last_listed,
                reviewed.get(candidate.paper_cid),
            )
            for candidate in ordered_candidates
        ]

    keyed = sorted(
        (
            (catalog._sort_key(sort, candidate), candidate)
            for candidate in ordered_candidates
        ),
        key=lambda pair: pair[0],
        reverse=True,
    )
    if after is not None:
        keyed = [pair for pair in keyed if pair[0] < after]

    window = keyed[:page_size]
    more = len(keyed) > page_size
    next_cursor = (
        catalog._encode_cursor(sort, window[-1][0]) if more and window else None
    )
    return catalog.CatalogPage(
        entries=catalog._entries([candidate for _, candidate in window]),
        next_cursor=next_cursor,
    )
