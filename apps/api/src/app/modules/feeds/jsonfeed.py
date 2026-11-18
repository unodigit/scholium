"""Render the newest listed papers of a category as a JSON Feed 1.1 document.

``GET /v1/feeds/{category}?format=json`` serves the same papers, in the same
order, as the Atom feed (feature 88): only the document differs.  Both take
their entries from the catalog's own listing, so a reader who switches formats
sees exactly the same catalog.

What an item carries
--------------------
``id``
    The paper's ``sch:xxxx-xxxx-xxxx`` short id.  A JSON Feed id "should be
    unchanged" when the item is updated, and the short id is derived from the
    paper's genesis cid, so it survives a new version being listed (a
    version-specific id would make readers show the same paper again as a new
    item).
``url``
    The paper's page on the web app (``.../p/{id}``), from the configured
    public web origin -- where a person reads it.  ``external_url`` carries
    the API's own JSON record alongside.  When no public web origin is
    configured the API record is the ``url`` itself, as before, and no
    ``external_url`` duplicates it.
``title`` / ``content_text``
    The title and abstract of the listed version shown.  The abstract is plain
    text, so it goes in ``content_text`` -- the field the format insists an
    item carry one way or the other -- never in ``content_html``.
``date_published`` / ``date_modified``
    When the paper first appeared in the catalog, and when a version of it was
    most recently listed (RFC 3339, UTC).
``authors``
    One per author, in byline order, named as their public profile is (the
    display name ``GET /v1/profiles/{did}`` shows every reader; the DID when
    there is no readable profile -- never saved, erased, or blank).  A DID is
    not a URL, so it is the author's ``name`` and nothing else.
``tags``
    The categories the paper is filed under (what other formats call
    categories, JSON Feed calls tags).
``_scholium``
    The paper's stored status (``preprint``, ``reviewed``, ``retracted``, ...)
    and the version number the title and abstract belong to -- the two things
    a reader needs to tell a retracted paper from a preprint without fetching
    it -- plus the licence when there is one.  A JSON Feed extension name must
    begin with an underscore and hold no dots, and its members should say what
    they are about, so the top-level ``_scholium`` object carries an ``about``.

The one thing JSON cannot hold is nothing: unlike the Atom renderer, nothing
is stripped or escaped here -- any Unicode a title or abstract can hold has a
spelling in JSON, and :func:`json.dumps` writes it.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any, Optional

from .atom import FeedEntry, PUBLISHER, rfc3339

__all__ = [
    "EXTENSION",
    "JSON_FEED_MEDIA_TYPE",
    "JSON_FEED_VERSION",
    "render_json_feed",
]

#: The ``version`` URL every JSON Feed 1.1 document carries.
JSON_FEED_VERSION = "https://jsonfeed.org/version/1.1"
#: The MIME type JSON Feed 1.1 publishers are told to serve.
JSON_FEED_MEDIA_TYPE = "application/feed+json"
#: Name of this plugin's extension object; JSON Feed reserves names beginning
#: with an underscore for exactly that.
EXTENSION = "_scholium"
#: Where the extension is documented, for a human reading the raw JSON.  The
#: Atom feed extends Atom with the same prefix (``urn:scholium:atom:1``).
EXTENSION_ABOUT = "urn:scholium:jsonfeed:1"


def _item(entry: FeedEntry, fallback: datetime) -> dict[str, Any]:
    """One catalog entry as a JSON Feed item."""
    scholium: dict[str, Any] = {
        "status": entry.status,
        "version": int(entry.version),
    }
    if entry.licence:
        scholium["licence"] = entry.licence
    # Written in the order the format's own examples read: the stable id and
    # where to read the paper, what it says, when, who wrote it, where filed --
    # and the extension object last of all.
    item: dict[str, Any] = {
        "id": entry.short_id,
        "url": entry.page_href or entry.href,
    }
    if entry.page_href:
        # The web page is the item's own url; the API's JSON record is the
        # related page elsewhere JSON Feed calls external_url.
        item["external_url"] = entry.href
    item["title"] = entry.title
    item["content_text"] = entry.abstract
    if entry.published is not None:
        item["date_published"] = rfc3339(entry.published)
    item["date_modified"] = rfc3339(entry.updated or entry.published or fallback)
    if entry.authors:
        item["authors"] = [{"name": author.shown_name} for author in entry.authors]
    if entry.categories:
        item["tags"] = list(entry.categories)
    item[EXTENSION] = scholium
    return item


def render_json_feed(
    *,
    feed_url: str,
    home_page_url: str,
    title: str,
    description: str,
    entries: Iterable[FeedEntry],
    now: Optional[datetime] = None,
) -> bytes:
    """The JSON Feed 1.1 document for ``entries`` (newest first), as UTF-8 bytes.

    ``feed_url`` is the URL the feed is served from -- a JSON Feed's unique
    identifier -- and ``home_page_url`` the node that publishes it.  An empty
    ``entries`` is a valid feed: ``items`` must be present, but may be empty,
    so a reader can subscribe to a category before its first paper arrives.
    """
    stamp = now or datetime.now(timezone.utc)
    document = {
        "version": JSON_FEED_VERSION,
        "title": title,
        "description": description,
        "home_page_url": home_page_url,
        "feed_url": feed_url,
        # The feed's author is the node that publishes it, as with the Atom
        # feed; an item's own authors, when it has them, say who wrote it.
        "authors": [{"name": PUBLISHER}],
        "items": [_item(entry, stamp) for entry in entries],
        EXTENSION: {"about": EXTENSION_ABOUT},
    }
    return (
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    ).encode("utf-8")
