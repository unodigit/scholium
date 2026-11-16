"""PUT /v1/me/guardians: an account sets its five recovery guardians."""

from __future__ import annotations

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

from app import db
from app.modules.notifications import list_notifications
from app.modules.recovery import (
    GUARDIAN_COUNT,
    GUARDIANS_CHANGED_KIND,
    INVALID_GUARDIANS_TYPE,
    UNSIGNED_GUARDIAN_CHANGE_TYPE,
    Guardian,
    get_guardians,
    guardian_change_message,
    has_guardians,
)

from .conftest import auth, new_did

URL = "/v1/me/guardians"
PROBLEM = "application/problem+json"


def sign(seed: SigningKey, text: str) -> str:
    return encode_signature(bytes(seed.sign(text.encode("utf-8")).signature))


def keyed_account() -> tuple[SigningKey, str]:
    """A ``(seed, did)`` pair whose private key these tests can sign with."""
    seed = SigningKey.generate()
    return seed, did_key_from_signing_key(seed)


def change(client, seed: SigningKey, did: str, guardians: list[str]):
    """PUT a *change* of guardians, signed by the account's own key."""
    return client.put(
        URL,
        json={
            "guardians": guardians,
            "signature": sign(seed, guardian_change_message(did, guardians)),
        },
        headers=auth(did),
    )


def stored(did: str) -> list[tuple[int, str]]:
    """The ``(position, guardian_did)`` rows saved for ``did``, straight from the table."""
    with db.SessionLocal() as session:
        rows = session.query(Guardian).filter(Guardian.did == did).order_by(Guardian.position).all()
        return [(row.position, row.guardian_did) for row in rows]


def put(client, did, guardians, **kwargs):
    return client.put(URL, json={"guardians": guardians}, headers=auth(did), **kwargs)


def assert_problem(response, status, type_=None):
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM)
    body = response.json()
    assert body["status"] == status
    assert body["instance"] == URL
    if type_ is not None:
        assert body["type"] == type_
    return body


# --- saving ------------------------------------------------------------------


def test_five_guardians_are_saved_to_the_guardians_table(client, did, five_guardians):
    response = put(client, did, five_guardians)

    assert response.status_code == 200, response.text
    assert response.json() == {"guardians": five_guardians}
    assert stored(did) == list(enumerate(five_guardians))


def test_the_order_sent_is_each_guardians_position(client, did, five_guardians):
    reordered = list(reversed(five_guardians))

    assert put(client, did, reordered).status_code == 200

    assert stored(did) == list(enumerate(reordered))
    assert get_guardians(did) == reordered


def test_setting_guardians_again_replaces_the_earlier_set(client, five_guardians):
    seed, did = keyed_account()
    assert put(client, did, five_guardians).status_code == 200
    replacements = [new_did() for _ in range(5)]

    response = change(client, seed, did, replacements)

    assert response.status_code == 200, response.text
    assert stored(did) == list(enumerate(replacements))


def test_repeating_the_same_request_is_harmless(client, did, five_guardians):
    assert put(client, did, five_guardians).status_code == 200
    assert put(client, did, five_guardians).status_code == 200

    assert stored(did) == list(enumerate(five_guardians))


# --- changing an existing set --------------------------------------------------


def test_changing_guardians_without_a_signature_is_403_and_changes_nothing(client):
    _seed, did = keyed_account()
    original = [new_did() for _ in range(5)]
    assert put(client, did, original).status_code == 200
    replacements = [new_did() for _ in range(5)]

    body = assert_problem(put(client, did, replacements), 403, UNSIGNED_GUARDIAN_CHANGE_TYPE)

    assert body["detail"]
    assert stored(did) == list(enumerate(original))


def test_a_signature_over_a_different_guardian_list_is_403(client):
    seed, did = keyed_account()
    original = [new_did() for _ in range(5)]
    assert put(client, did, original).status_code == 200
    replacements = [new_did() for _ in range(5)]
    other_list = [new_did() for _ in range(5)]

    response = client.put(
        URL,
        json={
            "guardians": replacements,
            "signature": sign(seed, guardian_change_message(did, other_list)),
        },
        headers=auth(did),
    )

    assert_problem(response, 403, UNSIGNED_GUARDIAN_CHANGE_TYPE)
    assert stored(did) == list(enumerate(original))


def test_a_guardian_change_signed_by_another_key_is_403(client):
    _seed, did = keyed_account()
    original = [new_did() for _ in range(5)]
    assert put(client, did, original).status_code == 200
    replacements = [new_did() for _ in range(5)]
    stranger = SigningKey.generate()

    response = client.put(
        URL,
        json={
            "guardians": replacements,
            "signature": sign(stranger, guardian_change_message(did, replacements)),
        },
        headers=auth(did),
    )

    assert_problem(response, 403, UNSIGNED_GUARDIAN_CHANGE_TYPE)
    assert stored(did) == list(enumerate(original))


def test_a_signed_change_notifies_the_account_owner(client):
    seed, did = keyed_account()
    original = [new_did() for _ in range(5)]
    assert put(client, did, original).status_code == 200
    replacements = [new_did() for _ in range(5)]

    assert change(client, seed, did, replacements).status_code == 200

    notices = [n for n in list_notifications(did) if n.kind == GUARDIANS_CHANGED_KIND]
    assert notices, "the account owner must be told the guardian set changed"
    assert notices[-1].payload["guardians"] == replacements
    assert notices[-1].payload["previous_guardians"] == original


def test_guardian_dids_is_accepted_as_another_name_for_guardians(client, did, five_guardians):
    response = client.put(URL, json={"guardian_dids": five_guardians}, headers=auth(did))

    assert response.status_code == 200, response.text
    assert response.json() == {"guardians": five_guardians}
    assert stored(did) == list(enumerate(five_guardians))


