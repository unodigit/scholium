"""Tests for consent-link notifications (feature 59).

When a version enters ``awaiting_consent`` -- on its first save, or again
after a decline returned it to draft -- every author listed on it receives one
``consent.request`` notification carrying the version's identifiers and a link
to the consent page.  No other state notifies anyone, and one author's broken
delivery does not silence the rest.

Isolation: the test database, the notification outbox and the event-subscriber
registry are process-global.  Every test writes under its own ``uuid`` version
cid and DIDs and filters reads by them; the outbox is emptied per test; and the
plugin's subscription is re-registered before each test because the state-event
tests deliberately clear the registry.
"""

from __future__ import annotations

import uuid

import pytest

from app import db
from app.modules.notifications import (
    CONSENT_REQUEST_KIND,
    Notification,
    build_consent_link,
    clear_outbox,
    ensure_table,
    get_outbox,
    notify_consent_requests,
    on_startup,
    subscribe_consent_notifications,
)
from app.modules.notifications import consent as consent_module
from app.modules.profiles import ProfileData, save_profile
from app.modules.submissions import (
    VersionAuthor,
    clear_state_changed_subscribers,
    save_version,
    state_changed_subscriber_count,
    transition_version,
)


@pytest.fixture(autouse=True)
def clean_state():
    """A fresh outbox and a registered subscriber for every test."""
    ensure_table()
    clear_outbox()
    subscribe_consent_notifications()
    yield
    clear_outbox()


def new_did() -> str:
    """A DID unique to this test, so parallel workers cannot collide."""
    return f"did:example:consent-{uuid.uuid4().hex}"


def save_a_version(
    authors: list[str],
    *,
    state: str = "awaiting_consent",
    n: int = 1,
) -> tuple[str, str]:
    """Save a version listing ``authors``; return ``(version_cid, paper_cid)``."""
    version_cid = f"bafkrei-version-{uuid.uuid4().hex}"
    paper_cid = f"bafkrei-paper-{uuid.uuid4().hex}"
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid,
        n=n,
        title="A paper waiting for its co-authors",
        abstract="",
        manifest_cid=f"bafkrei-manifest-{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=None,
        state=state,
        authors=[
            VersionAuthor(did=did, position=index + 1, credit_roles=None)
            for index, did in enumerate(authors)
        ],
    )
    return version_cid, paper_cid


def consent_rows(version_cid: str) -> list[tuple[str, dict]]:
    """The ``(did, payload)`` consent notifications about ``version_cid``, oldest first."""
    ensure_table()
    with db.SessionLocal() as session:
        rows = (
            session.query(Notification)
            .filter(Notification.kind == CONSENT_REQUEST_KIND)
            .order_by(Notification.id)
            .all()
        )
        return [
            (row.did, dict(row.payload))
            for row in rows
            if isinstance(row.payload, dict) and row.payload.get("version_cid") == version_cid
        ]


# --------------------------------------------------------------------------- #
# Entering awaiting_consent
# --------------------------------------------------------------------------- #


def test_each_listed_author_receives_one_consent_request():
    alice, bob, carol = new_did(), new_did(), new_did()

    version_cid, _ = save_a_version([alice, bob, carol])

    rows = consent_rows(version_cid)
    assert [did for did, _ in rows] == [alice, bob, carol]
    assert all(payload["version_cid"] == version_cid for _, payload in rows)


def test_the_payload_names_the_version_and_the_consent_page():
    alice = new_did()

    version_cid, paper_cid = save_a_version([alice], n=2)

    (_, payload), = consent_rows(version_cid)
    assert payload["paper_cid"] == paper_cid
    assert payload["version_cid"] == version_cid
    assert payload["n"] == 2
    assert payload["link"] == build_consent_link(version_cid)
    assert payload["link"].endswith(f"/consent/{version_cid}")


def test_the_notification_is_unread():
    alice = new_did()

    version_cid, _ = save_a_version([alice])

    with db.SessionLocal() as session:
        row = (
            session.query(Notification)
            .filter(Notification.kind == CONSENT_REQUEST_KIND, Notification.did == alice)
            .order_by(Notification.id.desc())
            .first()
        )
        assert row is not None
        assert row.did == alice
        assert row.read is False
        assert row.payload["version_cid"] == version_cid


def test_nobody_else_is_notified():
    alice = new_did()
    bystander = new_did()

    version_cid, _ = save_a_version([alice])

    assert bystander not in [did for did, _ in consent_rows(version_cid)]


def test_a_version_with_no_authors_notifies_nobody():
    version_cid, _ = save_a_version([])

    assert consent_rows(version_cid) == []


# --------------------------------------------------------------------------- #
# Only awaiting_consent
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("state", ["scanning", "moderation", "listed", "held", "rejected"])
def test_entering_another_state_sends_no_consent_request(state):
    alice = new_did()

    version_cid, _ = save_a_version([alice], state=state)

    assert consent_rows(version_cid) == []


def test_a_direct_event_for_another_state_is_ignored():
    alice = new_did()
    version_cid, paper_cid = save_a_version([alice], state="scanning")

    sent = notify_consent_requests(
        {
            "version_cid": version_cid,
            "paper_cid": paper_cid,
            "n": 1,
            "state": "listed",
        }
    )

    assert sent == []
    assert consent_rows(version_cid) == []


