"""The appellant is told how their appeal was decided (follow-up to ca0963b).

ca0963b made the appeals module send the appellant an ``appeal.decision``
notice when a panel (or a tier-4 moderator, without one) decides an appeal
*without* restoring the target.  It shipped with no test, and
``_notify_appellant`` swallows every exception, so a wrong lookup -- the
appellant, the subject, the title -- would leave the appellant uninformed with
nothing failing.

Every scene here is driven through the HTTP surface the web uses: the appeal is
filed with ``POST /v1/appeals``, the panel votes with
``POST /v1/appeals/{cid}/votes`` (or a tier-4 moderator decides with
``POST /v1/appeals/{cid}/decide``), and what the appellant was told is read back
from ``GET /v1/me/notifications``.

An overturn is not announced here: the restoration path already tells the
appellant, so it must be one notice, not two.  Each test therefore counts the
notices *the deciding vote added*, not the ones the original decision left.
"""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta

import pytest

from app import db
from app.modules import ledger, submissions
from app.modules.appeals import Appeal, get_appeal, get_panel
from app.modules.appeals import panel as panel_module
from app.modules.appeals import votes
from app.modules.moderation.tests.test_decisions import Moderator

from .test_appeal_panels import _account, client  # noqa: F401 - fixture re-export
from .test_appeal_polish import HiddenPost, _bearer
from .test_appeals import (  # noqa: F401 - autouse fixtures
    APPEALS_URL,
    Scene,
    _appeal,
    node_key,
    subscribed,
)

NOTIFICATIONS_URL = "/v1/me/notifications"
VOTES_URL = "/v1/appeals/{cid}/votes"
DECIDE_URL = "/v1/appeals/{cid}/decide"
KIND = "appeal.decision"


@pytest.fixture
def pool(monkeypatch):
    """Pin the panel candidates to exactly the DIDs a test names."""

    def pin(*dids: str) -> None:
        monkeypatch.setattr(panel_module, "_tiered_dids", lambda: list(dids))

    return pin


# --------------------------------------------------------------------------- #
# Scenes
# --------------------------------------------------------------------------- #


class HeldPaper:
    """A paper whose only version a moderator held, and its appeal."""

    def __init__(self, client, pool) -> None:
        self.client = client
        self.scene = Scene(client, coauthors=1)
        self.moderator = self.scene.moderator
        self.appellant = self.scene.author
        pool(*(_account(3) for _ in range(4)))
        record = _appeal(self.appellant, self.scene.decide("hold"))
        response = client.post(APPEALS_URL, json=record, headers=self.appellant.headers)
        assert response.status_code == 201, response.text
        self.appeal_cid: str = record["id"]
        self.title: str = submissions.get_version(self.scene.version_cid).title

    @property
    def appellant_did(self) -> str:
        return self.appellant.did

    @property
    def target_cid(self) -> str:
        return self.scene.version_cid


class HiddenPostAppeal:
    """A post a moderator hid, and its author's appeal."""

    def __init__(self, client, pool) -> None:
        self.client = client
        pool(*(_account(3) for _ in range(4)))
        self.scene = HiddenPost(client)
        self.moderator = self.scene.moderator
        self.appeal_cid: str = self.scene.appeal()["id"]
        self.title = self.scene.title

    @property
    def appellant_did(self) -> str:
        return self.scene.post_author.did

    @property
    def target_cid(self) -> str:
        return self.scene.post["id"]


def _notifications(client, did: str) -> list[dict]:
    response = client.get(NOTIFICATIONS_URL, headers=_bearer(did))
    assert response.status_code == 200, response.text
    return response.json()


def _vote(client, did: str, appeal_cid: str, outcome: str):
    return client.post(
        VOTES_URL.format(cid=appeal_cid),
        json={"outcome": outcome, "reasons": f"Reasons {uuid.uuid4().hex}"},
        headers=_bearer(did),
    )


def _panel(appeal_cid: str) -> list[str]:
    return [str(seat.member_did) for seat in get_panel(appeal_cid)]


def _decide_by_panel(client, scene, outcome: str) -> list[dict]:
    """Two of the three panelists vote ``outcome``; return what that added for the appellant."""
    members = _panel(scene.appeal_cid)
    assert len(members) == 3
    assert _vote(client, members[0], scene.appeal_cid, outcome).status_code == 200
    # The first vote decides nothing, so it tells the appellant nothing.
    before = _notifications(client, scene.appellant_did)
    assert not [row for row in before if row["kind"] == KIND]
    decided = _vote(client, members[1], scene.appeal_cid, outcome)
    assert decided.status_code == 200, decided.text
    assert decided.json()["outcome"] == outcome
    seen = {row["id"] for row in before}
    return [row for row in _notifications(client, scene.appellant_did) if row["id"] not in seen]