def test_accounts_keep_separate_guardians(client, five_guardians):
    alice, bob = new_did(), new_did()
    bobs = [new_did() for _ in range(5)]

    assert put(client, alice, five_guardians).status_code == 200
    assert put(client, bob, bobs).status_code == 200

    assert get_guardians(alice) == five_guardians
    assert get_guardians(bob) == bobs


def test_two_accounts_may_share_a_guardian(client, five_guardians):
    alice, bob = new_did(), new_did()

    assert put(client, alice, five_guardians).status_code == 200
    assert put(client, bob, five_guardians).status_code == 200

    assert get_guardians(alice) == get_guardians(bob) == five_guardians


def test_a_tier_zero_account_may_set_guardians(client, did, five_guardians):
    # Guardians are set during onboarding, before any trust tier is earned.
    response = client.put(URL, json={"guardians": five_guardians}, headers=auth(did, tier=0))

    assert response.status_code == 200, response.text


# --- authentication ------------------------------------------------------------


def test_without_a_token_the_request_is_401_and_saves_nothing(client, did, five_guardians):
    response = client.put(URL, json={"guardians": five_guardians})

    assert_problem(response, 401)
    assert stored(did) == []


def test_with_a_bad_token_the_request_is_401(client, five_guardians):
    response = client.put(
        URL, json={"guardians": five_guardians}, headers={"Authorization": "Bearer not-a-token"}
    )

    assert_problem(response, 401)


# --- validation ----------------------------------------------------------------


@pytest.mark.parametrize("count", [0, 1, GUARDIAN_COUNT - 1, GUARDIAN_COUNT + 1, 8])
def test_a_list_that_is_not_exactly_five_is_422_and_saves_nothing(client, did, count):
    response = put(client, did, [new_did() for _ in range(count)])

    body = assert_problem(response, 422, INVALID_GUARDIANS_TYPE)
    assert [error["type"] for error in body["errors"]] == ["guardian_count"]
    assert body["errors"][0]["loc"] == ["body", "guardians"]
    assert stored(did) == []


def test_a_rejected_list_keeps_the_previous_guardians(client, did, five_guardians):
    assert put(client, did, five_guardians).status_code == 200

    response = put(client, did, [new_did() for _ in range(4)])

    assert_problem(response, 422, INVALID_GUARDIANS_TYPE)
    assert stored(did) == list(enumerate(five_guardians))


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "alice",
        "did:web:example.com",
        "did:key:not-base58",
        "did:key:z6Mk",
    ],
)
def test_a_guardian_that_is_not_an_ed25519_did_key_is_422(client, did, bad):
    guardians = [new_did() for _ in range(4)] + [bad]

    response = put(client, did, guardians)

    body = assert_problem(response, 422, INVALID_GUARDIANS_TYPE)
    assert [(error["type"], error["loc"]) for error in body["errors"]] == [
        ("invalid_did", ["body", "guardians", 4])
    ]
    assert stored(did) == []


def test_a_repeated_guardian_is_422(client, did):
    first = new_did()
    guardians = [first, new_did(), first, new_did(), new_did()]

    response = put(client, did, guardians)

    body = assert_problem(response, 422, INVALID_GUARDIANS_TYPE)
    assert [(error["type"], error["loc"]) for error in body["errors"]] == [
        ("duplicate_guardian", ["body", "guardians", 2])
    ]
    assert stored(did) == []


def test_naming_yourself_as_a_guardian_is_422(client, did):
    guardians = [new_did(), did, new_did(), new_did(), new_did()]

    response = put(client, did, guardians)

    body = assert_problem(response, 422, INVALID_GUARDIANS_TYPE)
    assert [(error["type"], error["loc"]) for error in body["errors"]] == [
        ("self_guardian", ["body", "guardians", 1])
    ]
    assert stored(did) == []


def test_every_fault_is_reported_not_just_the_first(client, did):
    repeated = new_did()
    guardians = [repeated, "nope", repeated, did]  # four entries: wrong count, bad did, repeat, self

    response = put(client, did, guardians)

    body = assert_problem(response, 422, INVALID_GUARDIANS_TYPE)
    assert [error["type"] for error in body["errors"]] == [
        "guardian_count",
        "invalid_did",
        "duplicate_guardian",
        "self_guardian",
    ]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"guardians": "did:key:z6Mk"},
        {"guardians": None},
        {"guardians": [1, 2, 3, 4, 5]},
        {"guardians": [None] * 5},
        [],
    ],
)
def test_a_malformed_body_is_a_422_problem_and_saves_nothing(client, did, body):
    response = client.put(URL, json=body, headers=auth(did))

    assert_problem(response, 422)
    assert stored(did) == []


def test_a_body_that_is_not_json_is_422(client, did):
    response = client.put(URL, content=b"not json", headers={**auth(did), "Content-Type": "application/json"})

    assert_problem(response, 422)


# --- reading back --------------------------------------------------------------


def test_has_guardians_is_true_only_for_a_complete_set(client, did, five_guardians):
    assert not has_guardians(did)

    assert put(client, did, five_guardians).status_code == 200

    assert has_guardians(did)


def test_has_guardians_is_false_for_a_partial_set(did, five_guardians):
    # Not reachable through the API (a set is replaced atomically), but the gate
    # must still refuse a table that somehow holds fewer than five.
    with db.SessionLocal() as session:
        session.add_all(
            Guardian(did=did, guardian_did=guardian, position=position)
            for position, guardian in enumerate(five_guardians[:4])
        )
        session.commit()

    assert not has_guardians(did)
