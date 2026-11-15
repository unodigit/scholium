"""Render the newest listed papers of a category as an Atom feed (RFC 4287).

The document is written by hand instead of with :mod:`xml.etree.ElementTree`.
ElementTree keeps one *process-wide* namespace-prefix registry, and
``app.modules.export.oai`` already claims the default (empty) prefix for the
OAI-PMH namespace there; registering Atom as the default prefix as well would
make whichever module registered last rewrite the other's output.  Escaping
text and attributes ourselves keeps this plugin independent of that registry.

What an entry carries
---------------------

``<id>``
    The paper's ``sch:xxxx-xxxx-xxxx`` short id.  An Atom id must stay the
    same for the life of the entry, and the short id is derived from the paper's
    genesis cid, so it survives a new version being listed (a version-specific
    id would make readers show the same paper again as a new item).
``<title>`` / ``<summary>``
    The title and abstract of the listed version shown.
``<published>`` / ``<updated>``
    When the paper first appeared in the catalog, and when a version of it was
    most recently listed.
``<author>``
    One per author, in byline order.  Only the DID is public here (profile
    names are personal data and are not read for a feed).  The feed itself
    names the publisher as its author, which keeps an entry with no authorship
    rows valid Atom.
``<category>``
    One per category the paper is filed under.
``<sch:status>``
    The paper's stored status (``preprint``, ``reviewed``, ``retracted``, ...).
``<sch:version>``
    The version number the title and abstract belong to.

``sch:`` is :data:`SCHOLIUM_NAMESPACE`; the two extension elements are the only
things in the document outside the Atom namespace.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from xml.sax.saxutils import escape, quoteattr

__all__ = [
    "ATOM_MEDIA_TYPE",
    "ATOM_NAMESPACE",
    "FeedAuthor",
    "FeedEntry",
    "PUBLISHER",
    "SCHOLIUM_NAMESPACE",
    "render_feed",
]

ATOM_NAMESPACE = "http://www.w3.org/2005/Atom"
#: Namespace of the ``sch:status`` and ``sch:version`` extension elements.
SCHOLIUM_NAMESPACE = "urn:scholium:atom:1"
ATOM_MEDIA_TYPE = "application/atom+xml"
#: The feed's own author (and generator): the node that publishes it.
PUBLISHER = "Scholium"

#: Characters XML 1.0 forbids outright (C0 controls except tab/LF/CR, the
#: surrogate halves, and the two non-characters).  A title or abstract copied
#: from a PDF can hold any of them, and one such character would make the whole
#: feed unparseable for every reader.
_ILLEGAL_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


@dataclass(frozen=True)
class FeedAuthor:
    """One author of an entry."""

    #: The author's ``did:`` identifier, shown as the ``<name>``.
    did: str


@dataclass(frozen=True)
class FeedEntry:
    """Everything one ``<entry>`` shows, already read from the catalog."""

    #: ``sch:xxxx-xxxx-xxxx`` -- becomes the entry's ``<id>``.
    short_id: str
    title: str
    abstract: str
    #: The paper's stored status.
    status: str
    #: The version number the title and abstract describe.
    version: int
    categories: Sequence[str]
    authors: Sequence[FeedAuthor]
    #: Where a client reads this paper as JSON (``GET /v1/papers/{id}``).
    href: str
    #: When the paper first appeared in the catalog (UTC).
    published: Optional[datetime]
    #: When a version of the paper was most recently listed (UTC).
    updated: Optional[datetime]
    licence: Optional[str] = None


def _text(value: object) -> str:
    """``value`` as element text: XML-illegal characters dropped, markup escaped."""
    return escape(_ILLEGAL_XML.sub("", str(value)))


def _attr(value: object) -> str:
    """``value`` as a quoted attribute value (quotes and markup escaped)."""
    return quoteattr(_ILLEGAL_XML.sub("", str(value)))


def _rfc3339(moment: datetime) -> str:
    """``moment`` as the UTC ``YYYY-MM-DDThh:mm:ssZ`` an Atom date requires.

    The database stores naive UTC, so a naive value is taken to already be UTC.
    """
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _entry_xml(entry: FeedEntry, fallback: datetime) -> str:
    updated = entry.updated or entry.published or fallback
    lines = [
        "  <entry>",
        f"    <id>{_text(entry.short_id)}</id>",
        f"    <title>{_text(entry.title)}</title>",
        f'    <link rel="alternate" type="application/json" href={_attr(entry.href)}/>',
        f"    <updated>{_rfc3339(updated)}</updated>",
    ]
    if entry.published is not None:
        lines.append(f"    <published>{_rfc3339(entry.published)}</published>")
    for author in entry.authors:
        lines.append(
            f"    <author><name>{_text(author.did)}</name>"
            f"<uri>{_text(author.did)}</uri></author>"
        )
    for category in entry.categories:
        lines.append(f"    <category term={_attr(category)}/>")
    lines.append(f'    <summary type="text">{_text(entry.abstract)}</summary>')
    if entry.licence:
        lines.append(f"    <rights>{_text(entry.licence)}</rights>")
    lines.append(f"    <sch:status>{_text(entry.status)}</sch:status>")
    lines.append(f"    <sch:version>{int(entry.version)}</sch:version>")
    lines.append("  </entry>")
    return "\n".join(lines)


def render_feed(
    *,
    feed_id: str,
    title: str,
    self_href: str,
    entries: Iterable[FeedEntry],
    now: Optional[datetime] = None,
) -> bytes:
    """The Atom document for ``entries`` (newest first), as UTF-8 bytes.

    ``feed_id`` is the feed's permanent id and ``self_href`` the URL the feed
    is served from (its ``rel="self"`` link).  The feed's ``<updated>`` is that
    of its newest entry -- so it does not change while nothing new is listed,
    and a reader that polls with conditional requests is not told otherwise --
    or ``now`` for an empty feed, which RFC 4287 still requires to be dated.
    """
    items = list(entries)
    stamp = now or datetime.now(timezone.utc)
    dates = [item.updated or item.published for item in items]
    dates = [moment for moment in dates if moment is not None]
    # Every moment here is naive UTC or aware; compare them on one footing.
    feed_updated = (
        max(dates, key=lambda moment: _rfc3339(moment)) if dates else stamp
    )

    head = [
        '<?xml version="1.0" encoding="utf-8"?>',
        f'<feed xmlns="{ATOM_NAMESPACE}" xmlns:sch="{SCHOLIUM_NAMESPACE}">',
        f"  <id>{_text(feed_id)}</id>",
        f"  <title>{_text(title)}</title>",
        f"  <updated>{_rfc3339(feed_updated)}</updated>",
        f'  <link rel="self" type="{ATOM_MEDIA_TYPE}" href={_attr(self_href)}/>',
        # RFC 4287 wants an author on every entry *or* on the feed.  The feed's
        # is the publisher, so an entry whose authorship rows are missing is
        # still valid Atom; entries that name authors override it.
        f"  <author><name>{_text(PUBLISHER)}</name></author>",
        f"  <generator>{_text(PUBLISHER)}</generator>",
    ]
    body = [_entry_xml(item, stamp) for item in items]
    return ("\n".join(head + body + ["</feed>"]) + "\n").encode("utf-8")
