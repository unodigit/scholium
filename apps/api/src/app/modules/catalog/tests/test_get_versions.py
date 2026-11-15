"""Tests for ``GET /v1/papers/{id}/versions`` (plugin: catalog, feature 80).

A paper is put in place through the submissions plugin's own ``save_paper`` /
``save_version`` -- the calls its record handlers make -- and its versions are
listed (or held) with ``transition_version``, which is what a moderator's
decision ends up calling.  Reading then goes through the public route with an
anonymous client.
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
    save_paper,
    save_version,
    transition_version,
)

_TO_LISTED = ("scanning", "moderation", "listed")


class Paper:
    """One paper whose versions this test adds and lists."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Timeline paper {self.tag}",
                "abstract": "A paper that gets revised.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        save_paper(paper_cid=self.genesis["id"], categories=("cs.CR",))
        self.short_id = derive_short_id(self.genesis["id"])
        self.cids: list[str] = []

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
        self,
        *,
        change_note: Optional[str] = None,
        state: str = AWAITING_CONSENT,
        listed_at: Optional[datetime] = None,
    ) -> str:
        """Store the next version, move it to ``state`` and return its cid."""
        n = len(self.cids) + 1
        prev = self.cids[-1] if self.cids else self.genesis["id"]
        record = self._sign(
            "paper.version",
            {"paper": self.genesis["id"], "n": n, "change_note": change_note},
            prev=prev,
        )
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=f"Timeline paper {self.tag} -- version {n}",
            abstract=f"What version {n} holds.",
            manifest_cid="bafkreimanifest",
            licence="CC-BY-4.0",
            prev_cid=prev,
            change_note=change_note,
        )
        self.cids.append(record["id"])
        if state == "listed":
            for step in _TO_LISTED:
                transition_version(
                    record["id"], step, at=listed_at if step == "listed" else None
                )
        elif state != AWAITING_CONSENT:
            transition_version(record["id"], state)
        return record["id"]


def versions(client, identifier: str):
    return client.get(f"/v1/papers/{identifier}/versions")


def test_timeline_lists_each_version_with_n_cid_change_note_listed_at_and_anchor(client):
    paper = Paper()
    first = paper.add_version(state="listed", listed_at=datetime(2026, 1, 1, 9, 30))
    second = paper.add_version(
        change_note="Fixed the proof of Lemma 2",
        state="listed",
        listed_at=datetime(2026, 2, 1, 12, 0),
    )

    response = versions(client, paper.short_id)

    assert response.status_code == 200
    body = response.json()
    assert body["paper"] == body["shortId"] == paper.short_id
    assert body["paperCid"] == paper.genesis["id"]
    assert body["versions"] == [
        {
            "n": 1,
            "version": 1,
            "cid": first,
            "versionCid": first,
            "change_note": None,
            "changeNote": None,
            "listed_at": "2026-01-01T09:30:00",
            "listedAt": "2026-01-01T09:30:00",
            "anchor": "pending",
            "anchorStatus": "pending",
            "anchor_status": "pending",
        },
        {
            "n": 2,
            "version": 2,
            "cid": second,
            "versionCid": second,
            "change_note": "Fixed the proof of Lemma 2",
            "changeNote": "Fixed the proof of Lemma 2",
            "listed_at": "2026-02-01T12:00:00",
            "listedAt": "2026-02-01T12:00:00",
            "anchor": "pending",
            "anchorStatus": "pending",
            "anchor_status": "pending",
        },
    ]


def test_timeline_is_oldest_first(client):
    paper = Paper()
    for _ in range(4):
        paper.add_version(state="listed")

    body = versions(client, paper.short_id).json()

    assert [entry["n"] for entry in body["versions"]] == [1, 2, 3, 4]
    assert [entry["cid"] for entry in body["versions"]] == paper.cids


def test_a_single_listed_version_is_a_timeline_of_one(client):
    paper = Paper()
    cid = paper.add_version(state="listed")

    body = versions(client, paper.short_id).json()

    assert [entry["cid"] for entry in body["versions"]] == [cid]
    assert body["versions"][0]["listed_at"] is not None


