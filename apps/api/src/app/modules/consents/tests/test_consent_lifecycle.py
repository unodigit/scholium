"""Tests for the consent tally that advances a version (feature 55).

A version is saved in ``awaiting_consent`` listing its authors.  Each listed
author signs a ``coauthor.consent``; :func:`app.modules.consents.handle_consent`
stores the decision and then tallies the version:

* still waiting for someone -- stays ``awaiting_consent``;
* every listed author accepted -- moves to ``scanning``;
* one decline -- returns to ``draft``, with the decliner named on the
  ``version.state_changed`` event.

The tests save their own version rows and call the handler directly: the
signed-record pipeline itself (envelope, signature, listed-author gate) has its
own coverage, and this suite is about what the tally decides.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app.modules.consents import ConsentForbidden, handle_consent
from app.modules.submissions import (
    VersionAuthor,
    save_version,
    subscribe_version_state_changed,
    unsubscribe_version_state_changed,
)

AWAITING = "awaiting_consent"
SCANNING = "scanning"
DRAFT = "draft"


def new_did() -> str:
    """A DID unique to this test, so parallel workers never collide."""
    return f"did:example:coauthor-{uuid.uuid4().hex}"


def save_a_version(authors: list[str]) -> str:
    """Save a version listing ``authors`` in ``awaiting_consent``; return its cid."""
    version_cid = f"bafkrei-consent-lifecycle-{uuid.uuid4().hex}"
    save_version(
        version_cid=version_cid,
        paper_cid=f"bafkrei-paper-{uuid.uuid4().hex}",
        n=1,
        title="A paper whose authors must agree",
        abstract="",
        manifest_cid=f"bafkrei-manifest-{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=None,
        authors=[
            VersionAuthor(did=did, position=index + 1, credit_roles=None)
            for index, did in enumerate(authors)
        ],
    )
    return version_cid


def consent(version_cid: str, author: str, decision: str) -> dict:
    """The record the ingest pipeline would hand the consents handler."""
    return {
        "id": f"bafkrei-consent-{uuid.uuid4().hex}",
        "author": author,
        "body": {
            "version": version_cid,
            "role": "Conceptualization",
            "decision": decision,
        },
    }


def state_of(version_cid: str) -> str:
    from app.modules import submissions

    row = submissions.get_version(version_cid)
    assert row is not None
    return row.state


@pytest.fixture
def entered():
    """Collect every ``version.state_changed`` event published during a test."""
    events: list = []

    def collect(event) -> None:
        events.append(event)

    subscribe_version_state_changed(collect)
    try:
        yield events
    finally:
        unsubscribe_version_state_changed(collect)


def test_two_of_three_accepts_leave_the_version_awaiting_consent():
    alice, bob, carol = new_did(), new_did(), new_did()
    version_cid = save_a_version([alice, bob, carol])

    handle_consent(consent(version_cid, alice, "accept"))
    handle_consent(consent(version_cid, bob, "accept"))

    assert state_of(version_cid) == AWAITING


def test_the_last_accept_moves_the_version_to_scanning(entered):
    alice, bob, carol = new_did(), new_did(), new_did()
    version_cid = save_a_version([alice, bob, carol])

    for author in (alice, bob, carol):
        handle_consent(consent(version_cid, author, "accept"))

    assert state_of(version_cid) == SCANNING
    assert [(e.previous_state, e.state) for e in entered if e.version_cid == version_cid][-1] == (
        AWAITING,
        SCANNING,
    )


def test_one_decline_returns_the_version_to_draft_and_names_the_decliner(entered):
    alice, bob, carol = new_did(), new_did(), new_did()
    version_cid = save_a_version([alice, bob, carol])

    handle_consent(consent(version_cid, alice, "accept"))
    handle_consent(consent(version_cid, bob, "decline"))

    assert state_of(version_cid) == DRAFT
    to_draft = [e for e in entered if e.version_cid == version_cid and e.state == DRAFT]
    assert len(to_draft) == 1
    assert to_draft[0].actor == bob
    assert bob in (to_draft[0].reason or "")


def test_accepts_after_a_decline_do_not_lift_the_version_out_of_draft():
    alice, bob = new_did(), new_did()
    version_cid = save_a_version([alice, bob])

    handle_consent(consent(version_cid, bob, "decline"))
    handle_consent(consent(version_cid, alice, "accept"))

    assert state_of(version_cid) == DRAFT


def test_the_decision_in_hand_beats_an_earlier_one_on_the_row():
    """A re-signed consent counts as the new decision, not the stored old one."""
    alice, bob = new_did(), new_did()
    version_cid = save_a_version([alice, bob])

    handle_consent(consent(version_cid, alice, "accept"))
    assert state_of(version_cid) == AWAITING

    handle_consent(consent(version_cid, alice, "decline"))

    assert state_of(version_cid) == DRAFT


def test_a_decline_after_scanning_does_not_pull_the_version_back():
    alice = new_did()
    version_cid = save_a_version([alice])
    handle_consent(consent(version_cid, alice, "accept"))
    assert state_of(version_cid) == SCANNING

    handle_consent(consent(version_cid, alice, "decline"))

    assert state_of(version_cid) == SCANNING


def test_consents_for_an_unstored_version_do_not_raise():
    alice = new_did()
    version_cid = f"bafkrei-unstored-{uuid.uuid4().hex}"

    # No version row exists, so there is nothing to advance; the handler still
    # refuses the record because nobody is listed for that version.
    with pytest.raises(ConsentForbidden):
        handle_consent(consent(version_cid, alice, "accept"))


def _signed(seed, record_type: str, body: dict, prev: str | None = None) -> dict:
    """A signed record envelope (the tests that need real record cids)."""
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(seed),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        seed,
    )


def test_the_public_endpoint_reports_draft_and_names_the_decliner(client):
    """The decline clause is visible where the spec reads the state."""
    alice, bob = new_did(), new_did()
    seed = SigningKey.generate()
    genesis = _signed(seed, "paper.genesis", {"authors": [alice, bob]})
    version = _signed(
        seed,
        "paper.version",
        {
            "paper": genesis["id"],
            "n": 1,
            "authors": [
                {"did": alice, "position": 1},
                {"did": bob, "position": 2},
            ],
        },
        prev=genesis["id"],
    )
    save_version(
        version_cid=version["id"],
        paper_cid=genesis["id"],
        n=1,
        title="A paper a co-author refuses",
        abstract="",
        manifest_cid=f"bafkrei-manifest-{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=genesis["id"],
        authors=[
            VersionAuthor(did=alice, position=1, credit_roles=None),
            VersionAuthor(did=bob, position=2, credit_roles=None),
        ],
    )

    handle_consent(consent(version["id"], alice, "accept"))
    handle_consent(consent(version["id"], bob, "decline"))

    response = client.get(
        f"/v1/papers/{derive_short_id(genesis['id'])}/v/1/consents"
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["state"] == DRAFT
    assert payload["declinedBy"] == bob
    assert payload["declined"] == 1
