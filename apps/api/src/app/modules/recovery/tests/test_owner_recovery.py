"""The account owner's side of a recovery request (plugin: recovery).

An account's owner may still hold a device while someone else asks the account's
guardians to recover it.  What the owner can do about that:

* ``GET /v1/recovery/requests`` lists their own open request, marked
  ``role: "owner"`` (a guardian's rows are marked ``"guardian"``);
* ``POST /v1/recovery/requests/{id}/cancel`` cancels it from the signed-in
  session, or with a detached signature by the account's *active* key over the
  request id -- so it keeps working after the account rotated its key, and the
  keys it rotated away from no longer do;
* only the owner can cancel: a guardian's or a stranger's session is refused;
* a cancel tells *every* guardian of the account -- the ones who approved as
  well as the ones who never answered -- and closes the owner's own notice, and
  a request that completes closes the owner's notice too.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
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
from app.modules.recovery import finalize
from app.modules.recovery.approvals import approval_message
from app.settings import settings

from .conftest import auth, new_did

URL = "/v1/recovery/requests"


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
    """An open request against an account with five keyed guardians."""
    account_seed = SigningKey.generate()
    did = did_key_from_signing_key(account_seed)
    guardians = [SigningKey.generate() for _ in range(5)]
    set_guardians(did, [did_key_from_signing_key(guardian) for guardian in guardians])

    orcid = new_orcid()
    issue_orcid_credential(did, orcid)
    new_key = did_key_from_signing_key(SigningKey.generate())

    response = client.post(URL, json={"orcid": orcid, "new_public_key": new_key})
    assert response.status_code == 201, response.text
    return SimpleNamespace(
        client=client,
        did=did,
        orcid=orcid,
        new_key=new_key,
        account_seed=account_seed,
        guardians=guardians,
        request_id=response.json()["request_id"],
    )


def cancel_url(recovery) -> str:
    return f"{URL}/{recovery.request_id}/cancel"


def stored(recovery) -> RecoveryRequest | None:
    with db.SessionLocal() as session:
        return session.get(RecoveryRequest, recovery.request_id)


def approve(recovery, seed: SigningKey):
    """The guardian ``seed`` approves the request."""
    message = approval_message(recovery.request_id, recovery.did, recovery.new_key)
    response = recovery.client.post(
        f"{URL}/{recovery.request_id}/approvals",
        json={"signature": sign(seed, message)},
        headers=auth(did_key_from_signing_key(seed)),
    )
    assert response.status_code == 200, response.text
    return response


def signed_cancel(recovery, seed: SigningKey):
    """Cancel with a detached signature by ``seed`` and no access token."""
    return recovery.client.post(
        cancel_url(recovery), json={"signature": sign(seed, recovery.request_id)}
    )


def notices_of(recovery, did: str) -> list:
    """``did``'s ``recovery.request`` notifications about this request."""
    return [
        n
        for n in list_notifications(did)
        if n.kind == "recovery.request" and n.payload.get("request_id") == recovery.request_id
    ]


def only_notice(recovery, did: str):
    [notice] = notices_of(recovery, did)
    return notice


def listed(recovery, did: str) -> list[dict]:
    """The rows of ``GET /v1/recovery/requests`` for ``did`` about this request."""
    response = recovery.client.get(URL, headers=auth(did))
    assert response.status_code == 200, response.text
    return [row for row in response.json() if row["request_id"] == recovery.request_id]


# --- the list ----------------------------------------------------------------


def test_the_owner_sees_their_own_request_marked_owner(recovery):
    [row] = listed(recovery, recovery.did)

    assert row["role"] == "owner"
    assert row["status"] == "pending"
    assert row["account_did"] == recovery.did
    assert row["new_public_key"] == recovery.new_key


def test_a_guardian_sees_the_request_marked_guardian(recovery):
    for guardian in recovery.guardians:
        [row] = listed(recovery, did_key_from_signing_key(guardian))
        assert row["role"] == "guardian"


def test_a_stranger_sees_nothing_of_the_request(recovery):
    assert listed(recovery, new_did()) == []


def test_the_list_needs_an_access_token(recovery):
    assert recovery.client.get(URL).status_code == 401


def test_a_cancelled_request_leaves_the_owners_list(recovery):
    assert recovery.client.post(cancel_url(recovery), headers=auth(recovery.did)).status_code == 200

    assert listed(recovery, recovery.did) == []


