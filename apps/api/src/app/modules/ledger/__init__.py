"""Event log ledger module (plugin: ledger).

Feature 12: every accepted record is appended to the node's append-only,
hash-chained ``event_log`` table and in-process subscribers registered with
``subscribe(record_type, fn)`` are notified::

    from app.modules import ledger

    entry = ledger.append(envelope)      # seq, record_cid, ..., entry_hash
    ledger.subscribe("review.formal", on_formal_review)

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to register the ``EventLog`` model on the
shared declarative base before ``create_app`` creates tables.

See :mod:`app.modules.ledger.service` for append and subscription semantics,
:mod:`app.modules.ledger.hashing` for the hash-chain rule,
:mod:`app.modules.ledger.origin` for how ``origin_node`` is resolved and
:mod:`app.modules.ledger.sync_range` for the replay endpoint
``GET /v1/sync/range?from=&to=`` this package serves.
"""

from __future__ import annotations

from .hashing import (
    GENESIS_PREV_HASH,
    HASH_SIZE,
    compute_entry_hash,
    verify_entry_hash,
)
from .models import EventLog, LedgerEntry, ensure_table
from .origin import (
    DEFAULT_ORIGIN_NODE,
    ED25519_MULTICODEC_PREFIX,
    did_key_from_public_key,
    node_did,
)
from .service import (
    WILDCARD,
    RecordSubscriber,
    append,
    append_entry,
    append_record,
    clear_subscribers,
    entries,
    entry_by_cid,
    latest,
    subscribe,
    subscribed_types,
    subscriber_count,
    unsubscribe,
)
from .sync_range import MAX_PAGE, REVERSED_RANGE_TYPE, SyncEntry, router

__all__ = [
    "DEFAULT_ORIGIN_NODE",
    "ED25519_MULTICODEC_PREFIX",
    "EventLog",
    "GENESIS_PREV_HASH",
    "HASH_SIZE",
    "LedgerEntry",
    "MAX_PAGE",
    "REVERSED_RANGE_TYPE",
    "RecordSubscriber",
    "SyncEntry",
    "WILDCARD",
    "append",
    "append_entry",
    "append_record",
    "clear_subscribers",
    "compute_entry_hash",
    "did_key_from_public_key",
    "ensure_table",
    "entries",
    "entry_by_cid",
    "latest",
    "node_did",
    "router",
    "subscribe",
    "subscribed_types",
    "subscriber_count",
    "unsubscribe",
    "verify_entry_hash",
]
