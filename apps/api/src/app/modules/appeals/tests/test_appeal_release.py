"""Regression tests: an appeal restoration is a ``release``, and the draw is not grindable.

Two defects, one file:

* restoring a version that had never been listed appended a node-signed
  ``moderation.decision`` with action ``list`` to the public log, moved the
  version back to ``moderation`` and then wiped ``listed_at`` after the fact.
  The log permanently recorded an approval no moderator made, and anything that
  replays the log (rebuild, sync peers, the status rules) lists the unmoderated
  version.  A restoration is now a dedicated ``release`` record that names the
  state it returns the version to, and the log replays to the live state;
* the panel seed hashed in the appeal cid and the ledger head, both of which the
  appellant can predict, so they could vary a no-op field of the appeal until
  the draw seated the panel they wanted.  The seed is now an HMAC of the
  decision cid alone, keyed by a secret derived from the node's signing key.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

import pytest
from nacl.signing import SigningKey

from app import db
from app.modules import ledger, status, submissions
from app.modules.appeals import (
    Appeal,
    AppealPanelMember,
    AppealVoteReasons,
    apply_appeal,
    get_appeal,
    get_panel,
    seat_panel,
)
from app.modules.moderation import ACTION_STATES
from app.modules.submissions.models import Paper, PaperVersion
from app.modules.submissions.events import subscribe_state_changed, unsubscribe_state_changed
from app.settings import settings

from .test_appeals import APPEALS_URL, Scene, _appeal, node_key, subscribed  # noqa: F401
from .test_appeal_panels import _members, client, scene, standing  # noqa: F401
from .test_appeal_resolution import _vote

DECISION_TYPE = "moderation.decision"


def _file_appeal(client, scene: Scene, decision_cid: str) -> dict:
    record = _appeal(scene.author, decision_cid)
    response = client.post(APPEALS_URL, json=record, headers=scene.author.headers)
    assert response.status_code == 201, response.text
    return record


def _overturn(client, scene: Scene, decision_cid: str) -> dict:
    """Appeal ``decision_cid`` and have two of the three panelists overturn it."""
    record = _file_appeal(client, scene, decision_cid)
    first, second, _third = _members(record["id"])
    assert _vote(client, first, record["id"], "overturned").status_code == 200
    decided = _vote(client, second, record["id"], "overturned")
    assert decided.status_code == 200, decided.text
    return record


def _decision_bodies(version_cid: str) -> list[dict[str, Any]]:
    """Every ``moderation.decision`` body about the version, oldest first."""
    return [
        dict(entry.body)
        for entry in ledger.entries()
        if entry.record_type == DECISION_TYPE
        and isinstance(entry.body, dict)
        and entry.body.get("target") == version_cid
    ]


def _replayed_state(version_cid: str) -> str | None:
    """The state a consumer replaying the log arrives at, from the log alone.

    A state-setting action (``ACTION_STATES``) puts the version in its state; a
    ``release`` puts it in the state it names.  Nothing else changes it.
    """
    state = None
    for body in _decision_bodies(version_cid):
        action = body.get("action")
        if action in ACTION_STATES:
            state = ACTION_STATES[action]
        elif action == "release":
            state = body.get("state")
    return state


def _version(version_cid: str) -> PaperVersion:
    with db.SessionLocal() as session:
        row = session.get(PaperVersion, version_cid)
        session.expunge(row)
        return row


def _paper(paper_cid: str) -> Paper:
    with db.SessionLocal() as session:
        row = session.get(Paper, paper_cid)
        session.expunge(row)
        return row


# --------------------------------------------------------------------------- #
# A restoration is a release, never a "list"
# --------------------------------------------------------------------------- #


def test_restoring_a_never_listed_version_logs_no_list_decision(client, scene, standing):
    rejected = scene.decide("reject")
    assert _version(scene.version_cid).state == "rejected"

    appeal = _overturn(client, scene, rejected)

    # Back in the moderation queue, never in the catalog ...
    version = _version(scene.version_cid)
    assert version.state == "moderation"
    assert version.listed_at is None
    assert _paper(scene.paper_cid).latest_version_cid is None
    # ... and the log records no approval nobody made.
    bodies = _decision_bodies(scene.version_cid)
    assert "list" not in [body["action"] for body in bodies]
    assert [body["action"] for body in bodies] == ["reject", "release"]
    release = bodies[1]
    assert release["state"] == "moderation"
    assert release["appeal"] == appeal["id"]


def test_the_restoration_never_lists_a_version_even_for_a_moment(client, scene, standing):
    listed: list[str] = []

    def collect(event) -> None:
        if event.version_cid == scene.version_cid and event.state == "listed":
            listed.append(event.state)

    rejected = scene.decide("reject")
    subscribe_state_changed(collect)
    try:
        _overturn(client, scene, rejected)
    finally:
        unsubscribe_state_changed(collect)

    # No ``version.state_changed`` to ``listed``: no "your paper is listed"
    # notice, no AI pre-review of a version nobody approved.
    assert listed == []


@pytest.mark.parametrize("prior", ["moderation", "listed"])
def test_the_log_replays_to_the_state_the_live_node_has(client, scene, standing, prior):
    if prior == "listed":
        submissions.transition_version(scene.version_cid, "listed")
    held = scene.decide("hold")

    _overturn(client, scene, held)

    live = _version(scene.version_cid).state
    assert live == prior
    assert _replayed_state(scene.version_cid) == live


def test_a_restoration_never_writes_a_state_setting_record_the_node_did_not_mean(client, scene, standing):
    rejected = scene.decide("reject")

    _overturn(client, scene, rejected)

    node = ledger.node_did()
    node_decisions = [
        entry.body
        for entry in ledger.entries()
        if entry.record_type == DECISION_TYPE and entry.author_did == node
    ]
    assert [body["action"] for body in node_decisions] == ["release"]
    assert "release" not in ACTION_STATES  # a release is not itself a state-setting action


def test_a_release_ends_a_hold_for_the_status_rules(client, scene, standing):
    held = scene.decide("hold")
    assert status.compute_status(status.paper_records(scene.paper_cid)) == "contested"

    _overturn(client, scene, held)

    assert status.compute_status(status.paper_records(scene.paper_cid)) != "contested"


@pytest.mark.parametrize("prior", ["moderation", "listed"])
def test_a_rebuild_from_the_archive_reads_the_same_status_as_the_live_node(client, scene, standing, prior):
    # ``scholium rebuild`` recomputes every paper's status from the archived
    # records with its own copy of the status rules.  After an overturn it must
    # agree with the node, which no longer holds the paper contested.
    from scholium_cli.status import status_of

    if prior == "listed":
        submissions.transition_version(scene.version_cid, "listed")
    held = scene.decide("hold")
    _overturn(client, scene, held)

    records = status.paper_records(scene.paper_cid)
    live = submissions.get_paper(scene.paper_cid).status
    assert status_of(records).status == live
    assert live != "contested"


def test_a_release_back_to_held_keeps_the_hold_for_the_status_rules(scene):
    # compute_status is pure: a release naming ``held`` puts the hold back in force.
    def record(action: str, state: str | None, created: str, cid: str) -> dict:
        body: dict[str, Any] = {"target": scene.version_cid, "action": action, "clause": "MOD-01"}
        if state is not None:
            body["state"] = state
        return {"type": DECISION_TYPE, "id": cid, "author": "did:key:x", "created": created, "prev": None, "body": body}

    hold = record("hold", None, "2026-01-01T00:00:00Z", "a")
    release_listed = record("release", "listed", "2026-01-02T00:00:00Z", "b")
    release_held = record("release", "held", "2026-01-02T00:00:00Z", "c")

    assert status.compute_status([hold]) == "contested"
    assert status.compute_status([hold, release_listed]) != "contested"
    assert status.compute_status([hold, release_held]) == "contested"

    # The archive rebuild reads the same rules.
    from scholium_cli.status import status_of

    assert status_of([hold]).status == "contested"
    assert status_of([hold, release_listed]).status != "contested"
    assert status_of([hold, release_held]).status == "contested"


# --------------------------------------------------------------------------- #
# The guards of the previous fix still hold
# --------------------------------------------------------------------------- #


def _releases(version_cid: str) -> list[dict[str, Any]]:
    return [body for body in _decision_bodies(version_cid) if body["action"] == "release"]


def test_a_newer_decision_on_the_target_is_not_overwritten_by_a_restoration(client, scene, standing):
    first_hold = scene.decide("hold")
    record = _file_appeal(client, scene, first_hold)
    scene.decide("list")  # a moderator acts since ...
    scene.decide("hold")  # ... and holds it again

    first, second, _third = _members(record["id"])
    assert _vote(client, first, record["id"], "overturned").status_code == 200
    assert _vote(client, second, record["id"], "overturned").status_code == 200

    # The panel's verdict is on record, but the newer hold stands.
    assert _releases(scene.version_cid) == []
    assert _version(scene.version_cid).state == "held"


def test_a_forged_restoration_marker_does_not_pre_empt_the_restoration(client, scene, standing):
    held = scene.decide("hold")
    record = _file_appeal(client, scene, held)
    # Anyone who can sign a decision can put the appeal's cid in a body field.
    scene.decide("reclassify", category="cs.LG", appeal_restoration=record["id"], appeal=record["id"])

    first, second, _third = _members(record["id"])
    assert _vote(client, first, record["id"], "overturned").status_code == 200
    assert _vote(client, second, record["id"], "overturned").status_code == 200

    releases = _releases(scene.version_cid)
    assert len(releases) == 1 and releases[0]["state"] == "moderation"
    assert _version(scene.version_cid).state == "moderation"


def test_a_prior_state_a_release_cannot_name_fails_closed_and_tells_the_moderator(
    client, scene, standing, monkeypatch
):
    from app.modules.appeals import votes
    from app.modules.notifications import service as notifications

    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(votes, "_prior_version_state", lambda *_args: "scanning")
    monkeypatch.setattr(notifications, "notify", lambda did, kind, payload: sent.append((did, kind)))
    held = scene.decide("hold")

    _overturn(client, scene, held)

    assert _releases(scene.version_cid) == []
    assert _version(scene.version_cid).state == "held"
    assert (scene.moderator.did, "appeal.restoration_failed") in sent


# --------------------------------------------------------------------------- #
# The panel draw does not depend on the appeal the appellant writes
# --------------------------------------------------------------------------- #


def _forget_appeal(appeal_cid: str) -> None:
    """Drop an appeal's row, panel and reasons, as if it had never been filed here."""
    with db.SessionLocal() as session:
        session.query(AppealPanelMember).filter(AppealPanelMember.appeal_cid == appeal_cid).delete()
        session.query(AppealVoteReasons).filter(AppealVoteReasons.appeal_cid == appeal_cid).delete()
        session.query(Appeal).filter(Appeal.appeal_cid == appeal_cid).delete()
        session.commit()


