"""Acceptance tests for: API exposes POST /v1/auth/verify (feature 24).

Sign-in is challenge-response.  Feature 23 issues the nonce; this feature
checks the client's Ed25519 signature over it and hands out tokens::

    POST /v1/auth/challenge  {"did": did}              -> 200 {"nonce": ...}
    sig = Ed25519-sign(nonce UTF-8 bytes, seed)         # the key behind did
    POST /v1/auth/verify     {did, nonce, signature}
                                  -> 200 {"access_token": ..., "refresh_token": ...}

The criteria fix the behaviour, not the request body, so this suite pins
the body the project's own conventions already imply (it is merged before
the feature is built and is the executable statement of the contract):

* ``did`` -- the canonical Ed25519 did:key the challenge was issued to;
* ``nonce`` -- the exact nonce string the challenge endpoint returned;
* ``signature`` -- the 64-byte Ed25519 signature over the nonce's UTF-8
  bytes, as unpadded base64url text (``scholium_record_core.SIG_ENCODING``
  -- the encoding record signatures already use on this API).

Criteria (app_spec.xml, feature 24):

* POST /v1/auth/verify with a correctly signed nonce returns 200 with
  ``access_token`` and ``refresh_token``.
* POST /v1/auth/verify with a reused nonce returns 401 problem details.
* POST /v1/auth/verify with a signature from another key returns 401
  problem details.
"""

from __future__ import annotations

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

#: The endpoint under test.
URL = "/v1/auth/verify"

#: RFC 9457 media type every API error on this app is served as.
PROBLEM_JSON = "application/problem+json"

#: Exactly the fields criterion 1 names.
TOKEN_FIELDS = ("access_token", "refresh_token")


def sign_nonce(seed: SigningKey, nonce: str) -> str:
    """Sign ``nonce`` with ``seed`` the way this API carries signatures.

    The message is the nonce's UTF-8 bytes; the encoding is the project's
    record-signature wire form, unpadded base64url.
    """
    return encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))


def ask_for_nonce(client, did: str) -> str:
    """Run the feature-23 half of the flow: fetch a nonce for ``did``."""
    response = client.post("/v1/auth/challenge", json={"did": did})
    assert response.status_code == 200, response.text
    return response.json()["nonce"]


def verify_body(seed: SigningKey, did: str, nonce: str) -> dict:
    """A request body with the nonce signed by the key behind ``did``."""
    return {
        "did": did,
        "nonce": nonce,
        "signature": sign_nonce(seed, nonce),
    }


def assert_problem_details(response, status: int) -> dict:
    """Assert ``response`` is an RFC 9457 problem document with ``status``.

    Only what "returns problem details" states: the problem media type and
    the document's own status matching the HTTP status.  The instance is
    filled in by the app-wide handlers for every error, so it is checked
    too; the ``type`` URN is deliberately not pinned.
    """
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), (
        f"a {status} must be served as {PROBLEM_JSON}, "
        f"got {response.headers['content-type']!r}"
    )
    body = response.json()
    assert body["status"] == status, body
    assert body["instance"] == URL, body
    return body


# --------------------------------------------------------------------------- #
# Criterion 1: a correctly signed nonce returns 200 with both tokens
# --------------------------------------------------------------------------- #


def test_verify_with_a_correctly_signed_nonce_returns_200_with_tokens(client):
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    nonce = ask_for_nonce(client, did)

    response = client.post(URL, json=verify_body(seed, did, nonce))

    assert response.status_code == 200, response.text
    body = response.json()
    for field in TOKEN_FIELDS:
        assert field in body, f"response is missing the {field!r} field"
        assert isinstance(body[field], str) and body[field], (
            f"the {field!r} field must be a non-empty string"
        )


# --------------------------------------------------------------------------- #
# Criterion 2: a reused nonce returns 401 problem details
# --------------------------------------------------------------------------- #


def test_verify_with_a_reused_nonce_returns_401_problem_details(client):
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    nonce = ask_for_nonce(client, did)
    body = verify_body(seed, did, nonce)

    # The nonce's first use is a correct sign-in (criterion 1's scenario):
    # only then is the second request a *reused* nonce.  Ed25519 is
    # deterministic, so re-signing would yield the same body anyway.
    first = client.post(URL, json=body)
    assert first.status_code == 200, first.text

    second = client.post(URL, json=body)

    assert_problem_details(second, 401)


# --------------------------------------------------------------------------- #
# Criterion 3: a signature from another key returns 401 problem details
# --------------------------------------------------------------------------- #


def test_verify_with_a_signature_from_another_key_returns_401_problem_details(
    client,
):
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    nonce = ask_for_nonce(client, did)

    # A different Ed25519 key signs the same nonce: the signature is
    # well-formed and really over the nonce, but not the key behind
    # the did the challenge was issued to.
    imposter = SigningKey.generate()
    response = client.post(
        URL,
        json={
            "did": did,
            "nonce": nonce,
            "signature": sign_nonce(imposter, nonce),
        },
    )

    assert_problem_details(response, 401)
