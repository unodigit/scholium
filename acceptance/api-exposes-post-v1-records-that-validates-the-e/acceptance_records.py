"""Acceptance tests for: API exposes POST /v1/records (feature 20).

Every write on this API is a client-signed record envelope::

    {"v": 1, "type": ..., "author": did, "created": ..., "prev": ...,
     "body": {...}, "proofs": [...], "id": cid, "sig": signature}

``POST /v1/records`` validates that envelope, recomputes its CID, checks the
signature against the author's key, runs the type handler and appends the
record to the ledger.  The criteria pin down three ways a submission is
refused, so this suite sends the endpoint records that are sound in every
respect *except* the one the criterion names:

* the record is built and signed with the project's own record core
  (``scholium_record_core.sign_record``), so ``id`` is the recomputed CID and
  ``sig`` is a real Ed25519 signature by ``author`` over the canonical bytes;
* its type is a real Phase 1 type (``endorsement``) with a body that
  validates against that type's schema, and a handler is registered for it
  in the ingest registry at ``min_tier=0``.  Whatever order the pipeline
  checks things in, the only thing wrong with the record is then the thing
  the test breaks.  The probe handler is never called -- every record here is
  refused before the handler would run -- so these tests do not depend on the
  handler calling convention.  The registration is undone afterwards (and any
  real handler for the type restored);
* the author has signed in, so an account exists for them as it does for any
  real author, and the request carries their access token.  Records are
  self-authenticating, so the token is not what these tests are about.

Criteria (app_spec.xml, feature 20):

* POST /v1/records with an id that does not match the recomputed CID returns
  422 problem details.
* POST /v1/records with a signature made by a different key returns 401
  problem details.
* POST /v1/records with an unknown record type returns 422 problem details.

A refused record must not reach the ledger, so each test also checks that
``GET /v1/records/{cid}`` still answers 404 for the record's cid(s).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    RECORD_TYPES,
    did_key_from_signing_key,
    encode_signature,
    sign_envelope,
    sign_record,
    validate_envelope,
    verify_record,
)

from app.modules import ingest

#: The endpoint under test.
URL = "/v1/records"

#: RFC 9457 media type every API error on this app is served as.
PROBLEM_JSON = "application/problem+json"

#: A real Phase 1 record type whose body schema needs no other record to
#: exist (an endorsement names a DID and a category).
RECORD_TYPE = "endorsement"

#: A record type nobody registered a handler or a schema for.
UNKNOWN_RECORD_TYPE = "acceptance.no-such-record-type"


def _probe_handler(*args, **kwargs):
    """Stands in for the type's real handler; never reached by these tests."""
    return None


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def registered_type():
    """Make ``RECORD_TYPE`` a known type that any tier may submit.

    A real handler registered for the type by a later feature is set aside
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


def _sign_in(client, seed: SigningKey) -> str:
    """Sign ``seed``'s did:key in (challenge, then verify); return the access token."""
    did = did_key_from_signing_key(seed)
    challenge = client.post("/v1/auth/challenge", json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = client.post(
        "/v1/auth/verify", json={"did": did, "nonce": nonce, "signature": signature}
    )
    assert verify.status_code == 200, verify.text
    return verify.json()["access_token"]


class Author:
    """A signed-in author who can build correctly signed records."""

    def __init__(self, client) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        token = _sign_in(client, self.seed)
        self.headers = {"Authorization": f"Bearer {token}"}

    def unsigned(self, record_type: str = RECORD_TYPE) -> dict:
        """The seven content fields of a fresh, schema-valid record.

        The body carries a unique tag, so every call yields a different cid.
        """
        return {
            "v": 1,
            "type": record_type,
            "author": self.did,
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "endorsee": did_key_from_signing_key(SigningKey.generate()),
                "category": "cs.CR",
                "statement": f"acceptance {uuid.uuid4().hex}",
            },
            "proofs": [],
        }

    def record(self, record_type: str = RECORD_TYPE) -> dict:
        """A complete record: ``id`` is the recomputed CID, ``sig`` is this author's."""
        record = sign_record(self.unsigned(record_type), self.seed)
        # Guard the fixture itself: the record is intact, so a refusal below
        # can only come from what the test then breaks.
        assert verify_record(record)
        if record_type in RECORD_TYPES:
            assert validate_envelope(record) == []
        return record


@pytest.fixture
def author(client) -> Author:
    return Author(client)


# --------------------------------------------------------------------------- #
# Assertions
# --------------------------------------------------------------------------- #


def assert_problem_details(response, status: int) -> dict:
    """Assert ``response`` is an RFC 9457 problem document with ``status``.

    Only what "returns problem details" states: the problem media type and
    the document's own status matching the HTTP status, plus the ``title``
    every problem document on this API carries.  The ``type`` URN is
    deliberately not pinned.
    """
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), (
        f"a {status} must be served as {PROBLEM_JSON}, "
        f"got {response.headers['content-type']!r}"
    )
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def assert_not_in_ledger(client, *cids: str) -> None:
    """A refused record is not appended: its cid is unknown to the ledger."""
    for cid in cids:
        response = client.get(f"/v1/records/{cid}")
        assert response.status_code == 404, (
            f"a refused record must not be stored, but GET /v1/records/{cid} "
            f"answered {response.status_code}"
        )


# --------------------------------------------------------------------------- #
# Criterion 1: an id that does not match the recomputed CID returns 422
# --------------------------------------------------------------------------- #


def test_post_with_an_id_that_does_not_match_the_recomputed_cid_returns_422_problem_details(
    client, author, registered_type
):
    record = author.record()
    # A well-formed record id that belongs to a *different* record.  The
    # signature covers the content fields only (never ``id``), so it is
    # still a valid signature by the author: the id is the only defect.
    other = author.record()
    assert other["id"] != record["id"]
    submitted = {**record, "id": other["id"]}

    response = client.post(URL, json=submitted, headers=author.headers)

    assert_problem_details(response, 422)
    assert_not_in_ledger(client, record["id"], other["id"])


# --------------------------------------------------------------------------- #
# Criterion 2: a signature made by a different key returns 401
# --------------------------------------------------------------------------- #


def test_post_with_a_signature_made_by_a_different_key_returns_401_problem_details(
    client, author, registered_type
):
    record = author.record()
    # A different Ed25519 key signs the very same canonical bytes: the
    # signature is well-formed and really over this record, but it is not by
    # the key behind ``author``.  ``id`` is the correct recomputed CID.
    imposter = SigningKey.generate()
    forged_sig = sign_envelope(record, imposter)
    assert forged_sig != record["sig"]
    submitted = {**record, "sig": forged_sig}

    response = client.post(URL, json=submitted, headers=author.headers)

    assert_problem_details(response, 401)
    assert_not_in_ledger(client, record["id"])


# --------------------------------------------------------------------------- #
# Criterion 3: an unknown record type returns 422
# --------------------------------------------------------------------------- #


def test_post_with_an_unknown_record_type_returns_422_problem_details(client, author):
    # Truly unknown: no Phase 1 schema and no registered handler.
    assert UNKNOWN_RECORD_TYPE not in RECORD_TYPES
    assert ingest.get(UNKNOWN_RECORD_TYPE) is None

    # Otherwise sound: ``id`` is the recomputed CID and ``sig`` is the
    # author's own signature over the canonical bytes, so the type is the
    # only thing the endpoint can object to.
    record = author.record(UNKNOWN_RECORD_TYPE)

    response = client.post(URL, json=record, headers=author.headers)

    assert_problem_details(response, 422)
    assert_not_in_ledger(client, record["id"])
