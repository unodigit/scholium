"""GET /v1/did/{did}: the DID document (feature 26).

Every test uses freshly generated identities (and their own rotation
records) so nothing here races with the other workers that share this
database file -- see the conftest caveat.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules import identity, ledger
from app.modules.identity import Account

PROBLEM_JSON = "application/problem+json"

# A did:key for a secp256k1 key (from the did:key spec): valid did:key, but
# not Ed25519, so it can never be a scholium account.
SECP256K1_DID = "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"

HISTORY_FIELDS = {"record_cid", "seq", "old_key", "new_key", "effective_at", "reason"}


def _url(did_value: str) -> str:
    return f"/v1/did/{did_value}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _new_identity() -> tuple[SigningKey, str]:
    """A fresh Ed25519 signing key and the did:key it identifies."""
    key = SigningKey.generate()
    return key, did_key_from_signing_key(key)


def _append_record(
    key: SigningKey,
    record_type: str,
    body: dict,
    *,
    created: str = "2026-11-01T00:00:00Z",
):
    """Sign a record with ``key`` and append it to the node's event log."""
    record = sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(key),
            "created": created,
            "prev": None,
            "body": body,
            "proofs": [],
        },
        key,
    )
    return ledger.append(record)


def _append_rotation(
    key: SigningKey,
    new_key: str,
    *,
    old_key: str | None = None,
    effective_at: str | None = None,
    reason: str | None = None,
    created: str = "2026-11-01T00:00:00Z",
):
    """Append one ``key.rotation`` record signed by ``key``."""
    body: dict = {"newKey": new_key}
    if old_key is not None:
        body["oldKey"] = old_key
    if effective_at is not None:
        body["effectiveAt"] = effective_at
    if reason is not None:
        body["reason"] = reason
    return _append_record(key, "key.rotation", body, created=created)


def _assert_problem(response, status: int, instance: str) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    body = response.json()
    assert body["status"] == status
    assert body["instance"] == instance
    return body


def _get_document(client, did_value: str) -> dict:
    response = client.get(_url(did_value))
    assert response.status_code == 200, response.text
    return response.json()


# -- success ---------------------------------------------------------------- #


def test_resolves_a_did_that_never_signed_in(client):
    _, did_value = _new_identity()

    body = _get_document(client, did_value)

    assert body == {
        "did": did_value,
        "active_key": did_value,
        "tier": 0,
        "key_history": [],
    }


def test_active_key_before_any_rotation_is_the_did_itself(client):
    _, did_value = _new_identity()

    # A did:key encodes its own genesis key: that key is what is active.
    assert _get_document(client, did_value)["active_key"] == did_value


def test_tier_comes_from_the_accounts_row(client):
    _, did_value = _new_identity()
    identity.ensure_account_table()
    with db.SessionLocal() as session:
        session.add(Account(did=did_value, tier=2, created_at=_utcnow()))
        session.commit()

    assert _get_document(client, did_value)["tier"] == 2


def test_tier_1_is_served_for_a_tier_1_account(client):
    _, did_value = _new_identity()
    identity.ensure_account_table()
    with db.SessionLocal() as session:
        session.add(Account(did=did_value, tier=1, created_at=_utcnow()))
        session.commit()

    assert _get_document(client, did_value)["tier"] == 1


# -- key history ------------------------------------------------------------- #


def test_key_history_lists_rotation_records_oldest_first(client):
    key, did_value = _new_identity()
    first_new = _new_identity()[1]
    second_new = _new_identity()[1]
    first = _append_rotation(key, first_new, created="2026-11-01T00:00:00Z")
    second = _append_rotation(key, second_new, created="2026-11-02T00:00:00Z")

    history = _get_document(client, did_value)["key_history"]

    assert [entry["record_cid"] for entry in history] == [
        first.record_cid,
        second.record_cid,
    ]
    assert [entry["seq"] for entry in history] == [first.seq, second.seq]
    assert [entry["new_key"] for entry in history] == [first_new, second_new]
    assert set(history[0]) == HISTORY_FIELDS


def test_rotation_body_fields_are_mirrored(client):
    key, did_value = _new_identity()
    new_key = _new_identity()[1]
    _append_rotation(
        key,
        new_key,
        old_key=did_value,
        effective_at="2026-11-15T09:35:12Z",
        reason="routine rotation",
    )

    entry = _get_document(client, did_value)["key_history"][0]

    assert entry["old_key"] == did_value
    assert entry["effective_at"] == "2026-11-15T09:35:12Z"
    assert entry["reason"] == "routine rotation"


def test_rotation_fields_absent_from_the_body_are_null(client):
    key, did_value = _new_identity()
    _append_rotation(key, _new_identity()[1])

    entry = _get_document(client, did_value)["key_history"][0]

    assert entry["old_key"] is None
    assert entry["effective_at"] is None
    assert entry["reason"] is None