# --- cancelling from a session ------------------------------------------------


def test_the_owner_cancels_from_their_session(recovery):
    response = recovery.client.post(cancel_url(recovery), headers=auth(recovery.did))

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "cancelled"}
    assert stored(recovery).status == "cancelled"


def test_a_guardian_cannot_cancel(recovery):
    guardian = did_key_from_signing_key(recovery.guardians[0])

    response = recovery.client.post(cancel_url(recovery), headers=auth(guardian))

    assert response.status_code == 403
    assert stored(recovery).status == "pending"


def test_a_stranger_cannot_cancel(recovery):
    response = recovery.client.post(cancel_url(recovery), headers=auth(new_did()))

    assert response.status_code in (403, 404)
    assert stored(recovery).status == "pending"


def test_cancelling_without_any_credential_is_401(recovery):
    response = recovery.client.post(cancel_url(recovery))

    assert response.status_code == 401
    assert stored(recovery).status == "pending"


def test_cancelling_an_unknown_request_is_404(recovery):
    response = recovery.client.post(f"{URL}/rec_nope/cancel", headers=auth(recovery.did))

    assert response.status_code == 404


# --- cancelling with a signature ----------------------------------------------


def test_a_signed_cancel_with_the_original_key(recovery):
    response = signed_cancel(recovery, recovery.account_seed)

    assert response.status_code == 200, response.text
    assert stored(recovery).status == "cancelled"


def test_a_signed_cancel_after_one_rotation_uses_the_new_key(recovery):
    rotated = SigningKey.generate()
    apply_rotation(recovery.did, did_key_from_signing_key(rotated))

    assert signed_cancel(recovery, recovery.account_seed).status_code in (401, 403)
    assert stored(recovery).status == "pending"

    response = signed_cancel(recovery, rotated)

    assert response.status_code == 200, response.text
    assert stored(recovery).status == "cancelled"


def test_a_signed_cancel_after_two_rotations_uses_only_the_latest_key(recovery):
    first, second = SigningKey.generate(), SigningKey.generate()
    apply_rotation(recovery.did, did_key_from_signing_key(first))
    apply_rotation(recovery.did, did_key_from_signing_key(second))

    for old in (recovery.account_seed, first):
        assert signed_cancel(recovery, old).status_code in (401, 403)
        assert stored(recovery).status == "pending"

    response = signed_cancel(recovery, second)

    assert response.status_code == 200, response.text
    assert stored(recovery).status == "cancelled"


def test_a_signature_by_somebody_elses_key_cannot_cancel(recovery):
    response = signed_cancel(recovery, recovery.guardians[0])

    assert response.status_code in (401, 403)
    assert stored(recovery).status == "pending"


def test_the_owners_session_still_cancels_after_a_rotation(recovery):
    apply_rotation(recovery.did, did_key_from_signing_key(SigningKey.generate()))

    response = recovery.client.post(cancel_url(recovery), headers=auth(recovery.did))

    assert response.status_code == 200, response.text
    assert stored(recovery).status == "cancelled"


# --- what a cancel tells the guardians and the owner ---------------------------


def test_a_cancel_tells_the_guardians_who_approved_and_the_ones_who_did_not(recovery):
    approvers, silent = recovery.guardians[:2], recovery.guardians[2:]
    for guardian in approvers:
        approve(recovery, guardian)

    assert recovery.client.post(cancel_url(recovery), headers=auth(recovery.did)).status_code == 200

    for guardian in approvers + silent:
        notice = only_notice(recovery, did_key_from_signing_key(guardian))
        assert notice.read is True
        assert notice.payload["closed"] == "cancelled"
        assert notice.payload["approval_count"] == 2
        assert notice.payload["guardian_count"] == 5
    # An approving guardian keeps their own answer beside the closure.
    for guardian in approvers:
        assert only_notice(recovery, did_key_from_signing_key(guardian)).payload["answer"] == "approved"
    for guardian in silent:
        assert "answer" not in only_notice(recovery, did_key_from_signing_key(guardian)).payload


def test_a_cancel_tells_every_guardian_even_when_nobody_had_approved(recovery):
    assert recovery.client.post(cancel_url(recovery), headers=auth(recovery.did)).status_code == 200

    for guardian in recovery.guardians:
        notice = only_notice(recovery, did_key_from_signing_key(guardian))
        assert notice.payload["closed"] == "cancelled"
        assert notice.payload["approval_count"] == 0


