"""Network transparency module (plugin: network, feature 127).

Exposes ``GET /v1/network``: the public status document a reader (or a peer
deciding whether to mirror this node) can fetch without an account::

    from app.modules import network

    network.network_summary()   # NetworkStatus(...)

The document reports this node's DID, the current event-log head (``seq`` and
``entry_hash``), the status of the last public-timestamp anchor (always
``"pending"``: on-chain anchoring is out of scope), the replication summary
(``1 of 1 local`` for this single, unfederated node) and accepted moderation
decision counts grouped by the policy clause they cite.

Everything it serves is read from the modules that own it: the ledger
(:mod:`app.modules.ledger`) for the node identity and log head, and the
moderation plugin's ``moderation_decisions`` projection
(:mod:`app.modules.moderation.models`) for the counts.  The endpoint is public
and side-effect free.  See :mod:`app.modules.network.summary` for the response
shape and :mod:`app.modules.network.router` for the route.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to expose the ``router`` below; no central
registry or app-factory change is needed.
"""

from __future__ import annotations

from .router import router
from .summary import (
    LOCAL_REPLICAS,
    LOCAL_STANDING,
    REPLICAS_REQUIRED,
    LastAnchor,
    LogHead,
    ModerationCounts,
    NetworkStatus,
    ReplicaSummary,
    build_network_summary,
    log_head,
    moderation_counts_by_clause,
    network_summary,
    replica_summary,
)

__all__ = [
    "LOCAL_REPLICAS",
    "LOCAL_STANDING",
    "REPLICAS_REQUIRED",
    "LastAnchor",
    "LogHead",
    "ModerationCounts",
    "NetworkStatus",
    "ReplicaSummary",
    "build_network_summary",
    "log_head",
    "moderation_counts_by_clause",
    "network_summary",
    "replica_summary",
    "router",
]
