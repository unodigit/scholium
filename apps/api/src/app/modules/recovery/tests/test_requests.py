"""POST /v1/recovery/requests: open a recovery request, identified by ORCID iD."""

from __future__ import annotations

import base64
import json
import random
from types import SimpleNamespace

import pytest
from nacl.signing import SigningKey
from sqlalchemy import inspect

from app import db
from app.modules.notifications import get_outbox, list_notifications
from app.modules.orcid import Credential, ensure_credential_tables, issue_orcid_credential
from app.modules.orcid import models as orcid_models
from app.modules.profiles import (
    ProfileData,
    issue_verification_token,
    mark_email_verified,
    save_profile,
)
from app.modules.recovery import (
    INVALID_RECOVERY_REQUEST_TYPE,
    RECOVERY_ACCOUNT_NOT_FOUND_TYPE,
    RECOVERY_GUARDIANS_NOT_SET_TYPE,
    RecoveryRequest,
    find_account_by_orcid,
    normalize_orcid,
    set_guardians,
)
from app.modules.recovery import opening
from app.settings import settings

from .conftest import new_did

URL = "/v1/recovery/requests"
PROBLEM = "application/problem+json"


@pytest.fixture(autouse=True)
def node_key(tmp_path, monkeypatch):
    """A node signing key, so the real ORCID credential issuance can run."""
    path = tmp_path / "node.key"
    path.write_bytes(bytes(SigningKey.generate()).hex().encode("ascii"))
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))


@pytest.fixture(autouse=True)
def credentials_table():
    """Leave the ``credentials`` table as this test found it.

    ``issue_orcid_credential`` creates the table lazily and remembers having
    done so.  Left behind, it would stop other plugins' tests (which create it
    only when it is missing, and drop it only if they did) from cleaning up
    after themselves, so a second run of the suite would trip over their rows.
    So: drop it afterwards if this test is what created it, and forget the
    orcid plugin's "already created" memo on both sides of that.
    """
    made = not inspect(db.engine).has_table("credentials")
    orcid_models._table_engine = None
    ensure_credential_tables()
    yield
    if made:
        Credential.__table__.drop(bind=db.engine, checkfirst=True)
    orcid_models._table_engine = None


def new_orcid() -> str:
    """A fresh, well-formed ORCID iD (the tests share one database file)."""
    digits = "".join(random.choice("0123456789") for _ in range(16))
    return "-".join(digits[i : i + 4] for i in range(0, 16, 4))


@pytest.fixture
def account(five_guardians):
    """``(orcid, did, guardians)``: an account with an ORCID iD linked and guardians set."""
    orcid, did = new_orcid(), new_did()
    issue_orcid_credential(did, orcid)
    set_guardians(did, five_guardians)
    return orcid, did, five_guardians


def new_key() -> str:
    return new_did()


def stored(request_id: str) -> RecoveryRequest | None:
    with db.SessionLocal() as session:
        return session.get(RecoveryRequest, request_id)


def requests_for(did: str) -> list[RecoveryRequest]:
    with db.SessionLocal() as session:
        return session.query(RecoveryRequest).filter(RecoveryRequest.did == did).all()


def recovery_notifications(did: str):
    return [n for n in list_notifications(did) if n.kind == "recovery.request"]


def post(client, orcid, key, **kwargs):
    return client.post(URL, json={"orcid": orcid, "new_public_key": key}, **kwargs)


def assert_problem(response, status, type_=None):
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM)
    body = response.json()
    assert body["status"] == status
    assert body["instance"] == URL
    if type_ is not None:
        assert body["type"] == type_
    return body


# --- opening a request -------------------------------------------------------


def test_opening_a_request_returns_201_with_a_request_id(client, account):
    orcid, _did, _guardians = account

    response = post(client, orcid, new_key())

    assert response.status_code == 201, response.text
    body = response.json()
    assert isinstance(body["request_id"], str) and body["request_id"]
    assert body["status"] == "pending"
    assert body["guardians_notified"] == 5


