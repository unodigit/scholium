"""Acceptance tests for: API exposes ``POST /v1/appeals/{cid}/votes`` for panel
members; once 2 of 3 agree the system creates a node-signed ``appeal.decision``
with outcome and reasons (appeals plugin, feature 76).

Criteria (app_spec.xml, feature 76):

* Two matching panel votes on ``POST /v1/appeals/{cid}/votes`` produce an
  ``appeal.decision`` record retrievable from ``GET /v1/records/{cid}``.
* A vote from a non-panel member returns ``403``.

The feature description adds that the decision is *node-signed*, carries an
*outcome and reasons*, and is made *once 2 of 3 agree*.  Those parts are tested
too, each in its own test, since they say what the decision is and when it is
made.

The request
-----------

``{cid}`` is the cid of the ``appeal`` record, the ``id`` that ``POST
/v1/appeals`` answers with.  The voter is the caller: a panel member
authenticates with their access token, so who is voting is the token's DID, not
anything the body says::

    POST /v1/appeals/{appeal cid}/votes
    Authorization: Bearer <the panel member's access token>

    {"vote": "overturned", "reasons": "The paper is in scope of MOD-01."}

A vote is the outcome the member backs, in the vocabulary the ``appeal.decision``
schema already fixes for outcomes (``"upheld"``, ``"overturned"``), plus the
member's reasons.  The spec does not name the body's fields, so each vote is sent
under *both* names the repository uses for the same thing -- ``vote`` (the
``appeal_panels`` column) and ``outcome`` (the ``appeal.decision`` field), and
``reasons`` and ``reason`` (the two spellings the ``appeal.decision`` schema
accepts) -- so the tests do not depend on which of them an implementation reads.

When two of the three seated members have cast the same vote the node appends an
``appeal.decision`` to the public log: its ``target`` is the appeal's cid, its
``outcome`` is the outcome the two agreed on, it has reasons, and its author --
and so its signer -- is the node's own ``did:key``.

What is *not* pinned: the status code a counted vote is answered with (any
``2xx``), the shape of the response body, what happens to a member's second vote,
or to a vote cast after the decision.  The decision's cid is not read from the
response: the tests find the ``appeal.decision`` that targets the appeal in the
public log (``GET /v1/sync/range``) and then read it back through ``GET
/v1/records/{cid}``, as any reader would.  ``GET /v1/records/{cid}`` does not
serve ``sig`` (the ledger keeps no signature), so "node-signed" is observed as
the record's author being the node's DID.

How the scene is set up
-----------------------

Everything that comes before the vote goes through code that already exists:

* the paper, a version in state ``moderation`` and their records -- put in place
  the way the sibling suites do it (signed ``paper.genesis``, ``manifest`` and
  ``paper.version`` appended to the log, the paper and version indexed through the
  submissions plugin's exported ``save_paper`` / ``save_version``);
* a moderator (tier 4) who posts a signed ``moderation.decision`` to ``POST
  /v1/moderation/decisions``;
* six more tier-3/4 members, so the pool a panel is drawn from is larger than a
  panel and some members are *not* seated;
* the paper's author (also tier 3, so only the rule that authors never sit keeps
  them off the panel) who files the appeal with ``POST /v1/appeals``.

Filing the appeal seats its panel (feature 75).  Who sits is read with the
appeals plugin's exported ``get_panel`` -- the draw is seeded from the appeal's
cid, so a test cannot choose its panel, only find out who is on it.  Every person
a test creates is kept in a registry, so whoever is seated -- including a member
that an earlier test's scene left in the pool -- can vote with their own token.

Every test builds its own scene with freshly generated keys, so tests never
depend on one another's rows, and none compares a whole response object, since
later features may add fields.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    did_key_from_signing_key,
    sign_record,
    validate_body,
    verify_record,
)

from app import db
from app.modules import ledger
from app.modules.appeals import get_panel
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

#: The endpoint under test, for one appeal.
VOTES_URL = "/v1/appeals/{cid}/votes"

#: Endpoints the scene is put together through, and the ones the criteria are
#: observed through.
APPEALS_URL = "/v1/appeals"
DECISIONS_URL = "/v1/moderation/decisions"
POLICIES_URL = "/v1/moderation/policies"
RECORDS_URL = "/v1/records"
SYNC_HEAD_URL = "/v1/sync/head"
SYNC_RANGE_URL = "/v1/sync/range"

#: The record type the panel's decision has.
APPEAL_DECISION_TYPE = "appeal.decision"

#: Outcomes a panel member can back, as the ``appeal.decision`` schema names them.
UPHELD = "upheld"
OVERTURNED = "overturned"

#: Seats on a panel.
PANEL_SIZE = 3

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _now() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _timestamp() -> str:
    """Now as the ``created`` field of a record envelope."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _vote_body(outcome: str, reasons: str) -> dict[str, str]:
    """A vote, under every name the repository uses for its two parts."""
    return {"vote": outcome, "outcome": outcome, "reasons": reasons, "reason": reasons}


