"""Tests for ``GET /v1/papers`` (plugin: catalog, feature 82).

Papers are put in place through the submissions plugin's own ``save_paper`` /
``save_version`` and listed with ``transition_version``, like the sibling
tests.  Every test files its papers under a category of its own, so
``?category=`` isolates them from the rest of the shared database and the
assertions can be exact.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app.modules import ledger
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

URL = "/v1/papers"
_TO_LISTED = ("scanning", "moderation")


def hours_ago(hours: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours)


class Scene:
    """A category of its own and the papers filed under it."""

    def __init__(self) -> None:
        self.category = f"t.{uuid.uuid4().hex[:12]}"
        self.papers: list[Paper] = []

    def paper(self, **kwargs) -> "Paper":
        kwargs.setdefault("categories", (self.category,))
        paper = Paper(**kwargs)
        self.papers.append(paper)
        return paper

    def listed(self, hours: float = 0, **kwargs) -> "Paper":
        """A paper whose one version was listed ``hours`` ago."""
        paper = self.paper(**kwargs)
        paper.list_version(paper.add_version(), at=hours_ago(hours))
        return paper


class Paper:
    def __init__(self, *, categories=("cs.CR",), status: str = "preprint") -> None:
        self.tag = uuid.uuid4().hex
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Listed paper {self.tag}",
                "categories": list(categories),
            },
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(categories),
            licence="CC-BY-4.0",
            status=status,
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list[tuple[int, str, str]] = []

    def _sign(
        self,
        record_type: str,
        body: dict,
        prev: Optional[str] = None,
        key: Optional[SigningKey] = None,
    ) -> dict:
        key = key or self.key
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": did_key_from_signing_key(key),
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            key,
        )

    def add_version(self) -> tuple[int, str, str]:
        n = len(self.versions) + 1
        prev = self.versions[-1][1] if self.versions else self.genesis["id"]
        title = f"Listed paper {self.tag} -- version {n}"
        record = self._sign(
            "paper.version",
            {"paper": self.genesis["id"], "n": n, "title": title, "abstract": f"v{n}"},
            prev=prev,
        )
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=f"Abstract of version {n}.",
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

    def append(
        self, record_type: str, body: dict, at: datetime, key: Optional[SigningKey] = None
    ) -> None:
        """Append a record to the event log, received at ``at``."""
        ledger.append(
            self._sign(record_type, body, key=key),
            received_at=at.astimezone(timezone.utc).replace(tzinfo=None),
        )

    def review(
        self, target: str, at: datetime, reviewer: Optional[SigningKey] = None
    ) -> None:
        self.append(
            "review.formal",
            {
                "target": target,
                "scores": {},
                "confidence": 3,
                "recommendation": "minor_revisions",
            },
            at,
            key=reviewer,
        )


def get(client, **params):
    return client.get(URL, params=params)


def short_ids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["paper"] for item in response.json()["items"]]


def walk(client, limit: int, **params) -> list[list[str]]:
    """Every page's short ids, following ``nextCursor`` to the end."""
    pages, cursor = [], None
    for _ in range(50):
        query = dict(params, limit=limit)
        if cursor:
            query["cursor"] = cursor
        response = get(client, **query)
        assert response.status_code == 200, response.text
        body = response.json()
        pages.append([item["paper"] for item in body["items"]])
        cursor = body["nextCursor"]
        if cursor is None:
            return pages
    raise AssertionError("the cursor never ran out")


@pytest.fixture
def scene():
    return Scene()


# --------------------------------------------------------------------------- #
# Shape and defaults
# --------------------------------------------------------------------------- #


def test_defaults_are_the_latest_tab_newest_first(client, scene):
    older = scene.listed(hours=5)
    newer = scene.listed(hours=1)

    response = get(client, category=scene.category)

    assert short_ids(response) == [newer.short_id, older.short_id]
    assert response.json()["nextCursor"] is None


def test_an_item_is_the_version_get_paper_answers_with(client, scene):
    paper = scene.paper()
    v1 = paper.add_version()
    paper.list_version(v1, at=hours_ago(3))
    v2 = paper.add_version()
    paper.list_version(v2, at=hours_ago(1))

    (item,) = get(client, category=scene.category).json()["items"]
    single = client.get(f"{URL}/{paper.short_id}").json()

    assert item["n"] == item["version"] == 2
    assert item["versionCid"] == item["cid"] == v2[1]
    for field in (
        "paper", "shortId", "paperCid", "versionCid", "n", "title", "abstract",
        "authors", "categories", "licence", "status",
    ):  # fmt: skip
        assert item[field] == single[field], field
    assert item["authors"][0]["did"] == paper.did


def test_an_item_carries_the_row_fields_and_nothing_else(client, scene):
    scene.listed(hours=2)

    (item,) = get(client, category=scene.category).json()["items"]

    assert set(item) == {
        "paper", "shortId", "paperCid", "versionCid", "cid", "n", "version", "title",
        "abstract", "authors", "categories", "licence", "status", "listedAt", "updatedAt",
    }  # fmt: skip
    assert item["listedAt"] == item["updatedAt"]


