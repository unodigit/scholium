"""Tests for GET /v1/records/{cid} (feature 15).

Covers: the endpoint contract (200, the stored envelope as JSON with every
envelope field), the round-trip property (the served JSON recomputes to
the cid in the URL, so a client needs no trust in the node), envelopes
appended without an ``id`` (the ledger computes one), ``sig`` not being
retained by the log, and 404 problem details for unknown cids.

Isolation note: like test_append.py and test_sync_range.py, these tests
share whatever database the engine bound with the rest of the worker's
run.  Reads are keyed by cids unique to this test (uuid-tagged), which the
table's UNIQUE constraint keeps collision-free, and the unknown-cid tests
ask for cids that cannot exist; nothing anchors on a particular chain
head.
"""

from __future__ import annotations

import uuid

import pytest
from scholium_record_core import compute_record_id

from app.modules import ledger

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
PROBLEM_JSON = "application/problem+json"

#: Exactly the fields a served envelope carries: the seven content fields
#: the record id commits to, plus ``id``.
ENVELOPE_KEYS = {"v", "type", "author", "created", "prev", "body", "proofs", "id"}


def make_envelope(*, record_type: str = "test.ledger.records", with_id: bool = True, with_sig: bool = False):
    tag = uuid.uuid4().hex
    envelope = {
        "v": 1,
        "type": record_type,
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": f"bafyreiprev{tag}",
        "body": {"title": "A Study", "tag": tag, "nested": {"nums": [1, 2, 3], "flag": True}},
        "proofs": [{"alg": "ed25519", "value": f"sig-{tag}"}],
    }
    if with_id:
        envelope["id"] = f"bafyreirecord{tag}"
    if with_sig:
        envelope["sig"] = f"test-signature-{tag}"
    return envelope


# --------------------------------------------------------------------------- #
# The endpoint contract
# --------------------------------------------------------------------------- #


def test_get_returns_the_stored_envelope_as_json(client):
    envelope = make_envelope()
    entry = ledger.append(envelope)

    response = client.get(f"/v1/records/{entry.record_cid}")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    served = response.json()
    # Exactly the envelope: every content field as appended, plus the id.
    assert set(served) == ENVELOPE_KEYS
    assert served["v"] == envelope["v"]
    assert served["type"] == envelope["type"]
    assert served["author"] == envelope["author"]
    assert served["created"] == envelope["created"]
    assert served["prev"] == envelope["prev"]
    assert served["body"] == envelope["body"]
    assert served["proofs"] == envelope["proofs"]
    assert served["id"] == entry.record_cid


def test_the_served_json_recomputes_to_the_cid_in_the_url(client):
    # No 'id': the ledger computes the record id from the content fields.
    entry = ledger.append(make_envelope(with_id=False))

    response = client.get(f"/v1/records/{entry.record_cid}")

    assert response.status_code == 200
    served = response.json()
    assert served["id"] == entry.record_cid
    # A client that trusts nothing re-derives the id from the served JSON
    # alone and gets the cid it asked for.
    assert compute_record_id(served) == entry.record_cid


def test_a_sig_field_is_not_part_of_the_served_document(client):
    # 'sig' is excluded from the record id and is not a column of the log;
    # it is verified at ingest, not retained.
    envelope = make_envelope(with_sig=True)
    entry = ledger.append(envelope)

    response = client.get(f"/v1/records/{entry.record_cid}")

    assert response.status_code == 200
    served = response.json()
    assert "sig" not in served
    content = {k: envelope[k] for k in ("v", "type", "author", "created", "prev", "body", "proofs")}
    assert served == {**content, "id": entry.record_cid}


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


def test_an_unknown_cid_is_a_404_problem(client):
    cid = f"bafyreianother{uuid.uuid4().hex}"

    response = client.get(f"/v1/records/{cid}")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    problem = response.json()
    assert problem["status"] == 404
    assert problem["title"] == "Not Found"
    assert problem["type"] == ledger.RECORD_NOT_FOUND_TYPE
    assert cid in problem["detail"]
    assert problem["instance"] == f"/v1/records/{cid}"


def test_a_well_formed_but_unstored_cid_is_a_404_problem(client):
    # A real record id that was simply never appended here is unknown too.
    cid = compute_record_id(make_envelope())

    response = client.get(f"/v1/records/{cid}")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["status"] == 404


@pytest.mark.parametrize(
    "cid",
    [
        "not-a-cid",
        "bafyreiUPPERCASE",
        "0xdeadbeef",
        "does-not-exist-anywhere",
        "x" * 120,  # long garbage stays a 404, not a 414/500
    ],
)
def test_a_cid_that_is_not_a_record_id_at_all_is_a_404_problem(client, cid):
    response = client.get(f"/v1/records/{cid}")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["status"] == 404
