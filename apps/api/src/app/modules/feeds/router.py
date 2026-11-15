"""``GET /v1/feeds/{category}`` -- a feed of newly listed papers.

The module loader mounts ``router`` under ``/v1``, so this package serves::

    GET /v1/feeds/{category}[?limit=1-100][?format=atom|json]

``{category}`` is a category exactly as papers are filed under it (``cs.AI``).
The answer lists the papers filed under that category that have a listed
version, newest first -- newest by the instant the paper first appeared in the
catalog, the same order as ``GET /v1/papers?category=...`` -- one entry per
paper.  Which document carries them depends on ``format``:

``atom`` (the default, also when the parameter is absent)
    An Atom 1.0 document (``application/atom+xml``; feature 88)::

        <entry>
          <id>sch:k3f9-q2xz-7mwd</id>
          <title>...</title>
          <link rel="alternate" type="application/json" href=".../v1/papers/sch:k3f9-q2xz-7mwd"/>
          <updated>2026-02-01T00:00:00Z</updated>
          <published>2026-01-01T00:00:00Z</published>
          <author><name>did:key:z6Mk...</name><uri>did:key:z6Mk...</uri></author>
          <category term="cs.AI"/>
          <summary type="text">...</summary>
          <rights>CC-BY-4.0</rights>
          <sch:status>reviewed</sch:status>
          <sch:version>2</sch:version>
        </entry>

``json``
    The same papers as a JSON Feed 1.1 document
    (``application/feed+json``; feature 89), one item per paper::

        {
          "id": "sch:k3f9-q2xz-7mwd",
          "url": ".../v1/papers/sch:k3f9-q2xz-7mwd",
          "title": "...",
          "content_text": "the abstract",
          "date_published": "2026-01-01T00:00:00Z",
          "date_modified": "2026-02-01T00:00:00Z",
          "authors": [{"name": "did:key:z6Mk..."}],
          "tags": ["cs.AI"],
          "_scholium": {"status": "reviewed", "version": 2, "licence": "CC-BY-4.0"}
        }

In both, the entry's id is the paper's ``sch:`` short id and its status and
version ride along (``<sch:status>`` in Atom, the ``_scholium`` extension in
JSON Feed), so a reader can tell a retracted paper from a preprint without
fetching it.  See :mod:`app.modules.feeds.atom` and
:mod:`app.modules.feeds.jsonfeed` for the two documents.

Only *listed* versions are ever shown: a paper still in moderation, held or
rejected is not in the catalog and so is not in the feed.  A category no paper
is filed under is not an error -- a feed reader can subscribe before the first
paper arrives -- and answers an empty, dated feed.  Like the rest of reading,
feeds are public.  ``limit`` (default 50) is the most entries one document
holds; a feed has no pages, a reader follows it by polling.
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Path, Query, Request, Response

from app.modules.catalog import listing
from app.modules.submissions import authorship_for

from .atom import ATOM_MEDIA_TYPE, FeedAuthor, FeedEntry, render_feed
from .jsonfeed import JSON_FEED_MEDIA_TYPE, render_json_feed

__all__ = ["DEFAULT_LIMIT", "MAX_LIMIT", "router"]

#: Entries in a feed when the client names no ``limit``.
DEFAULT_LIMIT = 50
#: The most entries one feed may hold (what the catalog listing allows a page).
MAX_LIMIT = listing.MAX_LIMIT

#: Router the module loader mounts under ``/v1``.
router = APIRouter(tags=["feeds"])


def _entry(entry: listing.CatalogEntry, base_url: str) -> FeedEntry:
    """One catalog entry as the feed shows it."""
    paper = entry.paper
    version = entry.version
    return FeedEntry(
        short_id=paper.short_id,
        title=version.title,
        abstract=version.abstract,
        status=paper.status or "preprint",
        version=int(version.n),
        categories=list(paper.categories or []),
        authors=[
            FeedAuthor(did=row.author_did) for row in authorship_for(version.version_cid)
        ],
        href=f"{base_url}v1/papers/{quote(paper.short_id, safe=':')}",
        published=entry.listed_at,
        updated=entry.updated_at,
        licence=version.licence,
    )


@router.get(
    "/feeds/{category}",
    response_class=Response,
    responses={200: {"content": {ATOM_MEDIA_TYPE: {}, JSON_FEED_MEDIA_TYPE: {}}}},
    summary="Feed of the newest papers listed in a category",
)
def get_category_feed(
    request: Request,
    category: str = Path(min_length=1, max_length=64, description="e.g. cs.AI"),
    limit: Optional[int] = Query(
        default=None,
        ge=1,
        le=MAX_LIMIT,
        description=f"the most entries in the feed (default {DEFAULT_LIMIT})",
    ),
    format: Optional[str] = Query(
        default=None,
        pattern="^(atom|json)$",
        description=(
            "the document the feed comes as: json for JSON Feed 1.1,"
            " atom (the default) for Atom 1.0"
        ),
    ),
) -> Response:
    """Return ``category``'s newest listed papers as a feed.

    ``format=json`` answers a JSON Feed 1.1 document; anything else -- the
    parameter absent, or ``atom`` -- answers Atom, as before.  Both documents
    are built from the same page of the same listing in the same order.
    """
    page = listing.list_papers(
        tab="latest",
        category=category,
        sort="newest",
        limit=DEFAULT_LIMIT if limit is None else limit,
    )
    base_url = str(request.base_url)
    if not base_url.endswith("/"):
        base_url += "/"
    entries = [_entry(entry, base_url) for entry in page.entries]
    if format == "json":
        document = render_json_feed(
            feed_url=str(request.url),
            home_page_url=base_url,
            title=f"Scholium: new papers in {category}",
            description=(
                f"Papers newly listed under {category} on Scholium, newest first."
            ),
            entries=entries,
        )
        return Response(content=document, media_type=JSON_FEED_MEDIA_TYPE)
    document = render_feed(
        feed_id=str(request.url.replace(query="")),
        title=f"Scholium: new papers in {category}",
        self_href=str(request.url),
        entries=entries,
    )
    return Response(content=document, media_type=f"{ATOM_MEDIA_TYPE}; charset=utf-8")
