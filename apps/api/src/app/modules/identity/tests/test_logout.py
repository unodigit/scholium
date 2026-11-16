"""POST /v1/auth/logout: revoke the caller's refresh token (feature 177).

Logout retires a refresh token so it can no longer be exchanged for a new
token pair.  The token may be presented in the body (exactly as
``/v1/auth/refresh`` takes it) or, for the bearer-authenticated spelling, the
caller's access token may be used and every live refresh token belonging to
that DID is retired.  A successful logout answers ``204`` with no body.
"""

from __future__ import annotations

import hashlib

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

from app import db
from app.modules.identity import RefreshToken

URL = "/v1/auth/logout"
REFRESH_URL = "/v1/auth/refresh"
PROBLEM_JSON = "application/problem+json"


def _cookie_token(response) -> str:
    for header in response.headers.get_list("set-cookie"):
        if header.lower().startswith("scholium_refresh="):
            return header.split(";", 1)[0].split("=", 1)[1]
    raise AssertionError(f"no refresh cookie: {response.headers.get_list('set-cookie')}")


def sign_in(client) -> tuple[str, str, str]:
    """Sign in as a brand-new identity; return ``(did, access_token, refresh_token)``.

    The refresh token comes from the ``Set-Cookie`` header: the JSON body no
    longer carries it.
    """
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
    body = verify.json()
    return did, body["access_token"], _cookie_token(verify)


def _hash_of(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _row(raw_token: str) -> RefreshToken | None:
    with db.SessionLocal() as session:
        row = session.get(RefreshToken, _hash_of(raw_token))
        session.expunge(row) if row is not None else None
        return row


def test_logout_with_refresh_token_returns_204_and_revokes_it(client):
    _, _, refresh_token = sign_in(client)
    assert _row(refresh_token) is not None

    response = client.post(URL, json={"refresh_token": refresh_token})

    assert response.status_code == 204, response.text
    assert response.content == b""
    assert _row(refresh_token).rotated is True


def test_revoked_token_cannot_be_refreshed(client):
    _, _, refresh_token = sign_in(client)

    logout = client.post(URL, json={"refresh_token": refresh_token})
    assert logout.status_code == 204, logout.text

    refresh = client.post(REFRESH_URL, json={"refresh_token": refresh_token})
    assert refresh.status_code == 401, refresh.text
    assert refresh.headers["content-type"].startswith(PROBLEM_JSON)


def test_logout_with_bearer_access_token_revokes_the_callers_tokens(client):
    did, access_token, refresh_token = sign_in(client)

    response = client.post(URL, headers={"Authorization": f"Bearer {access_token}"})

    assert response.status_code == 204, response.text
    assert _row(refresh_token).rotated is True
    assert client.post(REFRESH_URL, json={"refresh_token": refresh_token}).status_code == 401


def test_logout_is_idempotent(client):
    _, _, refresh_token = sign_in(client)
    assert client.post(URL, json={"refresh_token": refresh_token}).status_code == 204

    again = client.post(URL, json={"refresh_token": refresh_token})

    assert again.status_code == 204, again.text


def test_unknown_refresh_token_still_answers_204(client):
    # Logout cannot fail for a token that is already unusable: the desired
    # end state (it cannot be refreshed) is exactly what is asked for.
    response = client.post(URL, json={"refresh_token": "not-a-token-we-issued"})

    assert response.status_code == 204, response.text


def test_logout_without_any_credential_is_rejected(client):
    response = client.post(URL)

    assert response.status_code == 401, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)


def test_body_without_refresh_token_is_rejected(client):
    response = client.post(URL, json={})

    assert response.status_code == 422, response.text
