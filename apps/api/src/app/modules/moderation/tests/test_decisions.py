"""Tests for POST /v1/moderation/decisions (moderation plugin, feature 71).

Every test builds its own paper, version and moderator with freshly generated
keys, so tests never depend on one another's rows.  A version is put in place
the way the submissions handlers leave it -- signed ``paper.genesis``,
``manifest`` and ``paper.version`` records in the event log, the paper and
version indexed through ``save_paper`` / ``save_version`` -- in whatever state
the test needs.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    verify_record,
)

from app import db
from app.main import app
from app.modules import ingest, ledger, moderation, submissions
from app.modules.identity.models import Account, ensure_account_table
from app.modules.moderation import (
    ACTION_STATES,
    DECISION_TYPE,
    DecisionNotAllowed,
    ModerationDecision,
    apply_decision,
    decision_fields,
    get_clauses,
    get_decision,
    handle_moderation_decision,
)
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.modules.submissions.models import PaperVersion
from app.security import issue_access_token

DECISIONS_URL = "/v1/moderation/decisions"
RECORDS_URL = "/v1/records"
PAPERS_URL = "/v1/papers"
PROBLEM_JSON = "application/problem+json"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _timestamp(offset: timedelta = timedelta(0)) -> str:
    return (datetime.now(timezone.utc) + offset).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# The scene
# --------------------------------------------------------------------------- #


class Submission:
    """One paper with one version in ``state``, waiting for a decision."""

    def __init__(self, state: str = "moderation", category: str = "cs.CR") -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Decision test paper {self.tag}"
        manuscript = f"%PDF-1.7 decision test {self.tag}".encode()
        #: The bytes the manifest's one file names (not stored unless a test stores them).
        self.manuscript = manuscript

        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": "Waiting for a moderator.",
                "categories": [category],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        manifest = self._sign(
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
        version = self._sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": self.title,
                "abstract": "Waiting for a moderator.",
                "authors": [{"did": self.did, "position": 1, "creditRoles": ["Conceptualization"]}],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)
        #: The signed genesis, manifest and version records, as appended to the log.
        self.records: tuple[dict, ...] = (genesis, manifest, version)

        save_paper(paper_cid=genesis["id"], categories=(category,))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=self.title,
            abstract="Waiting for a moderator.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
            state="awaiting_consent",
        )
        # ``save_version`` and ``transition_version`` both publish
        # ``version.state_changed``, and with JOBS_EAGER the scan job (and the
        # advisory AI pre-review of a listed version) would then run inline and
        # carry the version on from there.  Set the state on the row instead, so
        # the version is exactly where the test says it is.
        if state != "awaiting_consent":
            with db.SessionLocal() as session:
                row = session.get(PaperVersion, version["id"])
                row.state = state
                session.commit()

        self.version_cid: str = version["id"]
        self.paper_cid: str = genesis["id"]
        self.short_id: str = derive_short_id(genesis["id"])

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
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

    @property
    def state(self) -> str:
        version = submissions.get_version(self.version_cid)
        assert version is not None
        return str(version.state)

    @property
    def categories(self) -> list[str]:
        paper = submissions.get_paper(self.paper_cid)
        assert paper is not None
        return list(paper.categories)


class Moderator:
    """A moderator whose account tier and access-token tier are both settable."""

    def __init__(self, tier: int = 4, token_tier: int = 4) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(
                    did=self.did,
                    tier=tier,
                    created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=400),
                )
            )
            session.commit()
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, token_tier)}"}

    def decide(
        self,
        submission: Submission,
        action: str,
        *,
        clause: Optional[str] = "MOD-01",
        reason: Optional[str] = "default",
        created: Optional[str] = None,
        **extra: Any,
    ) -> dict:
        body: dict[str, Any] = {"target": submission.version_cid, "action": action, **extra}
        if clause is not None:
            body["clause"] = clause
        if reason == "default":
            body["reason"] = f"Decision {uuid.uuid4().hex}"
        elif reason is not None:
            body["reason"] = reason
        return sign_record(
            {
                "v": 1,
                "type": DECISION_TYPE,
                "author": self.did,
                "created": created or _timestamp(),
                "prev": None,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )

    def post(self, client, submission: Submission, action: str, **kwargs: Any):
        return client.post(DECISIONS_URL, json=self.decide(submission, action, **kwargs), headers=self.headers)


@pytest.fixture
def moderator() -> Moderator:
    return Moderator()


@pytest.fixture
def subscribed():
    """Put the package's ledger subscription back.

    The package subscribes when it is imported, but other suites call
    ``ledger.clear_subscribers()`` around their tests (ledger, search), which
    removes it for the rest of the worker's life.  ``POST /v1/records`` relies
    on that subscription to apply a decision; ``POST /v1/moderation/decisions``
    does not, because the endpoint applies the decision itself.
    """
    moderation._install_ledger_subscriber()


def _problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    body = response.json()
    assert body["status"] == status
    return body


def _stored(client, record: dict) -> bool:
    return client.get(f"{RECORDS_URL}/{record['id']}").status_code == 200


# --------------------------------------------------------------------------- #
# What each action does
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("action", "start", "expected"),
    [
        ("list", "moderation", "listed"),
        ("hold", "moderation", "held"),
        ("reject", "moderation", "rejected"),
        ("delist", "listed", "rejected"),
        ("list", "held", "listed"),
        ("list", "rejected", "listed"),
    ],
)
def test_state_setting_actions_set_the_version_state(client, moderator, action, start, expected):
    submission = Submission(state=start)
    decision = moderator.decide(submission, action)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert submission.state == expected
    body = response.json()
    assert body["id"] == decision["id"]
    assert body["state"] == expected
    assert body["action"] == action
    assert body["clause"] == "MOD-01"
    assert body["target"] == submission.version_cid
    assert body["shortId"] == f"{submission.short_id}/v1"
    assert body["anchor"] == "pending"


def test_action_state_table_matches_what_status_computation_assumes():
    # compute_status reads list/hold/reject/delist as state-setting and
    # reclassify as leaving the state alone.
    assert set(ACTION_STATES) == {"list", "hold", "reject", "delist"}


def test_the_decision_is_saved_to_moderation_decisions(client, moderator):
    submission = Submission()
    created = _timestamp(timedelta(minutes=-5))
    decision = moderator.decide(submission, "hold", clause="MOD-02", created=created)

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    row = get_decision(decision["id"])
    assert row is not None
    assert row.decision_cid == decision["id"]
    assert row.target_cid == submission.version_cid
    assert row.action == "hold"
    assert row.clause == "MOD-02"
    assert row.moderator_did == moderator.did
    # decided_at is the signer's own timestamp, in naive UTC.
    assert row.decided_at == datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ")


def test_hold_takes_a_listed_paper_out_of_the_catalog_and_list_restores_it(client, moderator):
    submission = Submission(state="listed")
    assert client.get(f"{PAPERS_URL}/{submission.short_id}").status_code == 200

    assert moderator.post(client, submission, "hold").status_code == 201
    assert client.get(f"{PAPERS_URL}/{submission.short_id}").status_code == 404

    assert moderator.post(client, submission, "list").status_code == 201
    assert client.get(f"{PAPERS_URL}/{submission.short_id}").status_code == 200


def test_reclassify_moves_the_paper_and_leaves_the_version_state(client, moderator):
    submission = Submission(state="moderation", category="cs.CR")

    response = moderator.post(client, submission, "reclassify", clause="MOD-10", category="cs.LG")

    assert response.status_code == 201, response.text
    assert submission.categories == ["cs.LG"]
    assert submission.state == "moderation"
    assert response.json()["state"] == "moderation"


def test_reclassify_accepts_a_list_of_categories(client, moderator):
    submission = Submission(category="cs.CR")

    response = moderator.post(
        client, submission, "reclassify", clause="MOD-10", categories=["cs.LG", "cs.CR", "cs.LG"]
    )

    assert response.status_code == 201, response.text
    assert submission.categories == ["cs.LG", "cs.CR"]


def test_reclassify_without_a_category_is_refused_and_not_recorded(client, moderator):
    submission = Submission(category="cs.CR")
    decision = moderator.decide(submission, "reclassify", clause="MOD-10")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    body = _problem(response, 422)
    assert body["errors"][0]["loc"] == ["body", "category"]
    assert submission.categories == ["cs.CR"]
    assert not _stored(client, decision)


# --------------------------------------------------------------------------- #
# What a decision must carry
# --------------------------------------------------------------------------- #


def test_missing_clause_is_422_and_does_not_act(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list", clause=None)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    _problem(response, 422)
    assert submission.state == "moderation"
    assert not _stored(client, decision)
    assert get_decision(decision["id"]) is None


def test_unknown_clause_is_422_naming_the_clause_and_does_not_act(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list", clause="MOD-99")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    body = _problem(response, 422)
    assert body["type"] == "urn:scholium:problem:unknown-policy-clause"
    assert body["errors"][0]["loc"] == ["body", "clause"]
    assert "MOD-99" in body["detail"]
    assert submission.state == "moderation"
    assert not _stored(client, decision)


def test_clause_ids_are_matched_exactly(client, moderator):
    submission = Submission()
    for clause in ("mod-01", " MOD-01", "MOD-01 "):
        decision = moderator.decide(submission, "list", clause=clause)
        _problem(client.post(DECISIONS_URL, json=decision, headers=moderator.headers), 422)
    assert submission.state == "moderation"


def test_every_served_clause_is_accepted(client, moderator):
    for clause in get_clauses():
        submission = Submission()
        response = moderator.post(client, submission, "hold", clause=clause.id)
        assert response.status_code == 201, (clause.id, response.text)


def test_missing_reason_is_422(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list", reason=None)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    _problem(response, 422)
    assert submission.state == "moderation"
    assert not _stored(client, decision)


@pytest.mark.parametrize("reason", ["", "   ", "\n\t"])
def test_blank_reason_without_a_reason_cid_is_422(client, moderator, reason):
    submission = Submission()
    decision = moderator.decide(submission, "list", reason=reason)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    _problem(response, 422)
    assert submission.state == "moderation"
    assert not _stored(client, decision)


def test_a_reason_cid_stands_in_for_the_reason(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list", reason=None, reasonCid="bafkreiexamplereasoncid")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert submission.state == "listed"


def test_unknown_action_is_422(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "expunge")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    _problem(response, 422)
    assert submission.state == "moderation"


def test_unknown_target_is_422_and_not_recorded(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list")
    # Re-sign the same decision aimed at a cid no version has.
    body = {**decision["body"], "target": submission.paper_cid}
    decision = sign_record({k: v for k, v in decision.items() if k not in ("id", "sig")} | {"body": body}, moderator.seed)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    body = _problem(response, 422)
    assert body["type"] == "urn:scholium:problem:unknown-decision-target"
    assert body["errors"][0]["loc"] == ["body", "target"]
    assert not _stored(client, decision)


def test_wrong_record_type_is_422(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list")
    other = sign_record(
        {k: v for k, v in decision.items() if k not in ("id", "sig")} | {"type": "flag"},
        moderator.seed,
    )

    response = client.post(DECISIONS_URL, json=other, headers=moderator.headers)

    body = _problem(response, 422)
    assert body["errors"][0]["loc"] == ["body", "type"]


# --------------------------------------------------------------------------- #
# Which transitions a moderator can make
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("start", ["awaiting_consent", "scanning"])
def test_listing_a_version_that_has_not_reached_moderation_is_409(client, moderator, start):
    submission = Submission(state=start)
    decision = moderator.decide(submission, "list")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    body = _problem(response, 409)
    assert body["type"] == "urn:scholium:problem:decision-not-allowed"
    assert body["state"] == start
    assert body["requested"] == "listed"
    assert submission.state == start
    assert not _stored(client, decision)
    assert get_decision(decision["id"]) is None


def test_a_decision_asking_for_the_state_the_version_already_has_is_recorded(client, moderator):
    submission = Submission(state="held")

    response = moderator.post(client, submission, "hold", clause="MOD-07")

    assert response.status_code == 201, response.text
    assert submission.state == "held"


# --------------------------------------------------------------------------- #
# Who may decide
# --------------------------------------------------------------------------- #


def test_no_credentials_is_401(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list")

    response = client.post(DECISIONS_URL, json=decision)

    _problem(response, 401)
    assert submission.state == "moderation"


def test_a_tier_1_caller_is_403(client):
    submission = Submission()
    member = Moderator(tier=1, token_tier=1)

    response = member.post(client, submission, "list")

    _problem(response, 403)
    assert submission.state == "moderation"


def test_a_tier_4_caller_relaying_a_record_signed_below_tier_4_is_403(client):
    submission = Submission()
    caller = Moderator()
    signer = Moderator(tier=3, token_tier=3)
    decision = signer.decide(submission, "list")

    response = client.post(DECISIONS_URL, json=decision, headers=caller.headers)

    _problem(response, 403)
    assert submission.state == "moderation"
    assert not _stored(client, decision)


def test_a_bad_signature_is_401(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list")
    decision["sig"] = moderator.decide(submission, "hold")["sig"]

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    _problem(response, 401)
    assert submission.state == "moderation"
    assert not _stored(client, decision)


# --------------------------------------------------------------------------- #
# Replays and the other door
# --------------------------------------------------------------------------- #


def test_a_replayed_decision_is_409_and_does_not_undo_a_later_one(client, moderator):
    submission = Submission()
    first = moderator.decide(submission, "list")
    assert client.post(DECISIONS_URL, json=first, headers=moderator.headers).status_code == 201
    assert moderator.post(client, submission, "hold").status_code == 201
    assert submission.state == "held"

    replay = client.post(DECISIONS_URL, json=first, headers=moderator.headers)

    _problem(replay, 409)
    assert submission.state == "held"


def test_apply_decision_is_idempotent_and_does_not_reapply_a_saved_decision(client, moderator):
    submission = Submission()
    first = moderator.decide(submission, "list")
    assert client.post(DECISIONS_URL, json=first, headers=moderator.headers).status_code == 201
    assert moderator.post(client, submission, "hold").status_code == 201

    saved = apply_decision(first)

    assert saved.decision_cid == first["id"]
    assert submission.state == "held"  # the stale 'list' did not run again


def test_a_decision_sent_to_post_records_takes_effect_too(client, moderator, subscribed):
    submission = Submission()
    decision = moderator.decide(submission, "list")

    response = client.post(RECORDS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert submission.state == "listed"
    row = get_decision(decision["id"])
    assert row is not None and row.action == "list"
    assert client.get(f"{PAPERS_URL}/{submission.short_id}").status_code == 200


def test_the_package_registers_the_record_type_and_subscribes_to_the_ledger():
    registration = ingest.get(DECISION_TYPE)
    assert registration is not None
    assert registration.handler is handle_moderation_decision
    assert int(registration.min_tier) == 4

    # Other plugins (e.g. status) may also subscribe to decisions; what matters
    # is that moderation's own subscriber is installed exactly once.
    from app.modules.ledger import service as ledger_service
    from app.modules.moderation.decisions import persist_entry

    moderation._install_ledger_subscriber()
    before = ledger.subscriber_count(DECISION_TYPE)
    moderation._install_ledger_subscriber()  # installing twice is harmless
    assert ledger.subscriber_count(DECISION_TYPE) == before
    assert ledger_service._subscribers[DECISION_TYPE].count(persist_entry) == 1


def test_post_records_still_applies_the_decision_checks(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "list", clause="MOD-99")

    response = client.post(RECORDS_URL, json=decision, headers=moderator.headers)

    _problem(response, 422)
    assert submission.state == "moderation"
    assert not _stored(client, decision)


def test_the_published_decision_carries_clause_and_reason(client, moderator):
    submission = Submission()
    decision = moderator.decide(submission, "reject", clause="MOD-09", reason="Pure promotion.")
    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    record = client.get(f"{RECORDS_URL}/{decision['id']}").json()

    assert record["type"] == DECISION_TYPE
    assert record["body"]["clause"] == "MOD-09"
    assert record["body"]["reason"] == "Pure promotion."
    assert record["body"]["action"] == "reject"


# --------------------------------------------------------------------------- #
# The record reader, without the HTTP layer
# --------------------------------------------------------------------------- #


def test_decision_fields_reads_created_as_utc():
    moderator = Moderator()
    submission = Submission()
    decision = moderator.decide(submission, "list", created="2026-11-14T07:33:00+02:00")

    fields = decision_fields(decision)

    assert fields.decided_at == datetime(2026, 11, 14, 5, 33, 0)
    assert fields.moderator_did == moderator.did
    assert fields.categories == ()


def test_decision_fields_refuses_a_created_that_is_not_an_instant():
    moderator = Moderator()
    decision = moderator.decide(Submission(), "list", created="yesterday")

    with pytest.raises(Exception) as excinfo:
        decision_fields(decision)

    assert getattr(excinfo.value, "status_code", None) == 422


def test_the_table_and_model_agree_with_the_spec_columns():
    columns = {column.name for column in ModerationDecision.__table__.columns}
    assert columns == {
        "decision_cid",
        "target_cid",
        "action",
        "clause",
        "moderator_did",
        "decided_at",
    }
    assert [c.name for c in ModerationDecision.__table__.primary_key.columns] == ["decision_cid"]
    assert issubclass(DecisionNotAllowed, Exception)
