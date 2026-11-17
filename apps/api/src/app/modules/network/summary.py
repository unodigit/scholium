"""The public network-status document behind ``GET /v1/network`` (feature 127).

The endpoint answers one question for a reader who does not trust the node:
*what does this node say about itself right now?*  The document is a compact,
stable summary of the node's identity, its append-only log, its (local-only)
replication and its moderation activity::

    GET /v1/network

    200 OK
    {
      "node_did": "did:key:z6MkfZrSg...",
      "standing": "local",
      "log_head": {
        "seq": 41,
        "entry_hash": "9f86d081884c7d659a2feaa0c55ad015..."
      },
      "last_anchor": {"status": "pending"},
      "replicas": {
        "have": 1,
        "of": 1,
        "local": true,
        "summary": "1 of 1 local"
      },
      "moderation": {
        "total": 3,
        "by_clause": {"MOD-01": 2, "MOD-04": 1}
      },
      "operator": "NextGenius",
      "software_version": "0.1.0",
      "probes": {"window_hours": 24, "runs": 0, "passed": 0, "pass_rate": null},
      "incidents": [],
      "replication_policy": {"replicas": 5, "operators": 3, "jurisdictions": 2},
      "papers_by_replica_health": {
        "meets_policy": 0,
        "below_policy": 0,
        "single_copy": 12
      }
    }

Every part is read from the same sources the rest of the public API serves:

* ``node_did`` is the DID this node records as the origin of its log entries
  (:func:`app.modules.ledger.origin.node_did`): the ``NODE_DID``-style
  environment override when set, otherwise the ``did:key`` derived from the
  Ed25519 key at ``NODE_KEY_PATH``, otherwise the local placeholder.  It is the
  DID a peer audits against, so it comes from the node's own identity rather
  than from the request.
* ``log_head`` is the current last entry of the event log -- ``seq`` and the
  32-byte ``entry_hash`` in hex, the wire form ``GET /v1/sync/range`` and
  ``GET /v1/records/{cid}/proof`` serve.  An empty log has the genesis head:
  ``seq`` 0 over the all-zero digest, exactly as ``GET /v1/sync/head`` reports
  it.  This endpoint deliberately serves only the head *position*, not the
  signed head: it is a public status page and must not fail just because the
  node key is not provisioned.  A client that needs the signature asks
  ``GET /v1/sync/head``.
* ``last_anchor`` is the public-timestamp status of the node's most recent
  anchor.  This node does not anchor its log on-chain yet (app_spec.xml,
  scope: "anchor status is always reported as pending"), so the status is
  always :data:`~app.modules.ledger.proof.ANCHOR_PENDING` -- a calm state,
  not an error (docs/design.md, "Calm under failure").
* ``replicas`` is the replication summary.  Federation and the multi-operator
  replica policy (PRD NET-3) are out of scope for this single local node, so
  it holds exactly one replica of its own records and the summary is
  ``"1 of 1 local"``.  ``have`` is the number held, ``of`` the number the node
  is configured to hold, and ``local`` says that replica lives on this node.
* ``moderation`` counts accepted decisions in ``moderation_decisions`` (the
  projection feature 71 writes) grouped by the policy clause they cite
  (``MOD-01`` ... ``MOD-10``).  ``by_clause`` lists only clauses a decision
  actually cites -- the natural ``GROUP BY`` result -- sorted by clause id so
  the document is deterministic; ``total`` is the number of decisions.  The
  clause titles and texts stay in ``GET /v1/moderation/policies``.

* ``operator`` is the name of the organisation running this node: the
  ``NODE_OPERATOR`` (or ``SCHOLIUM_NODE_OPERATOR``) environment variable when it
  is set to something, otherwise :data:`DEFAULT_OPERATOR`, the operator brand
  named in the PRD.  ``software_version`` is the version of the installed
  ``scholium-api`` package, so it can never drift from what is deployed.
* ``probes`` is the availability-probe record for the last 24 hours (PRD
  NET-3).  ``pass_rate`` is ``passed / runs`` in ``[0, 1]``, or ``null`` --
  never ``0`` -- when no probe has run, so a page can say "No probes run yet"
  instead of claiming every probe failed.  This node holds the only replica of
  its records, so there is no remote replica to probe and ``runs`` is 0.
* ``incidents`` is the public incident log, newest first.  Nothing records an
  incident yet, so it is an empty list, which the page renders as "No incidents
  recorded."
* ``replication_policy`` is the target a listed paper is held to (PRD NET-3):
  at least 5 replicas, 3 operators and 2 jurisdictions.
  ``papers_by_replica_health`` counts the *papers* with at least one listed
  version in each health -- ``meets_policy``, ``below_policy`` or
  ``single_copy`` -- judged against that target (:func:`replica_health`).  All
  three keys are always present.  This node is the only holder, so every listed
  paper is a ``single_copy``; the page must say so rather than report a paper
  with one of five replicas as healthy.

The endpoint is public and side-effect free: no credentials, no writes, and a
reading of the same tables and files the rest of the public API serves.
"""