def test_the_draw_does_not_depend_on_the_appeal_cid_or_body(client, scene, standing):
    decision = scene.decide("hold")
    first = _file_appeal(client, scene, decision)
    first_seed = get_appeal(first["id"]).panel_seed
    first_panel = _members(first["id"])
    assert first_seed

    # The appellant re-files the same decision with a different no-op body (so a
    # different cid, and a longer ledger).  Nothing they vary may move the draw.
    _forget_appeal(first["id"])
    for _ in range(3):
        again = _file_appeal(client, scene, decision)
        assert again["id"] != first["id"]
        assert get_appeal(again["id"]).panel_seed == first_seed
        assert _members(again["id"]) == first_panel
        _forget_appeal(again["id"])


def test_the_seed_is_an_hmac_of_the_decision_cid_keyed_by_the_node_key(client, scene, standing, node_key):
    from app.modules.appeals.panel import panel_seed_secret

    decision = scene.decide("hold")
    record = _file_appeal(client, scene, decision)

    key = ledger.node_signing_key()
    expected = hmac.new(panel_seed_secret(key), decision.encode("utf-8"), hashlib.sha256).hexdigest()
    assert get_appeal(record["id"]).panel_seed == expected
    # The secret is derived from the signing key, not the key itself, and the
    # seed is not a bare hash anyone could recompute from the decision cid.
    assert panel_seed_secret(key) != bytes(key)
    assert expected != hashlib.sha256(decision.encode("utf-8")).hexdigest()


