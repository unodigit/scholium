"""Tests for following a category and the Following feed (plugin: follows, feature 179).

Covers:

* ``PUT /v1/me/follows/{category}`` -- requires a token, answers ``204``, writes
  one ``follows`` row, and is idempotent;
* ``GET /v1/papers?tab=following`` -- requires a token, returns only the listed
  papers filed under the caller's followed categories, honours the catalog's
  sorts and keyset cursor, and stays per-account;
* the catalog's own tabs still answer exactly as before.

Every test uses a fresh DID and a category unique to it, so the shared database
and parallel workers never interfere.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules.follows.models import Follow
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)
from app.security import issue_access_token

PAPERS_URL = "/v1/papers"
FOLLOWS_URL = "/v1/me/follows"
_TO_LISTED = ("scanning", "moderation")


def _did() -> str:
    return "did:key:z6Mk" + uuid.uuid4().hex


def _auth(did: str, tier: int = 1) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _category() -> str:
    """A category unique to one test, so shared rows never collide."""
    return f"cs.T{uuid.uuid4().hex[:12]}"


def hours_ago(hours: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours)


class Paper:
    """A paper whose versions can be listed, built through the submissions API."""

    def __init__(self, *, categories, status: str = "preprint") -> None:
        self.tag = uuid.uuid4().hex
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.categories = list(categories)
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Following paper {self.tag}",
                "categories": self.categories,
            },
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
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

    def add_version(self) -> tuple[int, str, str]:
        n = len(self.versions) + 1
        prev = self.versions[-1][1] if self.versions else self.genesis["id"]
        title = f"Following paper {self.tag} -- version {n}"
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

    def publish(self, at: Optional[datetime] = None) -> "Paper":
        self.list_version(self.add_version(), at=at)
        return self


def items(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["paper"] for item in response.json()["items"]]


def following(client, did: str, **params):
    return client.get(PAPERS_URL, params={"tab": "following", **params}, headers=_auth(did))


# --------------------------------------------------------------------------- #
# PUT /v1/me/follows/{category}
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-token"}])
def test_put_follow_requires_a_usable_token(client, headers):
    response = client.put(f"{FOLLOWS_URL}/{_category()}", headers=headers)

    assert response.status_code == 401, response.text


def test_put_follow_answers_204_and_saves_the_row(client):
    did, category = _did(), _category()

    response = client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))

    assert response.status_code == 204, response.text
    assert response.content == b""
    with db.SessionLocal() as session:
        row = session.get(Follow, (did, category))
        assert row is not None
        assert (row.did, row.category) == (did, category)


def test_following_a_category_twice_keeps_one_row(client):
    did, category = _did(), _category()

    first = client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))
    second = client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))

    assert (first.status_code, second.status_code) == (204, 204)
    with db.SessionLocal() as session:
        rows = session.query(Follow).filter(Follow.did == did).all()
        assert [(row.category) for row in rows] == [category]


def test_a_category_may_not_be_blank(client):
    response = client.put(f"{FOLLOWS_URL}/%20", headers=_auth(_did()))

    assert response.status_code == 422, response.text


def test_delete_unfollows_and_is_idempotent(client):
    did, category = _did(), _category()
    client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))

    first = client.delete(f"{FOLLOWS_URL}/{category}", headers=_auth(did))
    second = client.delete(f"{FOLLOWS_URL}/{category}", headers=_auth(did))

    assert (first.status_code, second.status_code) == (204, 204)
    with db.SessionLocal() as session:
        assert session.get(Follow, (did, category)) is None


# --------------------------------------------------------------------------- #
# GET /v1/papers?tab=following
# --------------------------------------------------------------------------- #


def test_following_requires_a_usable_token(client):
    response = client.get(PAPERS_URL, params={"tab": "following"})

    assert response.status_code == 401, response.text


def test_following_with_no_follows_is_an_empty_page(client):
    response = following(client, _did())

    assert response.status_code == 200, response.text
    assert response.json() == {"items": [], "nextCursor": None}


def test_following_returns_only_papers_from_followed_categories(client):
    did, followed, other = _did(), _category(), _category()
    wanted = Paper(categories=(followed,)).publish()
    unwanted = Paper(categories=(other,)).publish()
    unlisted = Paper(categories=(followed,))  # no listed version
    client.put(f"{FOLLOWS_URL}/{followed}", headers=_auth(did))

    response = following(client, did)

    assert response.status_code == 200, response.text
    returned = items(response)
    assert wanted.short_id in returned
    assert unwanted.short_id not in returned
    assert unlisted.short_id not in returned


def test_following_covers_every_followed_category(client):
    did, cat_a, cat_b = _did(), _category(), _category()
    paper_a = Paper(categories=(cat_a,)).publish()
    paper_b = Paper(categories=(cat_b,)).publish()
    not_followed = Paper(categories=(_category(),)).publish()
    client.put(f"{FOLLOWS_URL}/{cat_a}", headers=_auth(did))
    client.put(f"{FOLLOWS_URL}/{cat_b}", headers=_auth(did))

    returned = items(following(client, did, limit=100))

    assert paper_a.short_id in returned
    assert paper_b.short_id in returned
    assert not_followed.short_id not in returned


def test_following_is_per_account(client):
    alice, bob = _did(), _did()
    alice_category, bob_category = _category(), _category()
    alice_paper = Paper(categories=(alice_category,)).publish()
    bob_paper = Paper(categories=(bob_category,)).publish()
    client.put(f"{FOLLOWS_URL}/{alice_category}", headers=_auth(alice))
    client.put(f"{FOLLOWS_URL}/{bob_category}", headers=_auth(bob))

    alice_feed = items(following(client, alice, limit=100))
    bob_feed = items(following(client, bob, limit=100))

    assert alice_paper.short_id in alice_feed
    assert bob_paper.short_id not in alice_feed
    assert bob_paper.short_id in bob_feed
    assert alice_paper.short_id not in bob_feed


def test_a_paper_in_two_followed_categories_appears_once(client):
    did, cat_a, cat_b = _did(), _category(), _category()
    paper = Paper(categories=(cat_a, cat_b)).publish()
    client.put(f"{FOLLOWS_URL}/{cat_a}", headers=_auth(did))
    client.put(f"{FOLLOWS_URL}/{cat_b}", headers=_auth(did))

    returned = items(following(client, did, limit=100))

    assert returned.count(paper.short_id) == 1


def test_following_is_newest_first_and_paginates_with_the_catalog_cursor(client):
    did, category = _did(), _category()
    oldest = Paper(categories=(category,)).publish(at=hours_ago(6))
    middle = Paper(categories=(category,)).publish(at=hours_ago(4))
    newest = Paper(categories=(category,)).publish(at=hours_ago(2))
    client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))

    first = following(client, did, limit=2)
    assert first.status_code == 200, first.text
    assert items(first) == [newest.short_id, middle.short_id]
    cursor = first.json()["nextCursor"]
    assert cursor is not None

    second = client.get(
        PAPERS_URL,
        params={"tab": "following", "limit": 2, "cursor": cursor},
        headers=_auth(did),
    )
    assert items(second) == [oldest.short_id]
    assert second.json()["nextCursor"] is None


def test_following_honours_the_category_narrowing(client):
    did, cat_a, cat_b = _did(), _category(), _category()
    paper_a = Paper(categories=(cat_a,)).publish()
    paper_b = Paper(categories=(cat_b,)).publish()
    client.put(f"{FOLLOWS_URL}/{cat_a}", headers=_auth(did))
    client.put(f"{FOLLOWS_URL}/{cat_b}", headers=_auth(did))

    returned = items(following(client, did, category=cat_b))

    assert paper_b.short_id in returned
    assert paper_a.short_id not in returned


def test_following_accepts_the_catalog_sorts(client):
    did, category = _did(), _category()
    paper = Paper(categories=(category,)).publish()
    client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))

    for sort in ("newest", "recently_updated", "recently_reviewed"):
        response = following(client, did, sort=sort)
        assert response.status_code == 200, response.text
        assert paper.short_id in items(response)


def test_an_unknown_tab_or_sort_is_still_422(client):
    did = _did()
    assert client.get(PAPERS_URL, params={"tab": "popular"}).status_code == 422
    response = client.get(
        PAPERS_URL,
        params={"tab": "following", "sort": "popular"},
        headers=_auth(did),
    )
    assert response.status_code == 422


def test_a_cursor_from_a_different_sort_is_refused(client):
    did, category = _did(), _category()
    Paper(categories=(category,)).publish()
    Paper(categories=(category,)).publish()
    client.put(f"{FOLLOWS_URL}/{category}", headers=_auth(did))
    first = following(client, did, limit=1)
    cursor = first.json()["nextCursor"]

    response = following(client, did, limit=1, sort="recently_updated", cursor=cursor)

    assert response.status_code == 422, response.text


# --------------------------------------------------------------------------- #
# The catalog's own tabs keep their behaviour
# --------------------------------------------------------------------------- #


def test_latest_and_reviewed_still_work(client):
    category = _category()
    preprint = Paper(categories=(category,)).publish()
    reviewed = Paper(categories=(category,), status="reviewed").publish()

    latest = client.get(PAPERS_URL, params={"category": category, "limit": 100})
    reviewed_only = client.get(
        PAPERS_URL, params={"category": category, "tab": "reviewed", "limit": 100}
    )

    assert set(items(latest)) == {preprint.short_id, reviewed.short_id}
    assert items(reviewed_only) == [reviewed.short_id]
