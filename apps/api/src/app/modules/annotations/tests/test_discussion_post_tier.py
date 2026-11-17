"""Regression tests: ``discussion.post`` is a tier-1 record, whichever plugin loads first.

REV-1 opens discussion to tier 1 and above.  The annotations plugin used to
register ``discussion.post`` itself at tier 0; because the module loader
imports ``annotations`` before ``discussion``, that registration won and a
tier-0 account could ``POST /v1/records`` a ``discussion.post``.  These tests
pin the tier, the enforcement through ingest, independence from import order,
and the annotations read route the web client calls without a version
(``GET /v1/papers/{id}/annotations``).

Isolation: every test uses fresh DIDs and unique record bodies (hence unique
cids), so parallel workers never collide.
"""

from __future__ import annotations

import importlib
import uuid
from datetime import datetime, timezone
from typing import NamedTuple, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules import annotations, discussion, ingest, ledger
from app.modules.identity.models import Account, ensure_account_table
from app.security import issue_access_token

PROBLEM_JSON = "application/problem+json"
TYPE = "discussion.post"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Signer:
    """A DID that signs records; ``tier`` is stored on its account (if any).

    The ingest pipeline reads an author's tier from the ``accounts`` table, so
    a tier above 0 needs a row; a tier-0 signer deliberately has none, like a
    DID that never signed in to this node.
    """

    def __init__(self, tier: int = 0) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}
        if tier > 0:
            ensure_account_table()
            with db.SessionLocal() as session:
                session.add(
                    Account(
                        did=self.did,
                        tier=tier,
                        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                    )
                )
                session.commit()

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
    version_ids: dict[int, str]


def publish(author: Signer, versions: int = 1) -> Published:
    """Append a paper genesis and ``versions`` numbered versions to the log."""
    tag = uuid.uuid4().hex
    genesis = author.sign(
        "paper.genesis",
        {
            "seed": tag,
            "title": f"Annotated paper {tag}",
            "abstract": "A paper people annotate.",
            "categories": ["cs.CR"],
            "licence": "CC-BY-4.0",
            "authors": [author.did],
        },
    )
    ledger.append(genesis)
    prev = genesis["id"]
    version_ids: dict[int, str] = {}
    for n in range(1, versions + 1):
        version = author.sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": n,
                "title": f"Annotated paper {tag}",
                "abstract": "A paper people annotate.",
                "authors": [author.did],
                "manifest": "bafyreifakemanifestcid",
                "licence": "CC-BY-4.0",
                "changeNote": f"Version {n}.",
            },
            prev=prev,
        )
        ledger.append(version)
        version_ids[n] = version["id"]
        prev = version["id"]
    return Published(derive_short_id(genesis["id"]), genesis["id"], version_ids)


def annotation(author: Signer, version_cid: str, paragraph_id: str, text: str) -> dict:
    """A signed ``discussion.post`` carrying a paragraph anchor."""
    return author.sign(
        TYPE,
        {
            "target": version_cid,
            "anchor": {
                "version": version_cid,
                "paragraph_id": paragraph_id,
                "quote": "the quoted words",
                "offset": 4,
            },
            "text": text,
        },
    )


def thread_post(author: Signer, version_cid: str) -> dict:
    return author.sign(
        TYPE,
        {"target": version_cid, "anchor": version_cid, "text": f"hello {uuid.uuid4().hex}"},
    )


@pytest.fixture
def restore_registration():
    """Hand the registry back as found: these tests unregister and re-register."""
    previous = ingest.get(TYPE)
    assert previous is not None, "discussion.post must be registered by the loaded app"
    yield
    ingest.unregister(TYPE)
    ingest.register(TYPE, previous.handler, previous.min_tier)


# --------------------------------------------------------------------------- #
# discussion.post is registered at tier 1
# --------------------------------------------------------------------------- #


def test_discussion_post_is_registered_at_tier_1(client):
    registration = ingest.get(TYPE)

    assert registration is not None
    assert int(registration.min_tier) == 1


def test_tier_0_author_cannot_post_discussion_post_to_records(client):
    reader = Signer(tier=0)
    paper = publish(Signer(tier=1))
    record = thread_post(reader, paper.version_ids[1])

    response = client.post("/v1/records", json=record, headers=reader.headers)

    assert response.status_code == 403, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["required_tier"] == 1
    assert response.json()["author_tier"] == 0


def test_tier_1_author_can_post_discussion_post_to_records(client):
    member = Signer(tier=1)
    paper = publish(member)
    record = thread_post(member, paper.version_ids[1])

    response = client.post("/v1/records", json=record, headers=member.headers)

    assert response.status_code == 201, response.text
    assert response.json()["id"] == record["id"]


