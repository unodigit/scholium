"""Tests for ``PUT /v1/profiles/{did}`` (feature 28).

Covers: the 200 response, that the personal data is encrypted into
``profile.enc_blob`` under a per-object key held in ``profile_keys`` (read back
from the raw tables, not through the service), upsert behaviour, owner-only
authorization, and the 401/403/422 problem-document contracts.
"""

from __future__ import annotations

import base64
import uuid

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key
from sqlalchemy import text

from app import db
from app.modules.profiles import (
    ProfileData,
    ProfileDecryptionError,
    ensure_tables,
    open_profile,
    read_profile,
    save_profile,
)
from app.modules.profiles.crypto import KEY_BYTES, NONCE_BYTES
from app.security import UNAUTHENTICATED_TYPE

PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}


def _problem(response) -> dict:
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == response.status_code
    assert body["title"]
    return body


def _row(did: str):
    """The raw ``profile`` row, bypassing the ORM and the service."""
    ensure_tables()
    with db.engine.connect() as conn:
        return conn.execute(
            text("SELECT did, enc_blob, key_ref FROM profile WHERE did = :did"), {"did": did}
        ).one_or_none()


def _key(key_ref: str):
    with db.engine.connect() as conn:
        row = conn.execute(
            text("SELECT key FROM profile_keys WHERE key_ref = :ref"), {"ref": key_ref}
        ).one_or_none()
    return None if row is None else bytes(row[0])


# --- the happy path ---------------------------------------------------------


def test_put_returns_200_with_the_saved_profile(client, did, auth):
    response = client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    assert response.status_code == 200
    assert response.json() == {"did": did, **PROFILE}


def test_the_response_is_not_cacheable(client, did, auth):
    response = client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("tier", range(5))
def test_every_tier_may_save_their_own_profile(client, did, auth, tier):
    response = client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did, tier))

    assert response.status_code == 200


@pytest.mark.parametrize(
    "did_form",
    [
        "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        "did:web:example.com:users:ada",
        "did:example:ada",
    ],
)
def test_dids_with_colons_work_as_the_path_parameter(client, auth, did_form):
    response = client.put(f"/v1/profiles/{did_form}", json=PROFILE, headers=auth(did_form))

    assert response.status_code == 200
    assert response.json()["did"] == did_form


def test_unicode_survives_the_round_trip(client, did, auth):
    body = {"name": "Zoë Çelik 李雷", "affiliation": "Université de Genève", "email": "zoe@example.ch"}

    assert client.put(f"/v1/profiles/{did}", json=body, headers=auth(did)).status_code == 200

    assert read_profile(did) == ProfileData(**body)


def test_an_empty_affiliation_is_allowed(client, did, auth):
    body = {**PROFILE, "affiliation": ""}

    response = client.put(f"/v1/profiles/{did}", json=body, headers=auth(did))

    assert response.status_code == 200
    assert response.json()["affiliation"] == ""


def test_surrounding_whitespace_is_trimmed(client, did, auth):
    body = {"name": "  Ada  ", "affiliation": " Co. ", "email": " ada@example.org "}

    response = client.put(f"/v1/profiles/{did}", json=body, headers=auth(did))

    assert response.json() == {
        "did": did,
        "name": "Ada",
        "affiliation": "Co.",
        "email": "ada@example.org",
    }
    assert read_profile(did) == ProfileData(name="Ada", affiliation="Co.", email="ada@example.org")


def test_unknown_members_are_ignored_and_never_stored(client, did, auth):
    body = {**PROFILE, "tier": 4, "orcid": "0000-0002-1825-0097"}

    response = client.put(f"/v1/profiles/{did}", json=body, headers=auth(did))

    assert response.status_code == 200
    assert set(response.json()) == {"did", "name", "affiliation", "email"}
    row = _row(did)
    fields = open_profile(_key(row.key_ref), did, row.enc_blob)
    assert set(fields) == {"name", "affiliation", "email"}