def _age(appeal_cid: str, days: int = 15) -> None:
    """Move the appeal's filed date back far enough for its deadline to pass."""
    with db.SessionLocal() as session:
        row = session.get(Appeal, appeal_cid)
        assert row is not None
        row.filed_at = row.filed_at - timedelta(days=days)
        session.commit()


def _appeal_notices(rows: list[dict]) -> list[dict]:
    return [row for row in rows if row["kind"] == KIND]


# --------------------------------------------------------------------------- #
# (a) A paper hold the panel upholds
# --------------------------------------------------------------------------- #


def test_upholding_a_paper_hold_tells_the_appellant_once_naming_the_paper(client, pool):
    scene = HeldPaper(client, pool)

    added = _decide_by_panel(client, scene, "upheld")

    assert [row["kind"] for row in added] == [KIND], added
    payload = added[0]["payload"]
    assert payload["summary"] == f'The appeal panel upheld the decision to hold "{scene.title}".'
    assert payload["outcome"] == payload["summary"]
    assert payload["title"] == scene.title
    assert payload["target_cid"] == scene.target_cid
    assert payload["target_kind"] == "paper"
    assert payload["appeal_cid"] == scene.appeal_cid
    assert payload["decided_without_panel"] is False
    # It links to the paper, not to a console the appellant cannot open.
    assert payload["link"].startswith("/p/sch:"), payload["link"]
    # The decision it reports is the one on the public log.
    decision = ledger.entry_by_cid(payload["decision_cid"])
    assert decision is not None and decision.record_type == "appeal.decision"
    assert decision.body["outcome"] == "upheld"
    assert decision.body["appeal"] == scene.appeal_cid


def test_no_panel_member_receives_the_appellants_notice(client, pool):
    scene = HeldPaper(client, pool)

    _decide_by_panel(client, scene, "upheld")

    for did in _panel(scene.appeal_cid):
        assert not _appeal_notices(_notifications(client, did)), did
    # Nor does the moderator whose decision was upheld.
    assert not _appeal_notices(_notifications(client, scene.moderator.did))


def test_a_vote_after_the_decision_does_not_tell_the_appellant_again(client, pool):
    scene = HeldPaper(client, pool)
    _decide_by_panel(client, scene, "upheld")

    third = _panel(scene.appeal_cid)[2]
    assert _vote(client, third, scene.appeal_cid, "upheld").status_code == 200

    assert len(_appeal_notices(_notifications(client, scene.appellant_did))) == 1


# --------------------------------------------------------------------------- #
# (b) A paper hold the panel overturns
# --------------------------------------------------------------------------- #


def test_overturning_a_paper_hold_tells_the_appellant_once_through_the_restoration(client, pool):
    scene = HeldPaper(client, pool)

    added = _decide_by_panel(client, scene, "overturned")

    assert len(added) == 1, added
    assert added[0]["kind"] != KIND, "the restoration notice must not be announced a second time"
    assert not _appeal_notices(_notifications(client, scene.appellant_did))
    assert added[0]["payload"]["action"] == "release"
    assert added[0]["payload"]["decision_cid"]


# --------------------------------------------------------------------------- #
# (c) A hidden post the panel upholds
# --------------------------------------------------------------------------- #


def test_upholding_a_hidden_post_tells_the_appellant_once_naming_the_posts_paper(client, pool):
    scene = HiddenPostAppeal(client, pool)

    added = _decide_by_panel(client, scene, "upheld")

    assert [row["kind"] for row in added] == [KIND], added
    payload = added[0]["payload"]
    assert payload["summary"] == f'The appeal panel upheld the decision to hide your post on "{scene.title}".'
    assert payload["title"] == scene.title
    assert payload["target_cid"] == scene.target_cid
    assert payload["target_kind"] == "post"
    assert payload["appeal_cid"] == scene.appeal_cid
    # The post is hidden, so the link is where its thread is, which the web serves.
    assert payload["link"].startswith("/discussion/sch:"), payload["link"]
    for did in _panel(scene.appeal_cid):
        assert not _appeal_notices(_notifications(client, did)), did


# --------------------------------------------------------------------------- #
# (d) A hidden post the panel overturns
# --------------------------------------------------------------------------- #


def test_overturning_a_hidden_post_tells_the_appellant_once_through_the_restoration(client, pool):
    scene = HiddenPostAppeal(client, pool)

    added = _decide_by_panel(client, scene, "overturned")

    assert len(added) == 1, added
    assert added[0]["kind"] != KIND, "the restoration notice must not be announced a second time"
    payload = added[0]["payload"]
    assert payload["action"] == "release"
    assert payload["summary"] == (
        f'The appeal panel overturned the decision to hide your post on "{scene.title}"; it is visible again.'
    )
    assert not _appeal_notices(_notifications(client, scene.appellant_did))


