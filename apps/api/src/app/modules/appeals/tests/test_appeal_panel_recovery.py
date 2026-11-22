"""Regression: a filed appeal survives a reload, and a short panel is recoverable.

A reader who appealed the hiding of their own post must see that the appeal was
filed after a reload -- the state may not live only in the browser tab -- and a
decision that could not draw a full panel must be marked, reported to the
moderators and the appellant, retried, and eventually decidable without one.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app import db
from app.modules import appeals, ledger
from app.modules.appeals import (
    PANEL_NOT_FORMED,
    Appeal,
    get_appeal,
    get_panel,
    retry_pending_panels,
)
from app.modules.appeals import panel as panel_module
from app.modules.moderation.tests.test_decisions import Moderator

from .test_appeal_panels import _account, client  # noqa: F401 - fixture re-export
from .test_appeals import (
    APPEALS_URL,
    Person,
    node_key,  # noqa: F401 - autouse fixture
    subscribed,  # noqa: F401 - autouse fixture
)
from .test_appeal_polish import HiddenPost, _bearer

THREADS_URL = "/v1/papers/{paper}/threads"
DECIDE_URL = "/v1/appeals/{cid}/decide"


@pytest.fixture
def pool(monkeypatch):
    """Pin the panel candidates to exactly the DIDs a test names."""

    def pin(*dids: str) -> None:
        monkeypatch.setattr(panel_module, "_tiered_dids", lambda: list(dids))

    return pin


def _find(payload: dict, post_cid: str) -> dict:
    def walk(node):
        if node.get("post_cid") == post_cid:
            return node
        for reply in node.get("replies", []):
            found = walk(reply)
            if found is not None:
                return found
        return None

    for thread in payload["threads"]:
        found = walk(thread)
        if found is not None:
            return found
    raise AssertionError(f"post {post_cid} is not in the threads payload")


def _document(client, scene, *, headers=None) -> dict:
    response = client.get(
        THREADS_URL.format(paper=scene.submission.short_id),
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return _find(response.json(), scene.post["id"])


def _age(appeal_cid: str, days: int = 15) -> None:
    """Move the appeal's filed date far enough back for its deadline to pass."""
    with db.SessionLocal() as session:
        row = session.get(Appeal, appeal_cid)
        assert row is not None
        row.filed_at = row.filed_at - timedelta(days=days)
        session.commit()


def test_threads_return_the_authors_filed_appeal_after_a_reload(client, pool):
    pool(*(_account(3) for _ in range(4)))
    scene = HiddenPost(client)
    record = scene.appeal()

    document = _document(client, scene, headers=_bearer(scene.post_author.did, 3))

    assert document["hidden"] is True
    assert document["appeal"] is not None
    assert document["appeal"]["appeal_cid"] == record["id"]
    assert document["appeal"]["filed_at"] is not None
    assert document["appeal"]["status"] == "awaiting_panel"
    assert document["appeal"]["outcome"] is None


def test_only_the_author_sees_the_appeal_on_their_own_hidden_post(client, pool):
    pool(*(_account(3) for _ in range(4)))
    scene = HiddenPost(client)
    scene.appeal()

    # No token: the reader is not the author (and the appeal is their business).
    assert _document(client, scene)["appeal"] is None
    # A different signed-in member is not the author either.
    other = Person()
    assert _document(client, scene, headers=_bearer(other.did, 3))["appeal"] is None


def test_a_short_panel_is_visible_to_its_author_and_reported(client, pool):
    eligible = [_account(3), _account(3)]
    pool(*eligible)
    scene = HiddenPost(client)
    record = scene.appeal()

    row = get_appeal(record["id"])
    assert row.status == PANEL_NOT_FORMED
    assert get_panel(record["id"]) == []

    document = _document(client, scene, headers=_bearer(scene.post_author.did, 3))
    assert document["appeal"]["status"] == "not_formed"

    from app.modules.notifications import list_notifications

    moderator_notes = [
        note
        for note in list_notifications(scene.moderator.did)
        if note.kind == appeals.PANEL_NOT_FORMED_KIND
        and note.payload.get("appeal_cid") == record["id"]
    ]
    assert moderator_notes
    assert "Only 2 eligible members are available; a panel needs 3." in moderator_notes[0].payload["summary"]
    # Two appeals about posts on one paper are told apart by the post's opening.
    assert (
        f'the appeal of a hidden post on "{scene.title}" ("{scene.text}...") yet.'
        in moderator_notes[0].payload["summary"]
    )

    appellant_notes = [
        note
        for note in list_notifications(scene.post_author.did)
        if note.kind == appeals.PANEL_NOT_FORMED_KIND
        and note.payload.get("appeal_cid") == record["id"]
    ]
    assert appellant_notes


