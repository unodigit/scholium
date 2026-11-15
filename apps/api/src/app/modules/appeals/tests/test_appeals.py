"""Tests for POST /v1/appeals (appeals plugin, feature 74).

Every test builds its own paper, version, moderator and moderation decision
with freshly generated keys, so tests never depend on one another's rows.  The
decision is made the way production makes it -- a signed ``moderation.decision``
posted to ``POST /v1/moderation/decisions`` -- and then appealed.
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
    did_key_from_signing_key,
    sign_record,
    verify_record,
)

from app import db
from app.main import app
from app.modules import appeals, ledger, moderation
from app.modules.appeals import (
    APPEAL_TYPE,
    Appeal,
    AppealAlreadyFiled,
    apply_appeal,
    get_appeal,
    get_appeal_for_decision,
)
from app.modules.identity.models import Account, ensure_account_table
from app.modules.moderation import DECISION_TYPE, ModerationDecision
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.modules.submissions.models import PaperVersion
from app.security import issue_access_token

APPEALS_URL = "/v1/appeals"
DECISIONS_URL = "/v1/moderation/decisions"
RECORDS_URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def subscribed():
    """Put both packages' ledger subscriptions back.

    The packages subscribe when they are imported, but other suites call
    ``ledger.clear_subscribers()`` around their tests, which removes them for
    the rest of the worker's life.  ``POST /v1/records`` relies on the
    subscriptions; ``POST /v1/appeals`` does not, because it saves the appeal
    itself.
    """
    moderation._install_ledger_subscriber()
    appeals._install_ledger_subscriber()


def _timestamp(offset: timedelta = timedelta(0)) -> str:
    return (datetime.now(timezone.utc) + offset).strftime("%Y-%m-%dT%H:%M:%SZ")


def _bearer(did: str, tier: int = 2) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


class Person:
    """A DID with its signing key."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = _bearer(self.did)

    def sign(self, record_type: str, body: dict, *, prev: Optional[str] = None) -> dict:
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


class Moderator(Person):
    def __init__(self) -> None:
        super().__init__()
        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(
                    did=self.did,
                    tier=4,
                    created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=400),
                )
            )
            session.commit()
        self.headers = _bearer(self.did, 4)


