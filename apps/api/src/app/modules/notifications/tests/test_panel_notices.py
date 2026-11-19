"""A panel seat's notification follows what the member did, not what was sent.

The seat notice says 'Vote on the appeal for "..." by 2026-12-02.' and links to
the vote form.  Once the member's vote is recorded (``appeal_panels.vote``) the
notice must stop asking for it: it is read, and it says what the member voted.
Once the panel has decided it says what the panel decided, so a member who never
voted is not asked to either.

The scenes reuse the appeals suites' builders (``Scene`` puts a paper, a version
in moderation and a moderator in place; ``standing`` seats tier-3/4 members).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import sign_record, verify_record

from app.modules import submissions
from app.modules.appeals import get_appeal
from app.modules.appeals import panel as panel_module
from app.modules.appeals.tests.test_appeal_panels import (  # noqa: F401 - fixture re-exports
    _account,
    _members,
    client,
    scene,
    standing,
)
from app.modules.appeals.tests.test_appeals import (  # noqa: F401 - autouse fixtures
    APPEALS_URL,
    Scene,
    _appeal,
    subscribed,
)
from app.modules.appeals.tests.test_appeal_resolution import (  # noqa: F401 - autouse fixture
    _bearer,
    node_key,
)
from app.modules.moderation.tests.test_decisions import Moderator, Submission, _timestamp
from app.modules.moderation.tests.test_record_decisions import RecordAuthor, _post
from app.modules.notifications import list_notifications

NOTIFICATIONS_URL = "/v1/me/notifications"
VOTES_URL = "/v1/appeals/{cid}/votes"
DECISIONS_URL = "/v1/moderation/decisions"


def _file(client: TestClient, scene: Scene) -> dict:
    record = _appeal(scene.author, scene.decide("hold"))
    response = client.post(APPEALS_URL, json=record, headers=scene.author.headers)
    assert response.status_code == 201, response.text
    return record


def _vote(client: TestClient, did: str, appeal_cid: str, outcome: str):
    return client.post(
        VOTES_URL.format(cid=appeal_cid),
        json={"outcome": outcome, "reasons": f"Reasons {uuid.uuid4().hex}"},
        headers=_bearer(did),
    )


@pytest.fixture
def pool(monkeypatch):
    """Pin the panel candidates to exactly the DIDs a test names."""

    def pin(*dids: str) -> None:
        monkeypatch.setattr(panel_module, "_tiered_dids", lambda: list(dids))

    return pin


class TwoHiddenPosts:
    """Two posts on one paper, each hidden and appealed: two appeals on one paper.

    Both appeals draw the same three members (the pool is exactly a panel), so
    one member's two seat notices can be read side by side.
    """

    def __init__(self, client: TestClient, pool) -> None:
        self.pool = [_account(3) for _ in range(3)]
        pool(*self.pool)
        self.paper = Submission(state="listed")
        self.moderator = Moderator()
        self.author = RecordAuthor()
        _account(3, self.author.did)
        self.posts = [_post(self.author, self.paper), _post(self.author, self.paper)]
        self.appeals: list[str] = []
        for post in self.posts:
            decision = self._hide(client, post)
            record = _appeal(self.author, decision)
            response = client.post(APPEALS_URL, json=record, headers=_bearer(self.author.did))
            assert response.status_code == 201, response.text
            self.appeals.append(record["id"])

    def _hide(self, client: TestClient, post: dict) -> str:
        record = sign_record(
            {
                "v": 1,
                "type": "moderation.decision",
                "author": self.moderator.did,
                "created": _timestamp(),
                "prev": None,
                "body": {
                    "target": post["id"],
                    "action": "hide",
                    "clause": "MOD-09",
                    "reason": "Abusive.",
                },
                "proofs": [],
            },
            self.moderator.seed,
        )
        assert verify_record(record)
        response = client.post(DECISIONS_URL, json=record, headers=self.moderator.headers)
        assert response.status_code == 201, response.text
        return record["id"]

    @property
    def title(self) -> str:
        return self.paper.title

    def excerpt(self, index: int) -> str:
        return self.posts[index]["body"]["text"]


def _seat_notice(client: TestClient, did: str, appeal_cid: str) -> dict:
    response = client.get(NOTIFICATIONS_URL, headers=_bearer(did))
    assert response.status_code == 200, response.text
    [row] = [
        row
        for row in response.json()
        if row["kind"] == "appeal.panel" and row["payload"].get("appeal_cid") == appeal_cid
    ]
    return row


def test_a_seat_notice_still_asks_for_the_vote_until_the_member_votes(client, scene, standing):
    record = _file(client, scene)
    member = _members(record["id"])[0]

    row = _seat_notice(client, member, record["id"])

    assert row["read"] is False
    assert row["payload"]["summary"].startswith("Vote on the appeal for")


def test_voting_resolves_the_seat_notice_to_what_the_member_voted(client, scene, standing):
    record = _file(client, scene)
    member = _members(record["id"])[0]
    title = submissions.get_version(scene.version_cid).title

    assert _vote(client, member, record["id"], "upheld").status_code == 200

    row = _seat_notice(client, member, record["id"])
    assert row["read"] is True
    assert row["payload"]["summary"] == f'You voted to uphold the decision on the appeal for "{title}".'
    assert row["payload"]["outcome"] == row["payload"]["summary"]
    assert "Vote on" not in row["payload"]["summary"]
    assert row["payload"]["answer"] == "upheld"


def test_a_changed_vote_is_what_the_notice_says(client, scene, standing):
    record = _file(client, scene)
    member = _members(record["id"])[0]
    title = submissions.get_version(scene.version_cid).title

    assert _vote(client, member, record["id"], "upheld").status_code == 200
    assert _vote(client, member, record["id"], "overturned").status_code == 200

    row = _seat_notice(client, member, record["id"])
    assert row["payload"]["summary"] == f'You voted to overturn the decision on the appeal for "{title}".'


def test_a_vote_leaves_the_other_seats_notices_asking(client, scene, standing):
    record = _file(client, scene)
    voter, other, _third = _members(record["id"])

    assert _vote(client, voter, record["id"], "upheld").status_code == 200

    row = _seat_notice(client, other, record["id"])
    assert row["read"] is False
    assert row["payload"]["summary"].startswith("Vote on the appeal for")


def test_a_member_who_never_voted_is_told_what_the_panel_decided(client, scene, standing):
    record = _file(client, scene)
    first, second, bystander = _members(record["id"])

    assert _vote(client, first, record["id"], "overturned").status_code == 200
    response = _vote(client, second, record["id"], "overturned")
    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "overturned"
    assert get_appeal(record["id"]).status == "overturned"

    title = submissions.get_version(scene.version_cid).title
    unvoted = _seat_notice(client, bystander, record["id"])
    assert unvoted["payload"]["summary"] == f'The panel overturned the decision on "{title}".'
    assert "Vote on" not in unvoted["payload"]["outcome"]
    assert unvoted["payload"].get("answer") is None

    # The members who voted keep their own record of it.
    voted = _seat_notice(client, first, record["id"])
    assert voted["read"] is True
    assert voted["payload"]["summary"] == f'You voted to overturn the decision on the appeal for "{title}".'


def test_listing_in_the_service_settles_the_notice_too(client, scene, standing):
    """Not only the HTTP route: every reader of the inbox sees the settled notice."""
    record = _file(client, scene)
    member = _members(record["id"])[0]

    assert _vote(client, member, record["id"], "upheld").status_code == 200

    [row] = [
        row
        for row in list_notifications(member)
        if row.kind == "appeal.panel" and row.payload.get("appeal_cid") == record["id"]
    ]
    assert row.read is True
    assert row.payload["summary"].startswith("You voted to uphold the decision on the appeal for")


# --------------------------------------------------------------------------- #
# Two appeals on one paper: the excerpt tells them apart
# --------------------------------------------------------------------------- #


def test_two_appeals_on_one_paper_are_told_apart_once_voted(client, pool):
    scene = TwoHiddenPosts(client, pool)
    member = _members(scene.appeals[0])[0]
    assert set(_members(scene.appeals[0])) == set(_members(scene.appeals[1])) == set(scene.pool)

    for appeal_cid in scene.appeals:
        assert _vote(client, member, appeal_cid, "upheld").status_code == 200

    summaries = [
        _seat_notice(client, member, appeal_cid)["payload"]["summary"]
        for appeal_cid in scene.appeals
    ]
    assert summaries == [
        f'You voted to uphold the decision on the appeal for "{scene.title}" ("{scene.excerpt(0)}...").',
        f'You voted to uphold the decision on the appeal for "{scene.title}" ("{scene.excerpt(1)}...").',
    ]
    assert summaries[0] != summaries[1]


def test_two_appeals_on_one_paper_are_told_apart_once_decided(client, pool):
    scene = TwoHiddenPosts(client, pool)

    summaries = []
    for appeal_cid in scene.appeals:
        seats = _members(appeal_cid)
        assert set(seats) == set(scene.pool)
        for member in seats[:2]:
            assert _vote(client, member, appeal_cid, "upheld").status_code == 200
        summaries.append(_seat_notice(client, seats[2], appeal_cid)["payload"]["summary"])

    assert summaries == [
        f'The panel upheld the decision on "{scene.title}" ("{scene.excerpt(0)}...").',
        f'The panel upheld the decision on "{scene.title}" ("{scene.excerpt(1)}...").',
    ]
    assert summaries[0] != summaries[1]
