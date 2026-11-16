"""Tests for the appeal panel draw (appeals plugin, feature 75).

Saving an appeal seats a 3-member panel in ``appeal_panels``: tier-3 or tier-4
members, never the deciding moderator or an author of the paper, drawn
deterministically from the appeal cid.

The test database is shared by every test a worker runs, so ``accounts`` holds
whatever earlier tests left behind.  Tests that touch the real membership
therefore assert properties of the panel (who is on it and who is not) rather
than exact identities, and the ones that need an exactly known membership
replace :func:`~app.modules.appeals.panel._tiered_dids`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app import db
from app.main import app
from app.modules import appeals
from app.modules.appeals import (
    PANEL_SIZE,
    PANEL_TIERS,
    PANEL_UNAVAILABLE,
    AppealPanelMember,
    PanelUnavailable,
    apply_appeal,
    draw_panel,
    eligible_members,
    get_appeal,
    get_panel,
    panel,
    panel_seed,
    seat_panel,
    select_panel,
)
from app.modules.identity.models import Account, ensure_account_table

# The scene builders live with the feature-74 tests.  ``subscribed`` is an
# autouse fixture, so importing it is what applies it to this module.
from .test_appeals import (
    APPEALS_URL,
    RECORDS_URL,
    Person,
    Scene,
    _appeal,
    node_key,  # noqa: F401
    subscribed,  # noqa: F401
)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _account(tier: int, did: Optional[str] = None) -> str:
    """Create (or re-tier) an account; return its DID."""
    ensure_account_table()
    did = did or Person().did
    with db.SessionLocal() as session:
        session.merge(
            Account(
                did=did,
                tier=tier,
                created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=400),
            )
        )
        session.commit()
    return did


def _members(appeal_cid: str) -> list[str]:
    return [row.member_did for row in get_panel(appeal_cid)]


def _tier_of(did: str) -> int:
    with db.SessionLocal() as session:
        return session.get(Account, did).tier


def _panel_rows(appeal_cid: str) -> list[AppealPanelMember]:
    with db.SessionLocal() as session:
        return session.query(AppealPanelMember).filter(AppealPanelMember.appeal_cid == appeal_cid).all()


@pytest.fixture
def scene(client) -> Scene:
    return Scene(client, coauthors=1)


@pytest.fixture
def standing(scene):
    """Tier-3/4 members around the scene, and the lower tiers that must never sit.

    The author and co-author hold tier 3 themselves, so only the exclusion
    keeps them off the panel.  Returns ``(eligible, ineligible)`` DID sets.
    """
    eligible = {_account(3) for _ in range(4)} | {_account(4) for _ in range(4)}
    ineligible = {_account(tier) for tier in (0, 1, 2) for _ in range(3)}
    for person in (scene.author, *scene.coauthors):
        _account(3, person.did)
    _account(4, scene.moderator.did)
    return eligible, ineligible


def _file(client, scene) -> dict:
    """The author appeals a decision over HTTP; return the appeal record."""
    record = _appeal(scene.author, scene.decide("hold"))
    response = client.post(APPEALS_URL, json=record, headers=scene.author.headers)
    assert response.status_code == 201, response.text
    return record


# --------------------------------------------------------------------------- #
# select_panel: the seeded draw, with no database
# --------------------------------------------------------------------------- #

POOL = [f"did:key:member-{i:02d}" for i in range(40)]


def test_the_same_cid_over_the_same_members_always_seats_the_same_panel():
    first = select_panel("bafyappeal-1", POOL)
    assert len(first) == PANEL_SIZE == 3
    assert len(set(first)) == 3
    assert all(did in POOL for did in first)
    assert select_panel("bafyappeal-1", POOL) == first


def test_the_draw_does_not_depend_on_the_order_or_repeats_of_the_candidates():
    expected = select_panel("bafyappeal-1", POOL)
    assert select_panel("bafyappeal-1", reversed(POOL)) == expected
    assert select_panel("bafyappeal-1", POOL + POOL[:10]) == expected
    assert select_panel("bafyappeal-1", sorted(POOL, key=lambda did: did[::-1])) == expected


def test_different_appeals_draw_different_panels():
    panels = {select_panel(f"bafyappeal-{i}", POOL) for i in range(30)}
    # 30 draws of 3 from 40: a constant or near-constant draw is not seeded by the cid.
    assert len(panels) > 20
    seats = {did for chosen in panels for did in chosen}
    assert len(seats) > 20


def test_a_member_who_leaves_without_sitting_does_not_change_the_panel():
    chosen = select_panel("bafyappeal-1", POOL)
    bystander = next(did for did in POOL if did not in chosen)
    assert select_panel("bafyappeal-1", [did for did in POOL if did != bystander]) == chosen

    # A newcomer either out-ranks one of the three or changes nothing.
    for i in range(20):
        newcomer = f"did:key:newcomer-{i}"
        grown = select_panel("bafyappeal-1", [*POOL, newcomer])
        assert grown == chosen or newcomer in grown


def test_fewer_candidates_than_seats_yields_them_all():
    assert set(select_panel("bafyappeal-1", POOL[:2])) == set(POOL[:2])
    assert select_panel("bafyappeal-1", []) == ()


def test_the_panel_tiers_are_three_and_four():
    assert PANEL_TIERS == (3, 4)


# --------------------------------------------------------------------------- #
# Eligibility, read from the real accounts table
# --------------------------------------------------------------------------- #


def test_only_tier_three_and_four_accounts_are_eligible(standing):
    eligible, ineligible = standing
    pool = set(eligible_members())
    assert eligible <= pool
    assert not (ineligible & pool)


def test_excluded_dids_are_left_out_of_the_pool(standing):
    eligible, _ = standing
    barred = set(sorted(eligible)[:3])
    pool = set(eligible_members(barred))
    assert not (barred & pool)
    assert eligible - barred <= pool


# --------------------------------------------------------------------------- #
# Filing an appeal seats its panel
# --------------------------------------------------------------------------- #


def test_filing_an_appeal_saves_a_three_member_panel(client, scene, standing):
    eligible, ineligible = standing
    record = _file(client, scene)

    rows = _panel_rows(record["id"])
    assert len(rows) == 3
    assert len({row.member_did for row in rows}) == 3
    assert all(row.vote is None for row in rows)
    for row in rows:
        assert _tier_of(row.member_did) in (3, 4)
        assert row.member_did not in ineligible


def test_the_panel_never_includes_the_moderator_or_any_author(client, standing):
    # Fresh scenes (and so fresh appeal cids) give the draw many chances to slip.
    for _ in range(6):
        scene = Scene(client, coauthors=2)
        barred = {scene.moderator.did, scene.author.did, *(p.did for p in scene.coauthors)}
        # The moderator is tier 4 already (a decision needs it); the authors are made tier 3.
        for person in (scene.author, *scene.coauthors):
            _account(3, person.did)
        # All of them are tier 3 or 4, so only the exclusion keeps them off.
        assert barred <= set(eligible_members())

        record = _file(client, scene)

        seated = set(_members(record["id"]))
        assert len(seated) == 3
        assert not (seated & barred)


def test_the_panel_is_the_one_the_appealed_decision_dictates(client, scene, standing):
    record = _file(client, scene)
    barred = {scene.moderator.did, scene.author.did, *(p.did for p in scene.coauthors)}

    # Anyone could recompute the draw from the decision cid and the membership.
    # (Seeding from the appeal cid let the appellant grind record ids until the
    # draw suited them; the decision cid is not theirs to choose.)
    expected = select_panel(panel_seed(record["id"]), eligible_members(barred))
    assert _members(record["id"]) == list(expected)


def test_an_appeal_arriving_through_post_records_gets_a_panel_too(client, scene, standing):
    record = _appeal(scene.author, scene.decide("reject"))
    response = client.post(RECORDS_URL, json=record, headers=scene.author.headers)
    assert response.status_code == 201, response.text

    assert get_appeal(record["id"]) is not None
    assert len(_members(record["id"])) == 3


def test_applying_the_appeal_again_keeps_the_panel_that_was_drawn(client, scene, standing):
    record = _file(client, scene)
    drawn = _members(record["id"])

    # A flood of new tier-3 members would redraw a different panel if one were drawn now.
    for _ in range(40):
        _account(3)
    again = apply_appeal(record)

    assert again.appeal_cid == record["id"]
    assert _members(record["id"]) == drawn
    assert len(_panel_rows(record["id"])) == 3


def test_a_seated_member_who_drops_a_tier_keeps_the_seat(client, scene, standing):
    record = _file(client, scene)
    drawn = _members(record["id"])

    _account(1, drawn[0])
    apply_appeal(record)

    assert _members(record["id"]) == drawn


def test_each_appeal_has_its_own_panel(client, standing):
    first, second = Scene(client), Scene(client)
    one, two = _file(client, first), _file(client, second)

    assert len(_members(one["id"])) == 3
    assert len(_members(two["id"])) == 3
    assert {r.appeal_cid for r in _panel_rows(one["id"])} == {one["id"]}


# --------------------------------------------------------------------------- #
# Too few members to seat a panel
# --------------------------------------------------------------------------- #


@pytest.fixture
def membership(monkeypatch):
    """Pin the tier-3/4 membership to exactly the DIDs the test names."""

    def pin(dids):
        monkeypatch.setattr(panel, "_tiered_dids", lambda: list(dids))

    return pin


def test_excluded_people_never_fill_the_seats_of_a_short_pool(client, scene, membership):
    # Five tier-3/4 members, but three of them are the moderator and the authors.
    others = [Person().did, Person().did]
    membership([scene.moderator.did, scene.author.did, scene.coauthors[0].did, *others])

    record = _file(client, scene)  # the appeal is still filed ...

    assert get_appeal(record["id"]) is not None
    assert _panel_rows(record["id"]) == []  # ... but no partial panel is drawn


def test_a_panel_is_drawn_once_enough_members_exist(client, scene, membership):
    others = [Person().did for _ in range(4)]
    membership([scene.moderator.did, scene.author.did, others[0], others[1]])
    record = _file(client, scene)
    assert _panel_rows(record["id"]) == []

    membership([scene.moderator.did, scene.author.did, *others])
    seated = seat_panel(get_appeal(record["id"]))

    # The moderator and the author are excluded, so the panel is drawn from
    # `others`, seeded from the appealed decision cid (see panel.py).
    assert [row.member_did for row in seated] == list(select_panel(panel_seed(record["id"]), others))
    assert len(seated) == 3
    assert scene.moderator.did not in _members(record["id"])
    assert scene.author.did not in _members(record["id"])
    # And it is the panel from now on.
    assert _members(record["id"]) == [row.member_did for row in seated]


def test_applying_the_appeal_again_draws_a_panel_that_was_short_before(client, scene, membership):
    others = [Person().did for _ in range(3)]
    membership(others[:2])
    record = _file(client, scene)
    assert _panel_rows(record["id"]) == []

    membership(others)
    apply_appeal(record)

    assert sorted(_members(record["id"])) == sorted(others)


def test_draw_panel_refuses_a_short_pool_with_problem_details(membership):
    membership([Person().did, Person().did])
    cid = f"bafy-short-{uuid.uuid4().hex}"

    with pytest.raises(PanelUnavailable) as caught:
        draw_panel(cid)

    problem = caught.value
    assert problem.status_code == 503
    assert problem.type == PANEL_UNAVAILABLE == "urn:scholium:problem:appeal-panel-unavailable"
    assert problem.eligible == 2 and problem.needed == 3
    assert problem.extensions == {"appeal": cid, "eligible": 2, "needed": 3}
    assert _panel_rows(cid) == []


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #


def test_draw_panel_is_idempotent_and_never_seats_a_member_twice(membership):
    members = [Person().did for _ in range(6)]
    membership(members)
    cid = f"bafy-idem-{uuid.uuid4().hex}"

    first = draw_panel(cid)
    again = draw_panel(cid)

    assert [row.member_did for row in again] == [row.member_did for row in first]
    assert len(_panel_rows(cid)) == 3
    with db.SessionLocal() as session:
        session.add(AppealPanelMember(appeal_cid=cid, member_did=first[0].member_did, vote=None))
        with pytest.raises(IntegrityError):
            session.commit()


def test_a_member_may_sit_on_the_panels_of_several_appeals(membership):
    members = [Person().did for _ in range(3)]
    membership(members)
    one, two = f"bafy-a-{uuid.uuid4().hex}", f"bafy-b-{uuid.uuid4().hex}"

    assert sorted(row.member_did for row in draw_panel(one)) == sorted(members)
    assert sorted(row.member_did for row in draw_panel(two)) == sorted(members)


def test_the_panel_of_an_unknown_appeal_is_empty():
    assert get_panel("bafy-nothing-here") == []
    assert get_panel(None) == []
    assert get_panel("") == []


def test_the_package_exports_the_panel_api():
    for name in ("PANEL_SIZE", "PANEL_TIERS", "draw_panel", "get_panel", "seat_panel", "select_panel"):
        assert hasattr(appeals, name), name
