"""Tests for GET /v1/records/{cid}/proof (feature 16).

Covers: the endpoint contract (200, the record's log ``seq`` /
``entry_hash`` / ``prev_hash``, the signed log head and anchor status
``pending``), that a client can re-derive the chain links from the served
envelope without trusting the node, that the embedded head is the same
Ed25519-signed document ``GET /v1/sync/head`` serves and verifies against
its ``node_did``, that the head is the log's *current* head rather than the
record's, and the 404 / 503 problem details.

Isolation note: like test_records.py, these tests share whatever database
the engine bound with the rest of the worker's run.  Reads are keyed by
cids unique to this test (uuid-tagged), and nothing anchors on a particular
chain head: chain links are checked through the previous entry's own proof,
and head assertions are phrased as bounds (``head.seq >= seq``) that an
append-only log cannot violate however other tests interleave.
"""

from __future__ import annotations

import uuid

import pytest
from nacl.signing import SigningKey, VerifyKey
from scholium_record_core import (
    compute_record_id,
    decode_signature,
    public_key_from_did_key,
    record_bytes,
)

from app.modules import ledger

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
PROBLEM_JSON = "application/problem+json"
NODE_KEY_SEED = bytes(range(32))

#: Exactly the fields a proof carries.
PROOF_KEYS = {"seq", "entry_hash", "prev_hash", "head", "anchor"}
#: Exactly the fields of the embedded signed head (same as GET /v1/sync/head).
HEAD_KEYS = {"seq", "entry_hash", "node_did", "signature"}


def make_envelope(*, record_type: str = "test.ledger.proof", with_id: bool = True):
    tag = uuid.uuid4().hex
    envelope = {
        "v": 1,
        "type": record_type,
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": f"bafyreiprev{tag}",
        "body": {"title": "A Study", "tag": tag, "nested": {"nums": [1, 2, 3]}},
        "proofs": [],
    }
    if with_id:
        # A synthetic id: the ledger trusts a present 'id' as the record cid.
        envelope["id"] = f"bafyreiproof{tag}"
    return envelope


@pytest.fixture
def node_key(monkeypatch, tmp_path):
    """Provision a node Ed25519 key (hex seed file) at ``NODE_KEY_PATH``."""
    key_path = tmp_path / "node.key"
    key_path.write_text(NODE_KEY_SEED.hex())
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))
    return SigningKey(NODE_KEY_SEED)


def proof_url(cid: str) -> str:
    return f"/v1/records/{cid}/proof"


def entry_at(seq: int):
    rows = ledger.entries(after=seq - 1, through=seq)
    assert len(rows) == 1, f"event_log has no entry at seq {seq}"
    return rows[0]


# --------------------------------------------------------------------------- #
# The endpoint contract
# --------------------------------------------------------------------------- #


def test_get_returns_the_records_log_position_and_hash_links(client, node_key):
    entry = ledger.append(make_envelope())

    response = client.get(proof_url(entry.record_cid))

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    proof = response.json()
    assert set(proof) == PROOF_KEYS
    assert proof["seq"] == entry.seq
    # 32-byte SHA-256 digests as lowercase hex, the form /v1/sync/range serves.
    assert proof["entry_hash"] == bytes(entry.entry_hash).hex()
    assert proof["prev_hash"] == bytes(entry.prev_hash).hex()
    assert len(proof["entry_hash"]) == len(proof["prev_hash"]) == 64


def test_anchor_status_is_pending(client, node_key):
    entry = ledger.append(make_envelope())

    proof = client.get(proof_url(entry.record_cid)).json()

    assert proof["anchor"] == "pending"
    assert ledger.ANCHOR_PENDING == "pending"


def test_the_embedded_head_has_the_sync_head_shape(client, node_key):
    entry = ledger.append(make_envelope())

    head = client.get(proof_url(entry.record_cid)).json()["head"]

    assert set(head) == HEAD_KEYS
    assert isinstance(head["seq"], int)
    assert len(head["entry_hash"]) == 64
    assert head["node_did"] == ledger.did_key_from_public_key(bytes(node_key.verify_key))