def _sign_in(client):
    """Sign in through the real identity flow; return ``(did, authorization headers)``."""
    signing_key = SigningKey.generate()
    did = did_key_from_signing_key(signing_key)
    nonce = client.post("/v1/auth/challenge", json={"did": did}).json()["nonce"]
    signature = base64.urlsafe_b64encode(signing_key.sign(nonce.encode()).signature).rstrip(b"=").decode()
    verified = client.post("/v1/auth/verify", json={"did": did, "nonce": nonce, "signature": signature})
    assert verified.status_code == 200
    return did, {"Authorization": f"Bearer {verified.json()['access_token']}"}


def test_a_freshly_signed_in_tier_0_account_can_save_its_profile(client):
    """The real path: sign in (feature 24) at tier 0, then save a profile."""
    did, headers = _sign_in(client)

    response = client.put(f"/v1/profiles/{did}", json=PROFILE, headers=headers)

    assert response.status_code == 200
    assert response.json() == {"did": did, **PROFILE}
    assert _key(_row(did).key_ref) is not None


def test_a_signed_in_user_cannot_save_another_users_profile(client):
    owner, _ = _sign_in(client)
    _, intruder_headers = _sign_in(client)

    response = client.put(f"/v1/profiles/{owner}", json=PROFILE, headers=intruder_headers)

    assert response.status_code == 403
    assert _row(owner) is None


# --- encryption at rest -----------------------------------------------------