def test_the_request_is_persisted_to_recovery_requests(client, account):
    orcid, did, _guardians = account
    key = new_key()

    request_id = post(client, orcid, key).json()["request_id"]

    row = stored(request_id)
    assert row is not None
    assert row.did == did
    assert row.new_public_key == key
    assert row.approvals == []
    assert row.contest_until is None
    assert row.status == "pending"


def test_no_access_token_is_needed(client, account):
    """The requester lost their key, so they cannot sign in."""
    orcid, _did, _guardians = account

    assert post(client, orcid, new_key()).status_code == 201


def test_each_guardian_is_notified(client, account):
    orcid, did, guardians = account
    key = new_key()

    request_id = post(client, orcid, key).json()["request_id"]

    for guardian in guardians:
        notices = recovery_notifications(guardian)
        assert len(notices) == 1, guardian
        notice = notices[0]
        assert notice.read is False
        assert notice.payload["request_id"] == request_id
        assert notice.payload["account_did"] == did
        assert notice.payload["orcid"] == orcid
        assert notice.payload["new_public_key"] == key
        assert notice.payload["approvals_path"] == f"{URL}/{request_id}/approvals"


def test_the_account_owner_is_notified_too(client, account):
    orcid, did, _guardians = account
    bystander = new_did()

    request_id = post(client, orcid, new_key()).json()["request_id"]

    assert recovery_notifications(bystander) == []
    notices = recovery_notifications(did)
    assert len(notices) == 1
    assert notices[0].payload["request_id"] == request_id
    assert notices[0].payload["security_path"] == "/me/security"
    assert notices[0].payload["cancel_path"] == "/me/security"
    assert notices[0].payload["safety_window_hours"] == 72


def test_the_owner_with_a_verified_email_is_emailed(client, account):
    orcid, did, _guardians = account
    address = "owner@example.org"
    save_profile(did, ProfileData(name="Mei Okafor", affiliation="", email=address))
    mark_email_verified(did, issue_verification_token(did, address))

    request_id = post(client, orcid, new_key()).json()["request_id"]

    (mail,) = [
        m for m in get_outbox() if m.get("did") == did and m.get("kind") == "recovery.request"
    ]
    assert mail["to"] == address
    assert request_id in mail["body"]
    assert "/me/security" in mail["body"]
    assert "72" in mail["body"]


def test_an_unverified_email_is_not_used_for_the_owner_notice(client, account):
    orcid, did, _guardians = account
    address = "unverified@example.org"
    save_profile(did, ProfileData(name="Mei Okafor", affiliation="", email=address))

    post(client, orcid, new_key())

    notice = recovery_notifications(did)[0]
    assert "email" not in notice.payload
    (mail,) = [
        m for m in get_outbox() if m.get("did") == did and m.get("kind") == "recovery.request"
    ]
    assert mail["to"] == did, "an unverified address is never used"


def test_the_response_does_not_reveal_the_account_or_its_guardians(client, account):
    orcid, did, guardians = account

    text = post(client, orcid, new_key()).text

    assert did not in text
    assert not any(guardian in text for guardian in guardians)


def test_each_request_gets_its_own_id_and_row(client, account):
    """A second request does not replace, or get refused because of, the first."""
    orcid, did, guardians = account
    first, second = new_key(), new_key()

    first_id = post(client, orcid, first).json()["request_id"]
    second_id = post(client, orcid, second).json()["request_id"]

    assert first_id != second_id
    assert {row.id: row.new_public_key for row in requests_for(did)} == {first_id: first, second_id: second}
    assert len(recovery_notifications(guardians[0])) == 2


# --- the body ----------------------------------------------------------------


@pytest.mark.parametrize(
    "spelling", ["new_public_key", "newPublicKey", "new_key", "newKey"], ids=lambda name: name
)
def test_the_new_key_may_be_sent_under_other_names(client, account, spelling):
    orcid, did, _guardians = account
    key = new_key()

    response = client.post(URL, json={"orcid": orcid, spelling: key})

    assert response.status_code == 201, response.text
    assert stored(response.json()["request_id"]).new_public_key == key


