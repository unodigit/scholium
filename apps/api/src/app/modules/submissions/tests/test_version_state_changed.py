"""Tests for ``version.state_changed`` events (feature 52).

A version advances through ``awaiting_consent``, ``scanning``, ``moderation``,
``listed``, ``held`` and ``rejected``; every advance emits exactly one
``version.state_changed`` event naming the version, the state it entered and
the state it left.  These tests drive the transitions directly (nothing here
depends on the plugins that will decide *when* to move a version) and observe
the events through the module's subscriber API.

Isolation: every test writes versions under a fresh ``uuid`` cid/paper cid and
the subscriber registry is cleared before and after it, because xdist workers
share a database and the registry is process-global.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import (
    AWAITING_CONSENT,
    HELD,
    LISTED,
    MODERATION,
    REJECTED,
    SCANNING,
    InvalidVersionState,
    UnknownVersion,
    VersionStateChanged,
    advance_version,
    can_transition,
    clear_state_changed_subscribers,
    emit_state_changed,
    get_paper,
    get_version,
    handle_paper_version,
    next_state,
    save_paper,
    save_version,
    state_changed_subscriber_count,
    subscribe_state_changed,
    subscribe_version_state_changed,
    transition_version,
    unsubscribe_state_changed,
)

PAPER_VERSION_TYPE = "paper.version"


# --------------------------------------------------------------------------- #
# Fixtures and helpers
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def clean_subscribers():
    """No subscriber from one test may observe another test's transitions."""
    clear_state_changed_subscribers()
    yield
    clear_state_changed_subscribers()


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_paper_cid() -> str:
    """A fresh, valid ``paper.genesis`` record cid."""
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    record = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did,
            "created": now(),
            "prev": None,
            "body": {
                "seed": uuid.uuid4().hex,
                "title": "A paper whose versions change state",
                "abstract": "",
                "categories": ["cs.T0"],
                "licence": "CC-BY-4.0",
                "authors": [did],
            },
            "proofs": [],
        },
        seed,
    )
    return record["id"]


def make_version(
    *,
    paper_cid: str | None = None,
    n: int = 1,
    state: str = AWAITING_CONSENT,
) -> str:
    """Save a version directly and return its cid."""
    version_cid = f"cid-{uuid.uuid4().hex}"
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid or f"paper-{uuid.uuid4().hex}",
        n=n,
        title="A version whose state changes",
        abstract="",
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=None,
        state=state,
    )
    return version_cid


def collect() -> list[VersionStateChanged]:
    """Subscribe a list and return it; the caller asserts on what lands there."""
    events: list[VersionStateChanged] = []
    subscribe_state_changed(events.append)
    return events


# --------------------------------------------------------------------------- #
# The first event: entering awaiting_consent
# --------------------------------------------------------------------------- #


def test_saving_a_version_emits_awaiting_consent():
    events = collect()

    version_cid = make_version()

    assert len(events) == 1
    event = events[0]
    assert isinstance(event, VersionStateChanged)
    assert event.version_cid == version_cid
    assert event.paper_cid == get_version(version_cid).paper_cid
    assert event.n == 1
    assert event.state == AWAITING_CONSENT == "awaiting_consent"
    assert event.previous_state is None
    assert event.to_state == AWAITING_CONSENT
    assert event.from_state is None


def test_the_event_is_named_version_state_changed():
    events = collect()
    make_version()

    event = events[0]
    assert event.event_type == "version.state_changed"
    assert event.record_type == "version.state_changed"
    assert event.as_dict()["type"] == "version.state_changed"
    assert event.to_dict()["state"] == AWAITING_CONSENT


def test_a_repeat_save_emits_no_second_event():
    version_cid = make_version()
    events = collect()

    save_version(
        version_cid=version_cid,
        paper_cid=f"paper-{uuid.uuid4().hex}",
        n=1,
        title="Different arguments are ignored for an existing cid",
        abstract="",
        manifest_cid="bafkreimanifest",
        licence="CC-BY-4.0",
        prev_cid=None,
    )

    assert events == []


# --------------------------------------------------------------------------- #
# Every advance emits one event
# --------------------------------------------------------------------------- #


def test_each_state_advance_emits_one_event_in_order():
    version_cid = make_version()
    events = collect()

    states = [SCANNING, MODERATION, LISTED, HELD, REJECTED]
    previous = AWAITING_CONSENT
    for state in states:
        transition_version(version_cid, state)
        assert get_version(version_cid).state == state

        assert len(events) == states.index(state) + 1
        event = events[-1]
        assert event.version_cid == version_cid
        assert event.state == state
        assert event.previous_state == previous
        previous = state

    assert [event.state for event in events] == states
    assert [event.previous_state for event in events] == [
        AWAITING_CONSENT,
        SCANNING,
        MODERATION,
        LISTED,
        HELD,
    ]