def test_put_stores_an_encrypted_blob_and_a_key_in_separate_tables(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    row = _row(did)
    assert row is not None
    blob = bytes(row.enc_blob)
    assert row.key_ref
    key = _key(row.key_ref)
    assert key is not None and len(key) == KEY_BYTES

    # Nothing personal appears in the clear -- not the values, not even the field names.
    for needle in (*PROFILE.values(), *PROFILE.keys(), "Lovelace", "example.org"):
        assert needle.encode() not in blob

    # ...and the key from profile_keys is what opens it.
    assert open_profile(key, did, blob) == PROFILE


def test_the_blob_does_not_open_under_another_key(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    row = _row(did)

    with pytest.raises(ProfileDecryptionError):
        open_profile(b"\x00" * KEY_BYTES, did, bytes(row.enc_blob))


def test_each_profile_gets_its_own_key(client, auth):
    a, b = (f"did:key:z6Mk{uuid.uuid4().hex}" for _ in range(2))
    client.put(f"/v1/profiles/{a}", json=PROFILE, headers=auth(a))
    client.put(f"/v1/profiles/{b}", json=PROFILE, headers=auth(b))

    row_a, row_b = _row(a), _row(b)

    assert row_a.key_ref != row_b.key_ref
    assert _key(row_a.key_ref) != _key(row_b.key_ref)
    # Same plaintext, different ciphertext.
    assert bytes(row_a.enc_blob) != bytes(row_b.enc_blob)


def test_a_blob_is_bound_to_its_did(client, did, auth):
    """A blob copied onto another DID's row must not decrypt as that DID."""
    other = f"did:key:z6Mk{uuid.uuid4().hex}"
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    row = _row(did)

    with pytest.raises(ProfileDecryptionError):
        open_profile(_key(row.key_ref), other, bytes(row.enc_blob))


def test_a_tampered_blob_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    row = _row(did)
    blob = bytearray(row.enc_blob)
    blob[-1] ^= 0x01

    with pytest.raises(ProfileDecryptionError):
        open_profile(_key(row.key_ref), did, bytes(blob))


@pytest.mark.parametrize("blob", [b"", b"\x01", b"\x02" + b"\x00" * 40, b"\x01" + b"\x00" * NONCE_BYTES])
def test_a_malformed_blob_is_rejected(blob):
    with pytest.raises(ProfileDecryptionError):
        open_profile(b"\x00" * KEY_BYTES, "did:example:x", blob)


# --- saving again -----------------------------------------------------------


def test_saving_again_replaces_the_profile_in_place(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    first = _row(did)

    updated = {"name": "Ada King", "affiliation": "Royal Society", "email": "ada.king@example.org"}
    response = client.put(f"/v1/profiles/{did}", json=updated, headers=auth(did))

    assert response.status_code == 200
    assert response.json() == {"did": did, **updated}
    second = _row(did)
    assert read_profile(did) == ProfileData(**updated)
    # Still one object under one key, re-encrypted with a fresh nonce.
    assert second.key_ref == first.key_ref
    assert _key(second.key_ref) == _key(first.key_ref)
    assert bytes(second.enc_blob) != bytes(first.enc_blob)
    with db.engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM profile WHERE did = :d"), {"d": did}).scalar_one()
    assert count == 1


def test_saving_the_same_data_twice_never_reuses_a_nonce(client, did, auth):
    nonces = set()
    for _ in range(5):
        client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
        blob = bytes(_row(did).enc_blob)
        nonces.add(blob[1 : 1 + NONCE_BYTES])

    assert len(nonces) == 5


def test_saving_after_the_key_is_gone_starts_over_under_a_new_key(client, did, auth):
    """What erasure leaves behind: a profile row whose key was deleted."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    old_ref = _row(did).key_ref
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM profile_keys WHERE key_ref = :r"), {"r": old_ref})
    assert read_profile(did) is None  # shredded: unreadable, and not an error

    updated = {**PROFILE, "name": "Ada Again"}
    response = client.put(f"/v1/profiles/{did}", json=updated, headers=auth(did))

    assert response.status_code == 200
    row = _row(did)
    assert row.key_ref != old_ref
    assert _key(old_ref) is None  # the old key is not resurrected
    assert read_profile(did) == ProfileData(**updated)


def test_a_first_save_that_loses_a_race_retries_as_an_update(did, monkeypatch):
    """Another save for the same new DID lands between our read and our insert.

    The loser's whole transaction -- including the key it just minted -- must
    roll back (no orphaned key), and the retry must update the winner's row
    under the winner's key.
    """
    from app.modules.profiles import service
    from app.modules.profiles.crypto import new_key, seal_profile

    winner_ref = f"pk_winner_{uuid.uuid4().hex}"
    minted: list[str] = []
    real_new_key_ref = service._new_key_ref

    def new_key_ref_with_a_racing_winner() -> str:
        ref = real_new_key_ref()
        minted.append(ref)
        if len(minted) == 1:  # the first attempt has read "no profile"; now someone else saves
            key = new_key()
            blob = seal_profile(key, did, {"name": "Winner", "affiliation": "", "email": "w@example.org"})
            with db.engine.begin() as conn:
                conn.execute(
                    text("INSERT INTO profile_keys (key_ref, key) VALUES (:r, :k)"),
                    {"r": winner_ref, "k": key},
                )
                conn.execute(
                    text("INSERT INTO profile (did, enc_blob, key_ref) VALUES (:d, :b, :r)"),
                    {"d": did, "b": blob, "r": winner_ref},
                )
        return ref

    monkeypatch.setattr(service, "_new_key_ref", new_key_ref_with_a_racing_winner)
    loser_data = ProfileData(name="Loser", affiliation="Co.", email="l@example.org")

    save_profile(did, loser_data)

    assert len(minted) == 1  # the retry reused the winner's key rather than minting another
    assert _row(did).key_ref == winner_ref
    assert _key(minted[0]) is None  # the loser's key was rolled back with its transaction
    assert read_profile(did) == loser_data


def test_read_profile_is_none_when_nothing_was_saved(did):
    assert read_profile(did) is None


def test_save_profile_rejects_an_empty_did():
    with pytest.raises(ValueError):
        save_profile("  ", ProfileData(**PROFILE))


# --- authentication and authorization ---------------------------------------


def test_put_requires_authentication(client, did):
    response = client.put(f"/v1/profiles/{did}", json=PROFILE)

    assert response.status_code == 401
    assert _problem(response)["type"] == UNAUTHENTICATED_TYPE
    assert response.headers["www-authenticate"] == "Bearer"
    assert _row(did) is None


def test_a_malformed_token_is_rejected(client, did):
    response = client.put(
        f"/v1/profiles/{did}", json=PROFILE, headers={"Authorization": "Bearer not-a-jwt"}
    )

    assert response.status_code == 401
    _problem(response)
    assert _row(did) is None


@pytest.mark.parametrize("tier", [0, 1, 4])
def test_only_the_owner_may_save_a_profile(client, did, auth, tier):
    """Not even a moderator may write somebody else's personal data."""
    intruder = f"did:key:z6Mk{uuid.uuid4().hex}"

    response = client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(intruder, tier))

    assert response.status_code == 403
    _problem(response)
    assert _row(did) is None


def test_a_stranger_cannot_overwrite_an_existing_profile(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    intruder = f"did:key:z6Mk{uuid.uuid4().hex}"

    response = client.put(
        f"/v1/profiles/{did}", json={**PROFILE, "name": "Mallory"}, headers=auth(intruder, 4)
    )

    assert response.status_code == 403
    assert read_profile(did) == ProfileData(**PROFILE)


def test_authorization_is_checked_before_the_body(client, did, auth):
    """A stranger sending garbage learns 403, not what is wrong with the body."""
    intruder = f"did:key:z6Mk{uuid.uuid4().hex}"

    assert client.put(f"/v1/profiles/{did}", json={}, headers=auth(intruder)).status_code == 403
    assert client.put(f"/v1/profiles/{did}", json={}).status_code == 401


# --- validation -------------------------------------------------------------


def _invalid_fields(response) -> set[str]:
    assert response.status_code == 422
    body = _problem(response)
    return {error["loc"][-1] for error in body["errors"]}


@pytest.mark.parametrize("missing", ["name", "affiliation", "email"])
def test_every_field_is_required(client, did, auth, missing):
    body = {k: v for k, v in PROFILE.items() if k != missing}

    response = client.put(f"/v1/profiles/{did}", json=body, headers=auth(did))

    assert _invalid_fields(response) == {missing}
    assert _row(did) is None


@pytest.mark.parametrize("name", ["", "   "])
def test_a_blank_name_is_rejected(client, did, auth, name):
    response = client.put(f"/v1/profiles/{did}", json={**PROFILE, "name": name}, headers=auth(did))

    assert _invalid_fields(response) == {"name"}


@pytest.mark.parametrize(
    "email",
    ["", "ada", "ada@", "@example.org", "ada@example", "ada@@example.org", "a da@example.org", "ada@example..org"],
)
def test_a_malformed_email_is_rejected(client, did, auth, email):
    response = client.put(f"/v1/profiles/{did}", json={**PROFILE, "email": email}, headers=auth(did))

    assert _invalid_fields(response) == {"email"}
    assert _row(did) is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("name", "x" * 201),
        ("affiliation", "x" * 301),
        ("email", "x" * 250 + "@example.org"),
    ],
)
def test_over_long_fields_are_rejected(client, did, auth, field, value):
    response = client.put(f"/v1/profiles/{did}", json={**PROFILE, field: value}, headers=auth(did))

    assert _invalid_fields(response) == {field}


@pytest.mark.parametrize("field", ["name", "affiliation"])
def test_control_characters_are_rejected(client, did, auth, field):
    response = client.put(
        f"/v1/profiles/{did}", json={**PROFILE, field: "Ada\r\nBcc: evil@example.org"}, headers=auth(did)
    )

    assert _invalid_fields(response) == {field}


@pytest.mark.parametrize("field", ["name", "affiliation", "email"])
def test_non_string_values_are_rejected(client, did, auth, field):
    response = client.put(f"/v1/profiles/{did}", json={**PROFILE, field: 42}, headers=auth(did))

    assert _invalid_fields(response) == {field}


def test_a_rejected_save_leaves_the_existing_profile_untouched(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    response = client.put(f"/v1/profiles/{did}", json={**PROFILE, "email": "nope"}, headers=auth(did))

    assert response.status_code == 422
    assert read_profile(did) == ProfileData(**PROFILE)
