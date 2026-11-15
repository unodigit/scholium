"""Acceptance tests for: API exposes POST /v1/auth/refresh (feature 25).

A refresh token is handed out by sign-in and is good for exactly one
refresh.  Refreshing rotates it: the presented token is retired and a
new one is returned::

    POST /v1/auth/challenge  {"did": did}                  -> 200 {"nonce": ...}
    POST /v1/auth/verify     {did, nonce, signature}
                                  -> 200 {"access_token": ..., "refresh_token": R1}
    POST /v1/auth/refresh    {"refresh_token": R1}
                                  -> 200 {"refresh_token": R2, ...}   # R2 != R1
    POST /v1/auth/refresh    {"refresh_token": R1}         -> 401     # rotated out

The criteria fix the behaviour, not the request body, so this suite pins
the one body the criteria's own wording implies (it is merged before the
feature is built and is the executable statement of the contract): a JSON
object whose ``refresh_token`` field is the token string exactly as
``/v1/auth/verify`` returned it.

Only what the criteria state is asserted.  The refresh response may carry
more (an ``access_token``, an expiry, ...) and the 401 may carry any
problem document; neither is checked here.

Criteria (app_spec.xml, feature 25):

* POST /v1/auth/refresh with a valid refresh_token returns 200 with a new
  refresh_token.
* POST /v1/auth/refresh with an already-used refresh_token returns 401.
"""

from __future__ import annotations

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

#: The endpoint under test.
URL = "/v1/auth/refresh"


def sign_in(client) -> str:
    """Sign in as a brand-new identity and return its refresh token.

    Runs the already-built challenge/verify flow (features 23 and 24), so
    the token under test is one the API itself issued and stored.  A new
    key per call keeps every test independent of every other.
    """
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)

    challenge = client.post("/v1/auth/challenge", json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]

    # The message is the nonce's UTF-8 bytes; the encoding is the project's
    # record-signature wire form, unpadded base64url.
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = client.post(
        "/v1/auth/verify",
        json={"did": did, "nonce": nonce, "signature": signature},
    )
    assert verify.status_code == 200, verify.text

    token = verify.json()["refresh_token"]
    assert isinstance(token, str) and token, verify.text
    return token


# --------------------------------------------------------------------------- #
# Criterion 1: a valid refresh_token returns 200 with a new refresh_token
# --------------------------------------------------------------------------- #


def test_refresh_with_a_valid_token_returns_200_with_a_new_refresh_token(client):
    old_token = sign_in(client)

    response = client.post(URL, json={"refresh_token": old_token})

    assert response.status_code == 200, response.text
    body = response.json()
    assert "refresh_token" in body, "response is missing the 'refresh_token' field"
    new_token = body["refresh_token"]
    assert isinstance(new_token, str) and new_token, (
        "the 'refresh_token' field must be a non-empty string"
    )
    assert new_token != old_token, (
        "the refresh token must be rotated: the response has to carry a "
        "new token, not the one that was presented"
    )


# --------------------------------------------------------------------------- #
# Criterion 2: an already-used refresh_token returns 401
# --------------------------------------------------------------------------- #


def test_refresh_with_an_already_used_token_returns_401(client):
    old_token = sign_in(client)

    # The token's first use is a correct refresh (criterion 1's scenario):
    # only then is the second request a *rotated-out* token being reused.
    first = client.post(URL, json={"refresh_token": old_token})
    assert first.status_code == 200, first.text

    second = client.post(URL, json={"refresh_token": old_token})

    assert second.status_code == 401, second.text