@pytest.mark.parametrize(
    "encode",
    [
        pytest.param(lambda raw: raw.hex(), id="hex"),
        pytest.param(lambda raw: base64.b64encode(raw).decode(), id="base64"),
        pytest.param(lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("="), id="base64url"),
    ],
)
def test_the_new_key_may_be_raw_public_key_material(client, account, encode):
    orcid, _did, _guardians = account
    key = encode(bytes(SigningKey.generate().verify_key))

    response = post(client, orcid, key)

    assert response.status_code == 201, response.text
    assert stored(response.json()["request_id"]).new_public_key == key


def test_the_orcid_is_accepted_the_way_orcid_writes_it(client, five_guardians):
    did = new_did()
    set_guardians(did, five_guardians)
    # Digits, with the check character an ``X``.
    orcid = new_orcid()[:-1] + "X"
    issue_orcid_credential(did, orcid)

    for spelling in (orcid, orcid.lower(), f"  {orcid}  ", f"https://orcid.org/{orcid}"):
        response = post(client, spelling, new_key())
        assert response.status_code == 201, (spelling, response.text)
        assert stored(response.json()["request_id"]).did == did


def test_a_credential_stored_with_a_lowercase_check_character_is_still_found():
    """LIKE ignores case on SQLite and not on PostgreSQL; the lookup must not depend on it."""
    did = new_did()
    orcid = new_orcid()[:-1] + "X"
    issue_orcid_credential(did, orcid)
    with db.SessionLocal() as session:
        row = session.query(Credential).filter(Credential.did == did).one()
        row.vc = row.vc.replace(orcid, orcid.lower())
        session.commit()

    assert opening.find_account_by_orcid(orcid) == did


def test_a_malformed_orcid_is_a_422_and_nothing_happens(client, account):
    _orcid, did, guardians = account

    body = assert_problem(post(client, "not-an-orcid", new_key()), 422, INVALID_RECOVERY_REQUEST_TYPE)

    assert [error["loc"] for error in body["errors"]] == [["body", "orcid"]]
    assert requests_for(did) == []
    assert recovery_notifications(guardians[0]) == []


@pytest.mark.parametrize("key", ["", "z6Mk-not-a-key", "did:key:z6MkNotAnEd25519Key", "abcd", "00" * 31])
def test_a_malformed_key_is_a_422_and_nothing_happens(client, account, key):
    orcid, did, guardians = account

    body = assert_problem(post(client, orcid, key), 422, INVALID_RECOVERY_REQUEST_TYPE)

    assert [error["loc"] for error in body["errors"]] == [["body", "new_public_key"]]
    assert requests_for(did) == []
    assert recovery_notifications(guardians[0]) == []


def test_every_fault_is_reported_at_once(client):
    body = assert_problem(post(client, "nope", "nope"), 422, INVALID_RECOVERY_REQUEST_TYPE)

    assert [error["loc"] for error in body["errors"]] == [["body", "orcid"], ["body", "new_public_key"]]


@pytest.mark.parametrize(
    "payload",
    [{}, {"orcid": "0000-0002-1825-0097"}, {"new_public_key": "x"}, {"orcid": 7, "new_public_key": "x"}, [1]],
)
def test_a_body_that_is_not_two_strings_is_a_standard_422(client, payload):
    response = client.post(URL, json=payload)

    assert_problem(response, 422)


# --- who can be recovered ----------------------------------------------------


def test_an_orcid_nobody_linked_is_a_404(client):
    orcid = new_orcid()

    response = post(client, orcid, new_key())

    body = assert_problem(response, 404, RECOVERY_ACCOUNT_NOT_FOUND_TYPE)
    assert orcid not in response.text
    assert body["detail"]


def test_no_credentials_table_at_all_is_a_404(client, monkeypatch):
    """Before anyone has linked an ORCID iD the table does not exist yet."""
    monkeypatch.setattr(opening, "inspect", lambda _engine: SimpleNamespace(has_table=lambda _name: False))

    assert_problem(post(client, new_orcid(), new_key()), 404, RECOVERY_ACCOUNT_NOT_FOUND_TYPE)


