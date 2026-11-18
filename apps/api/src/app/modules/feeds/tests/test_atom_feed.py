"""Tests for ``GET /v1/feeds/{category}`` (plugin: feeds, feature 88).

Papers are put in place through the submissions plugin's own ``save_paper`` /
``save_version`` and listed with ``transition_version``, like the catalog's
tests.  Every test files its papers under a category of its own, so the feed
of that category isolates them from the rest of the shared database and the
assertions can be exact.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from xml.etree import ElementTree as ET

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules.feeds.atom import (
    ATOM_NAMESPACE,
    SCHOLIUM_NAMESPACE,
    FeedAuthor,
    PUBLISHER,
    FeedEntry,
    render_feed,
)
from app.modules.profiles import ProfileData, erase_profile, save_profile
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)
from app.settings import settings

ATOM = f"{{{ATOM_NAMESPACE}}}"
SCH = f"{{{SCHOLIUM_NAMESPACE}}}"
_TO_LISTED = ("scanning", "moderation")


def hours_ago(hours: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours)


class Paper:
    """A paper saved through the submissions plugin, versions listed on demand."""

    def __init__(self, category: str, *, status: str = "preprint") -> None:
        self.tag = uuid.uuid4().hex
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.genesis = self._sign(
            "paper.genesis",
            {"seed": self.tag, "title": f"Paper {self.tag}", "categories": [category]},
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=(category,),
            licence="CC-BY-4.0",
            status=status,
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list[tuple[int, str, str]] = []

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.key,
        )

    def add_version(
        self, *, title: Optional[str] = None, abstract: Optional[str] = None
    ) -> tuple[int, str, str]:
        n = len(self.versions) + 1
        prev = self.versions[-1][1] if self.versions else self.genesis["id"]
        title = title or f"Feed paper {self.tag} -- version {n}"
        abstract = abstract or f"Abstract of version {n}."
        record = self._sign(
            "paper.version",
            {"paper": self.genesis["id"], "n": n, "title": title, "abstract": abstract},
            prev=prev,
        )
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=abstract,
            manifest_cid="bafkreimanifest",
            licence="CC-BY-4.0",
            prev_cid=prev,
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
        )
        version = (n, record["id"], title)
        self.versions.append(version)
        return version

    def list_version(self, version, at: Optional[datetime] = None) -> None:
        for state in _TO_LISTED:
            transition_version(version[1], state)
        transition_version(version[1], "listed", at=at)

    def hold(self, version) -> None:
        transition_version(version[1], "held")


class Scene:
    """A category of its own and the papers filed under it."""

    def __init__(self) -> None:
        self.category = f"t.{uuid.uuid4().hex[:12]}"

    def listed(self, hours: float = 0, **kwargs) -> Paper:
        paper = Paper(self.category, **kwargs)
        paper.list_version(paper.add_version(), at=hours_ago(hours))
        return paper

    def get(self, client, category: Optional[str] = None, **params):
        return client.get(f"/v1/feeds/{category or self.category}", params=params)


@pytest.fixture
def scene() -> Scene:
    return Scene()


def parse(response) -> ET.Element:
    assert response.status_code == 200, response.text
    return ET.fromstring(response.content)


def entries(root: ET.Element) -> list[ET.Element]:
    return root.findall(f"{ATOM}entry")


def entry_ids(root: ET.Element) -> list[str]:
    return [entry.findtext(f"{ATOM}id") for entry in entries(root)]


# --------------------------------------------------------------------------- #
# The document
# --------------------------------------------------------------------------- #


def test_the_feed_is_atom_xml(client, scene):
    scene.listed(hours=1)

    response = scene.get(client)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/atom+xml")
    root = ET.fromstring(response.content)
    assert root.tag == f"{ATOM}feed"
    assert root.findtext(f"{ATOM}id")
    assert scene.category in root.findtext(f"{ATOM}title")
    assert root.findtext(f"{ATOM}updated").endswith("Z")
    (self_link,) = [
        link for link in root.findall(f"{ATOM}link") if link.get("rel") == "self"
    ]
    assert self_link.get("href").endswith(f"/v1/feeds/{scene.category}")


def test_an_entry_carries_the_sch_id_and_status(client, scene):
    paper = scene.listed(hours=2, status="reviewed")

    (entry,) = entries(parse(scene.get(client)))

    assert entry.findtext(f"{ATOM}id") == paper.short_id
    assert paper.short_id.startswith("sch:")
    assert entry.findtext(f"{SCH}status") == "reviewed"


def test_an_entry_describes_the_listed_version(client, scene):
    paper = scene.listed(hours=2)

    (entry,) = entries(parse(scene.get(client)))

    assert entry.findtext(f"{ATOM}title") == paper.versions[0][2]
    assert entry.findtext(f"{ATOM}summary") == "Abstract of version 1."
    assert entry.findtext(f"{SCH}version") == "1"
    assert entry.findtext(f"{ATOM}rights") == "CC-BY-4.0"
    assert [c.get("term") for c in entry.findall(f"{ATOM}category")] == [scene.category]
    assert entry.findtext(f"{ATOM}author/{ATOM}name") == paper.did
    assert entry.find(f"{ATOM}published") is not None
    assert entry.findtext(f"{ATOM}updated").endswith("Z")
    (alternate,) = [
        link for link in entry.findall(f"{ATOM}link") if link.get("rel") == "alternate"
    ]
    assert alternate.get("href").endswith(f"/p/{paper.short_id}")


def test_the_entry_links_the_web_paper_page_and_the_api_record(client, scene, monkeypatch):
    paper = scene.listed(hours=1)
    monkeypatch.setattr(settings, "WEB_ORIGINS", "https://scholium.example.org")

    (entry,) = entries(parse(scene.get(client)))

    links = entry.findall(f"{ATOM}link")
    rels = [link.get("rel") for link in links]
    assert "alternate" in rels and "related" in rels
    (alternate,) = [link for link in links if link.get("rel") == "alternate"]
    (related,) = [link for link in links if link.get("rel") == "related"]
    # A reader's browser opens the paper's page on the web app, from the
    # configured public web origin.
    assert alternate.get("href") == f"https://scholium.example.org/p/{paper.short_id}"
    assert alternate.get("type") == "text/html"
    # The machine-readable API record stays a link away.
    assert related.get("href").endswith(f"/v1/papers/{paper.short_id}")
    assert related.get("type") == "application/json"


def test_the_related_link_resolves_to_the_paper(client, scene):
    paper = scene.listed(hours=1)
    (entry,) = entries(parse(scene.get(client)))
    (related,) = [
        link for link in entry.findall(f"{ATOM}link") if link.get("rel") == "related"
    ]

    response = client.get(related.get("href"))

    assert response.status_code == 200, response.text
    assert response.json()["shortId"] == paper.short_id


def test_an_entry_names_authors_by_their_profile_display_name(client, scene):
    paper = scene.listed(hours=2)
    save_profile(
        paper.did,
        ProfileData(
            name="Ada Lovelace", affiliation="Analytical Engines", email="ada@example.org"
        ),
    )

    (entry,) = entries(parse(scene.get(client)))

    (author,) = entry.findall(f"{ATOM}author")
    assert author.findtext(f"{ATOM}name") == "Ada Lovelace"
    # The DID stays as the identifier: a name is not unique, a DID is.
    assert author.findtext(f"{ATOM}uri") == paper.did


def test_an_author_without_a_profile_is_named_by_their_did(client, scene):
    paper = scene.listed(hours=2)

    (entry,) = entries(parse(scene.get(client)))

    assert entry.findtext(f"{ATOM}author/{ATOM}name") == paper.did


def test_an_erased_profile_never_leaks_its_name(client, scene):
    paper = scene.listed(hours=2)
    save_profile(
        paper.did,
        ProfileData(
            name="Ada Lovelace", affiliation="Analytical Engines", email="ada@example.org"
        ),
    )
    erase_profile(paper.did)

    response = scene.get(client)

    (entry,) = entries(parse(response))
    assert entry.findtext(f"{ATOM}author/{ATOM}name") == paper.did
    assert "Ada Lovelace" not in response.text


def test_the_status_follows_the_paper(client, scene):
    for status in ("preprint", "reviewed", "retracted"):
        scene_for_status = Scene()
        scene_for_status.listed(hours=1, status=status)

        (entry,) = entries(parse(scene_for_status.get(client)))

        assert entry.findtext(f"{SCH}status") == status


# --------------------------------------------------------------------------- #
# Which papers, in what order
# --------------------------------------------------------------------------- #


def test_entries_are_newest_listed_first(client, scene):
    oldest = scene.listed(hours=9)
    newest = scene.listed(hours=1)
    middle = scene.listed(hours=5)

    root = parse(scene.get(client))

    assert entry_ids(root) == [newest.short_id, middle.short_id, oldest.short_id]


def test_the_feed_updated_is_its_newest_entry(client, scene):
    scene.listed(hours=9)
    newest = scene.listed(hours=1)

    root = parse(scene.get(client))

    newest_entry = entries(root)[0]
    assert newest_entry.findtext(f"{ATOM}id") == newest.short_id
    assert root.findtext(f"{ATOM}updated") == newest_entry.findtext(f"{ATOM}updated")


def test_only_the_named_category_is_in_the_feed(client, scene):
    mine = scene.listed(hours=2)
    other = Scene().listed(hours=1)

    root = parse(scene.get(client))

    assert entry_ids(root) == [mine.short_id]
    assert other.short_id not in entry_ids(root)


def test_a_paper_with_no_listed_version_is_not_in_the_feed(client, scene):
    listed = scene.listed(hours=3)
    held = Paper(scene.category)
    held.hold(held.add_version())
    unlisted = Paper(scene.category)
    unlisted.add_version()

    assert entry_ids(parse(scene.get(client))) == [listed.short_id]


def test_a_paper_shows_its_latest_listed_version_once(client, scene):
    paper = Paper(scene.category)
    paper.list_version(paper.add_version(), at=hours_ago(5))
    paper.list_version(paper.add_version(), at=hours_ago(1))

    (entry,) = entries(parse(scene.get(client)))

    assert entry.findtext(f"{ATOM}id") == paper.short_id
    assert entry.findtext(f"{SCH}version") == "2"
    assert entry.findtext(f"{ATOM}title") == paper.versions[1][2]
    # First listed five hours ago, last listed one hour ago.
    published = datetime.strptime(entry.findtext(f"{ATOM}published"), "%Y-%m-%dT%H:%M:%SZ")
    updated = datetime.strptime(entry.findtext(f"{ATOM}updated"), "%Y-%m-%dT%H:%M:%SZ")
    assert updated - published > timedelta(hours=3)


def test_limit_caps_the_entries_and_keeps_the_newest(client, scene):
    papers = [scene.listed(hours=hours) for hours in (6, 4, 2)]

    root = parse(scene.get(client, limit=2))

    assert entry_ids(root) == [papers[2].short_id, papers[1].short_id]


def test_a_new_listing_shows_up_straight_away(client, scene):
    first = scene.listed(hours=2)
    assert entry_ids(parse(scene.get(client))) == [first.short_id]

    second = scene.listed(hours=0)

    assert entry_ids(parse(scene.get(client))) == [second.short_id, first.short_id]


# --------------------------------------------------------------------------- #
# Edges
# --------------------------------------------------------------------------- #


def test_a_category_with_no_papers_is_an_empty_dated_feed(client, scene):
    root = parse(scene.get(client))

    assert root.tag == f"{ATOM}feed"
    assert entries(root) == []
    assert root.findtext(f"{ATOM}updated").endswith("Z")


@pytest.mark.parametrize("limit", ["0", "101", "-1", "many"])
def test_a_bad_limit_is_a_problem(client, scene, limit):
    response = scene.get(client, limit=limit)

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")


def test_an_overlong_category_is_a_problem(client):
    assert client.get(f"/v1/feeds/{'x' * 65}").status_code == 422


def test_reading_a_feed_needs_no_account(client, scene):
    scene.listed(hours=1)

    assert scene.get(client).status_code == 200


#: U+0000 where the database can keep it. PostgreSQL cannot store NUL in text
#: (the ingest pipeline refuses it on every dialect), so there the stored title
#: never has one; every other character XML cannot hold is still put through.
STORABLE_NUL = "" if db.engine.dialect.name == "postgresql" else "\x00"


def test_the_feed_survives_text_xml_cannot_hold(client, scene):
    paper = Paper(scene.category)
    paper.list_version(
        paper.add_version(
            title=f'A <b>bold</b> & "quoted" title{STORABLE_NUL} with a NUL\x0b and a VT',
            abstract="Abstract with ]]> and <script>alert(1)</script> and \x1b[0m",
        ),
        at=hours_ago(1),
    )

    (entry,) = entries(parse(scene.get(client)))

    assert entry.findtext(f"{ATOM}title") == (
        'A <b>bold</b> & "quoted" title with a NUL and a VT'
    )
    assert entry.findtext(f"{ATOM}summary") == (
        "Abstract with ]]> and <script>alert(1)</script> and [0m"
    )


def test_the_category_is_escaped_where_it_is_echoed(client):
    category = "a&b"

    root = parse(client.get(f"/v1/feeds/{category}"))

    assert root.findtext(f"{ATOM}title").endswith(category)


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


def test_render_dates_a_naive_moment_as_utc_and_converts_an_aware_one():
    plus_two = timezone(timedelta(hours=2))
    document = render_feed(
        feed_id="urn:x",
        title="t",
        self_href="http://node/feed",
        entries=[
            _entry(
                published=datetime(2026, 1, 1, 12, 0, 0),
                updated=datetime(2026, 2, 1, 14, 0, 0, tzinfo=plus_two),
            )
        ],
    )

    (entry,) = entries(ET.fromstring(document))

    assert entry.findtext(f"{ATOM}published") == "2026-01-01T12:00:00Z"
    assert entry.findtext(f"{ATOM}updated") == "2026-02-01T12:00:00Z"


def test_render_an_entry_without_authors_is_still_valid_atom():
    root = ET.fromstring(
        render_feed(
            feed_id="urn:x",
            title="t",
            self_href="http://node/feed",
            entries=[_entry(authors=[])],
        )
    )

    # RFC 4287: every entry has an author unless the feed itself names one.
    (entry,) = entries(root)
    assert entry.find(f"{ATOM}author") is None
    assert root.findtext(f"{ATOM}author/{ATOM}name") == PUBLISHER


def test_render_names_an_author_by_display_name_with_the_did_as_fallback():
    root = ET.fromstring(
        render_feed(
            feed_id="urn:x",
            title="t",
            self_href="http://node/feed",
            entries=[
                _entry(
                    authors=[
                        FeedAuthor("did:key:z6Mk", "Ada Lovelace"),
                        FeedAuthor("did:key:z6Mk2"),
                    ]
                )
            ],
        )
    )

    (entry,) = entries(root)
    assert [a.findtext(f"{ATOM}name") for a in entry.findall(f"{ATOM}author")] == [
        "Ada Lovelace",
        "did:key:z6Mk2",
    ]
    assert [a.findtext(f"{ATOM}uri") for a in entry.findall(f"{ATOM}author")] == [
        "did:key:z6Mk",
        "did:key:z6Mk2",
    ]


def test_render_links_the_web_page_and_keeps_the_api_record():
    root = ET.fromstring(
        render_feed(
            feed_id="urn:x",
            title="t",
            self_href="http://node/feed",
            entries=[_entry(page_href="https://web.example.org/p/sch:aaaa-bbbb-cccc")],
        )
    )

    (entry,) = entries(root)
    links = {link.get("rel"): link for link in entry.findall(f"{ATOM}link")}

    assert links["alternate"].get("href") == "https://web.example.org/p/sch:aaaa-bbbb-cccc"
    assert links["alternate"].get("type") == "text/html"
    assert links["related"].get("href") == "http://node/v1/papers/sch:aaaa-bbbb-cccc"
    assert links["related"].get("type") == "application/json"


def test_render_without_a_web_page_the_api_record_is_the_alternate():
    root = ET.fromstring(
        render_feed(feed_id="urn:x", title="t", self_href="http://node/feed",
                    entries=[_entry()])  # fmt: skip
    )

    (entry,) = entries(root)
    links = {link.get("rel"): link for link in entry.findall(f"{ATOM}link")}

    # No public web origin configured: the entry still carries exactly one
    # alternate link, and it is the API record, as before the web page existed.
    assert set(links) == {"alternate"}
    assert links["alternate"].get("href") == "http://node/v1/papers/sch:aaaa-bbbb-cccc"
    assert links["alternate"].get("type") == "application/json"


def test_render_an_empty_feed_is_dated_now():
    now = datetime(2026, 3, 4, 5, 6, 7, tzinfo=timezone.utc)

    root = ET.fromstring(
        render_feed(feed_id="urn:x", title="t", self_href="http://node/feed",
                    entries=[], now=now)
    )  # fmt: skip

    assert root.findtext(f"{ATOM}updated") == "2026-03-04T05:06:07Z"


def test_render_does_not_touch_the_shared_namespace_registry():
    from app.modules.export import oai  # claims the default prefix for OAI-PMH

    render_feed(feed_id="urn:x", title="t", self_href="http://node/feed", entries=[_entry()])

    assert ET.tostring(ET.Element(f"{{{oai.OAI_NAMESPACE}}}x")).startswith(b"<x ")
