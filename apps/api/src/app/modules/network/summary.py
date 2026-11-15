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

The endpoint is public and side-effect free: no credentials, no writes, and a
reading of the same tables and files the rest of the public API serves.
"""

from __future__ import annotations

from typing import Literal, Mapping, Optional

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

__all__ = [
    "LOCAL_REPLICAS",
    "LOCAL_STANDING",
    "LastAnchor",
    "LogHead",
    "ModerationCounts",
    "NetworkStatus",
    "REPLICAS_REQUIRED",
    "ReplicaSummary",
    "build_network_summary",
    "log_head",
    "moderation_counts_by_clause",
    "network_summary",
    "replica_summary",
]

#: Standing of a node that serves its own records and takes part in no
#: federation yet.  The network page shows this word beside the node DID.
LOCAL_STANDING = "local"

#: Replicas this single local node holds: its own copy of every record.
LOCAL_REPLICAS = 1
#: Replicas a node in local-only mode is configured to hold.
REPLICAS_REQUIRED = 1


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


def build_network_summary(
    *,
    node_did: str,
    head: Optional[EventLog],
    by_clause: Mapping[str, int],
) -> NetworkStatus:
    """Assemble the status document from already-read values.

    Kept separate from :func:`network_summary` so the document's shape can be
    tested without a database, and so the reading order (head first, then the
    decisions) stays explicit at the call site.
    """
    if head is None:
        log = LogHead(seq=0, entry_hash=GENESIS_PREV_HASH.hex())
    else:
        log = LogHead(seq=int(head.seq), entry_hash=bytes(head.entry_hash).hex())

    counts = {str(clause): int(count) for clause, count in by_clause.items()}
    counts = dict(sorted(counts.items()))
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
    )


def network_summary() -> NetworkStatus:
    """Read this node's identity, log head and moderation counts."""
    return build_network_summary(
        node_did=node_did(),
        head=latest(),
        by_clause=moderation_counts_by_clause(),
    )
