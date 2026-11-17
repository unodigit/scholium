"""Tests for endorsement records (feature 41).

An ``endorsement`` record submitted through ``POST /v1/records`` is accepted
only from an author at tier 3 or above, is saved to the ``endorsements`` table,
and grants its endorsee tier 2 (Author).  Isolation: every test uses fresh
DIDs and a unique record body (hence a unique cid), so tests never collide.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules import ingest
from app.modules.endorsements import (
    AUTHOR_TIER,
    ENDORSEMENT_TYPE,
    ENDORSER_MIN_TIER,
    Endorsement,
    account_tier,
    save_endorsement,
)
from app.modules.identity.models import Account, ensure_account_table
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_account(did: str, tier: int) -> None:
    ensure_account_table()
    with db.SessionLocal() as session:
        session.add(Account(did=did, tier=tier, created_at=_utcnow()))
        session.commit()


def _give_standing(did: str, *categories: str) -> None:
    """Endorse ``did`` in each category, as a third party: the endorser's own standing.

    An endorser may only endorse in a category they are themself endorsed in.
    """
    for category in categories:
        save_endorsement(
            record_cid=f"cid-{uuid.uuid4().hex}",
            endorser_did=did_key_from_signing_key(SigningKey.generate()),
            endorsee_did=did,
            category=category,
        )


def _tier_of(did: str) -> int | None:
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        return None if account is None else int(account.tier)


def _stored(record_cid: str) -> Endorsement | None:
    with db.SessionLocal() as session:
        return session.get(Endorsement, record_cid)


class Author:
    """A signer who builds and submits correctly signed records."""

    def __init__(self, tier: int = 0) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def record(self, body: dict) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": ENDORSEMENT_TYPE,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": None,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )


def _body(**overrides) -> dict:
    body = {
        "endorsee": did_key_from_signing_key(SigningKey.generate()),
        "category": "cs.AI",
        "statement": f"test {uuid.uuid4().hex}",
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #


def test_module_registers_the_type_at_tier_3():
    registration = ingest.get(ENDORSEMENT_TYPE)
    assert registration is not None
    assert registration.handler is not None
    assert registration.min_tier == ENDORSER_MIN_TIER == 3


# --------------------------------------------------------------------------- #
# Accepted endorsements
# --------------------------------------------------------------------------- #


def test_tier_3_endorser_is_accepted_and_grants_author(client):
    endorser = Author(tier=3)
    _make_account(endorser.did, tier=3)
    _give_standing(endorser.did, "cs.AI")
    endorsee = did_key_from_signing_key(SigningKey.generate())
    record = endorser.record(_body(endorsee=endorsee, expiry="2030-01-02T03:04:05Z"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 201, response.text
    assert response.json()["id"] == record["id"]
    assert response.json()["state"] == "accepted"

    row = _stored(record["id"])
    assert row is not None
    assert row.endorser_did == endorser.did
    assert row.endorsee_did == endorsee
    assert row.category == "cs.AI"
    assert row.expires_at == datetime(2030, 1, 2, 3, 4, 5)

    assert _tier_of(endorsee) == AUTHOR_TIER == 2


def test_a_missing_expiry_is_stored_as_null(client):
    endorser = Author(tier=3)
    _make_account(endorser.did, tier=3)
    _give_standing(endorser.did, "cs.LG")
    endorsee = did_key_from_signing_key(SigningKey.generate())
    unmounted = _body(endorsee=endorsee, category="cs.LG")
    unmounted.pop("statement")
    record = endorser.record(unmounted)

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 201, response.text
    row = _stored(record["id"])
    assert row is not None
    assert row.expires_at is None
    assert row.category == "cs.LG"


def test_a_tier_4_moderator_may_endorse(client):
    endorser = Author(tier=4)
    _make_account(endorser.did, tier=4)
    endorsee = did_key_from_signing_key(SigningKey.generate())
    record = endorser.record(_body(endorsee=endorsee))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 201, response.text
    assert _tier_of(endorsee) == 2


def test_an_existing_higher_tier_is_not_demoted(client):
    endorser = Author(tier=3)
    _make_account(endorser.did, tier=3)
    _give_standing(endorser.did, "cs.AI")
    endorsee = did_key_from_signing_key(SigningKey.generate())
    _make_account(endorsee, tier=4)
    record = endorser.record(_body(endorsee=endorsee))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 201, response.text
    assert _tier_of(endorsee) == 4


# --------------------------------------------------------------------------- #
# Refusals
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("tier", [0, 1, 2])
def test_a_below_tier_3_endorser_is_refused(client, tier):
    endorser = Author(tier=tier)
    _make_account(endorser.did, tier=tier)
    endorsee = did_key_from_signing_key(SigningKey.generate())
    record = endorser.record(_body(endorsee=endorsee))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 403, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    problem = response.json()
    assert problem["status"] == 403
    assert "tier 3" in problem["detail"]

    # Refused before the ledger append: nothing was stored and nothing granted.
    assert _stored(record["id"]) is None
    from app.modules import ledger

    assert ledger.entry_by_cid(record["id"]) is None
    assert _tier_of(endorsee) is None


def test_an_unknown_endorser_account_reads_as_tier_0(client):
    endorser = Author(tier=0)
    record = endorser.record(_body())

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 403, response.text


def test_invalid_expiry_is_refused_with_422(client):
    endorser = Author(tier=3)
    _make_account(endorser.did, tier=3)
    endorsee = did_key_from_signing_key(SigningKey.generate())
    record = endorser.record(_body(endorsee=endorsee, expiry="not-a-timestamp"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 422, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert _stored(record["id"]) is None
    assert _tier_of(endorsee) is None


# --------------------------------------------------------------------------- #
# Service helpers
# --------------------------------------------------------------------------- #


def test_account_tier_reports_the_accounts_row():
    did_value = did_key_from_signing_key(SigningKey.generate())
    assert account_tier(did_value) == 0
    _make_account(did_value, tier=3)
    assert account_tier(did_value) == 3


def test_saving_the_same_record_twice_is_idempotent():
    from app.modules.endorsements import save_endorsement

    endorser = did_key_from_signing_key(SigningKey.generate())
    endorsee = did_key_from_signing_key(SigningKey.generate())
    kwargs = dict(
        record_cid=f"cid-{uuid.uuid4().hex}",
        endorser_did=endorser,
        endorsee_did=endorsee,
        category="cs.AI",
    )

    first = save_endorsement(**kwargs)
    second = save_endorsement(**kwargs)

    assert first.record_cid == second.record_cid
    with db.SessionLocal() as session:
        rows = session.query(Endorsement).filter_by(record_cid=kwargs["record_cid"]).all()
    assert len(rows) == 1
    assert _tier_of(endorsee) == 2