from __future__ import annotations

import importlib.metadata
import os
from typing import Iterable, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select

from app import db
from app.modules.ledger import (
    ANCHOR_PENDING,
    GENESIS_PREV_HASH,
    EventLog,
    latest,
    node_did,
)
from app.modules.moderation.models import (
    ModerationDecision,
    ensure_tables as ensure_moderation_tables,
)
from app.modules.submissions import PaperVersion, ensure_tables as ensure_submission_tables
from app.modules.submissions.state import LISTED

__all__ = [
    "DEFAULT_OPERATOR",
    "HEALTH_BELOW_POLICY",
    "HEALTH_MEETS_POLICY",
    "HEALTH_SINGLE_COPY",
    "Incident",
    "LOCAL_OPERATORS",
    "LOCAL_REPLICAS",
    "LOCAL_STANDING",
    "LastAnchor",
    "LogHead",
    "ModerationCounts",
    "NetworkStatus",
    "POLICY_JURISDICTIONS",
    "POLICY_OPERATORS",
    "POLICY_REPLICAS",
    "PROBE_WINDOW_HOURS",
    "ProbeStatistics",
    "REPLICAS_REQUIRED",
    "ReplicaHealthCounts",
    "ReplicaSummary",
    "ReplicationPolicy",
    "build_network_summary",
    "incident_log",
    "listed_paper_count",
    "log_head",
    "moderation_counts_by_clause",
    "network_summary",
    "node_operator",
    "probe_statistics",
    "recent_probe_outcomes",
    "replica_health",
    "replica_summary",
    "software_version",
]

#: Standing of a node that serves its own records and takes part in no
#: federation yet.  The network page shows this word beside the node DID.
LOCAL_STANDING = "local"

#: Replicas this single local node holds: its own copy of every record.
LOCAL_REPLICAS = 1
#: Replicas a node in local-only mode is configured to hold.
REPLICAS_REQUIRED = 1
#: Operators and jurisdictions the local node's replicas span: just this node's own.
LOCAL_OPERATORS = 1
LOCAL_JURISDICTIONS = 1

#: The replication policy a listed paper is held to (PRD NET-3, tech
#: architecture "Replicas / policy"): at least this many replicas, held by at
#: least this many operators, in at least this many jurisdictions.
POLICY_REPLICAS = 5
POLICY_OPERATORS = 3
POLICY_JURISDICTIONS = 2

#: Replica health of a paper, judged against the policy above.
HEALTH_MEETS_POLICY = "meets_policy"
HEALTH_BELOW_POLICY = "below_policy"
HEALTH_SINGLE_COPY = "single_copy"

#: Hours of availability probes the pass rate covers.
PROBE_WINDOW_HOURS = 24

#: The operator a node reports when its own operator is not configured: the
#: operator brand named in docs/PRD.md.  Another operator sets ``NODE_OPERATOR``.
DEFAULT_OPERATOR = "NextGenius"
#: Environment variables naming the operator (the first one set wins), spelled
#: like the ``NODE_DID`` / ``SCHOLIUM_NODE_DID`` pair in :mod:`app.modules.ledger.origin`.
_OPERATOR_ENV_NAMES = ("NODE_OPERATOR", "SCHOLIUM_NODE_OPERATOR")
#: The distribution this node's software version is read from.
_PACKAGE_NAME = "scholium-api"
#: Reported when the package metadata is unavailable (a source checkout that was never installed).
UNKNOWN_VERSION = "unknown"


class LogHead(BaseModel):
    """The log's current head: its last ``seq`` and that entry's hash."""

    model_config = ConfigDict(extra="forbid")

    #: Sequence number of the log's last entry (0 for an empty log).
    seq: int
    #: That entry's 32-byte ``entry_hash`` in lowercase hex (all zeros when empty).
    entry_hash: str


class LastAnchor(BaseModel):
    """Public-timestamp status of the node's most recent anchor."""

    model_config = ConfigDict(extra="forbid")

    #: Always ``"pending"``: on-chain anchoring is out of scope for this node.
    status: Literal["pending"]


class ReplicaSummary(BaseModel):
    """How many replicas the node holds, out of how many it should hold."""

    model_config = ConfigDict(extra="forbid")

    #: Replicas the node holds.
    have: int
    #: Replicas the node is configured to hold.
    of: int
    #: Whether the held replica is local to this node (it always is, for now).
    local: bool
    #: Human-readable form of the pair, e.g. ``"1 of 1 local"``.
    summary: str