def test_tier_0_author_cannot_post_an_annotation(client):
    reader = Signer(tier=0)
    paper = publish(Signer(tier=1))
    record = annotation(reader, paper.version_ids[1], "p-1", "tier zero margin note")

    response = client.post("/v1/annotations", json=record, headers=reader.headers)

    assert response.status_code == 403, response.text
    assert response.json()["required_tier"] == 1


# --------------------------------------------------------------------------- #
# ... whichever plugin is imported first
# --------------------------------------------------------------------------- #


def test_annotations_loaded_first_leaves_discussion_post_at_tier_1(client, restore_registration):
    ingest.unregister(TYPE)

    importlib.reload(annotations)
    discussion._ensure_record_type()

    registration = ingest.get(TYPE)
    assert registration is not None
    assert int(registration.min_tier) == 1


def test_discussion_loaded_first_leaves_discussion_post_at_tier_1(client, restore_registration):
    ingest.unregister(TYPE)

    discussion._ensure_record_type()
    importlib.reload(annotations)  # must neither raise nor change the tier

    registration = ingest.get(TYPE)
    assert registration is not None
    assert int(registration.min_tier) == 1


# --------------------------------------------------------------------------- #
# GET /v1/papers/{id}/annotations -- the route the web client calls
# --------------------------------------------------------------------------- #


def test_unversioned_read_route_returns_the_latest_versions_annotations(client):
    member = Signer(tier=1)
    paper = publish(member, versions=2)
    old = annotation(member, paper.version_ids[1], "p-old", "on version one")
    new_a = annotation(member, paper.version_ids[2], "p-7", "first on version two")
    new_b = annotation(member, paper.version_ids[2], "p-7", "second on version two")
    for record in (old, new_a, new_b):
        ledger.append(record)

    response = client.get(f"/v1/papers/{paper.short_id}/annotations")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["paper"] == paper.short_id
    assert body["version"] == 2
    assert body["versionCid"] == paper.version_ids[2]
    assert body["count"] == 2
    assert list(body["annotations"]) == ["p-7"]
    assert [a["id"] for a in body["annotations"]["p-7"]] == [new_a["id"], new_b["id"]]


def test_unversioned_read_route_matches_the_versioned_route_for_the_latest_version(client):
    member = Signer(tier=1)
    paper = publish(member, versions=2)
    ledger.append(annotation(member, paper.version_ids[2], "p-3", "a margin note"))

    unversioned = client.get(f"/v1/papers/{paper.short_id}/annotations")
    versioned = client.get(f"/v1/papers/{paper.short_id}/v/2/annotations")

    assert unversioned.status_code == versioned.status_code == 200
    assert unversioned.json() == versioned.json()


def test_a_tier_1_annotation_posted_through_the_api_is_read_back_unversioned(client):
    member = Signer(tier=1)
    paper = publish(member)
    record = annotation(member, paper.version_ids[1], "p-9", f"note {uuid.uuid4().hex}")

    created = client.post("/v1/annotations", json=record, headers=member.headers)
    assert created.status_code == 201, created.text

    response = client.get(f"/v1/papers/{paper.short_id}/annotations")

    assert response.status_code == 200, response.text
    assert [a["id"] for a in response.json()["annotations"]["p-9"]] == [record["id"]]


def test_unversioned_read_route_with_no_annotations_is_an_empty_group_map(client):
    paper = publish(Signer(tier=1))

    response = client.get(f"/v1/papers/{paper.short_id}/annotations")

    assert response.status_code == 200, response.text
    assert response.json()["count"] == 0
    assert response.json()["annotations"] == {}


@pytest.mark.parametrize("paper_id", ["sch:aaaa-aaaa-aaaa", "not-a-short-id"])
def test_unversioned_read_route_404s_for_an_unknown_or_malformed_paper(client, paper_id):
    response = client.get(f"/v1/papers/{paper_id}/annotations")

    assert response.status_code == 404, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)


def test_a_hidden_annotation_is_a_placeholder_without_its_body(client):
    """A ``hide`` decision withholds an annotation's text and quote, not its id."""
    from app.modules import moderation
    from app.modules.annotations.service import annotations_for_version

    author = Signer(tier=1)
    moderator = Signer(tier=4)
    paper = publish(author)
    record = annotation(author, paper.version_ids[1], "p-hidden", "the hidden annotation")
    ledger.append(record)
    decision = moderator.sign(
        "moderation.decision",
        {
            "target": record["id"],
            "action": "hide",
            "clause": "MOD-01",
            "reason": "Abusive annotation.",
        },
    )
    ledger.append(decision)
    moderation.hide_target(record["id"], decision["id"])

    [item] = annotations_for_version(paper.version_ids[1])["p-hidden"]

    assert item["id"] == record["id"]
    assert item["hidden"] is True
    assert item["text"] is None
    assert item["quote"] is None
    assert item["hidden_reason"] == "Abusive annotation."
    assert item["hidden_at"] is not None