def test_reentering_awaiting_consent_does_not_duplicate_an_unread_request():
    alice, bob = new_did(), new_did()
    version_cid, _ = save_a_version([alice, bob])
    assert len(consent_rows(version_cid)) == 2

    # A decline returns the version to draft; a later edit sends it back to
    # consent. While the authors have not read the first requests, the second
    # round asks them the same thing, so it adds no duplicate unread rows.
    transition_version(version_cid, "draft")
    transition_version(version_cid, "awaiting_consent")

    assert [did for did, _ in consent_rows(version_cid)] == [alice, bob]

    # Once they have read the requests, a later round is a fresh announcement.
    with db.SessionLocal() as session:
        rows = (
            session.query(Notification)
            .filter(Notification.kind == CONSENT_REQUEST_KIND)
            .all()
        )
        for row in rows:
            if isinstance(row.payload, dict) and row.payload.get("version_cid") == version_cid:
                row.read = True
        session.commit()

    transition_version(version_cid, "draft")
    transition_version(version_cid, "awaiting_consent")

    assert [did for did, _ in consent_rows(version_cid)] == [
        alice,
        bob,
        alice,
        bob,
    ]


def test_a_repeated_save_of_the_same_version_does_not_notify_twice():
    alice = new_did()
    version_cid, paper_cid = save_a_version([alice])
    assert len(consent_rows(version_cid)) == 1

    # A retry after the ledger append failed finds the row and emits no second
    # event, so the author is not asked to sign the same version twice.
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid,
        n=1,
        title="The same version, retried",
        abstract="",
        manifest_cid="bafkrei-manifest-retry",
        licence="CC-BY-4.0",
        prev_cid=None,
        authors=[VersionAuthor(did=alice, position=1, credit_roles=None)],
    )

    assert len(consent_rows(version_cid)) == 1


def test_a_mapping_event_can_drive_the_notifications():
    alice = new_did()
    version_cid, paper_cid = save_a_version([alice], state="scanning")

    sent = notify_consent_requests(
        {
            "version_cid": version_cid,
            "paper_cid": paper_cid,
            "n": 1,
            "state": "awaiting_consent",
            "previous_state": "draft",
        }
    )

    assert [notification.did for notification in sent] == [alice]
    assert consent_rows(version_cid)[0][1]["version_cid"] == version_cid


# --------------------------------------------------------------------------- #
# Email delivery
# --------------------------------------------------------------------------- #


def test_the_author_profile_address_is_used_and_emailed():
    alice, bob = new_did(), new_did()
    save_profile(
        alice,
        ProfileData(name="Alice", affiliation="Example U.", email="alice@example.org"),
    )

    version_cid, _ = save_a_version([alice, bob])

    payloads = {did: payload for did, payload in consent_rows(version_cid)}
    assert payloads[alice]["email"] == "alice@example.org"
    assert "email" not in payloads[bob]

    consent_mails = [mail for mail in get_outbox() if mail["kind"] == CONSENT_REQUEST_KIND]
    assert {mail["did"] for mail in consent_mails} == {alice, bob}
    alices = [mail for mail in consent_mails if mail["did"] == alice]
    assert alices and alices[0]["to"] == "alice@example.org"
    assert payloads[alice]["link"] in alices[0]["body"]


def test_without_a_profile_each_author_is_still_notified():
    alice = new_did()

    version_cid, _ = save_a_version([alice])

    assert [did for did, _ in consent_rows(version_cid)] == [alice]
    (mail,) = [m for m in get_outbox() if m["kind"] == CONSENT_REQUEST_KIND]
    assert mail["did"] == alice
    assert build_consent_link(version_cid) in mail["body"]


# --------------------------------------------------------------------------- #
# Robustness
# --------------------------------------------------------------------------- #


def test_one_authors_failure_does_not_stop_the_others(monkeypatch):
    alice, bob, carol = new_did(), new_did(), new_did()
    real_notify = consent_module.notify

    def flaky_notify(did, kind, payload=None):
        if did == alice:
            raise RuntimeError("this mailbox is down")
        return real_notify(did, kind, payload)

    monkeypatch.setattr(consent_module, "notify", flaky_notify)

    version_cid, _ = save_a_version([alice, bob, carol])

    assert [did for did, _ in consent_rows(version_cid)] == [bob, carol]


def test_the_startup_hook_restores_a_cleared_subscription():
    clear_state_changed_subscribers()
    assert state_changed_subscriber_count() == 0

    on_startup()

    assert state_changed_subscriber_count() == 1

    alice = new_did()
    version_cid, _ = save_a_version([alice])
    assert [did for did, _ in consent_rows(version_cid)] == [alice]


def test_build_consent_link_honours_an_explicit_base():
    assert (
        build_consent_link("bafyrei1", base_url="https://ui.example.org/")
        == "https://ui.example.org/consent/bafyrei1"
    )


def test_build_consent_link_requires_a_version():
    with pytest.raises(ValueError):
        build_consent_link("")