def test_another_node_key_draws_from_another_seed(client, scene, standing, monkeypatch, tmp_path):
    from app.modules.appeals.panel import derive_panel_seed

    decision = scene.decide("hold")
    mine = derive_panel_seed(decision, ledger.node_signing_key())

    other = tmp_path / "other.key"
    other.write_bytes(bytes(SigningKey.generate()).hex().encode("ascii"))
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(other))

    assert derive_panel_seed(decision, ledger.node_signing_key()) != mine


def test_a_node_without_a_key_files_the_appeal_but_seats_nobody(client, scene, standing, monkeypatch, tmp_path):
    decision = scene.decide("hold")
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(tmp_path / "missing.key"))

    record = _file_appeal(client, scene, decision)

    # Fail closed: no key, no secret, so no seed that anyone could grind.
    assert get_appeal(record["id"]) is not None
    assert get_panel(record["id"]) == []
    assert not get_appeal(record["id"]).panel_seed


def test_the_panel_is_drawn_once_the_key_is_provisioned(client, scene, standing, monkeypatch, tmp_path, node_key):
    decision = scene.decide("hold")
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(tmp_path / "missing.key"))
    record = _file_appeal(client, scene, decision)
    assert get_panel(record["id"]) == []

    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(node_key))
    apply_appeal(record)  # the ledger subscriber and the endpoint both repair a missing panel

    assert len(get_panel(record["id"])) == 3
    assert get_appeal(record["id"]).panel_seed
    # Seating again changes nothing: the same three seats come back.
    assert [seat.member_did for seat in seat_panel(get_appeal(record["id"]))] == _members(record["id"])
