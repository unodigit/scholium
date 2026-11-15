"""Tests for accepting ``manifest`` records (feature 48).

A manifest is accepted only when every file it lists has a row in the content
store's ``blobs`` table whose ``size`` matches the size the manifest declares.
Anything else is ``422`` problem details naming the offending file ``path``,
and the record must never reach the ledger.

Every test stores its own random bytes (so its own cid) and signs its own
record, because the worker's database and ``blobs`` table are shared.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import compute_file_id, did_key_from_signing_key, sign_record

from app.errors import ProblemException
from app.modules import content, ingest
from app.modules.submissions import (
    MANIFEST_TYPE,
    ManifestFileNotStored,
    ManifestFileSizeMismatch,
    handle_manifest,
    validate_manifest_files,
)
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Author:
    """A signed-in caller; manifests need no particular trust tier."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}

    def record(self, files: list[dict]) -> dict:
        unsigned = {
            "v": 1,
            "type": MANIFEST_TYPE,
            "author": self.did,
            "created": now(),
            "prev": None,
            "body": {"files": files},
            "proofs": [],
        }
        return sign_record(unsigned, self.seed)


def stored_blob(size: int = 64):
    """Store fresh random bytes and return the ``blobs`` row."""
    return content.store_bytes(os.urandom(size), media_type="application/pdf")


def unstored_cid(size: int = 7) -> str:
    """A well-formed file cid for bytes that are not in ``blobs``."""
    return compute_file_id(os.urandom(size))


def entry(blob, path: str, **overrides) -> dict:
    """A schema-valid manifest entry for ``blob``; ``overrides`` break a field."""
    value = {
        "path": path,
        "cid": blob.cid,
        "size": blob.size,
        "mediaType": "application/pdf",
        "role": "manuscript",
    }
    value.update(overrides)
    return value


def assert_problem(response, status: int = 422) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def assert_not_in_ledger(client, cid: str) -> None:
    response = client.get(f"/v1/records/{cid}")
    assert response.status_code == 404, response.text


# --------------------------------------------------------------------------- #
# The success path
# --------------------------------------------------------------------------- #


def test_a_manifest_whose_files_are_stored_is_accepted(client):
    author = Author()
    blob = stored_blob(100)
    record = author.record([entry(blob, "paper.pdf")])

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == record["id"]
    assert body["state"] == "accepted"
    # The record reached the ledger, envelope intact.
    stored = client.get(f"/v1/records/{record['id']}")
    assert stored.status_code == 200, stored.text
    assert stored.json()["body"] == record["body"]


def test_every_listed_file_is_checked(client):
    author = Author()
    first = stored_blob(10)
    second = stored_blob(20)
    record = author.record(
        [
            entry(first, "main.tex", role="source"),
            entry(second, "figures/plot.svg", mediaType="image/svg+xml", role="figure"),
        ]
    )

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text


def test_an_empty_file_matches_a_zero_size_blob(client):
    author = Author()
    # Empty bytes are the one content shared by every test (the empty-file cid
    # is a constant), so store them without declaring a media type: a later
    # ``store_bytes(b"")`` must not have its expectation changed here.
    blob = content.store_bytes(b"")
    record = author.record([entry(blob, "empty.txt")])

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text


def test_a_blob_still_being_scanned_is_accepted(client):
    """The feature checks existence and size, not the sanitizer's verdict."""
    author = Author()
    blob = stored_blob(32)
    assert blob.scan_status == content.SCAN_SCANNING
    record = author.record([entry(blob, "paper.pdf")])

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text


def test_only_the_existence_and_size_of_a_blob_are_required(client):
    """A different declared media type is not our refusal to make."""
    author = Author()
    blob = stored_blob(16)
    record = author.record([entry(blob, "paper.pdf", mediaType="application/octet-stream")])

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------- #
# Criterion: a cid that is not in blobs is refused, naming the file path
# --------------------------------------------------------------------------- #