def test_all_six_spec_states_are_reachable():
    version_cid = make_version()
    events = collect()

    # awaiting_consent is the creation state; walk the five that follow.
    for state in (SCANNING, MODERATION, LISTED, HELD, REJECTED):
        transition_version(version_cid, state)

    assert [event.state for event in events] == [
        SCANNING,
        MODERATION,
        LISTED,
        HELD,
        REJECTED,
    ]
    assert get_version(version_cid).state == REJECTED


def test_a_transition_to_the_current_state_emits_nothing():
    version_cid = make_version()
    events = collect()

    transition_version(version_cid, SCANNING)
    transition_version(version_cid, SCANNING)
    transition_version(version_cid, SCANNING)

    assert [event.state for event in events] == [SCANNING]
    assert get_version(version_cid).state == SCANNING


def test_the_event_carries_the_actor_and_reason():
    version_cid = make_version()
    events = collect()
    actor = did_key_from_signing_key(SigningKey.generate())

    transition_version(
        version_cid,
        MODERATION,
        actor=actor,
        reason="the scan found no executable content",
    )

    event = events[0]
    assert event.actor == actor
    assert event.reason == "the scan found no executable content"


def test_an_explicit_timestamp_is_used_for_listed_at_and_the_event():
    paper_cid = new_paper_cid()
    save_paper(paper_cid=paper_cid, categories=["cs.T0"])
    version_cid = make_version(paper_cid=paper_cid)
    events = collect()
    moment = datetime(2026, 1, 2, 3, 4, 5)

    transition_version(version_cid, LISTED, at=moment)

    assert events[0].at == moment
    assert get_version(version_cid).listed_at == moment


# --------------------------------------------------------------------------- #
# Refusals: nothing is written and nothing is emitted
# --------------------------------------------------------------------------- #


def test_an_unknown_state_is_refused_and_changes_nothing():
    version_cid = make_version()
    events = collect()

    with pytest.raises(InvalidVersionState):
        transition_version(version_cid, "published")

    assert get_version(version_cid).state == AWAITING_CONSENT
    assert events == []


def test_a_non_string_state_is_refused():
    version_cid = make_version()
    events = collect()

    with pytest.raises(InvalidVersionState):
        transition_version(version_cid, None)

    assert events == []


def test_an_unknown_version_is_refused_and_emits_nothing():
    events = collect()

    with pytest.raises(UnknownVersion):
        transition_version(f"cid-{uuid.uuid4().hex}", SCANNING)

    assert events == []


def test_an_empty_version_cid_is_refused():
    events = collect()

    with pytest.raises(UnknownVersion):
        transition_version("", SCANNING)

    assert events == []


# --------------------------------------------------------------------------- #
# Subscribers
# --------------------------------------------------------------------------- #


def test_a_failing_subscriber_neither_blocks_the_others_nor_the_transition():
    version_cid = make_version()
    seen: list[VersionStateChanged] = []

    def broken(event):
        raise RuntimeError("this consumer is down")

    subscribe_state_changed(broken)
    subscribe_state_changed(seen.append)

    transition_version(version_cid, SCANNING)

    assert get_version(version_cid).state == SCANNING
    assert [event.state for event in seen] == [SCANNING]


def test_subscribing_twice_delivers_once():
    version_cid = make_version()
    seen: list[VersionStateChanged] = []

    subscribe_state_changed(seen.append)
    subscribe_state_changed(seen.append)
    assert state_changed_subscriber_count() == 1

    transition_version(version_cid, SCANNING)

    assert len(seen) == 1


def test_the_decorator_form_works():
    version_cid = make_version()
    seen: list[VersionStateChanged] = []

    @subscribe_version_state_changed
    def remember(event):
        seen.append(event)

    transition_version(version_cid, SCANNING)

    assert [event.state for event in seen] == [SCANNING]


def test_unsubscribe_removes_one_subscriber():
    version_cid = make_version()
    seen: list[VersionStateChanged] = []

    subscribe_state_changed(seen.append)
    unsubscribe_state_changed(seen.append)

    transition_version(version_cid, SCANNING)

    assert seen == []
    assert state_changed_subscriber_count() == 0


def test_a_non_callable_subscriber_is_refused():
    with pytest.raises(TypeError):
        subscribe_state_changed("not a function")


def test_emitting_a_mapping_publishes_an_event():
    seen: list[VersionStateChanged] = []
    subscribe_state_changed(seen.append)

    emit_state_changed(
        {
            "version_cid": "cid-a",
            "paper_cid": "paper-a",
            "n": 1,
            "state": SCANNING,
            "previous_state": AWAITING_CONSENT,
        }
    )

    assert len(seen) == 1
    assert seen[0].state == SCANNING
    assert seen[0].previous_state == AWAITING_CONSENT


