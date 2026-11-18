"""Tests for ``POST /v1/records`` (feature 20).

Covers the whole pipeline: the 201 body (``id``, ``shortId``, ``state``,
``anchor``) and the stored envelope, the handler contract, and every refusal
-- invalid envelope, invalid body, unregistered type, id/CID mismatch, a
signature by another key, a duplicate cid and an unauthenticated caller --
plus the guarantee that a refused record never reaches the ledger.

Isolation: every test builds its own Ed25519 key, its own unique body (so a
unique cid) and registers only the handler(s) it needs, restoring any previous
registration afterwards.  Record types are process-global, so nothing here
assumes a particular registry state.
"""

import contextlib
import uuid
from datetime import datetime, timezone

from nacl.signing import SigningKey
from scholium_record_core import (
    compute_record_id,
    derive_short_id,
    did_key_from_signing_key,
    format_version_id,
    sign_envelope,
    sign_record,
)

from app.errors import ProblemException
from app.modules import ingest
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _probe_handler(*args, **kwargs):
    """A handler that accepts everything and reports nothing."""
    return None


@contextlib.contextmanager
def use_handler(record_type, handler=None, min_tier=0):
    """Register ``handler`` for ``record_type`` for the length of a test.

    A registration a real module installed is set aside and put back.
    """
    previous = ingest.get(record_type)
    if previous is not None:
        ingest.unregister(record_type)
    ingest.register(record_type, handler or _probe_handler, min_tier=min_tier)
    try:
        yield record_type
    finally:
        ingest.unregister(record_type)
        if previous is not None:
            ingest.register(record_type, previous.handler, previous.min_tier)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Author:
    """A signed-in author who can build correctly signed records."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}

    def unsigned(self, record_type: str = "endorsement", body=None) -> dict:
        return {
            "v": 1,
            "type": record_type,
            "author": self.did,
            "created": now(),
            "prev": None,
            "body": body if body is not None else endorsement_body(),
            "proofs": [],
        }

    def record(self, record_type: str = "endorsement", body=None) -> dict:
        return sign_record(self.unsigned(record_type, body), self.seed)


def endorsement_body() -> dict:
    return {
        "endorsee": did_key_from_signing_key(SigningKey.generate()),
        "category": "cs.CR",
        "statement": f"test {uuid.uuid4().hex}",
    }


def genesis_body() -> dict:
    return {
        "title": "A verifiable preprint",
        "categories": ["cs.CR"],
        "licence": "CC-BY-4.0",
    }


def version_body(genesis_id: str) -> dict:
    return {
        "paper": genesis_id,
        "n": 1,
        "title": "A verifiable preprint",
        "abstract": "Abstract.",
        "authors": [{"did": did_key_from_signing_key(SigningKey.generate())}],
        "manifest": "bafyreifakemanifestcid",
        "licence": "CC-BY-4.0",
        "changeNote": "Initial version.",
    }


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def stored(client, cid: str):
    """GET the stored envelope, or ``None`` when the ledger does not know it."""
    response = client.get(f"/v1/records/{cid}")
    return response.json() if response.status_code == 200 else None


# --------------------------------------------------------------------------- #
# The success path
# --------------------------------------------------------------------------- #


def test_a_valid_record_returns_201_with_the_cid_state_and_anchor(client):
    author = Author()
    record = author.record()
    with use_handler("endorsement"):
        response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {
        "id": record["id"],
        "shortId": None,
        "state": "accepted",
        "anchor": "pending",
    }

    # Appended to the ledger, and served back in its stored form.
    envelope = stored(client, record["id"])
    assert envelope is not None
    assert envelope["id"] == record["id"]
    assert envelope["type"] == "endorsement"
    assert envelope["author"] == author.did
    assert envelope["body"] == record["body"]


def test_the_handler_reported_state_is_returned(client):
    author = Author()

    def handler(record):
        return {"state": "moderation"}

    with use_handler("endorsement", handler):
        response = client.post(URL, json=author.record(), headers=author.headers)

    assert response.status_code == 201, response.text
    assert response.json()["state"] == "moderation"


def test_a_handler_may_return_a_plain_state_string(client):
    author = Author()

    def handler(record):
        return "queued"

    record = author.record()
    with use_handler("endorsement", handler):
        response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    assert response.json()["state"] == "queued"
    assert stored(client, record["id"]) is not None


def test_a_paper_genesis_record_reports_the_paper_short_id(client):
    author = Author()
    record = author.record("paper.genesis", genesis_body())

    with use_handler("paper.genesis"):
        response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    assert response.json()["shortId"] == derive_short_id(record["id"])


def test_a_paper_version_record_reports_its_version_id(client):
    author = Author()
    genesis = author.record("paper.genesis", genesis_body())
    version = author.record("paper.version", version_body(genesis["id"]))

    with use_handler("paper.genesis"), use_handler("paper.version"):
        assert client.post(URL, json=genesis, headers=author.headers).status_code == 201
        response = client.post(URL, json=version, headers=author.headers)

    assert response.status_code == 201, response.text
    expected = format_version_id(derive_short_id(genesis["id"]), 1)
    assert response.json()["shortId"] == expected


# --------------------------------------------------------------------------- #
# Refusals, and the ledger never sees them
# --------------------------------------------------------------------------- #


def test_an_id_that_is_not_the_recomputed_cid_is_refused(client):
    author = Author()
    record = author.record()
    other = author.record()
    submitted = {**record, "id": other["id"]}

    with use_handler("endorsement"):
        response = client.post(URL, json=submitted, headers=author.headers)

    body = assert_problem(response, 422)
    assert body["type"] == ingest.RECORD_ID_MISMATCH
    assert stored(client, record["id"]) is None
    assert stored(client, other["id"]) is None


def test_a_signature_by_another_key_is_refused(client):
    author = Author()
    imposter = SigningKey.generate()
    record = author.record()
    # A well-formed signature over exactly this record's bytes, made by a key
    # that is not the author's.  ``id`` is untouched, so it still matches.
    submitted = {**record, "sig": sign_envelope(record, imposter)}
    assert submitted["sig"] != record["sig"]

    with use_handler("endorsement"):
        response = client.post(URL, json=submitted, headers=author.headers)

    body = assert_problem(response, 401)
    assert body["type"] == ingest.INVALID_RECORD_SIGNATURE
    assert stored(client, record["id"]) is None


def test_the_signature_is_checked_against_the_authors_active_key(client, monkeypatch):
    """A rotated-in key signs for the DID; the signature verifies (feature 27)."""
    author = Author()
    new_seed = SigningKey.generate()
    new_did = did_key_from_signing_key(new_seed)
    envelope = author.unsigned()
    record = {
        **envelope,
        "id": compute_record_id(envelope),
        "sig": sign_envelope(envelope, new_seed),
    }

    monkeypatch.setattr(
        "app.modules.identity.resolve_active_key", lambda did: new_did, raising=False
    )
    with use_handler("endorsement"):
        response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    assert response.json()["id"] == record["id"]


def test_a_record_signed_by_a_rotated_out_key_is_refused(client, monkeypatch):
    author = Author()
    record = author.record()
    new_did = did_key_from_signing_key(SigningKey.generate())

    monkeypatch.setattr(
        "app.modules.identity.resolve_active_key", lambda did: new_did, raising=False
    )
    with use_handler("endorsement"):
        response = client.post(URL, json=record, headers=author.headers)

    assert_problem(response, 401)
    assert stored(client, record["id"]) is None


def test_an_active_key_may_be_a_raw_public_key(client, monkeypatch):
    author = Author()
    new_seed = SigningKey.generate()
    envelope = author.unsigned()
    record = {
        **envelope,
        "id": compute_record_id(envelope),
        "sig": sign_envelope(envelope, new_seed),
    }

    monkeypatch.setattr(
        "app.modules.identity.resolve_active_key",
        lambda did: bytes(new_seed.verify_key).hex(),
        raising=False,
    )
    with use_handler("endorsement"):
        response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text


def test_a_missing_signature_is_refused(client):
    author = Author()
    record = author.record()
    submitted = {key: value for key, value in record.items() if key != "sig"}

    with use_handler("endorsement"):
        response = client.post(URL, json=submitted, headers=author.headers)

    assert_problem(response, 401)
    assert stored(client, record["id"]) is None


def test_a_missing_id_is_refused(client):
    author = Author()
    record = author.record()
    submitted = {key: value for key, value in record.items() if key != "id"}

    with use_handler("endorsement"):
        response = client.post(URL, json=submitted, headers=author.headers)

    body = assert_problem(response, 422)
    assert body["type"] == ingest.INVALID_RECORD


def test_an_unknown_record_type_is_refused(client):
    author = Author()
    record = author.record("acceptance.no-such-record-type")

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 422)
    assert body["type"] == ingest.UNKNOWN_RECORD_TYPE
    assert stored(client, record["id"]) is None


def test_an_invalid_body_is_refused(client):
    author = Author()
    body = endorsement_body()
    del body["category"]
    record = author.record("endorsement", body)

    with use_handler("endorsement"):
        response = client.post(URL, json=record, headers=author.headers)

    problem = assert_problem(response, 422)
    assert problem["type"] == ingest.INVALID_RECORD
    assert stored(client, record["id"]) is None


def test_a_nul_in_any_string_is_refused_and_no_handler_runs(client):
    """PostgreSQL cannot store NUL in text; both dialects refuse it the same way."""
    author = Author()
    body = endorsement_body()
    body["statement"] = "fine\x00not fine"
    record = author.record("endorsement", body)
    calls = []

    with use_handler("endorsement", lambda *a, **k: calls.append(a)):
        response = client.post(URL, json=record, headers=author.headers)

    problem = assert_problem(response, 422)
    assert problem["type"] == ingest.INVALID_RECORD
    assert problem["errors"][0]["loc"] == ["body", "body", "statement"]
    assert calls == []
    assert stored(client, record["id"]) is None


def test_a_nul_in_a_nested_list_or_a_key_is_found_too():
    from app.modules.ingest import service

    assert service._nul_path({"a": {"b": ["x", {"c": "y\x00"}]}}) == ["a", "b", 1, "c"]
    assert service._nul_path({"a": {"k\x00": 1}}) == ["a", "k\x00"]
    assert service._nul_path({"a": ["tab\there", "emoji \U0001f600"], "n": 3}) is None


def test_a_malformed_envelope_is_refused(client):
    author = Author()
    record = author.record()
    record["v"] = "one"

    with use_handler("endorsement"):
        response = client.post(URL, json=record, headers=author.headers)

    assert_problem(response, 422)
    assert stored(client, record["id"]) is None


def test_a_duplicate_cid_is_refused_with_409(client):
    author = Author()
    record = author.record()

    with use_handler("endorsement"):
        first = client.post(URL, json=record, headers=author.headers)
        second = client.post(URL, json=record, headers=author.headers)

    assert first.status_code == 201, first.text
    body = assert_problem(second, 409)
    assert body["type"] == ingest.DUPLICATE_RECORD
    assert stored(client, record["id"]) is not None


def test_a_duplicate_cid_does_not_run_the_handler_again(client):
    author = Author()
    calls = []

    def handler(record):
        calls.append(record["id"])
        return None

    record = author.record()
    with use_handler("endorsement", handler):
        assert client.post(URL, json=record, headers=author.headers).status_code == 201
        duplicate = client.post(URL, json=record, headers=author.headers)

    assert_problem(duplicate, 409)
    assert calls == [record["id"]]


def test_an_unauthenticated_post_is_refused(client):
    author = Author()
    record = author.record()

    with use_handler("endorsement"):
        response = client.post(URL, json=record)

    assert_problem(response, 401)
    assert stored(client, record["id"]) is None


# --------------------------------------------------------------------------- #
# The handler runs only on a record that passed every check
# --------------------------------------------------------------------------- #


def test_a_handler_that_refuses_the_record_keeps_it_out_of_the_ledger(client):
    author = Author()
    record = author.record()

    def handler(record):
        raise ProblemException(422, "this record is not acceptable", type="urn:test:refused")

    with use_handler("endorsement", handler):
        response = client.post(URL, json=record, headers=author.headers)

    assert_problem(response, 422)
    assert stored(client, record["id"]) is None


def test_the_handler_is_not_called_for_a_record_that_fails_validation(client):
    author = Author()
    calls = []

    def handler(record):
        calls.append(record)
        return None

    record = author.record()
    submitted = {**record, "id": author.record()["id"]}

    with use_handler("endorsement", handler):
        response = client.post(URL, json=submitted, headers=author.headers)

    assert response.status_code == 422, response.text
    assert calls == []
