"""Tests for ``GET /v1/feeds/{category}?format=json`` (plugin: feeds, feature 89).

The papers, the order and the shared harness are the Atom feed's (feature 88,
:mod:`.test_atom_feed`); these tests hold the JSON Feed 1.1 document to the
spec at https://jsonfeed.org/version/1.1 and check that both formats show the
same catalog.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

import pytest
from xml.etree import ElementTree as ET

from app.modules.feeds.atom import ATOM_NAMESPACE, FeedAuthor, FeedEntry
from app.modules.feeds.jsonfeed import (
    EXTENSION,
    JSON_FEED_MEDIA_TYPE,
    JSON_FEED_VERSION,
    render_json_feed,
)

from .test_atom_feed import STORABLE_NUL, Paper, Scene, hours_ago

ATOM = f"{{{ATOM_NAMESPACE}}}"
#: RFC 3339 as the feed writes it: ``2026-01-01T12:00:00Z``.
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture
def scene() -> Scene:
    return Scene()


def get(client, scene: Scene, category: str | None = None, **params):
    params.setdefault("format", "json")
    return client.get(f"/v1/feeds/{category or scene.category}", params=params)


def document(response) -> dict:
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(JSON_FEED_MEDIA_TYPE)
    return json.loads(response.content)


def item_ids(feed: dict) -> list[str]:
    return [item["id"] for item in feed["items"]]


# --------------------------------------------------------------------------- #
# The document
# --------------------------------------------------------------------------- #


def test_the_feed_is_a_json_feed_11_document(client, scene):
    scene.listed(hours=1)

    feed = document(get(client, scene))

    assert feed["version"] == JSON_FEED_VERSION == "https://jsonfeed.org/version/1.1"
    assert scene.category in feed["title"]
    assert feed["feed_url"].endswith(f"/v1/feeds/{scene.category}?format=json")
    assert feed["home_page_url"].startswith("http")
    assert feed["description"]
    assert isinstance(feed["items"], list)
    # The feed's author is the node that publishes it (its reader-facing name,
    # not any member's data, exactly as the Atom feed's <author> fallback).
    assert feed["authors"] == [{"name": "Scholium"}]


def test_an_item_carries_the_sch_id_and_status(client, scene):
    paper = scene.listed(hours=2, status="reviewed")

    (item,) = document(get(client, scene))["items"]

    assert item["id"] == paper.short_id
    assert paper.short_id.startswith("sch:")
    assert item[EXTENSION]["status"] == "reviewed"


def test_an_item_describes_the_listed_version(client, scene):
    paper = scene.listed(hours=2)

    (item,) = document(get(client, scene))["items"]

    assert item["title"] == paper.versions[0][2]
    assert item["content_text"] == "Abstract of version 1."
    assert "content_html" not in item  # the abstract is plain text, never HTML
    assert item[EXTENSION]["version"] == 1
    assert item[EXTENSION]["licence"] == "CC-BY-4.0"
    assert item["tags"] == [scene.category]
    assert item["authors"] == [{"name": paper.did}]
    assert RFC3339.match(item["date_published"])
    assert RFC3339.match(item["date_modified"])


def test_the_item_url_resolves_to_the_paper(client, scene):
    paper = scene.listed(hours=1)
    (item,) = document(get(client, scene))["items"]

    response = client.get(item["url"])

    assert response.status_code == 200, response.text
    assert response.json()["shortId"] == paper.short_id
    assert item["url"].endswith(f"/v1/papers/{paper.short_id}")


def test_the_status_follows_the_paper(client):
    for status in ("preprint", "reviewed", "retracted"):
        scene = Scene()
        scene.listed(hours=1, status=status)

        (item,) = document(get(client, scene))["items"]

        assert item[EXTENSION]["status"] == status


# --------------------------------------------------------------------------- #
# Which papers, in what order
# --------------------------------------------------------------------------- #


def test_items_are_newest_listed_first(client, scene):
    oldest = scene.listed(hours=9)
    newest = scene.listed(hours=1)
    middle = scene.listed(hours=5)

    feed = document(get(client, scene))

    assert item_ids(feed) == [newest.short_id, middle.short_id, oldest.short_id]


def test_the_json_feed_shows_the_same_papers_as_the_atom_feed(client, scene):
    for hours in (7, 3, 1):
        scene.listed(hours=hours)

    feed = document(get(client, scene))
    atom = ET.fromstring(client.get(f"/v1/feeds/{scene.category}").content)
    atom_ids = [
        entry.findtext(f"{ATOM}id") for entry in atom.findall(f"{ATOM}entry")
    ]

    assert item_ids(feed) == atom_ids


def test_only_the_named_category_is_in_the_feed(client, scene):
    mine = scene.listed(hours=2)
    other = Scene().listed(hours=1)

    feed = document(get(client, scene))

    assert item_ids(feed) == [mine.short_id]
    assert other.short_id not in item_ids(feed)


def test_a_paper_with_no_listed_version_is_not_in_the_feed(client, scene):
    listed = scene.listed(hours=3)
    held = Paper(scene.category)
    held.hold(held.add_version())
    unlisted = Paper(scene.category)
    unlisted.add_version()

    assert item_ids(document(get(client, scene))) == [listed.short_id]


def test_a_paper_shows_its_latest_listed_version_once(client, scene):
    paper = Paper(scene.category)
    paper.list_version(paper.add_version(), at=hours_ago(5))
    paper.list_version(paper.add_version(), at=hours_ago(1))

    (item,) = document(get(client, scene))["items"]

    assert item["id"] == paper.short_id
    assert item[EXTENSION]["version"] == 2
    assert item["title"] == paper.versions[1][2]
    # First listed five hours ago, last listed one hour ago.
    published = datetime.strptime(item["date_published"], "%Y-%m-%dT%H:%M:%SZ")
    modified = datetime.strptime(item["date_modified"], "%Y-%m-%dT%H:%M:%SZ")
    assert modified - published > timedelta(hours=3)


def test_limit_caps_the_items_and_keeps_the_newest(client, scene):
    papers = [scene.listed(hours=hours) for hours in (6, 4, 2)]

    feed = document(get(client, scene, limit=2))

    assert item_ids(feed) == [papers[2].short_id, papers[1].short_id]


def test_a_new_listing_shows_up_straight_away(client, scene):
    first = scene.listed(hours=2)
    assert item_ids(document(get(client, scene))) == [first.short_id]

    second = scene.listed(hours=0)

    assert item_ids(document(get(client, scene))) == [second.short_id, first.short_id]


# --------------------------------------------------------------------------- #
# The format parameter
# --------------------------------------------------------------------------- #


def test_without_the_parameter_the_feed_is_still_atom(client, scene):
    scene.listed(hours=1)

    response = client.get(f"/v1/feeds/{scene.category}")

    assert response.headers["content-type"].startswith("application/atom+xml")
    assert ET.fromstring(response.content).tag == f"{ATOM}feed"


def test_format_atom_is_the_atom_feed(client, scene):
    scene.listed(hours=1)

    response = client.get(f"/v1/feeds/{scene.category}", params={"format": "atom"})

    assert response.headers["content-type"].startswith("application/atom+xml")


@pytest.mark.parametrize("bad", ["rss", "JSON", "xml", "1", ""])
def test_an_unknown_format_is_a_problem(client, scene, bad):
    response = get(client, scene, format=bad)

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")


@pytest.mark.parametrize("limit", ["0", "101", "-1", "many"])
def test_a_bad_limit_is_still_a_problem_in_json(client, scene, limit):
    response = get(client, scene, limit=limit)

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")


# --------------------------------------------------------------------------- #
# Edges
# --------------------------------------------------------------------------- #


def test_a_category_with_no_papers_is_an_empty_items_array(client, scene):
    feed = document(get(client, scene))

    assert feed["items"] == []
    assert feed["version"] == JSON_FEED_VERSION
    assert scene.category in feed["title"]


def test_reading_the_feed_needs_no_account(client, scene):
    scene.listed(hours=1)

    assert get(client, scene).status_code == 200


def test_text_xml_cannot_hold_survives_intact(client, scene):
    title = f'A <b>bold</b> & "quoted" title{STORABLE_NUL} with a NUL\x0b and a VT'
    abstract = "Abstract with ]]> and <script>alert(1)</script> and \x1b[0m"
    paper = Paper(scene.category)
    paper.list_version(
        paper.add_version(title=title, abstract=abstract), at=hours_ago(1)
    )

    (item,) = document(get(client, scene))["items"]

    # JSON has a spelling for every character there is, so unlike the Atom
    # feed nothing is stripped: the title and abstract round-trip exactly.
    assert item["title"] == title
    assert item["content_text"] == abstract
    assert item["id"] == paper.short_id


# --------------------------------------------------------------------------- #
# The renderer on its own
# --------------------------------------------------------------------------- #


def _entry(**overrides) -> FeedEntry:
    fields = dict(
        short_id="sch:aaaa-bbbb-cccc",
        title="Title",
        abstract="Abstract",
        status="preprint",
        version=1,
        categories=["cs.AI"],
        authors=[FeedAuthor("did:key:z6Mk")],
        href="http://node/v1/papers/sch:aaaa-bbbb-cccc",
        published=datetime(2026, 1, 1, 12, 0, 0),
        updated=datetime(2026, 2, 1, 12, 0, 0),
    )
    fields.update(overrides)
    return FeedEntry(**fields)


def _render(entries, **overrides) -> dict:
    params = dict(
        feed_url="http://node/v1/feeds/cs.AI?format=json",
        home_page_url="http://node/",
        title="Scholium: new papers in cs.AI",
        description="Papers newly listed under cs.AI on Scholium, newest first.",
        entries=entries,
    )
    params.update(overrides)
    return json.loads(render_json_feed(**params))


def test_render_dates_a_naive_moment_as_utc_and_converts_an_aware_one():
    plus_two = timezone(timedelta(hours=2))

    (item,) = _render(
        [
            _entry(
                published=datetime(2026, 1, 1, 12, 0, 0),
                updated=datetime(2026, 2, 1, 14, 0, 0, tzinfo=plus_two),
            )
        ]
    )["items"]

    assert item["date_published"] == "2026-01-01T12:00:00Z"
    assert item["date_modified"] == "2026-02-01T12:00:00Z"


def test_render_an_entry_without_dates_is_dated_now():
    now = datetime(2026, 3, 4, 5, 6, 7, tzinfo=timezone.utc)

    (item,) = _render([_entry(published=None, updated=None)], now=now)["items"]

    assert item["date_modified"] == "2026-03-04T05:06:07Z"
    assert "date_published" not in item


def test_render_an_empty_feed_has_an_empty_items_array():
    feed = _render([])

    assert feed["items"] == []
    assert feed["version"] == JSON_FEED_VERSION


def test_render_an_item_without_authors_has_no_authors_key():
    # The scene's helper always writes an authorship row, so an authorless
    # entry can only be built for the renderer directly.
    (item,) = _render([_entry(authors=[])])["items"]

    assert "authors" not in item


def test_render_the_extension_follows_the_naming_rules():
    feed = _render([_entry()])

    # JSON Feed reserves names beginning with "_" for extensions; the
    # extension's own name and every member key must be dot-free, and only
    # the extension's name may begin with the underscore.
    assert EXTENSION == "_scholium"
    assert set(feed[EXTENSION]) == {"about"}
    item = feed["items"][0]
    for key in item[EXTENSION]:
        assert key.isidentifier() and "." not in key


def test_render_item_keys_are_only_the_formats_own_or_the_extension():
    (item,) = _render([_entry()])["items"]

    allowed = {
        "id", "url", "title", "content_text", "date_published",
        "date_modified", "authors", "tags", EXTENSION,
    } | {"content_html", "external_url", "summary", "image", "banner_image",
         "language", "attachments"}

    assert set(item) <= allowed
    assert EXTENSION in item  # the status and version ride in the extension
