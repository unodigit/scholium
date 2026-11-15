"""POST /v1/auth/refresh: rotate a refresh token (feature 25).

A refresh token from ``/v1/auth/verify`` is good for exactly one refresh:
presenting it retires it (``rotated`` flag) and returns a fresh token.  A
token that was already rotated out is refused with 401.  Only the SHA-256
hash of each token is stored, never the raw value.
"""

from __future__ import annotations

import hashlib

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

from app import db
from app.modules.identity import RefreshToken

URL = "/v1/auth/refresh"
PROBLEM_JSON = "application/problem+json"


def sign_in(client) -> tuple[str, str]:
    """Sign in as a brand-new identity; return ``(did, refresh_token)``."""
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)

    challenge = client.post("/v1/auth/challenge", json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]

    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = client.post(
        "/v1/auth/verify",
        json={"did": did, "nonce": nonce, "signature": signature},
    )
    assert verify.status_code == 200, verify.text
    return did, verify.json()["refresh_token"]


def _hash_of(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _row(raw_token: str) -> RefreshToken | None:
    with db.SessionLocal() as session:
        row = session.get(RefreshToken, _hash_of(raw_token))
        session.expunge(row) if row is not None else None
        return row


def test_valid_token_returns_200_with_a_new_refresh_token(client):
    _, old_token = sign_in(client)

    response = client.post(URL, json={"refresh_token": old_token})

    assert response.status_code == 200, response.text
    body = response.json()
    new_token = body["refresh_token"]
    assert isinstance(new_token, str) and new_token
    assert new_token != old_token, "the refresh token must be rotated"
    # The response may carry more (an access token); when present it is a string.
    if "access_token" in body:
        assert isinstance(body["access_token"], str) and body["access_token"]
    assert response.headers["cache-control"] == "no-store"


def test_presented_token_is_retired_in_the_database(client):
    _, old_token = sign_in(client)

    assert _row(old_token) is not None and _row(old_token).rotated is False

    response = client.post(URL, json={"refresh_token": old_token})
    assert response.status_code == 200, response.text
    new_token = response.json()["refresh_token"]

    # The old row is marked rotated out, the new one is stored by its hash.
    assert _row(old_token).rotated is True
    new_row = _row(new_token)
    assert new_row is not None and new_row.rotated is False

    # Only hashes are stored: no row's primary key is the raw token.
    with db.SessionLocal() as session:
        raw_row = session.get(RefreshToken, new_token)
    assert raw_row is None


def test_rotated_out_token_reuse_returns_401(client):
    _, old_token = sign_in(client)

    first = client.post(URL, json={"refresh_token": old_token})
    assert first.status_code == 200, first.text

    second = client.post(URL, json={"refresh_token": old_token})

    assert second.status_code == 401, second.text
    assert second.headers["content-type"].startswith(PROBLEM_JSON)


def test_unknown_token_returns_401(client):
    response = client.post(URL, json={"refresh_token": "not-a-token-we-issued"})

    assert response.status_code == 401, response.text


def test_the_new_token_itself_refreshes_once(client):
    # The rotation must produce a genuine token, not a one-shot placeholder.
    _, token = sign_in(client)

    first = client.post(URL, json={"refresh_token": token})
    assert first.status_code == 200, first.text
    token = first.json()["refresh_token"]

    second = client.post(URL, json={"refresh_token": token})
    assert second.status_code == 200, second.text
    third = client.post(URL, json={"refresh_token": token})
    assert third.status_code == 401, third.text


def test_body_without_refresh_token_is_rejected(client):
    response = client.post(URL, json={})

    assert response.status_code == 422, response.text


# --------------------------------------------------------------------------- #
# Service layer
# --------------------------------------------------------------------------- #


def test_service_refresh_access_rotates_and_returns_tokens(client):
    from app.modules.identity.service import InvalidRefreshToken, refresh_access

    did, old_token = sign_in(client)

    access_token, new_token = refresh_access(old_token)

    assert isinstance(access_token, str) and access_token
    assert new_token != old_token
    assert _row(old_token).rotated is True

    # The new access token decodes to the same principal.
    from app.security import decode_access_token

    principal = decode_access_token(access_token)
    assert principal.did == did

    # A second service-level use is the reuse the criteria forbid.
    with pytest.raises(InvalidRefreshToken):
        refresh_access(old_token)
