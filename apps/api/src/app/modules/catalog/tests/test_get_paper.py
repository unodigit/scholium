"""Tests for ``GET /v1/papers/{id}`` (plugin: catalog, feature 79).

A paper is put in place through the submissions plugin's own ``save_paper`` /
``save_version`` -- the calls its record handlers make -- and listed with
``transition_version``, which is what a moderator's decision ends up calling.
Reading then goes through the public route with an anonymous client.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app.modules.submissions import (
    AWAITING_CONSENT,
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

URL = "/v1/papers"
_TO_LISTED = ("scanning", "moderation", "listed")


class Paper:
    """One paper whose versions this test adds and lists."""

    def __init__(self, *, categories=("cs.CR",), licence="CC-BY-4.0") -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.licence = licence
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Catalog paper {self.tag}",
                "abstract": "A paper readers look up.",
                "categories": self.categories,
                "licence": self.licence,
                "authors": [self.did],
            },
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence=self.licence,
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list[tuple[int, str, str, str]] = []

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

    def add_version(self, state: str = AWAITING_CONSENT) -> tuple[int, str, str, str]:
        n = len(self.versions) + 1
        prev = self.versions[-1][1] if self.versions else self.genesis["id"]
        title = f"Catalog paper {self.tag} -- version {n}"
        abstract = f"What changed in version {n}."
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
            licence=self.licence,
            prev_cid=prev,
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
        )
        version = (n, record["id"], title, abstract)
        self.versions.append(version)
        if state != AWAITING_CONSENT:
            transition_version(record["id"], state)
        return version

    def list_version(self, version: tuple[int, str, str, str]) -> None:
        for state in _TO_LISTED:
            transition_version(version[1], state)


def get(client, identifier: str):
    return client.get(f"{URL}/{identifier}")


def test_paper_short_id_returns_the_latest_listed_version(client):
    paper = Paper()
    v1 = paper.add_version()
    paper.list_version(v1)
    body = get(client, paper.short_id).json()
    assert body["n"] == 1
    assert body["title"] == v1[2]

    v2 = paper.add_version()
    paper.list_version(v2)
    body = get(client, paper.short_id).json()
    assert body["n"] == 2
    assert body["paper"] == paper.short_id


def test_version_id_and_version_cid_select_that_version(client):
    paper = Paper()
    v1 = paper.add_version()
    paper.list_version(v1)
    v2 = paper.add_version()
    paper.list_version(v2)

    by_id = get(client, f"{paper.short_id}/v1").json()
    by_cid = get(client, v1[1]).json()
    assert by_id["n"] == by_cid["n"] == 1
    assert by_id["title"] == by_cid["title"] == v1[2]
    assert by_id["versionCid"] == v1[1]


@pytest.mark.parametrize("state", [AWAITING_CONSENT, "draft"])
def test_unlisted_version_is_a_404(client, state):
    listed = Paper()
    listed.list_version(listed.add_version())
    assert get(client, listed.short_id).status_code == 200

    paper = Paper()
    version = paper.add_version(state=state)
    for identifier in (paper.short_id, f"{paper.short_id}/v1", version[1]):
        response = get(client, identifier)
        assert response.status_code == 404, identifier
        assert response.headers["content-type"].startswith("application/problem+json")


def test_paper_with_no_version_is_a_404(client):
    paper = Paper()
    assert get(client, paper.short_id).status_code == 404


def test_response_carries_the_paper_fields(client):
    paper = Paper(categories=("cs.CR", "cs.LG"), licence="CC-BY-4.0")
    version = paper.add_version()
    paper.list_version(version)

    body = get(client, paper.short_id).json()
    assert body["title"] == version[2]
    assert body["abstract"] == version[3]
    assert body["categories"] == paper.categories
    assert body["licence"] == paper.licence
    assert isinstance(body["status"], str) and body["status"]
    assert [author["did"] for author in body["authors"]] == [paper.did]
    assert body["authors"][0]["creditRoles"] == ["Conceptualization"]
    assert body["notices"] == []
