"""Regression tests for the appeal-resolution defects (bug 19).

Three defects, one file:

* a seated panelist is never told they hold a seat, and no endpoint names the
  panel, so nobody knows to vote;
* an overturning ``appeal.decision`` changes nothing: the appealed moderation
  decision stays in force and the paper stays ``contested``;
* the draw is seeded from the appeal cid, which the appellant chooses, instead
  of from the decision cid, which they cannot.

The scenes reuse the builders from the sibling suites: ``Scene`` puts a paper,
a version in ``moderation`` and a moderator in place; ``standing`` adds tier-3
and tier-4 members around it.  Every DID is made up per test, so a score of
earlier tests in the worker changes the *pool* a panel is drawn from but never
the properties asserted here.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.modules import ledger, status, submissions
from app.settings import settings
from app.modules.appeals import (
    PANEL_SIZE,
    apply_appeal,
    eligible_members,
    get_appeal,
    seat_panel,
    select_panel,
)
from app.security import issue_access_token

# ``subscribed`` is autouse and restores the ledger subscriptions other suites
# clear; importing it applies it here too.  ``Scene``/``Person``/``_appeal`` are
# the shared scene builders, and the fixtures are re-exported the same way.
from .test_appeals import (
    APPEALS_URL,
    Person,
    Scene,
    _appeal,
    subscribed,  # noqa: F401
)
from .test_appeal_panels import (  # noqa: F401 - fixture re-exports
    _members,
    client,
    membership,
    scene,
    standing,
)

NOTIFICATIONS_URL = "/v1/me/notifications"
VOTES_URL = "/v1/appeals/{cid}/votes"


@pytest.fixture(autouse=True)
def node_key(tmp_path, monkeypatch):
    """Provision the node's Ed25519 key: a panel's decision is node-signed.

    The root conftest points ``NODE_KEY_PATH`` at a per-worker file but never
    writes one; a test that votes must supply the key itself.
    """
    from nacl.signing import SigningKey

    path = tmp_path / "node.key"
    path.write_bytes(bytes(SigningKey.generate()).hex().encode("ascii"))
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))
    return path


def _bearer(did: str, tier: int = 3) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _file(client: TestClient, scene: Scene) -> dict:
    """The author appeals a fresh decision over HTTP; return the appeal record."""
    record = _appeal(scene.author, scene.decide("hold"))
    response = client.post(APPEALS_URL, json=record, headers=scene.author.headers)
    assert response.status_code == 201, response.text
    return record


def _notifications(client: TestClient, did: str) -> list[dict]:
    response = client.get(NOTIFICATIONS_URL, headers=_bearer(did))
    assert response.status_code == 200, response.text
    return response.json()


def _casting_notices(client: TestClient, did: str, appeal_cid: str) -> list[dict]:
    """The notifications sent to ``did`` about ``appeal_cid`` being seated."""
    return [
        row
        for row in _notifications(client, did)
        if isinstance(row.get("payload"), dict)
        and appeal_cid
        in {
            row["payload"].get("appeal_cid"),
            row["payload"].get("appeal"),
        }
    ]


def _vote(client: TestClient, did: str, appeal_cid: str, outcome: str, tier: int = 3):
    return client.post(
        VOTES_URL.format(cid=appeal_cid),
        json={"outcome": outcome, "reasons": f"Reasons {uuid.uuid4().hex}"},
        headers=_bearer(did, tier),
    )


# --------------------------------------------------------------------------- #
# Each seated member is told, once
# --------------------------------------------------------------------------- #


def test_every_seated_member_is_notified_that_they_hold_a_seat(client, scene, standing):
    record = _file(client, scene)
    seated = _members(record["id"])
    assert len(seated) == PANEL_SIZE

    for did in seated:
        notices = _casting_notices(client, did, record["id"])
        assert len(notices) == 1, f"{did} got {[n['payload'] for n in notices]!r}"
        payload = notices[0]["payload"]
        # The notice says which appeal, and links to it.
        assert payload["appeal_cid"] == record["id"]
        link = payload.get("link") or ""
        assert record["id"] in link
        assert payload.get("decision_cid") == get_appeal(record["id"]).decision_cid


def test_the_notice_is_sent_once_however_often_the_appeal_is_applied(client, scene, standing):
    record = _file(client, scene)
    seated = _members(record["id"])

    apply_appeal(record)  # the ledger subscriber and the endpoint both do this
    apply_appeal(record)

    for did in seated:
        assert len(_casting_notices(client, did, record["id"])) == 1


def test_a_member_who_is_not_seated_is_told_nothing(client, scene, standing):
    record = _file(client, scene)
    seated = set(_members(record["id"]))
    bystander = next(did for did in eligible_members() if did not in seated)

    assert _casting_notices(client, bystander, record["id"]) == []


def test_a_panel_drawn_later_notifies_the_members_it_seats(client, scene, membership):
    # A membership too small for a panel at filing time; the appeal is still
    # filed and its panel is drawn once enough members exist.
    late = [Person().did for _ in range(4)]
    membership([scene.moderator.did, scene.author.did, late[0], late[1]])
    record = _appeal(scene.author, scene.decide("hold"))
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201
    assert _members(record["id"]) == []

    membership([scene.moderator.did, scene.author.did, *late])
    seats = seat_panel(get_appeal(record["id"]))

    assert len(seats) == PANEL_SIZE
    for seat in seats:
        assert len(_casting_notices(client, seat.member_did, record["id"])) == 1


# --------------------------------------------------------------------------- #
# GET /v1/appeals/{id}: the panel is visible to the panel and to tier 4
# --------------------------------------------------------------------------- #


def test_a_seated_member_reads_the_panel(client, scene, standing):
    record = _file(client, scene)
    seated = _members(record["id"])

    for did in seated:
        response = client.get(f"/v1/appeals/{record['id']}", headers=_bearer(did))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["id"] == record["id"]
        assert body["appeal_cid"] == record["id"]
        assert {seat["did"] for seat in body["panel"]} == set(seated)
        assert body["viewer_on_panel"] is True


def test_a_moderator_reads_the_panel(client, scene, standing):
    record = _file(client, scene)
    seated = _members(record["id"])

    response = client.get(f"/v1/appeals/{record['id']}", headers=scene.moderator.headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert {seat["did"] for seat in body["panel"]} == set(seated)
    assert body["viewer_on_panel"] is False


def test_the_panel_is_not_shown_to_someone_who_does_not_hold_a_seat(client, scene, standing):
    record = _file(client, scene)
    seated = set(_members(record["id"]))
    # Neither a reader nor an eligible member the draw did not seat sees it.
    not_drawn = next(did for did in eligible_members() if did not in seated)
    for did, tier in ((Person().did, 2), (not_drawn, 3)):
        response = client.get(f"/v1/appeals/{record['id']}", headers=_bearer(did, tier))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["panel"] == []
        assert body["viewer_on_panel"] is False

    # The appeal itself is public, like the record it comes from.
    anonymous = client.get(f"/v1/appeals/{record['id']}")
    assert anonymous.status_code == 200, anonymous.text
    assert anonymous.json()["panel"] == []


def test_an_unknown_appeal_is_404(client):
    response = client.get(f"/v1/appeals/bafy-no-such-appeal-{uuid.uuid4().hex}")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


# --------------------------------------------------------------------------- #
# An overturn restores the target's prior state and lifts the hold
# --------------------------------------------------------------------------- #


def test_an_overturn_restores_the_target_version_and_ends_the_hold(client, scene, standing):
    prior_state = submissions.get_version(scene.version_cid).state
    decision = scene.decide("hold")
    assert submissions.get_version(scene.version_cid).state == "held"
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    # The hold is in force: the paper is contested.
    assert status.explain_status(status.paper_records(scene.paper_cid)).status == status.STATUS_CONTESTED

    first, second, _third = _members(record["id"])
    assert _vote(client, first, record["id"], "overturned").status_code == 200
    decided = _vote(client, second, record["id"], "overturned")
    assert decided.status_code == 200, decided.text
    assert decided.json()["outcome"] == "overturned"

    # The target is back in the state the appealed decision found it in ...
    assert submissions.get_version(scene.version_cid).state == prior_state
    # ... and the hold is no longer in force.
    assert status.explain_status(status.paper_records(scene.paper_cid)).status != status.STATUS_CONTESTED
    # The saved status follows, without a moderator relisting by hand.
    assert submissions.get_paper(scene.paper_cid).status != status.STATUS_CONTESTED


def test_a_listed_version_overturned_is_listed_again(client, scene, standing):
    # A version that has been in the catalog before it was held.
    submissions.transition_version(scene.version_cid, "listed")
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    first, second, _third = _members(record["id"])
    assert _vote(client, first, record["id"], "overturned").status_code == 200
    assert _vote(client, second, record["id"], "overturned").status_code == 200

    assert submissions.get_version(scene.version_cid).state == "listed"
    assert status.explain_status(status.paper_records(scene.paper_cid)).status != status.STATUS_CONTESTED


def test_an_upheld_appeal_leaves_the_hold_in_force(client, scene, standing):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    first, second, _third = _members(record["id"])
    assert _vote(client, first, record["id"], "upheld").status_code == 200
    decided = _vote(client, second, record["id"], "upheld")
    assert decided.status_code == 200 and decided.json()["outcome"] == "upheld"

    assert submissions.get_version(scene.version_cid).state == "held"
    assert status.explain_status(status.paper_records(scene.paper_cid)).status == status.STATUS_CONTESTED


def test_the_restoration_is_recorded_once_even_after_a_later_vote(client, scene, standing):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    first, second, third = _members(record["id"])
    assert _vote(client, first, record["id"], "overturned").status_code == 200
    assert _vote(client, second, record["id"], "overturned").status_code == 200

    # A member changing their vote after the decision reports it, and does not
    # restore the target a second time.
    assert _vote(client, third, record["id"], "overturned").status_code == 200

    restorations = [
        entry
        for entry in ledger.entries()
        if entry.record_type == "moderation.decision"
        and isinstance(entry.body, dict)
        and entry.body.get("appeal") == record["id"]
    ]
    assert len(restorations) == 1


# --------------------------------------------------------------------------- #
# Seeded from the decision, not from the appeal cid the appellant chooses
# --------------------------------------------------------------------------- #


def test_the_draw_is_seeded_from_the_decision(client, scene, standing):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    barred = {scene.moderator.did, scene.author.did, *(p.did for p in scene.coauthors)}
    expected = select_panel(decision, eligible_members(barred))

    assert _members(record["id"]) == list(expected)
    # And not the draw the appellant could steer by choosing the appeal cid.
    assert _members(record["id"]) != list(select_panel(record["id"], eligible_members(barred)))