def test_a_short_panel_notice_never_quotes_a_sealed_report(client, pool, monkeypatch):
    from app.modules.appeals import service as appeals_service
    from app.modules.notifications import list_notifications

    monkeypatch.setattr(appeals_service, "report_is_sealed", lambda target: True)
    pool(_account(3), _account(3))
    scene = HiddenPost(client)
    record = scene.appeal()

    notes = [
        note
        for did in (scene.moderator.did, scene.post_author.did)
        for note in list_notifications(did)
        if note.kind == appeals.PANEL_NOT_FORMED_KIND
        and note.payload.get("appeal_cid") == record["id"]
    ]
    assert len(notes) == 2
    for note in notes:
        assert scene.text not in note.payload["summary"]
        assert f'hidden post on "{scene.title}" yet.' in note.payload["summary"]


def test_the_draw_retries_when_a_member_becomes_available(client, pool):
    first, second = _account(3), _account(3)
    pool(first, second)
    scene = HiddenPost(client)
    record = scene.appeal()
    assert get_panel(record["id"]) == []

    third = _account(3)
    pool(first, second, third)

    assert retry_pending_panels() >= 1
    assert len(get_panel(record["id"])) == 3
    assert get_appeal(record["id"]).status == "pending"


def test_an_endorsement_reaching_the_log_retries_the_draw(client, pool):
    first, second = _account(3), _account(3)
    pool(first, second)
    scene = HiddenPost(client)
    record = scene.appeal()
    assert get_panel(record["id"]) == []

    third = _account(3)
    pool(first, second, third)
    endorser = Person()
    ledger.append(
        endorser.sign(
            "endorsement",
            {"endorsee": "did:key:z6Mkendorseedmember", "category": "cs.CR"},
        )
    )

    assert len(get_panel(record["id"])) == 3


def test_a_tier4_moderator_decides_an_unseated_appeal_after_the_deadline(client, pool):
    pool(_account(3), _account(3))
    scene = HiddenPost(client)
    record = scene.appeal()
    assert get_panel(record["id"]) == []
    decider = Moderator()

    early = client.post(
        DECIDE_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "No panel was formed."},
        headers=decider.headers,
    )
    assert early.status_code == 409, early.text

    _age(record["id"])
    response = client.post(
        DECIDE_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "No panel was formed."},
        headers=decider.headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decision"] is not None
    assert body["outcome"] == "upheld"
    assert get_appeal(record["id"]).status == "upheld"

    decision = ledger.entry_by_cid(body["decision"])
    assert decision is not None
    assert decision.body["decided_without_panel"] is True
    assert decision.body["reasons"] == ["No panel was formed."]

    detail = client.get(f"/v1/appeals/{record['id']}").json()
    assert detail["panel_status"] == "decided"
    assert detail["decided_without_panel"] is True
    assert detail["outcome"] == "upheld"


def test_a_moderator_involved_in_the_decision_may_not_take_the_fallback(client, pool):
    pool(_account(3), _account(3))
    scene = HiddenPost(client)
    record = scene.appeal()
    _age(record["id"])

    response = client.post(
        DECIDE_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "I decided the original."},
        headers=scene.moderator.headers,
    )

    assert response.status_code == 403, response.text
    assert get_appeal(record["id"]).status == PANEL_NOT_FORMED


def test_the_fallback_is_tier_4_only(client, pool):
    pool(_account(3), _account(3))
    scene = HiddenPost(client)
    record = scene.appeal()
    _age(record["id"])
    reviewer = Person()

    response = client.post(
        DECIDE_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "A reviewer cannot do this."},
        headers=_bearer(reviewer.did, 3),
    )

    assert response.status_code == 403, response.text


def test_a_seated_panel_is_decided_by_its_votes_not_by_a_moderator(client, pool):
    pool(*(_account(3) for _ in range(4)))
    scene = HiddenPost(client)
    record = scene.appeal()
    assert len(get_panel(record["id"])) == 3
    _age(record["id"])

    response = client.post(
        DECIDE_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "Skip the panel."},
        headers=Moderator().headers,
    )

    assert response.status_code == 409, response.text


def test_a_second_appeal_is_refused_with_the_day_it_was_filed(client, pool):
    import uuid

    pool(*(_account(3) for _ in range(4)))
    scene = HiddenPost(client)
    first = scene.appeal()
    second = scene.post_author.sign(
        "appeal",
        {
            "target": scene.decision_cid,
            "grounds": f"Unfair again {uuid.uuid4().hex}",
            "paper": scene.submission.paper_cid,
        },
    )

    response = client.post(APPEALS_URL, json=second, headers=_bearer(scene.post_author.did, 3))

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["type"] == appeals.APPEAL_ALREADY_FILED
    assert body["appeal"] == first["id"]
    assert body["filed_at"] == first["created"]


def test_the_daily_retry_job_is_registered(client):
    from datetime import timedelta

    from app import jobs

    assert jobs.schedule_registry.period("appeals.panels") == timedelta(days=1)
    assert "appeals.panels" in jobs.schedule_registry.kinds