def _assert_accepted(response, who: str) -> None:
    """The vote was counted: any 2xx, whatever the implementation answers with."""
    assert 200 <= response.status_code < 300, (
        f"{who}'s vote was not accepted: {response.status_code} {response.text}"
    )


# --------------------------------------------------------------------------- #
# People
# --------------------------------------------------------------------------- #

#: Everyone any test has created, by DID.  Accounts at tier 3 and 4 stay in the
#: database for the life of the process and so stay eligible for later panels;
#: when one of them is seated the test needs their key to cast their vote.
_PEOPLE: dict[str, "Person"] = {}


class Person:
    """A DID with its signing key, its trust tier and, optionally, an account."""

    def __init__(self, tier: int = 2, *, account: bool = False) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.tier = tier

        if account:
            ensure_account_table()
            with db.SessionLocal() as session:
                session.add(Account(did=self.did, tier=tier, created_at=_now() - timedelta(days=400)))
                session.commit()
        _PEOPLE[self.did] = self

    @property
    def headers(self) -> dict[str, str]:
        """The person's credentials: an access token at their trust tier."""
        return {"Authorization": f"Bearer {issue_access_token(self.did, self.tier)}"}

    def sign(self, record_type: str, body: dict, *, prev: Optional[str] = None) -> dict:
        """A complete signed record; the fixture fails if it is not valid."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": _timestamp(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        assert verify_record(record)
        return record


# --------------------------------------------------------------------------- #
# The scene: an appealed moderation decision with a seated panel
# --------------------------------------------------------------------------- #


class Scene:
    """A paper whose moderation decision has been appealed, and the panel that hears it."""

    def __init__(self, client) -> None:
        self.client = client

        #: The paper's only author, and the appellant.  Tier 3, so that nothing
        #: but the rule that authors never sit keeps them off the panel.
        self.author = Person(3, account=True)
        #: The deciding moderator.  Tier 4, for the same reason.
        self.moderator = Person(4, account=True)
        #: Members who may be drawn: more of them than there are seats.
        self.members = [Person(3 if i % 2 == 0 else 4, account=True) for i in range(2 * PANEL_SIZE)]

        self.version_cid = self._put_paper()
        self.decision_cid = self._moderate()
        self.appeal_cid = self._appeal()

        seated = [str(row.member_did) for row in get_panel(self.appeal_cid)]
        assert len(seated) == PANEL_SIZE, (
            f"filing the appeal should have seated a {PANEL_SIZE}-member panel, got {seated}"
        )
        unknown = [did for did in seated if did not in _PEOPLE]
        assert not unknown, f"panel members this suite did not create: {unknown}"
        #: The three seated members, in seat order.
        self.panel = [_PEOPLE[did] for did in seated]

        #: The log's head once the scene stands: everything after it is the votes' doing.
        self.since = self._head_seq()

    # -- building the scene ------------------------------------------------- #

    def _put_paper(self) -> str:
        """Append and index a paper with one version waiting in moderation."""
        tag = uuid.uuid4().hex
        title = f"Appeal vote acceptance paper {tag}"
        abstract = "A paper whose moderation decision is appealed."
        manuscript = f"%PDF-1.7 appeal vote acceptance {tag}".encode()

        genesis = self.author.sign(
            "paper.genesis",
            {
                "seed": tag,
                "title": title,
                "abstract": abstract,
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": [self.author.did],
            },
        )
        manifest = self.author.sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": compute_file_id(manuscript),
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = self.author.sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": title,
                "abstract": abstract,
                "authors": [{"did": self.author.did, "position": 1, "creditRoles": ["Conceptualization"]}],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        save_paper(paper_cid=genesis["id"], categories=(CATEGORY,))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=title,
            abstract=abstract,
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=(VersionAuthor(self.author.did, 1, ("Conceptualization",)),),
            state="moderation",
        )
        return version["id"]

    def _moderate(self) -> str:
        """The moderator holds the version; return the decision's cid."""
        policies = self.client.get(POLICIES_URL)
        assert policies.status_code == 200, policies.text
        clause = policies.json()[0]["id"]

        decision = self.moderator.sign(
            "moderation.decision",
            {
                "target": self.version_cid,
                "action": "hold",
                "clause": clause,
                "reason": f"Decision {uuid.uuid4().hex}",
            },
        )
        response = self.client.post(DECISIONS_URL, json=decision, headers=self.moderator.headers)
        assert response.status_code == 201, f"the scene's moderation decision: {response.text}"
        return decision["id"]

    def _appeal(self) -> str:
        """The author appeals the decision; return the appeal's cid."""
        appeal = self.author.sign(
            "appeal",
            {"target": self.decision_cid, "grounds": f"Grounds {uuid.uuid4().hex}"},
        )
        response = self.client.post(APPEALS_URL, json=appeal, headers=self.author.headers)
        assert response.status_code == 201, f"the scene's appeal: {response.text}"
        return appeal["id"]

    # -- the log ------------------------------------------------------------ #

    def _head_seq(self) -> int:
        head = self.client.get(SYNC_HEAD_URL)
        assert head.status_code == 200, head.text
        return int(head.json()["seq"])

    def decisions(self) -> list[dict[str, Any]]:
        """The log entries since the scene stood that are decisions on this appeal."""
        response = self.client.get(SYNC_RANGE_URL, params={"from": self.since})
        assert response.status_code == 200, response.text
        return [
            entry
            for entry in response.json()
            if entry["record_type"] == APPEAL_DECISION_TYPE
            and entry["body"].get("target") == self.appeal_cid
        ]

    def decision_record(self) -> dict[str, Any]:
        """The one ``appeal.decision`` on this appeal, read back as a reader would."""
        entries = self.decisions()
        assert len(entries) == 1, (
            f"expected one {APPEAL_DECISION_TYPE} targeting the appeal, found {len(entries)}"
        )
        cid = entries[0]["record_cid"]
        read = self.client.get(f"{RECORDS_URL}/{cid}")  # anonymous: no Authorization header
        assert read.status_code == 200, f"GET {RECORDS_URL}/{cid} -> {read.status_code}: {read.text}"
        record = read.json()
        assert record["id"] == cid
        return record

    # -- voting ------------------------------------------------------------- #

    def vote(self, voter: Person, outcome: str, reasons: Optional[str] = None):
        """``POST /v1/appeals/{cid}/votes`` as ``voter``."""
        return self.client.post(
            VOTES_URL.format(cid=self.appeal_cid),
            json=_vote_body(outcome, reasons or f"Reasons {uuid.uuid4().hex}"),
            headers=voter.headers,
        )

    def cast(self, voter: Person, outcome: str, reasons: Optional[str] = None) -> None:
        """A seated member votes, and the vote is accepted."""
        _assert_accepted(self.vote(voter, outcome, reasons), f"panel member {voter.did}")

    def outsider(self, kind: str) -> Person:
        """Someone who is signed in but holds no seat on this panel."""
        seated = {person.did for person in self.panel}
        if kind == "tier_3_or_4_member_not_drawn":
            # Eligible in every way -- tier, not the moderator, not an author --
            # and simply not one of the three the draw seated.
            return next(member for member in self.members if member.did not in seated)
        if kind == "appellant":
            return self.author
        if kind == "deciding_moderator":
            return self.moderator
        if kind == "tier_2_member":
            return Person(2)
        raise AssertionError(f"unknown kind of outsider: {kind}")


