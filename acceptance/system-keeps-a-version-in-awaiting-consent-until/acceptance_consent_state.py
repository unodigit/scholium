"""Acceptance tests for: System keeps a version in awaiting_consent until every
listed author has accepted, then moves it to scanning (consents plugin,
feature 55).

A version lists its authors; each of them signs a ``coauthor.consent`` record
(``POST /v1/records``) to accept or decline authorship.  The version waits in
state ``awaiting_consent`` until every listed author has accepted, and only then
moves to ``scanning``.  The version's state is read from
``GET /v1/papers/{id}/v/{n}/consents``.

Criteria (app_spec.xml, feature 55):

* A version with 3 authors and 2 consents has state awaiting_consent in
  GET /v1/papers/{id}/v/{n}/consents.
* After the third consent the version state becomes scanning.

How the scene is set up
-----------------------

The paper and its version belong to the submissions plugin, whose handlers are
guarded by tier, endorsement and upload rules that have nothing to do with
consent.  So the scene is put in place the way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` record (``n`` =
  1) listing three authors, each correctly signed and appended to the event log;
* the paper and version indexed through the submissions plugin's own exported
  ``save_paper`` / ``save_version`` -- the calls its ``paper.genesis`` and
  ``paper.version`` handlers make -- so ``paper_versions`` holds the version in
  state ``awaiting_consent`` with its three authors in ``authorship``, which is
  where a version's lifecycle state lives.

Everything the criteria are about goes through the public surface: each
author signs in over HTTP and posts their own signed ``coauthor.consent`` to
``POST /v1/records``, and the state is read back from the consents endpoint.

Why the second test also listens for ``version.state_changed``
--------------------------------------------------------------

Later features take a version on from ``scanning`` (a scan job moves a clean
version to ``moderation`` and holds a failed one), so on the finished project
the state read back after the third consent may already be past ``scanning``.
The test therefore passes when the state is ``scanning`` outright, and passes
for a later state only when the node announced -- through the
``version.state_changed`` event every state change publishes (feature 52) --
that this very version entered ``scanning``.  A version still in
``awaiting_consent`` (or sent back to ``draft``) after all three accepted
fails either way.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Iterator

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    encode_signature,
    sign_record,
    validate_envelope,
    verify_record,
)

from app.modules import ledger
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    subscribe_version_state_changed,
    unsubscribe_version_state_changed,
)

RECORDS_URL = "/v1/records"

#: States a version can be in once it has left ``scanning`` on the happy path
#: or been stopped there.  Reaching one of these after the consents is only
#: believable if the version was announced entering ``scanning`` on the way.
PAST_SCANNING = {"moderation", "listed", "held", "rejected"}


# --------------------------------------------------------------------------- #
# The scene: a paper version listing three authors
# --------------------------------------------------------------------------- #


def _sign_in(client, seed: SigningKey) -> dict[str, str]:
    """Sign ``seed``'s did:key in (challenge, then verify); return auth headers."""
    did = did_key_from_signing_key(seed)
    challenge = client.post("/v1/auth/challenge", json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = client.post(
        "/v1/auth/verify", json={"did": did, "nonce": nonce, "signature": signature}
    )
    assert verify.status_code == 200, verify.text
    return {"Authorization": f"Bearer {verify.json()['access_token']}"}


class Author:
    """A signed-in author who signs their own records."""

    def __init__(self, client) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = _sign_in(client, self.seed)

    def sign(self, record_type: str, body: dict, prev: str | None = None) -> dict:
        """A complete record: ``id`` is the recomputed cid, ``sig`` is this author's."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record


class Scene:
    """A paper whose version 1 lists three authors, none of whom has consented yet."""

    def __init__(self, client) -> None:
        self.client = client
        self.authors = [Author(client) for _ in range(3)]

        tag = uuid.uuid4().hex
        manuscript = f"%PDF-1.7 acceptance manuscript {tag}".encode()
        title = f"Acceptance paper {tag}"
        abstract = "A paper whose authors must all consent."
        lead = self.authors[0]

        genesis = lead.sign(
            "paper.genesis",
            {
                "seed": tag,
                "title": title,
                "abstract": abstract,
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [author.did for author in self.authors],
            },
        )
        manifest = lead.sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": compute_file_id(manuscript),
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = lead.sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": title,
                "abstract": abstract,
                "authors": [
                    {
                        "did": author.did,
                        "position": index + 1,
                        "creditRoles": ["Conceptualization"],
                    }
                    for index, author in enumerate(self.authors)
                ],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        # Index the paper and its version the way the submissions handlers do:
        # ``paper_versions`` gets the version in ``awaiting_consent`` and
        # ``authorship`` gets its three listed authors.
        save_paper(paper_cid=genesis["id"], categories=("cs.CR",))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=title,
            abstract=abstract,
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=tuple(
                VersionAuthor(author.did, index + 1, ("Conceptualization",))
                for index, author in enumerate(self.authors)
            ),
        )

        #: The ``{id}`` and ``{n}`` of the public URLs.
        self.short_id = derive_short_id(genesis["id"])
        self.n = 1
        self.version_cid: str = version["id"]

    def consent(self, author: Author, decision: str = "accept") -> None:
        """``author`` signs a ``coauthor.consent`` for the version and posts it."""
        record = author.sign(
            "coauthor.consent",
            {"version": self.version_cid, "role": "Conceptualization", "decision": decision},
        )
        response = self.client.post(RECORDS_URL, json=record, headers=author.headers)
        assert response.status_code == 201, response.text

    def consents(self) -> dict:
        """``GET /v1/papers/{id}/v/{n}/consents`` -- must answer 200; return its body."""
        response = self.client.get(f"/v1/papers/{self.short_id}/v/{self.n}/consents")
        assert response.status_code == 200, response.text
        return response.json()


@pytest.fixture
def scene(client) -> Scene:
    return Scene(client)


@pytest.fixture
def entered_states(scene: Scene) -> Iterator[list[str]]:
    """Every state the scene's version is announced entering, in order.

    Listens for the ``version.state_changed`` event (feature 52) for the
    length of the test, keeping only this scene's version.
    """
    states: list[str] = []

    def collect(event) -> None:
        if event.version_cid == scene.version_cid:
            states.append(event.state)

    subscribe_version_state_changed(collect)
    try:
        yield states
    finally:
        unsubscribe_version_state_changed(collect)


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_version_with_three_authors_and_two_consents_is_awaiting_consent(scene: Scene):
    """Two of three listed authors accepting leaves the version awaiting_consent."""
    first, second, _third = scene.authors
    scene.consent(first)
    scene.consent(second)

    payload = scene.consents()

    assert len(payload["authors"]) == 3, payload
    assert payload["state"] == "awaiting_consent", payload


def test_after_the_third_consent_the_version_state_becomes_scanning(
    scene: Scene, entered_states: list[str]
):
    """Once every one of the three listed authors has accepted, the version is scanning."""
    for author in scene.authors:
        scene.consent(author)

    state = scene.consents()["state"]

    if state != "scanning":
        # A later pipeline stage may already have taken the version on; that is
        # only believable if it was announced entering ``scanning`` first.
        assert state in PAST_SCANNING, (
            f"version state is {state!r} after all three authors accepted; "
            "expected 'scanning'"
        )
        assert "scanning" in entered_states, (
            f"version is {state!r} but was never announced entering 'scanning' "
            f"(announced: {entered_states})"
        )
