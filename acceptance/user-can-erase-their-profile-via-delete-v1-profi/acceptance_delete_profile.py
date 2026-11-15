"""Acceptance tests for: user can erase their profile via DELETE /v1/profiles/{did} (feature 30).

Erasure on this API is crypto-shredding: the per-object key that decrypts
``profile.enc_blob`` is deleted, an ``erasure.request`` record is appended to
the event log, and the caller receives a ``202``.  What must survive is
exactly what was signed: the user's records keep verifying and keep being
served, because a record's authority is its own signature, never the profile.

Each test plays the whole user journey through the public API only:

* a fresh Ed25519 identity signs in the real way (``/v1/auth/challenge`` then
  ``/v1/auth/verify``, features 23-24), so the caller is the token's own DID
  at tier 0 -- the plainest reading of "the owner";
* the profile is saved through the already-built ``PUT /v1/profiles/{did}``
  (feature 28), so there really is a key to shred, with values unique to this
  run so parallel workers never see each other's rows;
* the record the user signs is built and signed with the project's own record
  core (``scholium_record_core.sign_record``) and appended through the
  already-built ``POST /v1/records`` (feature 20) under a probe handler for a
  real Phase 1 type, set aside and restored afterwards exactly as the POST
  /v1/records acceptance suite does.

Criteria (app_spec.xml, feature 30):

* DELETE /v1/profiles/{did} by the owner returns 202.
* After erasure GET /v1/profiles/{did} returns the DID with null name,
  affiliation and email.
* After erasure GET /v1/records/{cid} for a record the user signed still
  returns the signed envelope.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_record_id,
    did_key_from_signing_key,
    encode_signature,
    sign_record,
)

from app.modules import ingest

#: A real Phase 1 record type whose body schema needs no other record to
#: exist (an endorsement names a DID and a category).
RECORD_TYPE = "endorsement"


def _probe_handler(*args, **kwargs):
    """Stands in for the type's real handler; the default "accepted" is fine."""
    return None


@pytest.fixture
def registered_type():
    """Make ``RECORD_TYPE`` a known type that any tier may submit.

    A real handler registered for the type by another feature is set aside
    for the duration of the test and put back afterwards.
    """
    previous = ingest.get(RECORD_TYPE)
    if previous is not None:
        ingest.unregister(RECORD_TYPE)
    ingest.register(RECORD_TYPE, _probe_handler, min_tier=0)
    try:
        yield RECORD_TYPE
    finally:
        ingest.unregister(RECORD_TYPE)
        if previous is not None:
            ingest.register(RECORD_TYPE, previous.handler, previous.min_tier)


class Owner:
    """A signed-in user: the DID whose profile these tests erase."""

    def __init__(self, client) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

        challenge = client.post("/v1/auth/challenge", json={"did": self.did})
        assert challenge.status_code == 200, challenge.text
        nonce = challenge.json()["nonce"]
        signature = encode_signature(bytes(self.seed.sign(nonce.encode("utf-8")).signature))
        verify = client.post(
            "/v1/auth/verify", json={"did": self.did, "nonce": nonce, "signature": signature}
        )
        assert verify.status_code == 200, verify.text
        self.headers = {"Authorization": f"Bearer {verify.json()['access_token']}"}

        # Unique per run: a name that shows up after erasure is this test's.
        tag = uuid.uuid4().hex
        self.profile = {
            "name": f"Ada {tag}",
            "affiliation": f"Analytical Engine Co. {tag}",
            "email": f"ada.{tag}@example.org",
        }

    def save_profile(self, client) -> None:
        """Save this owner's profile (feature 28); a setup guard, not the test."""
        response = client.put(f"/v1/profiles/{self.did}", json=self.profile, headers=self.headers)
        assert response.status_code == 200, response.text

    def erase(self, client):
        """DELETE this owner's profile: the endpoint under test."""
        return client.delete(f"/v1/profiles/{self.did}", headers=self.headers)

    def signed_record(self) -> dict:
        """A complete, correctly signed record authored by this owner."""
        return sign_record(
            {
                "v": 1,
                "type": RECORD_TYPE,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": None,
                "body": {
                    "endorsee": did_key_from_signing_key(SigningKey.generate()),
                    "category": "cs.CR",
                    "statement": f"acceptance {uuid.uuid4().hex}",
                },
                "proofs": [],
            },
            self.seed,
        )


@pytest.fixture
def owner(client) -> Owner:
    return Owner(client)


# --------------------------------------------------------------------------- #
# Criterion 1: DELETE /v1/profiles/{did} by the owner returns 202
# --------------------------------------------------------------------------- #


def test_delete_by_the_owner_returns_202(client, owner):
    owner.save_profile(client)

    response = owner.erase(client)

    assert response.status_code == 202, response.text


# --------------------------------------------------------------------------- #
# Criterion 2: after erasure GET shows the DID with null personal fields
# --------------------------------------------------------------------------- #


def test_after_erasure_get_returns_the_did_with_null_name_affiliation_and_email(client, owner):
    owner.save_profile(client)
    # Guard the setup: the profile was readable before the erasure.
    before = client.get(f"/v1/profiles/{owner.did}")
    assert before.status_code == 200, before.text
    assert before.json()["name"] == owner.profile["name"], before.text

    response = owner.erase(client)
    assert response.status_code == 202, response.text

    after = client.get(f"/v1/profiles/{owner.did}")
    assert after.status_code == 200, after.text
    body = after.json()
    assert body["did"] == owner.did, body
    for field in ("name", "affiliation", "email"):
        assert body[field] is None, f"after erasure {field} must be null, got {body[field]!r}"


# --------------------------------------------------------------------------- #
# Criterion 3: after erasure the user's signed record is still served
# --------------------------------------------------------------------------- #


def test_after_erasure_get_still_returns_the_signed_envelope_of_a_record_the_user_signed(
    client, owner, registered_type
):
    owner.save_profile(client)
    record = owner.signed_record()
    submitted = client.post("/v1/records", json=record, headers=owner.headers)
    assert submitted.status_code == 201, submitted.text
    # Guard the setup: the ledger serves the record before the erasure.
    assert client.get(f"/v1/records/{record['id']}").status_code == 200

    response = owner.erase(client)
    assert response.status_code == 202, response.text

    served = client.get(f"/v1/records/{record['id']}")
    assert served.status_code == 200, served.text
    envelope = served.json()
    # It is the same signed envelope: it names itself with the record's cid,
    # it is authored by the erased user, and it still carries the signed body.
    assert envelope["id"] == record["id"], envelope
    assert envelope["author"] == owner.did, envelope
    assert envelope["type"] == RECORD_TYPE, envelope
    assert envelope["body"] == record["body"], envelope
    # ...and it still verifies: the served content fields hash to the cid in
    # the URL, which is the very thing the user's signature committed to.
    assert compute_record_id(envelope) == record["id"], envelope