@pytest.fixture
def scene(client) -> Scene:
    return Scene(client)


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_two_matching_panel_votes_produce_an_appeal_decision_retrievable_by_cid(client, scene):
    """Two of the three seated members vote alike; the decision can then be read by its cid."""
    first, second, _third = scene.panel

    # The appeal is open: nobody has decided it yet.
    assert scene.decisions() == []

    scene.cast(first, UPHELD)
    scene.cast(second, UPHELD)

    record = scene.decision_record()
    assert record["type"] == APPEAL_DECISION_TYPE
    assert record["body"]["target"] == scene.appeal_cid


@pytest.mark.parametrize(
    "kind",
    [
        "tier_3_or_4_member_not_drawn",
        "appellant",
        "deciding_moderator",
        "tier_2_member",
    ],
)
def test_a_vote_from_a_non_panel_member_returns_403(client, scene, kind):
    """Someone signed in who holds no seat on the panel is refused with 403, and the vote does not count."""
    outsider = scene.outsider(kind)
    first = scene.panel[0]
    assert outsider.did not in {person.did for person in scene.panel}

    # Control: a seated member's vote on this very appeal is accepted.  Were the
    # outsider's vote counted too, the two would be a majority.
    scene.cast(first, UPHELD)

    response = scene.vote(outsider, UPHELD)

    assert response.status_code == 403, (
        f"a vote from {kind} should be refused: {response.status_code} {response.text}"
    )
    # The refused vote was not counted: one valid vote does not decide an appeal.
    assert scene.decisions() == []