def test_listed_at_is_the_first_listing_and_updated_at_the_latest(client, scene):
    paper = scene.paper()
    paper.list_version(paper.add_version(), at=hours_ago(30))
    paper.list_version(paper.add_version(), at=hours_ago(2))

    (item,) = get(client, category=scene.category).json()["items"]

    assert datetime.fromisoformat(item["listedAt"]) < datetime.fromisoformat(
        item["updatedAt"]
    )


# --------------------------------------------------------------------------- #
# Which papers
# --------------------------------------------------------------------------- #


def test_a_held_paper_leaves_the_list_but_a_held_newer_version_does_not(client, scene):
    gone = scene.paper()
    gone_v1 = gone.add_version()
    gone.list_version(gone_v1, at=hours_ago(4))

    kept = scene.paper()
    kept.list_version(kept.add_version(), at=hours_ago(3))
    kept_v2 = kept.add_version()
    kept.list_version(kept_v2, at=hours_ago(2))

    assert set(short_ids(get(client, category=scene.category))) == {
        gone.short_id,
        kept.short_id,
    }

    gone.hold(gone_v1)
    kept.hold(kept_v2)

    response = get(client, category=scene.category)
    assert short_ids(response) == [kept.short_id]
    assert response.json()["items"][0]["n"] == 1  # still shown as its listed version


def test_category_matches_one_category_exactly(client, scene):
    both = scene.listed(categories=(scene.category, "cs.ZZ"))
    scene.listed(categories=(scene.category + "x",))

    assert short_ids(get(client, category=scene.category)) == [both.short_id]
    assert both.short_id in short_ids(get(client, category="cs.ZZ"))
    assert short_ids(get(client, category=scene.category[:-1])) == []


def test_reviewed_tab_keeps_only_reviewed_papers(client, scene):
    reviewed = scene.listed(status="reviewed")
    scene.listed(status="preprint")
    scene.listed(status="contested")

    assert short_ids(get(client, category=scene.category, tab="reviewed")) == [
        reviewed.short_id
    ]
    assert len(short_ids(get(client, category=scene.category, tab="latest"))) == 3


def test_tab_category_sort_and_cursor_combine(client, scene):
    # Reviewed papers in the scene's category, mixed with papers each filter must drop.
    reviewed = [scene.listed(hours=h, status="reviewed") for h in (6, 2, 4)]
    scene.listed(hours=1, status="preprint")  # wrong tab
    scene.listed(hours=1, status="reviewed", categories=("cs.ELSE",))  # wrong category
    # Two agreeing reviewers keep a paper *reviewed* in the ledger, so the
    # status subscription -- which saves what the ledger says -- leaves the tab
    # as seeded.  One reviewer alone would drop it to ``under_review``.
    for paper, at in ((reviewed[0], hours_ago(0.5)), (reviewed[2], hours_ago(1))):
        paper.review(paper.versions[0][1], at=at)
        paper.review(paper.versions[0][1], at=at, reviewer=SigningKey.generate())

    pages = walk(
        client,
        limit=2,
        category=scene.category,
        tab="reviewed",
        sort="recently_reviewed",
    )

    # Reviewed most recently first (reviewed[0], then reviewed[2]); the paper
    # nobody reviewed follows.
    assert pages == [
        [reviewed[0].short_id, reviewed[2].short_id],
        [reviewed[1].short_id],
    ]


# --------------------------------------------------------------------------- #
# Sorts
# --------------------------------------------------------------------------- #


def test_recently_updated_follows_the_latest_listed_version(client, scene):
    republished = scene.listed(hours=50)
    middle = scene.listed(hours=20)
    newest = scene.listed(hours=10)
    republished.list_version(republished.add_version(), at=hours_ago(1))

    response = get(client, category=scene.category, sort="recently_updated")
    assert short_ids(response) == [
        republished.short_id,
        newest.short_id,
        middle.short_id,
    ]
    # ...while "newest" still goes by when each paper first appeared.
    response = get(client, category=scene.category, sort="newest")
    assert short_ids(response) == [
        newest.short_id,
        middle.short_id,
        republished.short_id,
    ]


def test_recently_reviewed_orders_by_the_newest_revealed_review(client, scene):
    by_version = scene.listed(hours=9)
    by_short_id = scene.listed(hours=8)
    by_paper_cid = scene.listed(hours=7)
    commit_only = scene.listed(hours=6)  # a sealed commit is not a review
    unreviewed_old = scene.listed(hours=5)
    unreviewed_new = scene.listed(hours=1)

    by_version.review(by_version.versions[0][1], at=hours_ago(4))
    by_short_id.review(by_short_id.short_id, at=hours_ago(3))
    by_paper_cid.review(by_paper_cid.genesis["id"], at=hours_ago(2))
    commit_only.append(
        "review.commit", {"target": commit_only.versions[0][1]}, hours_ago(0.5)
    )
    # A newer review than by_version's first one moves it to the front.
    by_version.review(f"{by_version.short_id}/v1", at=hours_ago(1.5))

    response = get(client, category=scene.category, sort="recently_reviewed")

    assert short_ids(response) == [
        by_version.short_id,
        by_paper_cid.short_id,
        by_short_id.short_id,
        # Unreviewed papers follow, newest listing first: 1h, 5h, then 6h ago.
        unreviewed_new.short_id,
        unreviewed_old.short_id,
        commit_only.short_id,
    ]