def test_active_key_is_the_newest_rotations_new_key(client):
    key, did_value = _new_identity()
    first_new = _new_identity()[1]
    second_new = _new_identity()[1]
    _append_rotation(key, first_new, created="2026-11-01T00:00:00Z")
    _append_rotation(key, second_new, created="2026-11-02T00:00:00Z")

    body = _get_document(client, did_value)

    assert body["active_key"] == second_new
    assert body["active_key"] != first_new


def test_a_single_rotation_moves_the_active_key(client):
    key, did_value = _new_identity()
    new_key = _new_identity()[1]
    _append_rotation(key, new_key, old_key=did_value)

    body = _get_document(client, did_value)

    assert body["active_key"] == new_key
    assert body["key_history"][0]["old_key"] == did_value


def test_other_dids_rotations_are_not_in_the_history(client):
    other_key, _other_did = _new_identity()
    key, did_value = _new_identity()
    _append_rotation(other_key, _new_identity()[1], created="2026-11-01T00:00:00Z")

    body = _get_document(client, did_value)

    assert body["key_history"] == []
    assert body["active_key"] == did_value


def test_other_record_types_do_not_become_key_history(client):
    key, did_value = _new_identity()
    _append_record(key, "paper.genesis", {"title": "not a rotation"})

    body = _get_document(client, did_value)

    assert body["key_history"] == []
    assert body["active_key"] == did_value


def test_resolution_reflects_rotations_appended_after_an_earlier_lookup(client):
    key, did_value = _new_identity()
    assert _get_document(client, did_value)["active_key"] == did_value

    new_key = _new_identity()[1]
    _append_rotation(key, new_key, created="2026-11-03T00:00:00Z")

    body = _get_document(client, did_value)

    assert body["active_key"] == new_key
    assert len(body["key_history"]) == 1


def test_one_document_carries_active_key_history_and_tier_together(client):
    """The spec's three things, all non-default, in one resolved document."""
    key, did_value = _new_identity()
    new_key = _new_identity()[1]
    rotation = _append_rotation(
        key,
        new_key,
        old_key=did_value,
        effective_at="2026-11-15T09:35:12Z",
        reason="routine rotation",
    )
    identity.ensure_account_table()
    with db.SessionLocal() as session:
        session.add(Account(did=did_value, tier=2, created_at=_utcnow()))
        session.commit()

    body = _get_document(client, did_value)

    assert body["did"] == did_value
    assert body["active_key"] == new_key
    assert body["tier"] == 2
    assert [entry["record_cid"] for entry in body["key_history"]] == [rotation.record_cid]


# -- rejected input ---------------------------------------------------------- #


def _bad_dids() -> list[tuple[str, str]]:
    good_did = _new_identity()[1]
    return [
        ("not-a-did", "alice"),
        ("did-web", "did:web:example.com"),
        ("bare-prefix", "did:key:"),
        ("bare-multibase", "did:key:z"),
        ("garbage-base58", "did:key:z0OIl"),
        ("secp256k1", SECP256K1_DID),
        ("not-canonical", good_did + "x"),
        ("did-url-fragment", good_did + "#" + good_did[len("did:key:") :]),
    ]


@pytest.mark.parametrize("label,value", _bad_dids(), ids=[label for label, _ in _bad_dids()])
def test_rejects_a_did_that_is_not_a_canonical_ed25519_did_key(client, label, value):
    # ``#`` would be eaten as a URL fragment, so percent-encode the path;
    # the problem's ``instance`` then carries the encoded request path.
    from urllib.parse import quote

    url = "/v1/did/" + quote(value, safe=":")

    response = client.get(url)

    body = _assert_problem(response, 422, url)
    assert body["type"] == identity.INVALID_DID_TYPE
    assert "did:key" in body["detail"]
    # The rejected value is never echoed back in the explanation (the
    # message's own generic example does not count; ``instance`` is the
    # request path by definition and necessarily carries it).
    assert value not in body["detail"].replace("did:key:z6Mk...", "")


def test_rejects_an_empty_did_at_the_router(client):
    # An empty path segment does not match the route at all.
    assert client.get("/v1/did/").status_code == 404


def test_only_get_is_allowed(client):
    _, did_value = _new_identity()

    assert client.post(_url(did_value)).status_code == 405
    assert client.put(_url(did_value)).status_code == 405
    assert client.delete(_url(did_value)).status_code == 405


def test_module_router_serves_the_endpoint_under_the_v1_prefix(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert set(paths["/v1/did/{did}"]) == {"get"}


# -- service ----------------------------------------------------------------- #


def test_key_rotation_type_constant():
    assert identity.KEY_ROTATION_TYPE == "key.rotation"


def test_resolve_did_document_assembles_the_document():
    _, did_value = _new_identity()

    document = identity.resolve_did_document(did_value)

    assert document == identity.DidDocument(
        did=did_value,
        active_key=did_value,
        tier=0,
        key_history=[],
    )


def test_resolve_did_document_rejects_an_invalid_did():
    with pytest.raises(identity.InvalidDid):
        identity.resolve_did_document("alice")


def test_history_entry_models_are_strict():
    with pytest.raises(ValueError):
        identity.KeyRotationEntry(
            record_cid="bafy", seq=1, new_key="did:key:z6Mk", surprise=True
        )