class Scene:
    """A paper whose only version is in ``moderation``, plus the people around it."""

    def __init__(self, client: TestClient, *, coauthors: int = 0) -> None:
        self.client = client
        self.author = Person()
        self.coauthors = [Person() for _ in range(coauthors)]
        self.moderator = Moderator()
        tag = uuid.uuid4().hex
        title = f"Appeal test paper {tag}"
        manuscript = f"%PDF-1.7 appeal test {tag}".encode()
        byline = [self.author, *self.coauthors]

        genesis = self.author.sign(
            "paper.genesis",
            {
                "seed": tag,
                "title": title,
                "abstract": "Rejected by a moderator.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [p.did for p in byline],
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
                "abstract": "Rejected by a moderator.",
                "authors": [
                    {"did": p.did, "position": i + 1, "creditRoles": ["Conceptualization"]}
                    for i, p in enumerate(byline)
                ],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        save_paper(paper_cid=genesis["id"], categories=("cs.CR",))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=title,
            abstract="Rejected by a moderator.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=tuple(VersionAuthor(p.did, i + 1, ("Conceptualization",)) for i, p in enumerate(byline)),
            state="awaiting_consent",
        )
        # Set the state on the row, not through ``transition_version``: with
        # JOBS_EAGER the scan job would otherwise carry the version on.
        with db.SessionLocal() as session:
            session.get(PaperVersion, version["id"]).state = "moderation"
            session.commit()

        self.version_cid: str = version["id"]
        self.paper_cid: str = genesis["id"]

    def decide(self, action: str = "hold", **extra: Any) -> str:
        """The moderator posts a decision on the version; return its cid."""
        body: dict[str, Any] = {
            "target": self.version_cid,
            "action": action,
            "clause": "MOD-01",
            "reason": f"Decision {uuid.uuid4().hex}",
            **extra,
        }
        record = self.moderator.sign(DECISION_TYPE, body)
        response = self.client.post(DECISIONS_URL, json=record, headers=self.moderator.headers)
        assert response.status_code == 201, response.text
        return record["id"]

    def reclassify(self, category: str = "cs.LG") -> str:
        """A decision that leaves the version's state alone, so several can be stacked."""
        return self.decide("reclassify", category=category)


def _appeal(signer: Person, target: str, **body: Any) -> dict:
    return signer.sign(APPEAL_TYPE, {"target": target, "grounds": f"Grounds {uuid.uuid4().hex}", **body})


def _problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    body = response.json()
    assert body["status"] == status
    return body


def _rows(decision_cid: str) -> list[Appeal]:
    with db.SessionLocal() as session:
        return session.query(Appeal).filter(Appeal.decision_cid == decision_cid).all()


def _stored(client: TestClient, record: dict) -> bool:
    return client.get(f"{RECORDS_URL}/{record['id']}").status_code == 200


@pytest.fixture
def scene(client) -> Scene:
    return Scene(client)


# --------------------------------------------------------------------------- #
# The happy path
# --------------------------------------------------------------------------- #


def test_author_appeals_a_decision_and_the_appeal_is_saved(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision, grounds="  The paper is in scope of clause 2.1.  ")

    response = client.post(APPEALS_URL, json=record, headers=scene.author.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == record["id"]
    assert body["target"] == decision
    assert body["status"] == "pending"
    assert body["anchor"] == "pending"
    assert body["shortId"].startswith("sch:") and body["shortId"].endswith("/v1")

    row = get_appeal(record["id"])
    assert row is not None
    assert row.decision_cid == decision
    assert row.appellant_did == scene.author.did
    assert row.grounds == "The paper is in scope of clause 2.1."
    assert row.status == "pending"
    assert row.filed_at == datetime.fromisoformat(record["created"].replace("Z", "+00:00")).replace(tzinfo=None)
    assert get_appeal_for_decision(decision).appeal_cid == record["id"]


def test_the_appeal_is_a_public_record(client, scene):
    decision = scene.decide("reject")
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    fetched = client.get(f"{RECORDS_URL}/{record['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["type"] == "appeal"
    assert fetched.json()["body"]["grounds"] == record["body"]["grounds"]


def test_a_reclassify_decision_can_be_appealed_too(client, scene):
    decision = scene.reclassify()
    response = client.post(APPEALS_URL, json=_appeal(scene.author, decision), headers=scene.author.headers)
    assert response.status_code == 201, response.text


def test_naming_the_decision_and_paper_consistently_is_accepted(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision, decision=decision, paper=scene.paper_cid)
    response = client.post(APPEALS_URL, json=record, headers=scene.author.headers)
    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------- #
# Once
# --------------------------------------------------------------------------- #


def test_a_second_appeal_of_the_same_decision_is_409(client, scene):
    decision = scene.decide("hold")
    first = _appeal(scene.author, decision)
    second = _appeal(scene.author, decision)
    assert first["id"] != second["id"]

    assert client.post(APPEALS_URL, json=first, headers=scene.author.headers).status_code == 201
    response = client.post(APPEALS_URL, json=second, headers=scene.author.headers)

    problem = _problem(response, 409)
    assert problem["type"] == appeals.APPEAL_ALREADY_FILED
    assert problem["decision"] == decision
    assert problem["appeal"] == first["id"]
    # Nothing of the second appeal reached the log or the table.
    assert not _stored(client, second)
    assert get_appeal(second["id"]) is None
    assert [row.appeal_cid for row in _rows(decision)] == [first["id"]]


def test_resubmitting_the_same_appeal_is_409(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    assert client.post(APPEALS_URL, json=record, headers=scene.author.headers).status_code == 201

    _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 409)
    assert len(_rows(decision)) == 1


def test_co_authors_share_the_one_appeal(client):
    scene = Scene(client, coauthors=1)
    decision = scene.decide("hold")
    coauthor = scene.coauthors[0]

    assert client.post(APPEALS_URL, json=_appeal(scene.author, decision), headers=scene.author.headers).status_code == 201
    problem = _problem(client.post(APPEALS_URL, json=_appeal(coauthor, decision), headers=coauthor.headers), 409)
    assert problem["type"] == appeals.APPEAL_ALREADY_FILED


def test_a_listed_co_author_may_appeal(client):
    scene = Scene(client, coauthors=1)
    decision = scene.decide("hold")
    coauthor = scene.coauthors[0]

    response = client.post(APPEALS_URL, json=_appeal(coauthor, decision), headers=coauthor.headers)

    assert response.status_code == 201, response.text
    assert get_appeal_for_decision(decision).appellant_did == coauthor.did


def test_each_decision_has_its_own_single_appeal(client, scene):
    first_decision = scene.reclassify("cs.LG")
    second_decision = scene.reclassify("cs.AI")

    assert client.post(APPEALS_URL, json=_appeal(scene.author, first_decision), headers=scene.author.headers).status_code == 201
    assert client.post(APPEALS_URL, json=_appeal(scene.author, second_decision), headers=scene.author.headers).status_code == 201
    _problem(client.post(APPEALS_URL, json=_appeal(scene.author, first_decision), headers=scene.author.headers), 409)
    _problem(client.post(APPEALS_URL, json=_appeal(scene.author, second_decision), headers=scene.author.headers), 409)


def test_the_database_enforces_one_appeal_per_decision(scene):
    """Two appeals racing past the handler: one is saved, the other is a 409."""
    decision = scene.decide("hold")
    first = _appeal(scene.author, decision)
    second = _appeal(scene.author, decision)

    apply_appeal(first)
    with pytest.raises(AppealAlreadyFiled) as raised:
        apply_appeal(second)

    assert raised.value.status_code == 409
    assert raised.value.appeal_cid == first["id"]
    assert [row.appeal_cid for row in _rows(decision)] == [first["id"]]


def test_apply_appeal_is_idempotent(scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)

    one = apply_appeal(record)
    two = apply_appeal(record)

    assert one.appeal_cid == two.appeal_cid == record["id"]
    assert len(_rows(decision)) == 1


# --------------------------------------------------------------------------- #
# Who may appeal
# --------------------------------------------------------------------------- #


def test_someone_who_is_not_an_author_gets_403_and_leaves_the_appeal_free(client, scene):
    decision = scene.decide("hold")
    stranger = Person()
    record = _appeal(stranger, decision)

    problem = _problem(client.post(APPEALS_URL, json=record, headers=stranger.headers), 403)

    assert problem["type"] == appeals.APPEAL_NOT_AUTHORIZED
    assert not _stored(client, record)
    assert _rows(decision) == []
    # The decision's single appeal is still the author's to spend.
    assert client.post(APPEALS_URL, json=_appeal(scene.author, decision), headers=scene.author.headers).status_code == 201


def test_the_deciding_moderator_cannot_appeal_their_own_decision(client, scene):
    decision = scene.decide("hold")
    problem = _problem(
        client.post(APPEALS_URL, json=_appeal(scene.moderator, decision), headers=scene.moderator.headers), 403
    )
    assert problem["type"] == appeals.APPEAL_NOT_AUTHORIZED


def test_a_relayed_appeal_is_authorised_by_its_signer_not_the_caller(client, scene):
    decision = scene.decide("hold")
    relay = Person()

    relayed = client.post(APPEALS_URL, json=_appeal(scene.author, decision), headers=relay.headers)

    assert relayed.status_code == 201, relayed.text
    stranger = Person()
    other = scene.decide("reclassify", category="cs.AI")
    _problem(client.post(APPEALS_URL, json=_appeal(stranger, other), headers=scene.author.headers), 403)


# --------------------------------------------------------------------------- #
# What is appealed
# --------------------------------------------------------------------------- #


def test_an_unknown_target_is_422(client, scene):
    record = _appeal(scene.author, "bafyreiunknowndecision")
    problem = _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert problem["type"] == appeals.UNKNOWN_APPEAL_TARGET
    assert problem["errors"][0]["loc"] == ["body", "target"]


def test_a_target_that_is_not_a_decision_is_422(client, scene):
    # The version's own cid is a record this node holds -- but not a decision.
    for target in (scene.version_cid, scene.paper_cid):
        problem = _problem(
            client.post(APPEALS_URL, json=_appeal(scene.author, target), headers=scene.author.headers), 422
        )
        assert problem["type"] == appeals.UNKNOWN_APPEAL_TARGET


def test_a_decision_known_only_to_the_log_can_still_be_appealed(client, scene):
    decision = scene.decide("hold")
    with db.SessionLocal() as session:
        session.query(ModerationDecision).filter(ModerationDecision.decision_cid == decision).delete()
        session.commit()
    assert moderation.get_decision(decision) is None

    response = client.post(APPEALS_URL, json=_appeal(scene.author, decision), headers=scene.author.headers)

    assert response.status_code == 201, response.text


def test_a_decision_naming_another_paper_is_422(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision, paper=Scene(client).paper_cid)
    problem = _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert problem["errors"][0]["loc"] == ["body", "paper"]
    assert _rows(decision) == []


def test_naming_a_different_decision_is_422(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision, decision="bafyreisomethingelse")
    problem = _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert problem["errors"][0]["loc"] == ["body", "decision"]


# --------------------------------------------------------------------------- #
# The record
# --------------------------------------------------------------------------- #


def test_missing_grounds_is_422(client, scene):
    decision = scene.decide("hold")
    record = scene.author.sign(APPEAL_TYPE, {"target": decision})
    _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert _rows(decision) == []


def test_blank_grounds_is_422(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision, grounds="   \n ")
    problem = _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert problem["errors"][0]["loc"] == ["body", "grounds"]
    assert _rows(decision) == []


def test_missing_target_is_422(client, scene):
    record = scene.author.sign(APPEAL_TYPE, {"grounds": "Because."})
    _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)


def test_another_record_type_is_422(client, scene):
    decision = scene.decide("hold")
    record = scene.author.sign("endorsement", {"target": decision, "grounds": "x"})
    problem = _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert problem["errors"][0]["type"] == "wrong_record_type"


def test_a_forged_signature_is_401(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    record["sig"] = _appeal(Person(), decision)["sig"]
    _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 401)
    assert _rows(decision) == []


def test_a_tampered_appeal_is_422(client, scene):
    decision = scene.decide("hold")
    record = _appeal(scene.author, decision)
    record["body"]["grounds"] = "Changed after signing."
    _problem(client.post(APPEALS_URL, json=record, headers=scene.author.headers), 422)
    assert _rows(decision) == []


def test_no_token_is_401(client, scene):
    decision = scene.decide("hold")
    _problem(client.post(APPEALS_URL, json=_appeal(scene.author, decision)), 401)
    assert _rows(decision) == []


# --------------------------------------------------------------------------- #
# The generic door
# --------------------------------------------------------------------------- #


def test_an_appeal_posted_to_records_is_saved_and_counts_as_the_one_appeal(client, scene):
    decision = scene.decide("hold")
    first = _appeal(scene.author, decision)

    response = client.post(RECORDS_URL, json=first, headers=scene.author.headers)

    assert response.status_code == 201, response.text
    assert get_appeal(first["id"]) is not None
    second = _appeal(scene.author, decision)
    _problem(client.post(APPEALS_URL, json=second, headers=scene.author.headers), 409)
    _problem(client.post(RECORDS_URL, json=_appeal(scene.author, decision), headers=scene.author.headers), 409)


def test_an_appeal_by_a_non_author_posted_to_records_is_403(client, scene):
    decision = scene.decide("hold")
    stranger = Person()
    _problem(client.post(RECORDS_URL, json=_appeal(stranger, decision), headers=stranger.headers), 403)
    assert _rows(decision) == []


def test_the_record_type_is_registered_with_ingest():
    from app.modules import ingest

    registration = ingest.get(APPEAL_TYPE)
    assert registration is not None
    assert registration.handler is appeals.handle_appeal
    assert registration.min_tier == appeals.APPEAL_MIN_TIER
