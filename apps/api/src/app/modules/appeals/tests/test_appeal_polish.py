"""Appeal polish: who the panel line is for, what an appeal names, and who may sit.

Regressions for one report ("every /mod viewer is told they are on the panel;
overturn notice shows a raw CID; post appeals never say what was hidden"):

* ``GET /v1/appeals/{cid}`` says whether the *caller* holds a seat (and their
  vote) and describes the appealed decision's target -- record type, paper
  title, post/review excerpt -- so the card can say what was decided;
* the seat notice and the attention item for an appeal against a hidden post
  name the post's paper and the date in words, not "an appeal panel" and
  ``2026-12-02``;
* the panel hearing an appeal never includes the decision's moderator, the
  record's author or a reporter whose flag the decision settled;
* the author's notice after the panel overturns a hide names what came back
  and carries no cid.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import sign_record, verify_record

from app.modules import flags
from app.modules.appeals import get_appeal, get_panel, panel as panel_module
from app.modules.appeals.service import panel_exclusions, resolve_decision
from app.modules.appeals.subject import AppealSubject, seat_summary
from app.modules.moderation.tests.test_decisions import (
    DECISIONS_URL,
    Moderator,
    Submission,
    _timestamp,
)
from app.modules.moderation.tests.test_record_decisions import RecordAuthor, _post
from app.modules.notifications import list_notifications
from app.security import issue_access_token

from .test_appeal_panels import _account, client  # noqa: F401 - fixture re-export
from .test_appeals import APPEALS_URL, node_key, subscribed  # noqa: F401 - autouse fixtures

flags.ensure_tables()

NOTIFICATIONS_URL = "/v1/me/notifications"
VOTES_URL = "/v1/appeals/{cid}/votes"
ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
CID = re.compile(r"\bbafy[a-z0-9]{10,}")


def _bearer(did: str, tier: int = 3) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


class HiddenPost:
    """A post a moderator hid, after a reporter flagged it, and its appeal."""

    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.submission = Submission(state="listed")
        self.post_author = RecordAuthor()
        self.post = _post(self.post_author, self.submission)
        self.moderator = Moderator()
        self.reporter = RecordAuthor()
        _account(3, self.reporter.did)
        _account(3, self.post_author.did)
        _account(4, self.moderator.did)

        response = client.post(
            "/v1/flags",
            json={"target": self.post["id"], "reason": "spam"},
            headers=_bearer(self.reporter.did, 1),
        )
        assert response.status_code == 201, response.text

        decision = self._decision()
        response = client.post(DECISIONS_URL, json=decision, headers=self.moderator.headers)
        assert response.status_code == 201, response.text
        self.decision_cid: str = decision["id"]

    def _decision(self) -> dict:
        record = sign_record(
            {
                "v": 1,
                "type": "moderation.decision",
                "author": self.moderator.did,
                "created": _timestamp(),
                "prev": None,
                "body": {
                    "target": self.post["id"],
                    "action": "hide",
                    "clause": "MOD-09",
                    "reason": "Abusive.",
                },
                "proofs": [],
            },
            self.moderator.seed,
        )
        assert verify_record(record)
        return record

    @property
    def text(self) -> str:
        return self.post["body"]["text"]

    @property
    def title(self) -> str:
        return self.submission.title

    def appeal(self, *, appellant=None) -> dict:
        appellant = appellant or self.post_author
        record = sign_record(
            {
                "v": 1,
                "type": "appeal",
                "author": appellant.did,
                "created": _timestamp(),
                "prev": None,
                "body": {
                    "target": self.decision_cid,
                    "grounds": f"Unfair {uuid.uuid4().hex}",
                    "paper": self.submission.paper_cid,
                },
                "proofs": [],
            },
            appellant.seed,
        )
        assert verify_record(record)
        response = self.client.post(
            APPEALS_URL, json=record, headers=_bearer(appellant.did, 3)
        )
        assert response.status_code == 201, response.text
        return record


@pytest.fixture
def pool(monkeypatch):
    """Exactly known panel candidates: ``set_pool(*dids)`` replaces the tiered accounts."""

    def set_pool(*dids: str) -> None:
        monkeypatch.setattr(panel_module, "_tiered_dids", lambda: list(dids))

    return set_pool


def _members(appeal_cid: str) -> list[str]:
    return [str(seat.member_did) for seat in get_panel(appeal_cid)]


def _seat_pool(*extra_tier_dids: str) -> list[str]:
    return [_account(3) for _ in range(4)] + list(extra_tier_dids)


# --------------------------------------------------------------------------- #
# Who sits
# --------------------------------------------------------------------------- #


def test_the_exclusions_include_the_record_author_and_the_reporters_the_decision_settled(
    client, pool
):
    scene = HiddenPost(client)
    paper_author = scene.submission.did
    record = scene.appeal(appellant=scene.post_author)

    excluded = panel_exclusions(
        get_appeal(record["id"]), resolve_decision(scene.decision_cid)
    )

    assert scene.moderator.did in excluded
    assert scene.post_author.did in excluded
    assert scene.reporter.did in excluded
    assert paper_author in excluded


def test_a_reporter_whose_flag_the_decision_settled_is_never_drawn(client, pool):
    scene = HiddenPost(client)
    members = _seat_pool()[:2]
    # The reporter would be the third of exactly three candidates.
    pool(*members, scene.reporter.did)

    record = scene.appeal()

    assert scene.reporter.did not in _members(record["id"])


def test_the_author_of_a_hidden_record_is_never_drawn_when_a_paper_author_appeals(
    client, pool
):
    scene = HiddenPost(client)
    members = _seat_pool()[:2]
    pool(*members, scene.post_author.did)

    # A paper author speaks for the paper; the post's author is excluded all the same.
    record = scene.appeal(appellant=_PaperAuthor(scene.submission))

    assert scene.post_author.did not in _members(record["id"])


class _PaperAuthor:
    def __init__(self, submission: Submission) -> None:
        self.did = submission.did
        self.seed = submission.seed


# --------------------------------------------------------------------------- #
# GET /v1/appeals/{cid}: the viewer and the subject
# --------------------------------------------------------------------------- #


def _detail(client, appeal_cid: str, did: str | None, tier: int = 3) -> dict:
    headers = _bearer(did, tier) if did else {}
    response = client.get(f"/v1/appeals/{appeal_cid}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_detail_says_the_viewer_is_on_the_panel_only_for_a_seated_member(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()
    assert sorted(_members(record["id"])) == sorted(seated)

    assert _detail(client, record["id"], seated[0])["viewer_on_panel"] is True
    # The moderator who made the decision reads the same appeal and is not on it.
    assert _detail(client, record["id"], scene.moderator.did, 4)["viewer_on_panel"] is False
    assert _detail(client, record["id"], None)["viewer_on_panel"] is False


def test_the_detail_gives_the_viewers_own_vote_and_when_they_cast_it(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    before = _detail(client, record["id"], seated[0])
    assert before["viewer_vote"] is None
    assert before["viewer_voted_at"] is None
    vote = client.post(
        VOTES_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "Sound."},
        headers=_bearer(seated[0]),
    )
    assert vote.status_code == 200, vote.text

    after = _detail(client, record["id"], seated[0])
    assert after["viewer_vote"] == "upheld"
    assert after["viewer_voted_at"] is not None
    voted_at = datetime.fromisoformat(after["viewer_voted_at"].replace("Z", "+00:00"))
    assert voted_at.tzinfo is not None
    assert abs(datetime.now(timezone.utc) - voted_at) < timedelta(minutes=1)
    # The tally is the panel's, not the public's: the viewer sees one of three.
    assert after["votes_cast"] == 1
    other = _detail(client, record["id"], seated[1])
    assert other["viewer_vote"] is None
    assert other["viewer_voted_at"] is None


def test_the_detail_still_gives_the_viewers_vote_once_the_panel_decides(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    for member in seated[:2]:
        vote = client.post(
            VOTES_URL.format(cid=record["id"]),
            json={"outcome": "overturned", "reasons": "In scope."},
            headers=_bearer(member),
        )
        assert vote.status_code == 200, vote.text

    body = _detail(client, record["id"], seated[0])
    assert body["outcome"] == "overturned"
    assert body["viewer_vote"] == "overturned"
    assert body["viewer_voted_at"] is not None
    assert body["votes_cast"] == 2


def test_the_detail_gives_a_seated_member_their_own_reasons_and_no_one_else(client, pool):
    """A reloaded "Change my vote" pre-fills the reasons from this answer."""
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()
    assert sorted(_members(record["id"])) == sorted(seated)

    before = _detail(client, record["id"], seated[0])
    assert before["viewer_reasons"] is None

    vote = client.post(
        VOTES_URL.format(cid=record["id"]),
        json={"outcome": "upheld", "reasons": "The post broke MOD-09."},
        headers=_bearer(seated[0]),
    )
    assert vote.status_code == 200, vote.text

    assert _detail(client, record["id"], seated[0])["viewer_reasons"] == [
        "The post broke MOD-09."
    ]
    # Another seated member sees their own (none), never this member's.
    assert _detail(client, record["id"], seated[1])["viewer_reasons"] is None
    # Nor does a moderator outside the panel, or an anonymous reader.
    assert _detail(client, record["id"], scene.moderator.did, 4)["viewer_reasons"] is None
    assert _detail(client, record["id"], None)["viewer_reasons"] is None

    # Changing the vote replaces what "Change my vote" would pre-fill.
    changed = client.post(
        VOTES_URL.format(cid=record["id"]),
        json={"outcome": "overturned", "reasons": "The excerpt is not abusive."},
        headers=_bearer(seated[0]),
    )
    assert changed.status_code == 200, changed.text
    assert _detail(client, record["id"], seated[0])["viewer_reasons"] == [
        "The excerpt is not abusive."
    ]


def test_the_detail_describes_the_hidden_post(client, pool):
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    body = _detail(client, record["id"], scene.moderator.did, 4)

    assert body["target_cid"] == scene.post["id"]
    assert body["target_kind"] == "post"
    assert body["record_type"] == "discussion.post"
    assert body["paper_title"] == scene.title
    assert body["excerpt"] == scene.text
    assert body["target_link"].startswith("/discussion/sch:")
    assert body["decision_action"] == "hide"


# --------------------------------------------------------------------------- #
# The seat notice and the attention item name what is appealed
# --------------------------------------------------------------------------- #


def _seat_notice(did: str, appeal_cid: str):
    [row] = [
        row
        for row in list_notifications(did)
        if row.kind == "appeal.panel" and row.payload.get("appeal_cid") == appeal_cid
    ]
    return row


def test_the_seat_notice_for_a_hidden_post_names_the_post_and_writes_the_date_in_words(
    client, pool
):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    summary = _seat_notice(seated[0], record["id"]).payload["summary"]

    assert f'hidden post on "{scene.title}"' in summary
    # The excerpt tells two appeals about posts on the same paper apart.
    assert f'("{scene.text}...")' in summary
    assert summary != "Vote on an appeal panel."
    assert not ISO_DAY.search(summary)
    assert re.search(r" by \d{1,2} [A-Z][a-z]{2} \d{4}\.$", summary)


def test_two_post_appeals_on_the_same_paper_read_differently():
    """The same paper title alone made two hidden-post appeals indistinguishable."""
    deadline = datetime(2026, 12, 3, 12, 0, tzinfo=timezone.utc)
    first = AppealSubject(
        target_cid="bafy-post-one",
        kind="post",
        title="A paper under appeal",
        excerpt="The first hidden post.",
        action="hide",
    )
    second = AppealSubject(
        target_cid="bafy-post-two",
        kind="post",
        title="A paper under appeal",
        excerpt="The second hidden post.",
        action="hide",
    )

    one = seat_summary(first, deadline)
    two = seat_summary(second, deadline)

    assert one != two
    assert one == (
        'Vote on the appeal of a hidden post on "A paper under appeal" '
        '("The first hidden post...") by 3 Dec 2026.'
    )
    assert two == (
        'Vote on the appeal of a hidden post on "A paper under appeal" '
        '("The second hidden post...") by 3 Dec 2026.'
    )


def test_the_attention_item_for_a_hidden_post_names_the_post(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    response = client.get("/v1/me/dashboard", headers=_bearer(seated[0]))
    assert response.status_code == 200, response.text
    items = [
        item
        for item in response.json()["needs_attention"]["items"]
        if item.get("appeal_cid") == record["id"]
    ]
    assert items, response.json()
    summary = items[0]["summary"]
    assert f'hidden post on "{scene.title}"' in summary
    assert f'("{scene.text}...")' in summary
    assert not ISO_DAY.search(summary)
    # The sentence is for reading; the fields beside it stay machine-readable.
    assert ISO_DAY.fullmatch(items[0]["dueAt"])
    assert items[0]["deadline"].startswith(items[0]["dueAt"])


def test_a_notice_for_a_member_who_never_voted_names_the_subject(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    for did in seated[:2]:
        response = client.post(
            VOTES_URL.format(cid=record["id"]),
            json={"outcome": "overturned", "reasons": f"Reasons {uuid.uuid4().hex}"},
            headers=_bearer(did),
        )
        assert response.status_code == 200, response.text

    bystander = _seat_notice(seated[2], record["id"]).payload["summary"]
    assert bystander == f'The panel overturned the decision on "{scene.title}".'
    voter = _seat_notice(seated[0], record["id"]).payload["summary"]
    assert voter == (
        f'You voted to overturn the decision on the appeal for "{scene.title}".'
    )


# --------------------------------------------------------------------------- #
# The author's notice after an overturn
# --------------------------------------------------------------------------- #


def test_the_authors_overturn_notice_names_the_post_and_shows_no_cid(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()
    for did in seated[:2]:
        response = client.post(
            VOTES_URL.format(cid=record["id"]),
            json={"outcome": "overturned", "reasons": f"Reasons {uuid.uuid4().hex}"},
            headers=_bearer(did),
        )
        assert response.status_code == 200, response.text

    notices = [
        row
        for row in list_notifications(scene.post_author.did)
        if row.payload.get("action") == "release"
    ]
    assert len(notices) == 1
    # The dashboard reads this marker to label the notice "Appeal outcome".
    assert notices[0].payload["appeal"] == record["id"]
    payload = notices[0].payload
    assert payload["summary"] == (
        f'The appeal panel overturned the decision to hide your post on "{scene.title}"; '
        "it is visible again."
    )
    assert payload["outcome"] == payload["summary"]
    assert "moderator" not in payload["summary"].lower()
    assert not CID.search(payload["summary"])
    assert not CID.search(str(payload.get("reason") or ""))
    # The reason line would only say the sentence again.
    assert not payload.get("reason")


def test_the_signed_restoration_does_not_put_the_appeals_cid_in_its_reason(client, pool):
    from app.modules import ledger

    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()
    for did in seated[:2]:
        response = client.post(
            VOTES_URL.format(cid=record["id"]),
            json={"outcome": "overturned", "reasons": f"Reasons {uuid.uuid4().hex}"},
            headers=_bearer(did),
        )
        assert response.status_code == 200, response.text

    [release] = [
        entry.body
        for entry in ledger.entries()
        if entry.record_type == "moderation.decision"
        and isinstance(entry.body, dict)
        and entry.body.get("target") == scene.post["id"]
        and entry.body.get("action") == "release"
    ]
    assert release["appeal"] == record["id"]
    assert record["id"] not in release["reason"]
    assert not CID.search(release["reason"])


def test_a_release_a_moderator_signs_on_their_own_is_not_credited_to_a_panel(client, pool):
    """A release that answers no appeal keeps the moderation notice's own words."""
    scene = HiddenPost(client)
    release = sign_record(
        {
            "v": 1,
            "type": "moderation.decision",
            "author": scene.moderator.did,
            "created": _timestamp(),
            "prev": None,
            "body": {
                "target": scene.post["id"],
                "action": "release",
                "state": "listed",
                "clause": "MOD-09",
                "reason": "Hidden by mistake.",
            },
            "proofs": [],
        },
        scene.moderator.seed,
    )
    response = client.post(DECISIONS_URL, json=release, headers=scene.moderator.headers)
    assert response.status_code == 201, response.text

    notices = [
        row
        for row in list_notifications(scene.post_author.did)
        if row.payload.get("action") == "release"
    ]
    assert len(notices) == 1
    # No appeal answered it, so it carries no appeal marker and stays a
    # moderation outcome on the dashboard.
    assert notices[0].kind == "moderation.outcome"
    assert "appeal" not in notices[0].payload
    assert "appeal panel" not in notices[0].payload["summary"]
    assert notices[0].payload.get("reason") == "Hidden by mistake."