class ModerationCounts(BaseModel):
    """Accepted moderation decisions grouped by the policy clause they cite."""

    model_config = ConfigDict(extra="forbid")

    #: Number of accepted decisions in total.
    total: int
    #: Decisions per cited clause id; clauses with no decision are absent.
    by_clause: dict[str, int]


class ProbeStatistics(BaseModel):
    """Availability-probe results over the last :data:`PROBE_WINDOW_HOURS` hours."""

    model_config = ConfigDict(extra="forbid")

    #: Hours the figures cover.
    window_hours: int
    #: Probes run in the window.
    runs: int
    #: Probes that passed.
    passed: int
    #: ``passed / runs`` in ``[0, 1]``; ``None`` -- not ``0`` -- when no probe ran.
    pass_rate: Optional[float]


class Incident(BaseModel):
    """One entry of the public incident log."""

    model_config = ConfigDict(extra="forbid")

    #: When the incident began, RFC 3339 UTC (``2027-05-04T09:30:00Z``).
    occurred_at: str
    #: One-line description.
    title: str
    #: What happened and what was done, in plain language.
    detail: str


class ReplicationPolicy(BaseModel):
    """The target every listed paper is held to (PRD NET-3)."""

    model_config = ConfigDict(extra="forbid")

    #: Replicas a paper should have.
    replicas: int
    #: Distinct operators that should hold them.
    operators: int
    #: Distinct jurisdictions they should span.
    jurisdictions: int


class ReplicaHealthCounts(BaseModel):
    """Listed papers per replica health; every health is always present."""

    model_config = ConfigDict(extra="forbid")

    #: Papers that meet the full replication policy.
    meets_policy: int
    #: Papers with more than one replica that still fall short of the policy.
    below_policy: int
    #: Papers with a single copy: one failure loses them.
    single_copy: int


class NetworkStatus(BaseModel):
    """The document ``GET /v1/network`` serves."""

    model_config = ConfigDict(extra="forbid")

    #: DID this node records as the origin of its log entries.
    node_did: str
    #: Federation standing; ``"local"`` for this single, unfederated node.
    standing: str
    #: Current head of the event log.
    log_head: LogHead
    #: Status of the node's most recent public-timestamp anchor.
    last_anchor: LastAnchor
    #: Replication summary.
    replicas: ReplicaSummary
    #: Moderation decision counts by cited policy clause.
    moderation: ModerationCounts
    #: Name of the organisation operating this node.
    operator: str
    #: Version of the software this node runs.
    software_version: str
    #: Availability-probe results for the last 24 hours.
    probes: ProbeStatistics
    #: Public incident log, newest first (empty when nothing is recorded).
    incidents: list[Incident]
    #: Replication target a listed paper is held to.
    replication_policy: ReplicationPolicy
    #: Listed papers per replica health.
    papers_by_replica_health: ReplicaHealthCounts


def log_head() -> LogHead:
    """Return the current log head, or the genesis head for an empty log."""
    entry = latest()
    if entry is None:
        return LogHead(seq=0, entry_hash=GENESIS_PREV_HASH.hex())
    return LogHead(seq=int(entry.seq), entry_hash=bytes(entry.entry_hash).hex())


def replica_summary() -> ReplicaSummary:
    """Return the fixed local replication summary: ``1 of 1 local``."""
    return ReplicaSummary(
        have=LOCAL_REPLICAS,
        of=REPLICAS_REQUIRED,
        local=True,
        summary=f"{LOCAL_REPLICAS} of {REPLICAS_REQUIRED} {LOCAL_STANDING}",
    )


def moderation_counts_by_clause() -> dict[str, int]:
    """Count accepted decisions per cited policy clause, sorted by clause id.

    The table is the moderation plugin's projection of accepted, signed
    ``moderation.decision`` records (feature 71), so this is a count of
    decisions a reader can fetch and verify from the public ledger, not of
    drafts or requests.  Clauses with no decision are not listed.
    """
    ensure_moderation_tables()
    statement = (
        select(ModerationDecision.clause, func.count(ModerationDecision.decision_cid))
        .group_by(ModerationDecision.clause)
        .order_by(ModerationDecision.clause)
    )
    with db.SessionLocal() as session:
        rows = session.execute(statement).all()
    return {str(clause): int(count) for clause, count in rows}


def node_operator() -> str:
    """Name of the organisation running this node.

    The first of :data:`_OPERATOR_ENV_NAMES` that holds anything but
    whitespace, trimmed; otherwise :data:`DEFAULT_OPERATOR`.  Read on every
    call, like the node DID, so changing the environment needs no restart.
    """
    for name in _OPERATOR_ENV_NAMES:
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return DEFAULT_OPERATOR