# --------------------------------------------------------------------------- #
# The happy-path helper
# --------------------------------------------------------------------------- #


def test_advance_version_walks_the_happy_path():
    version_cid = make_version()
    events = collect()

    advance_version(version_cid)
    advance_version(version_cid)
    advance_version(version_cid)

    assert get_version(version_cid).state == LISTED
    assert [event.state for event in events] == [SCANNING, MODERATION, LISTED]
    assert [event.previous_state for event in events] == [
        AWAITING_CONSENT,
        SCANNING,
        MODERATION,
    ]


def test_advancing_past_listed_is_refused():
    version_cid = make_version()
    for state in (SCANNING, MODERATION, LISTED):
        transition_version(version_cid, state)

    with pytest.raises(InvalidVersionState):
        advance_version(version_cid)


def test_next_state_knows_the_happy_path():
    assert next_state(AWAITING_CONSENT) == SCANNING
    assert next_state(SCANNING) == MODERATION
    assert next_state(MODERATION) == LISTED
    assert next_state(LISTED) is None
    assert next_state(HELD) is None


def test_can_transition_describes_the_natural_graph():
    assert can_transition(AWAITING_CONSENT, SCANNING)
    assert can_transition(None, AWAITING_CONSENT)
    assert can_transition(LISTED, HELD)
    assert not can_transition(AWAITING_CONSENT, LISTED)
    assert not can_transition(REJECTED, "published")


# --------------------------------------------------------------------------- #
# Listed bookkeeping
# --------------------------------------------------------------------------- #


def test_listing_sets_listed_at_and_points_the_paper_at_the_version():
    paper_cid = new_paper_cid()
    save_paper(paper_cid=paper_cid, categories=["cs.T0"])
    version_cid = make_version(paper_cid=paper_cid)

    transition_version(version_cid, LISTED)

    version = get_version(version_cid)
    paper = get_paper(paper_cid)
    assert version.listed_at is not None
    assert paper is not None
    assert paper.latest_version_cid == version_cid
    assert paper.listed_at is not None


def test_holding_a_listed_version_unlists_the_paper_but_keeps_listed_at():
    paper_cid = new_paper_cid()
    save_paper(paper_cid=paper_cid, categories=["cs.T0"])
    version_cid = make_version(paper_cid=paper_cid)

    transition_version(version_cid, LISTED)
    listed_at = get_version(version_cid).listed_at
    transition_version(version_cid, HELD)

    paper = get_paper(paper_cid)
    assert paper.latest_version_cid is None
    assert paper.listed_at is None
    assert get_version(version_cid).listed_at == listed_at


def test_holding_a_different_version_leaves_the_listed_paper_alone():
    paper_cid = new_paper_cid()
    save_paper(paper_cid=paper_cid, categories=["cs.T0"])
    listed_version = make_version(paper_cid=paper_cid, n=1)
    other_version = make_version(paper_cid=paper_cid, n=2)

    transition_version(listed_version, LISTED)
    transition_version(other_version, HELD)

    paper = get_paper(paper_cid)
    assert paper.latest_version_cid == listed_version


def test_a_version_without_a_paper_row_can_still_be_listed():
    version_cid = make_version(paper_cid=f"paper-{uuid.uuid4().hex}")
    events = collect()

    transition_version(version_cid, LISTED)

    assert get_version(version_cid).listed_at is not None
    assert [event.state for event in events] == [LISTED]


# --------------------------------------------------------------------------- #
# The ingest path
# --------------------------------------------------------------------------- #


def _tier_two_author() -> tuple[SigningKey, str]:
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    ensure_account_table()
    with db.SessionLocal() as session:
        session.add(
            Account(
                did=did,
                tier=2,
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )
        session.commit()
    return seed, did


def test_accepting_a_paper_version_emits_its_first_event():
    seed, did = _tier_two_author()
    paper_cid = new_paper_cid()
    save_paper(paper_cid=paper_cid, categories=["cs.T0"])
    body = {
        "paper": paper_cid,
        "n": 1,
        "title": "A version accepted through the ingest handler",
        "abstract": "",
        "authors": [did],
        "manifest": f"bafkreimanifest{uuid.uuid4().hex}",
        "licence": "CC-BY-4.0",
        "changeNote": "First version.",
    }
    record = sign_record(
        {
            "v": 1,
            "type": PAPER_VERSION_TYPE,
            "author": did,
            "created": now(),
            "prev": paper_cid,
            "body": body,
            "proofs": [],
        },
        seed,
    )
    events = collect()

    assert handle_paper_version(record) == AWAITING_CONSENT

    assert len(events) == 1
    assert events[0].version_cid == record["id"]
    assert events[0].state == AWAITING_CONSENT
    assert events[0].previous_state is None