def test_a_signed_cancel_tells_the_guardians_too(recovery):
    approve(recovery, recovery.guardians[0])

    assert signed_cancel(recovery, recovery.account_seed).status_code == 200

    for guardian in recovery.guardians:
        assert only_notice(recovery, did_key_from_signing_key(guardian)).payload["closed"] == "cancelled"


def test_a_refused_cancel_tells_nobody(recovery):
    approve(recovery, recovery.guardians[0])
    guardian = did_key_from_signing_key(recovery.guardians[1])

    assert recovery.client.post(cancel_url(recovery), headers=auth(guardian)).status_code == 403
    assert recovery.client.post(cancel_url(recovery)).status_code == 401

    for seed in recovery.guardians:
        assert "closed" not in only_notice(recovery, did_key_from_signing_key(seed)).payload
    owner = only_notice(recovery, recovery.did)
    assert owner.read is False
    assert "closed" not in owner.payload


def test_cancelling_twice_still_leaves_one_notice_per_guardian(recovery):
    approve(recovery, recovery.guardians[0])

    for _ in range(2):
        assert recovery.client.post(cancel_url(recovery), headers=auth(recovery.did)).status_code == 200

    for guardian in recovery.guardians:
        notices = notices_of(recovery, did_key_from_signing_key(guardian))
        assert len(notices) == 1
        assert notices[0].payload["closed"] == "cancelled"


def test_a_cancel_resolves_the_owners_own_notice(recovery):
    before = only_notice(recovery, recovery.did)
    assert before.read is False
    assert "closed" not in before.payload

    assert recovery.client.post(cancel_url(recovery), headers=auth(recovery.did)).status_code == 200

    after = only_notice(recovery, recovery.did)
    assert after.read is True
    assert after.payload["status"] == "cancelled"
    assert after.payload["closed"] == "cancelled"
    # It is still the owner's notice, not turned into a guardian's.
    assert after.payload["cancel_path"] == "/me/security"
    assert "answer" not in after.payload


def test_a_signed_cancel_resolves_the_owners_notice_too(recovery):
    rotated = SigningKey.generate()
    apply_rotation(recovery.did, did_key_from_signing_key(rotated))

    assert signed_cancel(recovery, rotated).status_code == 200

    owner = only_notice(recovery, recovery.did)
    assert owner.read is True
    assert owner.payload["status"] == "cancelled"


def test_a_cancel_leaves_other_requests_notices_alone(recovery):
    other = recovery.client.post(
        URL,
        json={"orcid": recovery.orcid, "new_public_key": did_key_from_signing_key(SigningKey.generate())},
    )
    assert other.status_code == 201, other.text
    other_id = other.json()["request_id"]

    assert recovery.client.post(cancel_url(recovery), headers=auth(recovery.did)).status_code == 200

    [owner_other] = [n for n in list_notifications(recovery.did) if n.payload.get("request_id") == other_id]
    assert owner_other.read is False
    assert "closed" not in owner_other.payload
    guardian = did_key_from_signing_key(recovery.guardians[0])
    [guardian_other] = [n for n in list_notifications(guardian) if n.payload.get("request_id") == other_id]
    assert guardian_other.read is False
    assert "closed" not in guardian_other.payload


# --- a completed recovery closes the owner's notice too -------------------------


def test_a_completed_recovery_resolves_the_owners_notice(recovery, monkeypatch):
    for guardian in recovery.guardians[:3]:
        approve(recovery, guardian)
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, recovery.request_id)
        row.contest_until = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
        session.commit()
    monkeypatch.setattr(finalize, "apply_rotation", lambda *_args, **_kwargs: None)

    assert finalize.finalize_recovery_request(recovery.request_id) is True

    owner = only_notice(recovery, recovery.did)
    assert owner.read is True
    assert owner.payload["status"] == "finalized"
    assert owner.payload["closed"] == "finalized"
    assert owner.payload["approval_count"] == 3
    assert owner.payload["guardian_count"] == 5


def test_reaching_quorum_leaves_the_owners_notice_open(recovery):
    # The safety window opening is not the end: the owner can still cancel.
    for guardian in recovery.guardians[:3]:
        approve(recovery, guardian)

    owner = only_notice(recovery, recovery.did)
    assert owner.read is False
    assert "closed" not in owner.payload
    assert "status" not in owner.payload