def test_the_proof_is_the_same_for_repeated_requests(client, node_key):
    # Nothing in the record's own part of the proof changes between reads.
    entry = ledger.append(make_envelope())

    first = client.get(proof_url(entry.record_cid)).json()
    second = client.get(proof_url(entry.record_cid)).json()

    for field in ("seq", "entry_hash", "prev_hash", "anchor"):
        assert first[field] == second[field]


# --------------------------------------------------------------------------- #
# The hash chain, checked the way a client that trusts nothing would
# --------------------------------------------------------------------------- #


def test_entry_hash_recomputes_from_the_served_envelope_and_prev_hash(client, node_key):
    # No 'id': the ledger computes the real record id, as an ingested record has.
    entry = ledger.append(make_envelope(with_id=False))

    proof = client.get(proof_url(entry.record_cid)).json()
    envelope = client.get(f"/v1/records/{entry.record_cid}").json()

    # entry_hash == sha256(prev_hash || utf8(cid) || raw), raw re-derived from
    # the envelope alone.
    assert compute_record_id(envelope) == entry.record_cid == envelope["id"]
    recomputed = ledger.compute_entry_hash(
        bytes.fromhex(proof["prev_hash"]), envelope["id"], record_bytes(envelope)
    )
    assert recomputed.hex() == proof["entry_hash"]


def test_prev_hash_is_the_previous_entrys_entry_hash(client, node_key):
    ledger.append(make_envelope())
    entry = ledger.append(make_envelope())

    proof = client.get(proof_url(entry.record_cid)).json()

    if proof["seq"] > 1:
        previous = entry_at(proof["seq"] - 1)
        previous_proof = client.get(proof_url(previous.record_cid)).json()
        assert previous_proof["seq"] == proof["seq"] - 1
        assert proof["prev_hash"] == previous_proof["entry_hash"]
    else:  # pragma: no cover - only on a log this record happens to open
        assert proof["prev_hash"] == ledger.GENESIS_PREV_HASH.hex()


# --------------------------------------------------------------------------- #
# The signed log head
# --------------------------------------------------------------------------- #


def test_the_embedded_head_signature_verifies_against_its_node_did(client, node_key):
    entry = ledger.append(make_envelope())

    head = client.get(proof_url(entry.record_cid)).json()["head"]

    verify_key = VerifyKey(public_key_from_did_key(head["node_did"]))
    message = ledger.head_message(head["seq"], bytes.fromhex(head["entry_hash"]), head["node_did"])
    # Raises nacl.exceptions.BadSignatureError when the signature is wrong.
    verify_key.verify(message, decode_signature(head["signature"]))


def test_the_head_covers_the_record(client, node_key):
    entry = ledger.append(make_envelope())

    proof = client.get(proof_url(entry.record_cid)).json()

    # Append-only: the head is at or after the record.  When it is the
    # record's own entry the two hash pairs coincide.
    assert proof["head"]["seq"] >= proof["seq"]
    if proof["head"]["seq"] == proof["seq"]:
        assert proof["head"]["entry_hash"] == proof["entry_hash"]


def test_the_head_is_the_current_head_not_the_records(client, node_key):
    old = ledger.append(make_envelope())
    before = client.get(proof_url(old.record_cid)).json()

    newest = ledger.append(make_envelope())
    after = client.get(proof_url(old.record_cid)).json()

    # The record's own part of the proof does not move ...
    for field in ("seq", "entry_hash", "prev_hash", "anchor"):
        assert after[field] == before[field]
    # ... but the head has advanced past the record to (at least) the newer entry.
    assert after["head"]["seq"] >= newest.seq > before["seq"]
    assert after["head"]["seq"] > before["head"]["seq"] or before["head"]["seq"] >= newest.seq


