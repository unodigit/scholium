"""POST /v1/recovery/requests/{id}/approvals: only a real guardian may approve.

A guardian's approval is the proof that the account holder's key really is
lost: three of them move a request into the 72-hour contest window.  So an
approval is accepted only when

* the caller is authenticated (their access token names the guardian), and
* the caller's DID is one of the account's current guardians, and
* the body carries an Ed25519 signature by that guardian's active key over the
  request id, the account DID and the new key.

Anything else is refused with problem details, and no approval is recorded.
"""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature
from sqlalchemy import inspect

from app import db
from app.modules.notifications import list_notifications
from app.modules.orcid import Credential, ensure_credential_tables, issue_orcid_credential
from app.modules.orcid import models as orcid_models
from app.modules.recovery import RecoveryRequest, apply_rotation, set_guardians
from app.modules.recovery.approvals import approval_message
from app.settings import settings

from .conftest import auth

PROBLEM = "application/problem+json"
REQUESTS_URL = "/v1/recovery/requests"


def new_orcid() -> str:
    digits = "".join(random.choice("0123456789") for _ in range(16))
    return "-".join(digits[i : i + 4] for i in range(0, 16, 4))


@pytest.fixture(autouse=True)
def node_key(tmp_path, monkeypatch):
    path = tmp_path / "node.key"
    path.write_bytes(bytes(SigningKey.generate()).hex().encode("ascii"))
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))


@pytest.fixture(autouse=True)
def credentials_table():
    made = not inspect(db.engine).has_table("credentials")
    orcid_models._table_engine = None
    ensure_credential_tables()
    yield
    if made:
        Credential.__table__.drop(bind=db.engine, checkfirst=True)
    orcid_models._table_engine = None


def sign(seed: SigningKey, text: str) -> str:
    """A detached Ed25519 signature over ``text``, unpadded base64url."""
    return encode_signature(bytes(seed.sign(text.encode("utf-8")).signature))


@pytest.fixture
def recovery(client):
    """An open recovery request for an account with five keyed guardians."""
    account_seed = SigningKey.generate()
    did = did_key_from_signing_key(account_seed)
    guardians = [SigningKey.generate() for _ in range(5)]
    set_guardians(did, [did_key_from_signing_key(guardian) for guardian in guardians])

    orcid = new_orcid()
    issue_orcid_credential(did, orcid)
    new_key = did_key_from_signing_key(SigningKey.generate())

    response = client.post(
        REQUESTS_URL, json={"orcid": orcid, "new_public_key": new_key}
    )
    assert response.status_code == 201, response.text
    return SimpleNamespace(
        client=client,
        did=did,
        new_key=new_key,
        account_seed=account_seed,
        guardians=guardians,
        request_id=response.json()["request_id"],
    )


def approval_url(recovery) -> str:
    return f"{REQUESTS_URL}/{recovery.request_id}/approvals"


def approve(
    recovery,
    seed: SigningKey | None = None,
    *,
    message: str | None = None,
    signature: str | None = None,
    body_guardian: str | None = None,
    headers: dict[str, str] | None = None,
):
    """POST an approval.  ``seed`` (when given) authenticates and signs."""
    if seed is not None:
        headers = auth(did_key_from_signing_key(seed))
        if signature is None:
            signature = sign(
                seed,
                message or approval_message(recovery.request_id, recovery.did, recovery.new_key),
            )
    body: dict[str, str] = {}
    if body_guardian is not None:
        body["guardian_did"] = body_guardian
    if signature is not None:
        body["signature"] = signature
    return recovery.client.post(approval_url(recovery), json=body, headers=headers or {})


def stored(recovery) -> RecoveryRequest | None:
    with db.SessionLocal() as session:
        return session.get(RecoveryRequest, recovery.request_id)


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM)
    body = response.json()
    assert body["status"] == status
    return body


# --- authentication ----------------------------------------------------------


def test_an_approval_without_an_access_token_is_401(recovery):
    response = approve(
        recovery,
        signature="not-a-signature",
        body_guardian=did_key_from_signing_key(recovery.guardians[0]),
    )

    assert_problem(response, 401)
    assert stored(recovery).approvals == []
    assert stored(recovery).status == "pending"


def test_an_approval_with_a_bad_access_token_is_401(recovery):
    response = approve(
        recovery,
        signature="not-a-signature",
        headers={"Authorization": "Bearer not-a-token"},
    )

    assert_problem(response, 401)
    assert stored(recovery).approvals == []


# --- guardian identity -------------------------------------------------------


def test_a_guardian_did_spoofed_in_the_body_is_rejected(recovery):
    """Authenticating as guardian 0 may not approve on guardian 1's behalf."""
    response = approve(
        recovery,
        recovery.guardians[0],
        body_guardian=did_key_from_signing_key(recovery.guardians[1]),
    )

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