def software_version() -> str:
    """Version of the installed ``scholium-api`` package (or ``"unknown"``)."""
    try:
        return importlib.metadata.version(_PACKAGE_NAME)
    except importlib.metadata.PackageNotFoundError:
        return UNKNOWN_VERSION


def probe_statistics(outcomes: Iterable[bool]) -> ProbeStatistics:
    """Summarise probe ``outcomes`` (``True`` = passed) from the last 24 hours.

    The pass rate is ``None`` when there are no outcomes: "no probes run yet" is
    a different statement from "every probe failed" (a rate of ``0.0``).
    """
    results = list(outcomes)
    passed = sum(1 for outcome in results if outcome)
    return ProbeStatistics(
        window_hours=PROBE_WINDOW_HOURS,
        runs=len(results),
        passed=passed,
        pass_rate=passed / len(results) if results else None,
    )


def recent_probe_outcomes() -> list[bool]:
    """Outcomes of the availability probes run in the last 24 hours.

    The prober (tech architecture: random byte-range challenges against each
    *claimed remote* replica) has nothing to challenge on a node that holds the
    only copy of its records, so none has ever run and this is empty.
    """
    return []


def incident_log() -> list[Incident]:
    """The public incident log, newest first.  Nothing records incidents yet."""
    return []


def replica_health(replicas: int, operators: int, jurisdictions: int) -> str:
    """Health of a paper held by ``replicas`` replicas across the given spread.

    ``meets_policy`` needs all three of the policy's minimums; one copy is a
    ``single_copy`` whatever else is true; anything in between is
    ``below_policy``.
    """
    if (
        replicas >= POLICY_REPLICAS
        and operators >= POLICY_OPERATORS
        and jurisdictions >= POLICY_JURISDICTIONS
    ):
        return HEALTH_MEETS_POLICY
    if replicas <= 1:
        return HEALTH_SINGLE_COPY
    return HEALTH_BELOW_POLICY


def listed_paper_count() -> int:
    """Number of papers with at least one listed version.

    The catalog's own definition of a listed paper (``GET /v1/papers``): a paper
    counts once however many of its versions are listed, and a paper whose
    versions are all held, rejected or still in review does not count.
    """
    ensure_submission_tables()
    statement = select(func.count(func.distinct(PaperVersion.paper_cid))).where(
        PaperVersion.state == LISTED
    )
    with db.SessionLocal() as session:
        return int(session.execute(statement).scalar_one())


def build_network_summary(
    *,
    node_did: str,
    head: Optional[EventLog],
    by_clause: Mapping[str, int],
    operator: Optional[str] = None,
    version: Optional[str] = None,
    probe_outcomes: Iterable[bool] = (),
    incidents: Iterable[Incident] = (),
    listed_papers: int = 0,
) -> NetworkStatus:
    """Assemble the status document from already-read values.

    Kept separate from :func:`network_summary` so the document's shape can be
    tested without a database, and so the reading order (head first, then the
    decisions) stays explicit at the call site.  ``listed_papers`` is held to
    the policy by what this node actually holds for each of them: its own
    single replica, in its own operator and jurisdiction.
    """
    if head is None:
        log = LogHead(seq=0, entry_hash=GENESIS_PREV_HASH.hex())
    else:
        log = LogHead(seq=int(head.seq), entry_hash=bytes(head.entry_hash).hex())

    counts = {str(clause): int(count) for clause, count in by_clause.items()}
    counts = dict(sorted(counts.items()))

    health = {HEALTH_MEETS_POLICY: 0, HEALTH_BELOW_POLICY: 0, HEALTH_SINGLE_COPY: 0}
    health[replica_health(LOCAL_REPLICAS, LOCAL_OPERATORS, LOCAL_JURISDICTIONS)] = int(
        listed_papers
    )
    return NetworkStatus(
        node_did=node_did,
        standing=LOCAL_STANDING,
        log_head=log,
        last_anchor=LastAnchor(status=ANCHOR_PENDING),
        replicas=replica_summary(),
        moderation=ModerationCounts(
            total=sum(counts.values()),
            by_clause=counts,
        ),
        operator=operator if operator is not None else node_operator(),
        software_version=version if version is not None else software_version(),
        probes=probe_statistics(probe_outcomes),
        incidents=list(incidents),
        replication_policy=ReplicationPolicy(
            replicas=POLICY_REPLICAS,
            operators=POLICY_OPERATORS,
            jurisdictions=POLICY_JURISDICTIONS,
        ),
        papers_by_replica_health=ReplicaHealthCounts(**health),
    )


def network_summary() -> NetworkStatus:
    """Read this node's identity, log head, moderation counts and papers."""
    return build_network_summary(
        node_did=node_did(),
        head=latest(),
        by_clause=moderation_counts_by_clause(),
        probe_outcomes=recent_probe_outcomes(),
        incidents=incident_log(),
        listed_papers=listed_paper_count(),
    )
