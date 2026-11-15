"""Tests for the discussion plugin (features 99-102).

A signed ``discussion.post`` from a tier-1 member is accepted by
``POST /v1/papers/{id}/threads``, persisted to ``discussion_posts``, and listed
by ``GET /v1/papers/{id}/threads`` with replies ordered by helpful votes then
time.  Helpful votes are once per member, mutes hide a DID's posts, and no
vote changes a paper's status.

Isolation: every test uses fresh DIDs and unique record bodies (hence unique
cids), so parallel workers never collide.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import NamedTuple, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
)

from app import db
from app.modules import ledger
from app.modules.discussion import DiscussionPost, ensure_tables
from app.security import issue_access_token

PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Member:
    """A member who signs records and holds a token at ``tier``."""

    def __init__(self, tier: int = 1) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": _now(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )


class Published(NamedTuple):
    short_id: str
    genesis_id: str
    version_id: str


def publish(author: Member) -> Published:
    """Append a paper genesis and version 1 to the log; return how to address them."""
    tag = uuid.uuid4().hex
    genesis = author.sign(
        "paper.genesis",
        {
            "seed": tag,
            "title": f"Discussion paper {tag}",
            "abstract": "A paper people discuss.",
            "categories": ["cs.CR"],
            "licence": "CC-BY-4.0",
            "authors": [author.did],
        },
    )
    version = author.sign(
        "paper.version",
        {
            "paper": genesis["id"],
            "n": 1,
            "title": f"Discussion paper {tag}",
            "abstract": "A paper people discuss.",
            "authors": [author.did],
            "manifest": "bafyreifakemanifestcid",
            "licence": "CC-BY-4.0",
            "changeNote": "First version.",
        },
        prev=genesis["id"],
    )
    for record in (genesis, version):
        ledger.append(record)
    return Published(derive_short_id(genesis["id"]), genesis["id"], version["id"])


def post(
    client,
    author: Member,
    paper: Published,
    text: str,
    *,
    parent: Optional[str] = None,
    endpoint: Optional[str] = None,
) -> dict:
    """Submit a signed ``discussion.post`` through the thread endpoint."""
    body = {
        "target": paper.version_id,
        "anchor": paper.version_id,
        "text": text,
        "parent": parent,
    }
    record = author.sign("discussion.post", body)
    url = endpoint or f"/v1/papers/{paper.short_id}/threads"
    response = client.post(url, json=record, headers=author.headers)
    assert response.status_code == 201, response.text
    return record


def threads(client, paper: Published, member: Optional[Member] = None) -> dict:
    response = client.get(
        f"/v1/papers/{paper.short_id}/threads",
        headers=None if member is None else member.headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def threads_by_id(client, paper_id: str) -> dict:
    response = client.get(f"/v1/papers/{paper_id}/threads")
    assert response.status_code == 200, response.text
    return response.json()


def _walk(node):
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def cids(payload) -> list[str]:
    """Every post cid in a threads payload, in response order."""
    found: list[str] = []
    for node in _walk(payload):
        if isinstance(node, dict) and "post_cid" in node:
            found.append(node["post_cid"])
    return found


def stored(post_cid: str) -> Optional[DiscussionPost]:
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(DiscussionPost, post_cid)
        if row is not None:
            session.expunge(row)
        return row


# --------------------------------------------------------------------------- #
# Feature 100: tier gate and acceptance
# --------------------------------------------------------------------------- #


def test_tier_0_post_is_403(client):
    reader = Member(tier=0)
    paper = publish(Member(tier=1))
    record = reader.sign(
        "discussion.post",
        {"target": paper.version_id, "anchor": paper.version_id, "text": "hello"},
    )

    response = client.post(
        f"/v1/papers/{paper.short_id}/threads", json=record, headers=reader.headers
    )

    assert response.status_code == 403, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["required_tier"] == 1
    assert response.json()["caller_tier"] == 0


def test_tier_1_post_is_201_and_appears_in_get(client):
    member = Member(tier=1)
    paper = publish(member)
    text = f"a member's post {uuid.uuid4().hex}"

    record = post(client, member, paper, text)

    payload = threads(client, paper)
    found = cids(payload)
    assert record["id"] in found, payload

    node = next(n for n in _walk(payload) if isinstance(n, dict) and n.get("post_cid") == record["id"])
    assert node["text"] == text
    assert node["author_did"] == member.did


def test_accepted_post_is_persisted_to_discussion_posts(client):
    member = Member(tier=1)
    paper = publish(member)
    record = post(client, member, paper, f"persist me {uuid.uuid4().hex}")

    row = stored(record["id"])

    assert row is not None
    assert row.paper_cid == paper.genesis_id
    assert row.author_did == member.did
    assert row.parent_cid is None
    assert int(row.helpful) == 0


def test_an_id_the_log_does_not_hold_still_works_as_its_own_namespace(client):
    member = Member(tier=1)
    record = member.sign(
        "discussion.post",
        {"target": "bafyreitarget", "anchor": "bafyreitarget", "text": "orphan"},
    )

    posted = client.post(
        "/v1/papers/paper-not-in-the-log/threads",
        json=record,
        headers=member.headers,
    )
    assert posted.status_code == 201, posted.text

    payload = threads_by_id(client, "paper-not-in-the-log")
    assert record["id"] in cids(payload)


def test_a_post_accepted_through_records_is_persisted(client):
    member = Member(tier=1)
    paper = publish(member)
    record = member.sign(
        "discussion.post",
        {
            "target": paper.version_id,
            "anchor": paper.version_id,
            "text": f"via records {uuid.uuid4().hex}",
        },
    )

    response = client.post("/v1/records", json=record, headers=member.headers)

    assert response.status_code == 201, response.text
    row = stored(record["id"])
    assert row is not None
    assert row.paper_cid == paper.genesis_id


# --------------------------------------------------------------------------- #
# Feature 99: threads, replies and ordering
# --------------------------------------------------------------------------- #


def test_replies_nest_under_their_thread(client):
    member = Member(tier=1)
    paper = publish(member)
    root = post(client, member, paper, f"root {uuid.uuid4().hex}")
    reply = post(client, member, paper, f"reply {uuid.uuid4().hex}", parent=root["id"])

    payload = threads(client, paper)

    root_node = next(
        node for node in payload["threads"] if node["post_cid"] == root["id"]
    )
    assert [item["post_cid"] for item in root_node["replies"]] == [reply["id"]]


def test_threads_are_ordered_by_helpful_votes_then_time(client):
    author = Member(tier=1)
    voter = Member(tier=1)
    paper = publish(author)
    first = post(client, author, paper, f"first {uuid.uuid4().hex}")
    second = post(client, author, paper, f"second {uuid.uuid4().hex}")
    third = post(client, author, paper, f"third {uuid.uuid4().hex}")

    # Unvoted threads keep posting order; the newest becomes most helpful.
    before = cids(threads(client, paper))
    assert before == [first["id"], second["id"], third["id"]]

    response = client.post(
        f"/v1/posts/{third['id']}/helpful", headers=voter.headers
    )
    assert response.status_code == 201, response.text

    after = cids(threads(client, paper))
    assert after == [third["id"], first["id"], second["id"]]


def test_replies_are_ordered_by_helpful_votes_then_time(client):
    author = Member(tier=1)
    voter = Member(tier=1)
    paper = publish(author)
    root = post(client, author, paper, f"root {uuid.uuid4().hex}")
    first = post(client, author, paper, f"reply one {uuid.uuid4().hex}", parent=root["id"])
    second = post(client, author, paper, f"reply two {uuid.uuid4().hex}", parent=root["id"])

    assert client.post(
        f"/v1/posts/{second['id']}/helpful", headers=voter.headers
    ).status_code == 201

    payload = threads(client, paper)
    root_node = next(n for n in payload["threads"] if n["post_cid"] == root["id"])
    assert [item["post_cid"] for item in root_node["replies"]] == [
        second["id"],
        first["id"],
    ]


# --------------------------------------------------------------------------- #
# Feature 101: helpful votes
# --------------------------------------------------------------------------- #


def test_a_repeat_helpful_mark_is_409(client):
    author = Member(tier=1)
    voter = Member(tier=1)
    paper = publish(author)
    record = post(client, author, paper, f"vote me {uuid.uuid4().hex}")

    first = client.post(f"/v1/posts/{record['id']}/helpful", headers=voter.headers)
    second = client.post(f"/v1/posts/{record['id']}/helpful", headers=voter.headers)

    assert first.status_code == 201, first.text
    assert second.status_code == 409, second.text
    assert second.headers["content-type"].startswith(PROBLEM_JSON)
    assert int(stored(record["id"]).helpful) == 1


def test_helpful_on_unknown_post_is_404(client):
    voter = Member(tier=1)
    response = client.post("/v1/posts/not-a-cid/helpful", headers=voter.headers)
    assert response.status_code == 404, response.text


# --------------------------------------------------------------------------- #
# Feature 102: mutes
# --------------------------------------------------------------------------- #


def test_muting_a_did_hides_their_posts_for_that_caller(client):
    muted = Member(tier=1)
    reader = Member(tier=1)
    paper = publish(muted)
    hidden = post(client, muted, paper, f"mute me {uuid.uuid4().hex}")
    shown = post(client, reader, paper, f"keep me {uuid.uuid4().hex}")

    response = client.post(
        "/v1/me/mutes", json={"did": muted.did}, headers=reader.headers
    )
    assert response.status_code == 201, response.text

    visible = cids(threads(client, paper, reader))
    assert shown["id"] in visible
    assert hidden["id"] not in visible

    # Another reader (and an anonymous one) still sees both.
    assert hidden["id"] in cids(threads(client, paper))


# --------------------------------------------------------------------------- #
# Persistence backstop
# --------------------------------------------------------------------------- #


def test_a_post_appended_directly_to_the_log_is_listed_and_persisted(client):
    author = Member(tier=1)
    paper = publish(author)
    record = author.sign(
        "discussion.post",
        {
            "target": paper.version_id,
            "anchor": paper.version_id,
            "text": f"direct {uuid.uuid4().hex}",
        },
    )
    ledger.append(record)

    payload = threads(client, paper)

    assert record["id"] in cids(payload)
    assert stored(record["id"]) is not None
