"""Tests for ``GET /v1/network`` (feature 127).

The endpoint is the public network transparency document: this node's DID,
its event-log head, the status of its last public-timestamp anchor, its
replication summary and its accepted moderation decisions grouped by policy
clause.  The tests exercise the public route over the real app assembled by
the module loader, and the pure document builder directly for the genesis
(empty-log) case.
"""

from __future__ import annotations

import importlib.metadata
import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger, moderation, network
from app.modules.moderation.models import ModerationDecision, ensure_tables
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

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


def add_paper(*, final_state: str, versions: int = 1) -> str:
    """Save a paper whose ``versions`` versions all end in ``final_state``."""
    tag = uuid.uuid4().hex
    key = SigningKey.generate()
    # ``save_paper`` derives the short id from the genesis CID, so it must be a real one.
    paper_cid = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did_key_from_signing_key(key),
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"seed": tag, "title": f"Network paper {tag}", "categories": ["t.net"]},
            "proofs": [],
        },
        key,
    )["id"]
    save_paper(
        paper_cid=paper_cid,
        categories=(f"t.{tag[:12]}",),
        licence="CC-BY-4.0",
        status="preprint",
    )
    prev = paper_cid
    for n in range(1, versions + 1):
        version_cid = f"bafyreinetworkversion{tag}{n}"
        save_version(
            version_cid=version_cid,
            paper_cid=paper_cid,
            n=n,
            title=f"Network paper {tag} v{n}",
            abstract="An abstract.",
            manifest_cid="bafkreimanifest",
            licence="CC-BY-4.0",
            prev_cid=prev,
            authors=(VersionAuthor(AUTHOR, 1, ("Conceptualization",)),),
        )
        for state in ("scanning", "moderation", final_state):
            transition_version(version_cid, state)
        prev = version_cid
    return paper_cid


def health_counts(client) -> dict:
    return client.get(NETWORK_URL).json()["papers_by_replica_health"]


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
        "operator",
        "software_version",
        "probes",
        "incidents",
        "replication_policy",
        "papers_by_replica_health",
    }
    assert set(body["log_head"]) == {"seq", "entry_hash"}
    assert set(body["last_anchor"]) == {"status"}
    assert set(body["replicas"]) == {"have", "of", "local", "summary"}
    assert set(body["moderation"]) == {"total", "by_clause"}
    assert set(body["probes"]) == {"window_hours", "runs", "passed", "pass_rate"}
    assert set(body["replication_policy"]) == {"replicas", "operators", "jurisdictions"}
    assert set(body["papers_by_replica_health"]) == {
        "meets_policy",
        "below_policy",
        "single_copy",
    }


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


# --------------------------------------------------------------------------- #
# Operator and software version (design.md 5.8: "nodes with standing ...")
# --------------------------------------------------------------------------- #


def test_the_operator_defaults_to_the_founding_operator(client, monkeypatch):
    monkeypatch.delenv("NODE_OPERATOR", raising=False)
    monkeypatch.delenv("SCHOLIUM_NODE_OPERATOR", raising=False)

    assert client.get(NETWORK_URL).json()["operator"] == network.DEFAULT_OPERATOR
    assert network.DEFAULT_OPERATOR == "NextGenius"


def test_the_operator_name_comes_from_the_environment(client, monkeypatch):
    monkeypatch.setenv("NODE_OPERATOR", "  Example University Library  ")

    assert client.get(NETWORK_URL).json()["operator"] == "Example University Library"


def test_a_blank_operator_setting_falls_back_to_the_default(client, monkeypatch):
    monkeypatch.setenv("NODE_OPERATOR", "   ")

    assert client.get(NETWORK_URL).json()["operator"] == network.DEFAULT_OPERATOR


def test_the_software_version_is_the_installed_package_version(client):
    version = client.get(NETWORK_URL).json()["software_version"]

    assert version == importlib.metadata.version("scholium-api")
    assert version.strip() != ""


# --------------------------------------------------------------------------- #
# Probe statistics
# --------------------------------------------------------------------------- #


def test_no_probes_run_yet_is_explicit_not_zero_percent(client):
    probes = client.get(NETWORK_URL).json()["probes"]

    assert probes == {"window_hours": 24, "runs": 0, "passed": 0, "pass_rate": None}


def test_the_pass_rate_is_passed_over_runs():
    stats = network.probe_statistics([True, True, False, True])

    assert (stats.runs, stats.passed, stats.window_hours) == (4, 3, 24)
    assert stats.pass_rate == 0.75


def test_a_run_of_failures_is_zero_percent_not_no_probes():
    stats = network.probe_statistics([False, False])

    assert stats.runs == 2
    assert stats.pass_rate == 0.0


def test_no_outcomes_have_no_pass_rate():
    assert network.probe_statistics([]).pass_rate is None


# --------------------------------------------------------------------------- #
# Incident log
# --------------------------------------------------------------------------- #


def test_the_incident_log_is_an_empty_list_when_nothing_is_recorded(client):
    assert client.get(NETWORK_URL).json()["incidents"] == []


# --------------------------------------------------------------------------- #
# Replication policy target and papers by replica health
# --------------------------------------------------------------------------- #


def test_the_replication_policy_target_is_published(client):
    body = client.get(NETWORK_URL).json()

    # PRD NET-3: at least 5 replicas, 3 operators and 2 jurisdictions.
    assert body["replication_policy"] == {
        "replicas": 5,
        "operators": 3,
        "jurisdictions": 2,
    }
    # The honest local summary is unchanged beside it.
    assert body["replicas"]["summary"] == "1 of 1 local"


@pytest.mark.parametrize(
    ("replicas", "operators", "jurisdictions", "health"),
    [
        (1, 1, 1, "single_copy"),
        (0, 0, 0, "single_copy"),
        (2, 1, 1, "below_policy"),
        (4, 3, 2, "below_policy"),
        (5, 2, 2, "below_policy"),
        (5, 3, 1, "below_policy"),
        (5, 3, 2, "meets_policy"),
        (7, 4, 3, "meets_policy"),
    ],
)
def test_replica_health_is_judged_against_the_policy_target(
    replicas, operators, jurisdictions, health
):
    assert network.replica_health(replicas, operators, jurisdictions) == health


def test_a_listed_paper_on_this_local_node_is_a_single_copy_not_healthy(client):
    before = health_counts(client)

    add_paper(final_state="listed")

    after = health_counts(client)
    assert after["single_copy"] == before["single_copy"] + 1
    # One local replica can never meet or approach the 5/3/2 target.
    assert after["meets_policy"] == before["meets_policy"] == 0
    assert after["below_policy"] == before["below_policy"] == 0


def test_papers_are_counted_once_however_many_versions_are_listed(client):
    before = health_counts(client)["single_copy"]

    add_paper(final_state="listed", versions=3)

    assert health_counts(client)["single_copy"] == before + 1


def test_only_listed_papers_are_counted(client):
    before = health_counts(client)

    add_paper(final_state="held")
    add_paper(final_state="rejected")

    assert health_counts(client) == before


def test_the_builder_reports_every_health_even_when_no_paper_is_listed():
    summary = network.build_network_summary(
        node_did="did:key:zEmptyNode",
        head=None,
        by_clause={},
        listed_papers=0,
    )

    assert summary.papers_by_replica_health.model_dump() == {
        "meets_policy": 0,
        "below_policy": 0,
        "single_copy": 0,
    }
    assert summary.probes.pass_rate is None
    assert summary.incidents == []
