"""Tests for ``POST /v1/credentials/present`` (feature 35).

Covers the mounted route, the ``200 {"verified": true}`` answer for every
accepted request shape (the credential itself, a wrapper, a W3C presentation),
and every refusal: a tampered credential signature, a missing signature, a
revoked or expired credential, a revoked local ``credentials`` row, and a bad
presentation proof -- each as ``422`` problem details naming the failing check.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from scholium_record_core import encode_signature, did_key_from_signing_key

from app import db
from app.modules.orcid.models import Credential

URL = "/v1/credentials/present"
PROBLEM_JSON = "application/problem+json"


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    assert isinstance(body.get("detail"), str) and body["detail"], body
    return body


def _canonical(document: dict) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sign(document: dict, key) -> str:
    return encode_signature(bytes(key.sign(_canonical(document)).signature))


# --------------------------------------------------------------------------- #
# Routing
# --------------------------------------------------------------------------- #


def test_route_is_mounted_by_the_module_loader(client):
    assert "post" in client.get("/openapi.json").json()["paths"][URL]


# --------------------------------------------------------------------------- #
# Success
# --------------------------------------------------------------------------- #


def test_a_genuine_credential_verifies(client, credential):
    response = client.post(URL, json=credential)

    assert response.status_code == 200, response.text
    assert response.json() == {"verified": True}


@pytest.mark.parametrize(
    "wrap",
    [
        lambda credential: {"credential": credential},
        lambda credential: {"vc": credential},
        lambda credential: {"verifiableCredential": credential},
        lambda credential: {"verifiableCredential": [credential]},
        lambda credential: {
            "@context": "https://www.w3.org/2018/credentials/v1",
            "type": ["VerifiablePresentation"],
            "verifiableCredential": [credential],
        },
        lambda credential: {"presentation": {"verifiableCredential": [credential]}},
    ],
)
def test_every_accepted_request_shape_verifies(client, credential, wrap):
    response = client.post(URL, json=wrap(credential))

    assert response.status_code == 200, response.text
    assert response.json() == {"verified": True}


def test_a_credential_from_another_node_verifies(client, credential):
    """Verification is cryptographic: no local ``credentials`` row is needed."""
    with db.SessionLocal() as session:
        session.query(Credential).filter(Credential.did == credential["credentialSubject"]["id"]).delete()
        session.commit()

    assert client.post(URL, json=credential).json() == {"verified": True}


# --------------------------------------------------------------------------- #
# Credential signature failures
# --------------------------------------------------------------------------- #


def test_a_tampered_credential_body_is_refused(client, credential):
    credential["credentialSubject"]["orcid"] = "0000-0000-0000-0000"

    body = assert_problem(client.post(URL, json=credential), 422)

    assert "signature" in body["detail"].lower()
    assert body["errors"][0]["check"] == "signature"


def test_a_tampered_signature_is_refused(client, credential):
    credential["proof"]["proofValue"] = encode_signature(bytes(64))

    body = assert_problem(client.post(URL, json=credential), 422)

    assert "signature" in body["detail"].lower()


def test_a_credential_without_a_signature_is_refused(client, credential):
    del credential["proof"]
    del credential["signature"]

    body = assert_problem(client.post(URL, json=credential), 422)

    assert "signature" in body["detail"].lower()


def test_a_credential_signed_by_another_key_is_refused(client, credential, node_key):
    # Re-sign the document as if it were genuine, but under a different key: the
    # issuer did:key no longer matches, so verification must fail.
    from nacl.signing import SigningKey

    forged = {key: value for key, value in credential.items() if key not in ("proof", "signature", "node_did")}
    forged["proof"] = {
        "type": "Ed25519Signature2020",
        "proofValue": _sign(forged, SigningKey.generate()),
    }

    assert_problem(client.post(URL, json=forged), 422)


@pytest.mark.parametrize("payload", [{}, {"hello": "world"}, {"credential": "not-json"}, []])
def test_a_request_without_a_credential_is_refused(client, payload):
    body = assert_problem(client.post(URL, json=payload), 422)

    assert "credential" in body["detail"].lower()


# --------------------------------------------------------------------------- #
# Status failures
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("status", ["revoked", "suspended", "expired", "invalid"])
def test_a_credential_with_a_bad_declared_status_is_refused(client, credential, status):
    credential["status"] = status

    body = assert_problem(client.post(URL, json=credential), 422)

    assert "status" in body["detail"].lower()
    assert body["errors"][0]["check"] == "status"


def test_a_revoked_local_credentials_row_is_refused(client, credential):
    subject = credential["credentialSubject"]["id"]
    with db.SessionLocal() as session:
        row = session.query(Credential).filter(Credential.did == subject).one()
        row.status = "revoked"
        session.commit()

    body = assert_problem(client.post(URL, json=credential), 422)

    assert "status" in body["detail"].lower()


def test_an_expired_credential_is_refused(client, credential):
    credential["expirationDate"] = (
        datetime.now(timezone.utc) - timedelta(days=1)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    body = assert_problem(client.post(URL, json=credential), 422)

    assert "expire" in body["detail"].lower()


def test_a_valid_declared_status_still_verifies(client, credential):
    credential["status"] = "valid"

    assert client.post(URL, json=credential).json() == {"verified": True}


def test_a_credential_status_object_is_understood(client, credential):
    credential["credentialStatus"] = {"type": "BitstringStatusListEntry", "revoked": True}

    assert_problem(client.post(URL, json=credential), 422)


# --------------------------------------------------------------------------- #
# Presentation signatures
# --------------------------------------------------------------------------- #


def _presentation(credential, holder_key):
    holder = did_key_from_signing_key(holder_key)
    presentation = {
        "@context": "https://www.w3.org/2018/credentials/v1",
        "type": ["VerifiablePresentation"],
        "holder": holder,
        "verifiableCredential": [credential],
    }
    presentation["proof"] = {
        "type": "Ed25519Signature2020",
        "verificationMethod": f"{holder}#key-1",
        "proofPurpose": "authentication",
        "proofValue": _sign(presentation, holder_key),
    }
    return presentation


def test_a_signed_presentation_verifies(client, credential):
    from nacl.signing import SigningKey

    presentation = _presentation(credential, SigningKey.generate())

    response = client.post(URL, json=presentation)

    assert response.status_code == 200, response.text
    assert response.json() == {"verified": True}


def test_a_signed_presentation_in_a_wrapper_verifies(client, credential):
    from nacl.signing import SigningKey

    presentation = _presentation(credential, SigningKey.generate())
    wrapper = {"presentation": presentation}

    assert client.post(URL, json=wrapper).status_code == 200


def test_a_tampered_presentation_proof_is_refused(client, credential):
    from nacl.signing import SigningKey

    presentation = _presentation(credential, SigningKey.generate())
    presentation["verifiableCredential"][0]["credentialSubject"]["orcid"] = "0000-0000-0000-0000"

    body = assert_problem(client.post(URL, json=presentation), 422)

    assert "presentation signature" in body["detail"].lower()


def test_a_presentation_signed_by_another_key_is_refused(client, credential):
    from nacl.signing import SigningKey

    presentation = _presentation(credential, SigningKey.generate())
    presentation["proof"]["proofValue"] = _sign(
        {key: value for key, value in presentation.items() if key != "proof"},
        SigningKey.generate(),
    )

    body = assert_problem(client.post(URL, json=presentation), 422)

    assert "presentation signature" in body["detail"].lower()


def test_a_presentation_proof_without_a_holder_is_refused(client, credential):
    from nacl.signing import SigningKey

    presentation = _presentation(credential, SigningKey.generate())
    del presentation["holder"]
    del presentation["proof"]["verificationMethod"]

    assert_problem(client.post(URL, json=presentation), 422)
