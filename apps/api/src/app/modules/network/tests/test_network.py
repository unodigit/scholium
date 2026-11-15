"""Tests for ``GET /v1/network`` (feature 127).

The endpoint is the public network transparency document: this node's DID,
its event-log head, the status of its last public-timestamp anchor, its
replication summary and its accepted moderation decisions grouped by policy
clause.  The tests exercise the public route over the real app assembled by
the module loader, and the pure document builder directly for the genesis
(empty-log) case.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app import db
from app.modules import ledger, moderation, network
from app.modules.moderation.models import ModerationDecision, ensure_tables

#: A well-formed Ed25519 did:key; ``ledger.append`` does not check signatures.
AUTHOR = "did:key:z6MkhaKgUb4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"

#: The endpoint under test.
NETWORK_URL = "/v1/network"


def make_envelope() -> dict:
    """A minimal valid record with a unique body and cid."""
    tag = uuid.uuid4().hex
    return {
        "v": 1,
        "type": "test.network",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {"tag": tag},
        "proofs": [],
        "id": f"bafyreinetwork{tag}",
    }


def add_decision(clause: str) -> ModerationDecision:
    """Save one accepted moderation decision citing ``clause``."""
    ensure_tables()
    row = ModerationDecision(
        decision_cid=f"bafyreinetworkdecision{uuid.uuid4().hex}",
        target_cid="bafyreinetworkversion",
        action="list",
        clause=clause,
        moderator_did="did:key:z6Mknetmoderator",
        decided_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    with db.SessionLocal() as session:
        session.add(row)
        session.commit()
        session.expunge(row)
    return row


# --------------------------------------------------------------------------- #
# Shape of the document
# --------------------------------------------------------------------------- #


def test_network_serves_the_documented_document_shape(client):
    ledger.append(make_envelope())

    response = client.get(NETWORK_URL)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body) == {
        "node_did",
        "standing",
        "log_head",
        "last_anchor",
        "replicas",
        "moderation",
    }
    assert set(body["log_head"]) == {"seq", "entry_hash"}
    assert set(body["last_anchor"]) == {"status"}
    assert set(body["replicas"]) == {"have", "of", "local", "summary"}
    assert set(body["moderation"]) == {"total", "by_clause"}


# --------------------------------------------------------------------------- #
# Node identity and log head
# --------------------------------------------------------------------------- #


def test_network_reports_the_node_did(client):
    ledger.append(make_envelope())

    body = client.get(NETWORK_URL).json()

    assert body["node_did"] == ledger.node_did()
    assert body["standing"] == "local"


def test_network_reports_the_current_log_head(client):
    entry = ledger.append(make_envelope())

    body = client.get(NETWORK_URL).json()

    # "log head seq": the endpoint serves the log's last entry, with its
    # 32-byte entry hash in hex -- the same wire form as /v1/sync/range.
    assert body["log_head"]["seq"] == entry.seq == ledger.latest().seq
    assert body["log_head"]["entry_hash"] == bytes(entry.entry_hash).hex()
    assert len(body["log_head"]["entry_hash"]) == 64


# --------------------------------------------------------------------------- #
# Anchor status and replication summary
# --------------------------------------------------------------------------- #


def test_last_anchor_status_is_pending(client):
    ledger.append(make_envelope())

    body = client.get(NETWORK_URL).json()

    assert body["last_anchor"]["status"] == "pending"
    assert ledger.ANCHOR_PENDING == "pending"


def test_replica_summary_is_one_of_one_local(client):
    body = client.get(NETWORK_URL).json()

    assert body["replicas"] == {
        "have": 1,
        "of": 1,
        "local": True,
        "summary": "1 of 1 local",
    }


# --------------------------------------------------------------------------- #
# Moderation decision counts by clause
# --------------------------------------------------------------------------- #


def test_moderation_decisions_are_counted_by_clause(client):
    first = f"NET-TEST-{uuid.uuid4().hex}"
    second = f"NET-TEST-{uuid.uuid4().hex}"
    add_decision(first)
    add_decision(first)
    add_decision(second)

    counts = client.get(NETWORK_URL).json()["moderation"]

    assert counts["by_clause"][first] == 2
    assert counts["by_clause"][second] == 1
    # ``total`` is the number of decisions, not of clauses.
    assert counts["total"] >= 3
    assert counts["total"] == sum(counts["by_clause"].values())


def test_a_clause_with_no_decision_is_not_listed(client):
    clause = f"NET-ABSENT-{uuid.uuid4().hex}"

    counts = client.get(NETWORK_URL).json()["moderation"]

    assert clause not in counts["by_clause"]


def test_clauses_are_listed_in_sorted_order(client):
    later = f"NET-TEST-Z-{uuid.uuid4().hex}"
    earlier = f"NET-TEST-A-{uuid.uuid4().hex}"
    add_decision(later)
    add_decision(earlier)

    by_clause = client.get(NETWORK_URL).json()["moderation"]["by_clause"]

    assert list(by_clause) == sorted(by_clause)


# --------------------------------------------------------------------------- #
# The pure document builder (genesis / empty log)
# --------------------------------------------------------------------------- #


def test_an_empty_log_serves_the_genesis_head():
    summary = network.build_network_summary(
        node_did="did:key:zEmptyNode",
        head=None,
        by_clause={},
    )

    assert summary.log_head.seq == 0
    assert summary.log_head.entry_hash == ledger.GENESIS_PREV_HASH.hex()
    assert summary.moderation.total == 0
    assert summary.moderation.by_clause == {}
    assert summary.last_anchor.status == "pending"
    assert summary.replicas.summary == "1 of 1 local"


def test_the_builder_counts_every_decision_and_sorts_clauses():
    summary = network.build_network_summary(
        node_did="did:key:zNode",
        head=None,
        by_clause={"MOD-10": 1, "MOD-02": 3},
    )

    assert summary.moderation.by_clause == {"MOD-02": 3, "MOD-10": 1}
    assert summary.moderation.total == 4