# --------------------------------------------------------------------------- #
# (e) Decided without a panel
# --------------------------------------------------------------------------- #


def _without_panel(client, pool, outcome: str):
    """A hidden-post appeal that drew no panel, decided by a tier-4 moderator after the deadline."""
    pool(_account(3), _account(3))
    scene = HiddenPost(client)
    appeal_cid = scene.appeal()["id"]
    assert get_panel(appeal_cid) == []
    _age(appeal_cid)
    decider = Moderator()
    before = {row["id"] for row in _notifications(client, scene.post_author.did)}
    response = client.post(
        DECIDE_URL.format(cid=appeal_cid),
        json={"outcome": outcome, "reasons": "No panel was formed."},
        headers=decider.headers,
    )
    assert response.status_code == 200, response.text
    added = [row for row in _notifications(client, scene.post_author.did) if row["id"] not in before]
    return scene, appeal_cid, decider, added


def test_a_decision_without_a_panel_tells_the_appellant_so(client, pool):
    scene, appeal_cid, decider, added = _without_panel(client, pool, "upheld")

    assert [row["kind"] for row in added] == [KIND], added
    payload = added[0]["payload"]
    assert payload["summary"] == (
        f'Decided without a panel: upheld the decision to hide your post on "{scene.title}".'
    )
    assert payload["decided_without_panel"] is True
    assert payload["appeal_cid"] == appeal_cid
    # The moderator who took the fallback is not the appellant and hears nothing of it.
    assert not _appeal_notices(_notifications(client, decider.did))
    assert not _appeal_notices(_notifications(client, scene.moderator.did))


def test_overturning_without_a_panel_is_told_once_through_the_restoration(client, pool):
    scene, _appeal_cid, _decider, added = _without_panel(client, pool, "overturned")

    assert len(added) == 1, added
    assert added[0]["kind"] != KIND
    assert added[0]["payload"]["action"] == "release"


# --------------------------------------------------------------------------- #
# The notice never costs the appeal its decision, and never fails silently
# --------------------------------------------------------------------------- #


def test_a_subject_lookup_that_raises_is_logged_and_the_decision_stands(client, pool, monkeypatch, caplog):
    scene = HeldPaper(client, pool)

    def broken(*_args, **_kwargs):
        raise RuntimeError("the subject lookup is broken")

    monkeypatch.setattr(votes, "describe_subject", broken)
    members = _panel(scene.appeal_cid)
    assert _vote(client, members[0], scene.appeal_cid, "upheld").status_code == 200
    with caplog.at_level(logging.ERROR, logger=votes.logger.name):
        decided = _vote(client, members[1], scene.appeal_cid, "upheld")

    # The vote succeeds and the decision is public, recorded and counted ...
    assert decided.status_code == 200, decided.text
    body = decided.json()
    assert body["outcome"] == "upheld"
    assert body["decision"] is not None
    assert ledger.entry_by_cid(body["decision"]) is not None
    assert get_appeal(scene.appeal_cid).status == "upheld"
    # ... the failure is on the record, with the appeal it was about ...
    failures = [
        record
        for record in caplog.records
        if record.name == votes.logger.name and record.levelno >= logging.ERROR
    ]
    assert len(failures) == 1, [record.getMessage() for record in caplog.records]
    assert scene.appeal_cid in failures[0].getMessage()
    assert failures[0].exc_info is not None
    assert "the subject lookup is broken" in str(failures[0].exc_info[1])
    # ... and nobody was told something half-true in its place.
    assert not _appeal_notices(_notifications(client, scene.appellant_did))


def test_a_notification_that_cannot_be_stored_is_logged_and_the_decision_stands(
    client, pool, monkeypatch, caplog
):
    from app.modules.notifications import service as notifications

    scene = HeldPaper(client, pool)

    def refuse(*_args, **_kwargs):
        raise RuntimeError("the inbox is unavailable")

    monkeypatch.setattr(notifications, "notify", refuse)
    members = _panel(scene.appeal_cid)
    assert _vote(client, members[0], scene.appeal_cid, "upheld").status_code == 200
    with caplog.at_level(logging.ERROR, logger=votes.logger.name):
        decided = _vote(client, members[1], scene.appeal_cid, "upheld")

    assert decided.status_code == 200, decided.text
    assert get_appeal(scene.appeal_cid).status == "upheld"
    assert any(
        scene.appeal_cid in record.getMessage() and record.levelno >= logging.ERROR for record in caplog.records
    )