def test_the_paper_genesis_cid_names_the_same_timeline(client):
    paper = Paper()
    cid = paper.add_version(state="listed")

    response = versions(client, paper.genesis["id"])

    assert response.status_code == 200
    body = response.json()
    assert body["paper"] == paper.short_id
    assert [entry["cid"] for entry in body["versions"]] == [cid]


@pytest.mark.parametrize("state", [AWAITING_CONSENT, "scanning", "moderation", "held", "rejected"])
def test_an_unlisted_version_is_not_on_the_timeline(client, state):
    paper = Paper()
    listed = paper.add_version(state="listed")
    paper.add_version(state=state)

    body = versions(client, paper.short_id).json()

    assert [entry["cid"] for entry in body["versions"]] == [listed]


def test_a_listed_version_that_is_later_held_leaves_the_timeline(client):
    paper = Paper()
    first = paper.add_version(state="listed")
    second = paper.add_version(state="listed")
    assert [e["n"] for e in versions(client, paper.short_id).json()["versions"]] == [1, 2]

    transition_version(second, "held")

    body = versions(client, paper.short_id).json()
    assert [entry["cid"] for entry in body["versions"]] == [first]


def test_a_later_listed_version_is_listed_after_a_held_one(client):
    """A gap in ``n`` (version 2 held, version 3 listed) is shown as it is."""
    paper = Paper()
    paper.add_version(state="listed")
    paper.add_version(state="held")
    third = paper.add_version(state="listed")

    body = versions(client, paper.short_id).json()

    assert [entry["n"] for entry in body["versions"]] == [1, 3]
    assert body["versions"][-1]["cid"] == third


@pytest.mark.parametrize("state", [AWAITING_CONSENT, "held", "rejected"])
def test_a_paper_with_no_listed_version_is_a_404(client, state):
    paper = Paper()
    paper.add_version(state=state)

    response = versions(client, paper.short_id)

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_a_paper_with_no_version_at_all_is_a_404(client):
    paper = Paper()

    assert versions(client, paper.short_id).status_code == 404


def test_unlisted_and_unknown_papers_answer_the_same_404(client):
    unlisted = Paper()
    unlisted.add_version(state=AWAITING_CONSENT)
    unknown = f"sch:{'0' * 4}-{'0' * 4}-{'0' * 4}"

    unlisted_body = versions(client, unlisted.short_id).json()
    unknown_body = versions(client, unknown).json()

    assert unlisted_body["status"] == unknown_body["status"] == 404
    # The paper is never named as unlisted: only the id the caller sent is echoed.
    assert unlisted_body["detail"].replace(unlisted.short_id, "<id>") == (
        unknown_body["detail"].replace(unknown, "<id>")
    )


@pytest.mark.parametrize(
    "identifier",
    [
        "not-an-id",
        "sch:nope",
        "sch:AAAA-BBBB-CCCC",
        "bafyreidoesnotexist",
        "sch:xxxx-xxxx-xxxx",
    ],
)
def test_a_malformed_or_unknown_id_is_a_404(client, identifier):
    response = versions(client, identifier)

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_a_version_cid_does_not_name_a_paper(client):
    paper = Paper()
    cid = paper.add_version(state="listed")

    assert versions(client, cid).status_code == 404


def test_reading_the_timeline_needs_no_credentials(client):
    paper = Paper()
    paper.add_version(state="listed")

    response = client.get(f"/v1/papers/{paper.short_id}/versions", headers={})

    assert response.status_code == 200


def test_the_versions_route_does_not_shadow_the_version_id_route(client):
    """``/papers/{id}/v{n}`` still answers for ``v1`` next to ``/versions``."""
    paper = Paper()
    cid = paper.add_version(state="listed")

    timeline = versions(client, paper.short_id)
    version = client.get(f"/v1/papers/{paper.short_id}/v1")

    assert timeline.status_code == 200
    assert version.status_code == 200
    assert version.json()["versionCid"] == cid
    assert "versions" in timeline.json()
    assert "versions" not in version.json()