def test_an_account_without_guardians_is_a_409_and_nothing_is_saved(client):
    orcid, did = new_orcid(), new_did()
    issue_orcid_credential(did, orcid)

    assert_problem(post(client, orcid, new_key()), 409, RECOVERY_GUARDIANS_NOT_SET_TYPE)

    assert requests_for(did) == []


def test_a_revoked_credential_does_not_identify_an_account(client, five_guardians):
    orcid, did = new_orcid(), new_did()
    set_guardians(did, five_guardians)
    issue_orcid_credential(did, orcid)
    with db.SessionLocal() as session:
        for credential in session.query(Credential).filter(Credential.did == did):
            credential.status = "revoked"
        session.commit()

    assert_problem(post(client, orcid, new_key()), 404, RECOVERY_ACCOUNT_NOT_FOUND_TYPE)
    assert find_account_by_orcid(orcid) is None


def test_another_accounts_credential_is_not_matched_by_a_similar_orcid(client, account):
    """An iD only matches the credential that carries exactly that iD."""
    orcid, _did, _guardians = account
    other = orcid[:-1] + ("0" if orcid[-1] != "0" else "1")

    assert_problem(post(client, other, new_key()), 404, RECOVERY_ACCOUNT_NOT_FOUND_TYPE)


def test_the_most_recently_issued_credential_wins_when_an_orcid_is_shared(client, five_guardians):
    orcid, older, newer = new_orcid(), new_did(), new_did()
    ensure_credential_tables()

    def store(did: str, issued: str, row_id: str) -> None:
        vc = {
            "type": ["VerifiableCredential", "OrcidOwnershipCredential"],
            "issuanceDate": issued,
            "credentialSubject": {"id": did, "orcid": orcid},
        }
        with db.SessionLocal() as session:
            session.add(Credential(id=row_id, did=did, kind="orcid", vc=json.dumps(vc), status="valid"))
            session.commit()

    # The newer credential is stored first, so storage order cannot explain the answer.
    store(newer, "2026-11-02T00:00:00Z", f"cred_{newer}")
    store(older, "2026-11-01T00:00:00Z", f"cred_{older}")
    for did in (older, newer):
        set_guardians(did, five_guardians)

    assert find_account_by_orcid(orcid) == newer
    request_id = post(client, orcid, new_key()).json()["request_id"]
    assert stored(request_id).did == newer


def test_a_credential_binding_the_orcid_to_another_did_is_ignored():
    orcid, row_did, claimed_did = new_orcid(), new_did(), new_did()
    ensure_credential_tables()
    vc = {"issuanceDate": "2026-11-01T00:00:00Z", "credentialSubject": {"id": claimed_did, "orcid": orcid}}
    with db.SessionLocal() as session:
        session.add(Credential(id=f"cred_{row_did}", did=row_did, kind="orcid", vc=json.dumps(vc), status="valid"))
        session.commit()

    assert find_account_by_orcid(orcid) is None


# --- notification failures ---------------------------------------------------


def test_one_guardians_failed_notification_does_not_undo_the_request(client, account, monkeypatch):
    orcid, did, guardians = account
    real_notify = opening.notify

    def flaky(did_, kind, payload=None):
        if did_ == guardians[2]:
            raise RuntimeError("inbox unavailable")
        return real_notify(did_, kind, payload)

    monkeypatch.setattr(opening, "notify", flaky)

    response = post(client, orcid, new_key())

    assert response.status_code == 201, response.text
    assert response.json()["guardians_notified"] == 4
    assert stored(response.json()["request_id"]) is not None
    assert recovery_notifications(guardians[2]) == []
    assert all(len(recovery_notifications(g)) == 1 for g in guardians if g != guardians[2])


# --- helpers -----------------------------------------------------------------


def test_normalize_orcid():
    assert normalize_orcid("0000-0002-1825-0097") == "0000-0002-1825-0097"
    assert normalize_orcid(" https://sandbox.orcid.org/0000-0002-1694-233x ") == "0000-0002-1694-233X"
    for bad in ("", "0000000218250097", "0000-0002-1825-009", "0000-0002-1825-0097-1", None, 5):
        with pytest.raises(opening.InvalidOrcid):
            normalize_orcid(bad)