def test_a_manifest_file_with_no_blob_is_refused_naming_the_path(client):
    author = Author()
    blob = stored_blob()
    record = author.record([entry(blob, "paper.pdf", cid=unstored_cid())])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 422)
    assert "paper.pdf" in response.text
    assert "paper.pdf" in str(body["detail"])
    assert any("paper.pdf" in str(error.get("msg")) for error in body["errors"])
    assert_not_in_ledger(client, record["id"])


def test_the_refusal_names_the_offending_file_not_only_the_first(client):
    author = Author()
    good = stored_blob()
    record = author.record(
        [
            entry(good, "paper.pdf"),
            entry(good, "figures/missing.png", cid=unstored_cid()),
        ]
    )

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 422)
    assert "figures/missing.png" in str(body["detail"])
    assert "paper.pdf" not in str(body["detail"])
    assert_not_in_ledger(client, record["id"])


def test_a_malformed_cid_is_also_not_in_blobs(client):
    author = Author()
    record = author.record([entry(stored_blob(), "paper.pdf", cid="not-a-file-cid")])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 422)
    assert "paper.pdf" in str(body["detail"])
    assert_not_in_ledger(client, record["id"])


# --------------------------------------------------------------------------- #
# Criterion: a declared size that disagrees with blobs.size is refused
# --------------------------------------------------------------------------- #


def test_a_size_that_disagrees_with_the_blob_is_refused_naming_the_path(client):
    author = Author()
    blob = stored_blob(128)
    record = author.record([entry(blob, "paper.pdf", size=blob.size + 1)])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 422)
    assert "paper.pdf" in str(body["detail"])
    assert str(blob.size) in str(body["detail"])
    assert_not_in_ledger(client, record["id"])


def test_a_smaller_declared_size_is_refused_too(client):
    author = Author()
    blob = stored_blob(64)
    record = author.record([entry(blob, "figures/plot.svg", size=1)])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 422)
    assert "figures/plot.svg" in str(body["detail"])
    assert_not_in_ledger(client, record["id"])


# --------------------------------------------------------------------------- #
# The handler itself (unit level)
# --------------------------------------------------------------------------- #


def test_the_module_registered_the_manifest_handler():
    registration = ingest.get(MANIFEST_TYPE)
    assert registration is not None
    assert registration.handler is handle_manifest
    # A manifest is relaying a signed statement about bytes that exist; the
    # author entitlement is decided by paper.genesis/paper.version instead.
    assert int(registration.min_tier) == 0


def test_validate_manifest_files_returns_none_for_a_match():
    blob = stored_blob(5)
    record = {"body": {"files": [entry(blob, "a.txt")]}}

    assert validate_manifest_files(record) is None


def test_validate_manifest_files_raises_for_a_missing_blob():
    blob = stored_blob()
    record = {"body": {"files": [entry(blob, "a.txt", cid=unstored_cid())]}}

    with pytest.raises(ManifestFileNotStored) as caught:
        validate_manifest_files(record)

    assert caught.value.path == "a.txt"
    assert caught.value.status_code == 422
    assert "a.txt" in caught.value.detail


def test_validate_manifest_files_raises_for_a_size_mismatch():
    blob = stored_blob(4)
    record = {"body": {"files": [entry(blob, "a.txt", size=5)]}}

    with pytest.raises(ManifestFileSizeMismatch) as caught:
        validate_manifest_files(record)

    assert caught.value.path == "a.txt"
    assert caught.value.declared == 5
    assert caught.value.stored == 4
    assert caught.value.status_code == 422


def test_the_handler_refuses_before_the_pipeline_appends():
    blob = stored_blob()
    record = {"body": {"files": [entry(blob, "a.txt", cid=unstored_cid())]}}

    with pytest.raises(ProblemException):
        handle_manifest(record)


# --------------------------------------------------------------------------- #
# Structural refusals stay 422 problem details
# --------------------------------------------------------------------------- #


def test_a_body_that_lists_no_files_is_refused(client):
    author = Author()
    record = author.record([])

    response = client.post(URL, json=record, headers=author.headers)

    assert_problem(response, 422)
    assert_not_in_ledger(client, record["id"])