def test_a_review_of_another_paper_does_not_move_this_one(client, scene):
    first = scene.listed(hours=3)
    second = scene.listed(hours=2)
    first.review(
        second.versions[0][1], at=hours_ago(1)
    )  # signed by first's key, aimed at second

    response = get(client, category=scene.category, sort="recently_reviewed")

    assert short_ids(response) == [second.short_id, first.short_id]


# --------------------------------------------------------------------------- #
# Cursor pagination
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("sort", ["newest", "recently_updated", "recently_reviewed"])
def test_pages_hold_limit_papers_and_cover_every_paper_once(client, scene, sort):
    papers = [scene.listed(hours=h) for h in (6, 2, 5, 1, 4)]
    papers[0].review(papers[0].versions[0][1], at=hours_ago(0.5))

    pages = walk(client, limit=2, category=scene.category, sort=sort)

    assert [len(page) for page in pages] == [2, 2, 1]
    flat = [cid for page in pages for cid in page]
    assert sorted(flat) == sorted(p.short_id for p in papers)
    assert flat == short_ids(get(client, category=scene.category, sort=sort))


def test_papers_that_tie_on_one_instant_never_straddle_a_page_twice(client, scene):
    moment = hours_ago(2)
    papers = []
    for _ in range(5):
        paper = scene.paper()
        paper.list_version(paper.add_version(), at=moment)
        papers.append(paper)

    pages = walk(client, limit=2, category=scene.category)

    flat = [cid for page in pages for cid in page]
    assert len(flat) == len(set(flat)) == 5
    assert set(flat) == {p.short_id for p in papers}


def test_the_last_page_has_no_cursor_even_when_it_is_exactly_full(client, scene):
    for hours in (3, 2, 1):
        scene.listed(hours=hours)

    assert get(client, category=scene.category, limit=3).json()["nextCursor"] is None
    assert (
        get(client, category=scene.category, limit=2).json()["nextCursor"] is not None
    )


def test_a_walk_is_not_disturbed_by_papers_listed_or_held_meanwhile(client, scene):
    oldest = scene.listed(hours=8)
    older = scene.listed(hours=6)
    newer = scene.listed(hours=4)
    newest = scene.listed(hours=2)

    first = get(client, category=scene.category, limit=2).json()
    assert [i["paper"] for i in first["items"]] == [newest.short_id, newer.short_id]

    # Between the two requests: a brand-new paper arrives and a paper already
    # read is held.  An offset cursor would now repeat or skip a paper.
    scene.listed(hours=0)
    newer.hold(newer.versions[0])

    second = get(client, category=scene.category, limit=2, cursor=first["nextCursor"])
    assert short_ids(second) == [older.short_id, oldest.short_id]
    assert second.json()["nextCursor"] is None


# --------------------------------------------------------------------------- #
# Refusals
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "params",
    [
        {"tab": "following"},
        {"tab": "popular"},
        {"sort": "most_voted"},
        {"limit": 0},
        {"limit": 101},
        {"limit": "many"},
        {"category": ""},
    ],
)
def test_unknown_or_out_of_range_parameters_are_422(client, params):
    response = get(client, **params)

    assert response.status_code == 422, response.text
    assert response.json()["status"] == 422


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    "cursor",
    [
        "not a cursor!",
        "x" * 600,
        _b64("not json"),
        _b64("[]"),
        _b64("{}"),
        _b64(json.dumps({"v": 2, "sort": "newest", "key": ["a", "b"]})),
        _b64(json.dumps({"v": 1, "sort": "newest", "key": []})),
        _b64(json.dumps({"v": 1, "sort": "newest", "key": [1, 2]})),
        _b64(json.dumps({"v": 1, "sort": "newest", "key": ["only-one-part"]})),
    ],
)
def test_a_cursor_this_listing_did_not_issue_is_422(client, cursor):
    response = get(client, cursor=cursor)

    assert response.status_code == 422, response.text


def test_a_cursor_belongs_to_the_sort_that_issued_it(client, scene):
    for hours in (3, 2, 1):
        scene.listed(hours=hours)
    cursor = get(client, category=scene.category, sort="newest", limit=1).json()[
        "nextCursor"
    ]

    response = get(
        client, category=scene.category, sort="recently_updated", cursor=cursor
    )

    assert response.status_code == 422, response.text
    assert "sort" in response.json()["detail"]


def test_no_paper_listed_is_an_empty_page_not_an_error(client, scene):
    response = get(client, category=scene.category)

    assert response.status_code == 200
    assert response.json() == {"items": [], "nextCursor": None}