# --------------------------------------------------------------------------- #
# The rest of the feature description
# --------------------------------------------------------------------------- #


def test_the_appeal_decision_is_node_signed_with_the_outcome_and_reasons(client, scene, node_did):
    """The decision's signer is the node, and it states the outcome the panel agreed on, with reasons."""
    first, second, _third = scene.panel
    scene.cast(first, OVERTURNED, reasons=f"First member's reasons {uuid.uuid4().hex}")
    scene.cast(second, OVERTURNED, reasons=f"Second member's reasons {uuid.uuid4().hex}")

    record = scene.decision_record()

    # Node-signed: the node's own key is the author (and the signer).
    assert record["author"] == node_did
    assert record["author"] not in {person.did for person in scene.panel}

    body = record["body"]
    # An ``appeal.decision`` with an outcome and reasons is what the schema says it is.
    assert validate_body(APPEAL_DECISION_TYPE, body) == [], validate_body(APPEAL_DECISION_TYPE, body)
    assert body["outcome"] == OVERTURNED
    assert body["target"] == scene.appeal_cid


def test_a_decision_is_made_only_once_two_of_the_three_votes_agree(client, scene):
    """One vote does not decide, nor do two that differ; a second vote for the same outcome does."""
    first, second, third = scene.panel

    scene.cast(first, UPHELD)
    assert scene.decisions() == [], "one vote of three decided the appeal"

    scene.cast(second, OVERTURNED)
    assert scene.decisions() == [], "two votes that differ decided the appeal"

    scene.cast(third, OVERTURNED)

    record = scene.decision_record()
    assert record["body"]["outcome"] == OVERTURNED
