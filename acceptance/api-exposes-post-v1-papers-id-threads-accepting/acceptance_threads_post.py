"""Acceptance tests for: API exposes ``POST /v1/papers/{id}/threads`` accepting
a signed ``discussion.post`` and returning ``201`` with the post cid
(discussion plugin, feature 100).

Criteria (app_spec.xml, feature 100):

* ``POST /v1/papers/{id}/threads`` by a tier-0 account returns ``403``.
* ``POST /v1/papers/{id}/threads`` by a tier-1 member returns ``201`` and the
  post appears in ``GET /v1/papers/{id}/threads``.

The request
-----------

Like every write on this API, the endpoint takes a client-signed record
envelope.  A member signs a ``discussion.post`` with their own Ed25519 key, so
the ``id`` is the recomputed cid and the ``sig`` a real signature by
``author``::

    POST /v1/papers/{id}/threads
    Authorization: Bearer <access token>

    {"v": 1, "type": "discussion.post", "author": "did:key:z6Mk...",
     "created": "2026-11-16T00:00:00Z", "prev": null,
     "body": {"target": "<version cid>", "anchor": "<version cid>",
              "text": "..."},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

The caller is authenticated with an access token at their trust tier.  The
tier-0 caller is a signed-in account whose tier is 0; the tier-1 caller is a
member whose account row and token both say tier 1, so the request passes
whichever of those the node reads.

How the scene is set up
-----------------------

The paper a post is filed against belongs to the submissions plugin, whose
``POST /v1/records`` handlers carry tier, endorsement, consent and scan rules
irrelevant to discussion.  So the paper is put in the node the way the
discussion plugin's own tests do it: a ``paper.genesis`` and a
``paper.version`` signed by their author and appended to the event log.  The
paper is then addressed by its public ``sch:`` id.

Both criteria are observed only through the feature's public surface: the
``POST`` response status, and the post cid and text found in the
``GET /v1/papers/{id}/threads`` document.  The tests never compare a whole
response object, since later features may add fields.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, NamedTuple

from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger
from app.modules.identity.models import Account, ensure_account_table
from app.security import issue_access_token

#: The record type this endpoint accepts.
DISCUSSION_POST_TYPE = "discussion.post"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _created() -> str:
    """Now as the ``created`` field of a record envelope."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _all_strings(value: Any) -> Iterator[str]:
    """Every string anywhere inside a JSON value."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _all_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_strings(item)


def _sign_post(seed: SigningKey, did: str, paper: "Published", text: str) -> dict:
    """A complete signed ``discussion.post`` on ``paper``'s version."""
    body = {
        "target": paper.version_id,
        "anchor": paper.version_id,
        "text": text,
    }
    record = sign_record(
        {
            "v": 1,
            "type": DISCUSSION_POST_TYPE,
            "author": did,
            "created": _created(),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        seed,
    )
    # Guard the fixture itself: a failure further on can only be the feature's.
    assert isinstance(record.get("id"), str) and record["id"]
    assert record["sig"]
    return record


# --------------------------------------------------------------------------- #
# The scene: a published paper and a signed-in account at a given tier
# --------------------------------------------------------------------------- #


class Published(NamedTuple):
    """A paper appended to the log and addressable by its public ids."""

    short_id: str
    genesis_id: str
    version_id: str


def publish_paper() -> Published:
    """Append a paper genesis and version 1 to the log; return how to address it."""
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    tag = uuid.uuid4().hex
    title = f"Thread acceptance paper {tag}"

    genesis = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did,
            "created": _created(),
            "prev": None,
            "body": {
                "seed": tag,
                "title": title,
                "abstract": "A paper people discuss.",
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": [did],
            },
            "proofs": [],
        },
        seed,
    )
    version = sign_record(
        {
            "v": 1,
            "type": "paper.version",
            "author": did,
            "created": _created(),
            "prev": genesis["id"],
            "body": {
                "paper": genesis["id"],
                "n": 1,
                "title": title,
                "abstract": "A paper people discuss.",
                "authors": [did],
                "manifest": "bafyreifakemanifestcid",
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            "proofs": [],
        },
        seed,
    )
    for record in (genesis, version):
        ledger.append(record)
    return Published(derive_short_id(genesis["id"]), genesis["id"], version["id"])


class Member:
    """A signed-in account at ``tier``: an ``accounts`` row and an access token."""

    def __init__(self, tier: int) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.tier = tier

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(Account(did=self.did, tier=tier, created_at=_now()))
            session.commit()

        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def discussion_post(self, paper: Published, text: str) -> dict:
        """A signed ``discussion.post`` by this member on ``paper``."""
        return _sign_post(self.seed, self.did, paper, text)


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_tier_0_account_posting_a_thread_returns_403(client):
    """A tier-0 account may not open a thread: the request is refused with 403."""
    reader = Member(tier=0)
    paper = publish_paper()
    record = reader.discussion_post(paper, f"a reader's post {uuid.uuid4().hex}")

    response = client.post(
        f"/v1/papers/{paper.short_id}/threads",
        json=record,
        headers=reader.headers,
    )

    assert response.status_code == 403, (
        f"a tier-0 account posting a thread should be refused with 403; "
        f"got {response.status_code}: {response.text}"
    )


def test_tier_1_member_posting_a_thread_returns_201_and_the_post_is_listed(client):
    """A tier-1 member's signed post is accepted with 201 and then listed."""
    member = Member(tier=1)
    paper = publish_paper()
    text = f"a member's post {uuid.uuid4().hex}"
    record = member.discussion_post(paper, text)

    posted = client.post(
        f"/v1/papers/{paper.short_id}/threads",
        json=record,
        headers=member.headers,
    )

    assert posted.status_code == 201, (
        f"a tier-1 member posting a thread should be accepted with 201; "
        f"got {posted.status_code}: {posted.text}"
    )

    # The response carries the accepted post's cid.
    post_cid = record["id"]
    assert post_cid in set(_all_strings(posted.json())), (
        f"the 201 response should carry the post cid {post_cid!r}: {posted.json()}"
    )

    # The post is readable back from the paper's public thread listing.
    listed = client.get(f"/v1/papers/{paper.short_id}/threads")
    assert listed.status_code == 200, (
        f"GET /v1/papers/{paper.short_id}/threads -> "
        f"{listed.status_code}: {listed.text}"
    )
    payload = listed.json()
    assert post_cid in set(_all_strings(payload)), (
        f"the accepted post {post_cid!r} should appear in the thread listing: {payload}"
    )
    assert text in set(_all_strings(payload)), (
        f"the accepted post's text should appear in the thread listing: {payload}"
    )