def test_the_embedded_head_is_what_sync_head_serves(client, node_key):
    entry = ledger.append(make_envelope())

    sync_before = client.get("/v1/sync/head").json()
    proof = client.get(proof_url(entry.record_cid)).json()
    sync_after = client.get("/v1/sync/head").json()

    head = proof["head"]
    assert sync_before["seq"] <= head["seq"] <= sync_after["seq"]
    if sync_before == sync_after:
        # Nothing was appended in between; Ed25519 signatures are
        # deterministic, so the documents are identical byte for byte.
        assert head == sync_before


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


def test_an_unknown_cid_is_a_404_problem(client, node_key):
    cid = f"bafyreianother{uuid.uuid4().hex}"

    response = client.get(proof_url(cid))

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    problem = response.json()
    assert problem["status"] == 404
    assert problem["title"] == "Not Found"
    assert problem["type"] == ledger.RECORD_NOT_FOUND_TYPE
    assert cid in problem["detail"]
    assert problem["instance"] == proof_url(cid)


def test_a_well_formed_but_unstored_cid_is_a_404_problem(client, node_key):
    # A real record id that was simply never appended here is unknown too.
    cid = compute_record_id(make_envelope(with_id=False))

    response = client.get(proof_url(cid))

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["type"] == ledger.RECORD_NOT_FOUND_TYPE


@pytest.mark.parametrize(
    "cid",
    [
        "not-a-cid",
        "bafyreiUPPERCASE",
        "0xdeadbeef",
        "x" * 120,  # long garbage stays a 404, not a 414/500
    ],
)
def test_a_cid_that_is_not_a_record_id_at_all_is_a_404_problem(client, node_key, cid):
    response = client.get(proof_url(cid))

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    assert response.json()["status"] == 404


def test_an_unknown_cid_is_a_404_even_when_the_node_has_no_key(client, monkeypatch, tmp_path):
    monkeypatch.setattr(
        "app.modules.ledger.origin.settings.NODE_KEY_PATH", str(tmp_path / "missing.key")
    )

    response = client.get(proof_url(f"bafyreianother{uuid.uuid4().hex}"))

    assert response.status_code == 404
    assert response.json()["type"] == ledger.RECORD_NOT_FOUND_TYPE


def test_a_node_without_a_key_cannot_sign_the_head_so_answers_503(client, monkeypatch, tmp_path):
    entry = ledger.append(make_envelope())
    monkeypatch.setattr(
        "app.modules.ledger.origin.settings.NODE_KEY_PATH", str(tmp_path / "missing.key")
    )

    response = client.get(proof_url(entry.record_cid))

    assert response.status_code == 503
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    problem = response.json()
    assert problem["status"] == 503
    assert problem["type"] == ledger.NODE_KEY_UNAVAILABLE_TYPE
    # Never an unsigned proof.
    assert "head" not in problem and "seq" not in problem


def test_an_unreadable_key_file_also_answers_503(client, monkeypatch, tmp_path):
    entry = ledger.append(make_envelope())
    key_path = tmp_path / "garbage.key"
    key_path.write_bytes(b"not an ed25519 key")
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))

    response = client.get(proof_url(entry.record_cid))

    assert response.status_code == 503
    assert response.json()["type"] == ledger.NODE_KEY_UNAVAILABLE_TYPE


def test_the_envelope_endpoint_is_not_shadowed_by_the_proof_route(client, node_key):
    entry = ledger.append(make_envelope())

    envelope = client.get(f"/v1/records/{entry.record_cid}")
    proof = client.get(proof_url(entry.record_cid))

    assert envelope.status_code == proof.status_code == 200
    assert envelope.json()["id"] == entry.record_cid
    assert set(proof.json()) == PROOF_KEYS


def test_the_proof_is_read_only(client, node_key):
    entry = ledger.append(make_envelope())

    response = client.post(proof_url(entry.record_cid))

    assert response.status_code == 405
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