def test_an_authenticated_non_guardian_is_rejected(recovery):
    stranger = SigningKey.generate()
    response = approve(recovery, stranger)

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


def test_a_signature_by_another_guardian_is_rejected(recovery):
    """The caller's own active key must have signed, not a co-guardian's."""
    response = approve(
        recovery,
        recovery.guardians[0],
        signature=sign(
            recovery.guardians[1],
            approval_message(recovery.request_id, recovery.did, recovery.new_key),
        ),
    )

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


def test_only_the_guardians_active_key_may_sign(recovery):
    """After a guardian rotates, the old key no longer approves for them."""
    guardian_did = did_key_from_signing_key(recovery.guardians[0])
    rotated_seed = SigningKey.generate()
    apply_rotation(guardian_did, did_key_from_signing_key(rotated_seed))

    retired = approve(recovery, recovery.guardians[0])
    assert_problem(retired, 403)
    assert stored(recovery).approvals == []

    message = approval_message(recovery.request_id, recovery.did, recovery.new_key)
    accepted = recovery.client.post(
        approval_url(recovery),
        json={"guardian_did": guardian_did, "signature": sign(rotated_seed, message)},
        headers=auth(guardian_did),
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["approval_count"] == 1


# --- the signature -----------------------------------------------------------


def test_a_junk_signature_is_rejected(recovery):
    response = approve(
        recovery,
        recovery.guardians[0],
        signature="not-a-signature",
    )

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


def test_a_missing_signature_is_rejected(recovery):
    guardian_did = did_key_from_signing_key(recovery.guardians[0])
    response = recovery.client.post(
        approval_url(recovery), json={}, headers=auth(guardian_did)
    )

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


def test_a_signature_over_a_different_new_key_is_rejected(recovery):
    other_key = did_key_from_signing_key(SigningKey.generate())
    response = approve(
        recovery,
        recovery.guardians[0],
        message=approval_message(recovery.request_id, recovery.did, other_key),
    )

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


def test_a_signature_over_another_request_is_rejected(recovery):
    response = approve(
        recovery,
        recovery.guardians[0],
        message=approval_message("rec_" + "0" * 32, recovery.did, recovery.new_key),
    )

    assert_problem(response, 403)
    assert stored(recovery).approvals == []


# --- acceptance --------------------------------------------------------------


def test_a_valid_guardian_approval_is_recorded(recovery):
    response = approve(recovery, recovery.guardians[0])

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["approval_count"] == 1
    assert body["status"] == "pending"

    row = stored(recovery)
    assert len(row.approvals) == 1
    assert row.approvals[0]["guardian_did"] == did_key_from_signing_key(recovery.guardians[0])


def test_the_caller_may_name_themselves_in_the_body(recovery):
    guardian = recovery.guardians[0]
    guardian_did = did_key_from_signing_key(guardian)

    response = approve(recovery, guardian, body_guardian=guardian_did)

    assert response.status_code == 200, response.text
    assert response.json()["approval_count"] == 1


def test_a_delimited_approval_message_is_accepted(recovery):
    """Clients that do not sign JSON may use the same three values, delimited."""
    guardian = recovery.guardians[0]
    message = f"{recovery.request_id}:{recovery.did}:{recovery.new_key}"

    response = recovery.client.post(
        approval_url(recovery),
        json={"signature": sign(guardian, message)},
        headers=auth(did_key_from_signing_key(guardian)),
    )

    assert response.status_code == 200, response.text
    assert response.json()["approval_count"] == 1


def test_a_duplicate_approval_does_not_count_twice(recovery):
    first = approve(recovery, recovery.guardians[0])
    second = approve(recovery, recovery.guardians[0])

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["approval_count"] == 1
    assert len(stored(recovery).approvals) == 1


def test_three_distinct_guardians_open_the_72_hour_contest_window(recovery):
    for guardian in recovery.guardians[:3]:
        response = approve(recovery, guardian)
        assert response.status_code == 200, response.text

    body = response.json()
    assert body["approval_count"] == 3
    assert body["status"] == "contest"
    assert body["opened_contest_window"] is True
    assert body["contest_until"]
    assert stored(recovery).status == "contest"
    assert stored(recovery).contest_until is not None


def test_guardians_are_not_notified_of_approvals(recovery):
    """Approving sends no further ``recovery.request`` notice to the guardians."""
    guardian_did = did_key_from_signing_key(recovery.guardians[0])
    before = len([n for n in list_notifications(guardian_did) if n.kind == "recovery.request"])

    for guardian in recovery.guardians[:3]:
        assert approve(recovery, guardian).status_code == 200

    after = len([n for n in list_notifications(guardian_did) if n.kind == "recovery.request"])
    assert after == before
