"""``key.rotation`` records through ``POST /v1/records`` (feature 37).

A rotation is authorized by the *old* key: ingest verifies the record's
signature against the author's currently active key before this plugin's
handler runs, and the handler then swaps ``account_keys`` over to the body's
``newKey``.  These tests walk that hand-over end to end -- the accepted
record, the new key active in the table, the old key refused with ``401``
afterwards and the new key able to sign -- plus the refusals that keep the
table honest (a rotation signed by a stranger, a ``newKey`` that is neither a
canonical Ed25519 did:key nor raw Ed25519 public key material).

Every test generates its own keys, so nothing here collides with the other
xdist workers that share the database file (see the conftest caveat).
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

from nacl.signing import SigningKey
from scholium_record_core import (
    compute_record_id,
    did_key_from_signing_key,
    sign_envelope,
)
from sqlalchemy import select

from app import db
from app.modules.identity import resolve_active_key
from app.modules.identity.models import AccountKey
from app.modules import ledger
from app.modules.recovery import INVALID_KEY_ROTATION_TYPE

from .conftest import auth

URL = "/v1/records"
PROBLEM = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unsigned(author: str, body: dict) -> dict:
    """An unsigned ``key.rotation`` envelope authored by ``author``."""
    return {
        "v": 1,
        "type": "key.rotation",
        "author": author,
        "created": _now(),
        "prev": None,
        "body": body,
        "proofs": [],
    }


def _signed_by(author: str, body: dict, seed: SigningKey) -> dict:
    """A ``key.rotation`` envelope signed by ``seed``, whatever key that is.

    ``sign_record`` would insist the signer is the DID's own genesis key;
    after a rotation the account's DID stays put while the *signing key*
    changes, so every record here is signed at the envelope level instead.
    """
    unsigned = _unsigned(author, body)
    return {**unsigned, "id": compute_record_id(unsigned), "sig": sign_envelope(unsigned, seed)}


def _rotation_body(old_key: str, new_key: str) -> dict:
    return {"oldKey": old_key, "newKey": new_key, "reason": "new device"}


def _post(client, record: dict, author: str):
    return client.post(URL, json=record, headers=auth(author))


def _stored_keys(did: str) -> list[tuple[str, object, object]]:
    """The ``(public_key, active_from, active_until)`` rows ``account_keys`` holds for ``did``."""
    with db.SessionLocal() as session:
        rows = (
            session.execute(select(AccountKey).where(AccountKey.did == did).order_by(AccountKey.active_from))
            .scalars()
            .all()
        )
    return [(row.public_key, row.active_from, row.active_until) for row in rows]


def _open_key(did: str) -> str | None:
    """The key whose window is still open for ``did`` (``active_until`` null)."""
    with db.SessionLocal() as session:
        rows = (
            session.execute(
                select(AccountKey.public_key).where(
                    AccountKey.did == did, AccountKey.active_until.is_(None)
                )
            )
            .scalars()
            .all()
        )
    return rows[-1] if rows else None


def assert_problem(response, status: int, type_: str | None = None) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM)
    body = response.json()
    assert body["status"] == status
    if type_ is not None:
        assert body["type"] == type_
    return body


# --------------------------------------------------------------------------- #
# The hand-over: old key signs, new key becomes active
# --------------------------------------------------------------------------- #


def test_rotation_signed_by_old_key_is_accepted_and_activates_the_new_key(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    new_seed = SigningKey.generate()
    new_key = did_key_from_signing_key(new_seed)

    record = _signed_by(did, _rotation_body(did, new_key), old_seed)
    response = _post(client, record, did)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == record["id"]
    assert body["state"] == "accepted"
    assert body["anchor"] == "pending"

    # The new key is the one active row in account_keys, and resolvers see it.
    stored = _stored_keys(did)
    assert len(stored) == 1
    assert stored[0][0] == new_key
    assert stored[0][2] is None
    assert resolve_active_key(did) == new_key

    # The DID document reflects the hand-over: the new key is active and the
    # rotation itself is the key history's first entry.
    document = client.get(f"/v1/did/{did}")
    assert document.status_code == 200, document.text
    assert document.json()["active_key"] == new_key
    assert [entry["new_key"] for entry in document.json()["key_history"]] == [new_key]

    # The record itself is in the ledger, so the rotation stays provable.
    assert ledger.entry_by_cid(record["id"]) is not None


def test_later_records_signed_by_the_old_key_are_refused_401(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    new_key = did_key_from_signing_key(SigningKey.generate())

    first = _signed_by(did, _rotation_body(did, new_key), old_seed)
    assert _post(client, first, did).status_code == 201

    # A second rotation, still signed by the OLD key: refused, nothing changes.
    third_key = did_key_from_signing_key(SigningKey.generate())
    replay = _signed_by(did, _rotation_body(new_key, third_key), old_seed)
    response = _post(client, replay, did)

    assert_problem(response, 401)
    assert resolve_active_key(did) == new_key
    assert ledger.entry_by_cid(replay["id"]) is None


def test_the_new_key_signs_after_a_rotation(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    new_seed = SigningKey.generate()
    new_key = did_key_from_signing_key(new_seed)

    assert _post(client, _signed_by(did, _rotation_body(did, new_key), old_seed), did).status_code == 201

    # The new device key can now sign records for the same DID...
    third_key = did_key_from_signing_key(SigningKey.generate())
    response = _post(client, _signed_by(did, _rotation_body(new_key, third_key), new_seed), did)

    assert response.status_code == 201, response.text
    assert resolve_active_key(did) == third_key


def test_a_second_rotation_closes_the_previous_keys_window(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    second_seed = SigningKey.generate()
    second_key = did_key_from_signing_key(second_seed)
    third_key = did_key_from_signing_key(SigningKey.generate())

    assert _post(client, _signed_by(did, _rotation_body(did, second_key), old_seed), did).status_code == 201
    assert _post(client, _signed_by(did, _rotation_body(second_key, third_key), second_seed), did).status_code == 201

    rows = _stored_keys(did)
    assert [public_key for public_key, _, _ in rows] == [second_key, third_key]
    assert rows[0][2] is not None, "the rotated-out key's window must be closed"
    assert rows[1][2] is None
    # The old window ends exactly where the new one begins.
    assert rows[0][2] == rows[1][1]

    # Both previous keys are dead: only the third key may sign for the DID now.
    fourth_key = did_key_from_signing_key(SigningKey.generate())
    assert_problem(_post(client, _signed_by(did, _rotation_body(third_key, fourth_key), old_seed), did), 401)
    assert_problem(_post(client, _signed_by(did, _rotation_body(third_key, fourth_key), second_seed), did), 401)
    assert resolve_active_key(did) == third_key


# --------------------------------------------------------------------------- #
# newKey shapes
# --------------------------------------------------------------------------- #


def test_rotation_to_a_raw_hex_public_key_is_accepted(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    new_seed = SigningKey.generate()
    raw_key = bytes(new_seed.verify_key).hex()

    response = _post(client, _signed_by(did, _rotation_body(did, raw_key), old_seed), did)

    assert response.status_code == 201, response.text
    assert _open_key(did) == raw_key
    assert resolve_active_key(did) == raw_key

    # ... and the old key is refused afterwards, exactly as for a did:key.
    assert_problem(
        _post(
            client,
            _signed_by(did, _rotation_body(raw_key, did_key_from_signing_key(SigningKey.generate())), old_seed),
            did,
        ),
        401,
    )


def test_rotation_to_a_base64_public_key_is_accepted(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    new_seed = SigningKey.generate()
    raw_key = base64.b64encode(bytes(new_seed.verify_key)).decode()

    response = _post(client, _signed_by(did, _rotation_body(did, raw_key), old_seed), did)

    assert response.status_code == 201, response.text
    assert resolve_active_key(did) == raw_key

    # The raw key can sign for the DID afterwards: ingest decodes it the same
    # way when verifying.
    third_key = did_key_from_signing_key(SigningKey.generate())
    response = _post(client, _signed_by(did, _rotation_body(raw_key, third_key), new_seed), did)
    assert response.status_code == 201, response.text
    assert resolve_active_key(did) == third_key


def test_rotation_to_a_key_that_is_neither_did_nor_key_material_is_refused(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)

    # Neither a canonical did:key nor key material: the handler refuses, with
    # its own problem type.  (An empty string never reaches the handler -- the
    # shipped schema's minLength already refuses it -- but is a 422 too.)
    for bad in ("did:key:not-a-real-key", "plaintext password"):
        record = _signed_by(did, _rotation_body(did, bad), old_seed)
        response = _post(client, record, did)

        assert_problem(response, 422, type_=INVALID_KEY_ROTATION_TYPE)
        assert ledger.entry_by_cid(record["id"]) is None

    empty = _signed_by(did, _rotation_body(did, ""), old_seed)
    assert_problem(_post(client, empty, did), 422)
    assert ledger.entry_by_cid(empty["id"]) is None

    # Nothing was activated: the DID is still its own genesis key.
    assert _stored_keys(did) == []
    assert resolve_active_key(did) == did


def test_a_past_effective_at_dates_the_hand_over_a_future_one_takes_effect_now(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    first_key = did_key_from_signing_key(SigningKey.generate())
    past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

    record = _signed_by(did, {"oldKey": did, "newKey": first_key, "effectiveAt": past}, old_seed)
    assert _post(client, record, did).status_code == 201
    stored = _stored_keys(did)
    assert stored[0][1] == datetime.fromisoformat(past.replace("Z", "+00:00")).replace(tzinfo=None)

    # A future effectiveAt cannot authorize a key before its proof was seen:
    # the hand-over takes effect at acceptance, so the old key is dead now.
    second_seed = SigningKey.generate()
    second_key = did_key_from_signing_key(second_seed)
    future = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    future_record = _signed_by(did, {"oldKey": first_key, "newKey": second_key, "effectiveAt": future}, old_seed)

    assert _post(client, future_record, did).status_code == 401
    assert resolve_active_key(did) == first_key


# --------------------------------------------------------------------------- #
# Authorization: only the active key may rotate
# --------------------------------------------------------------------------- #


def test_a_rotation_signed_by_a_stranger_key_is_refused_before_anything_changes(client):
    old_seed = SigningKey.generate()
    did = did_key_from_signing_key(old_seed)
    new_key = did_key_from_signing_key(SigningKey.generate())

    record = _signed_by(did, _rotation_body(did, new_key), SigningKey.generate())
    response = _post(client, record, did)

    assert_problem(response, 401)
    assert _stored_keys(did) == []
    assert resolve_active_key(did) == did
