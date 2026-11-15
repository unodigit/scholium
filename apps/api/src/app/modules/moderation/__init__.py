"""Moderation plugin: policy clauses, the queue and signed decisions.

Exposes ``GET /v1/moderation/policies`` returning the policy clause list
(id, title, text) loaded from the ``policies.yaml`` bundled with this
module; ``MODERATION_POLICIES_YAML`` (alias ``POLICIES_YAML``) overrides
the source file.

``GET /v1/moderation/queue`` lists the versions waiting in ``moderation``
with the signals a moderator decides with.

``POST /v1/moderation/decisions`` accepts a signed ``moderation.decision``
(list, hold, reclassify, reject, delist, tombstone) that cites a known policy
clause and a reason, saves it to the ``moderation_decisions`` table and sets
the version state (feature 71).  Importing this package registers the record
type with the ingest pipeline at tier 4 and subscribes to the ledger, so a
decision takes effect whether it arrives here or through ``POST
/v1/records``.  See :mod:`app.modules.moderation.decisions`.

A ``tombstone`` saves the cid to the ``denylist`` table and deletes the blob
bytes, while the envelope and log entry remain and verification still passes
(feature 73).  See :mod:`app.modules.moderation.tombstones`.
"""

from app.security import Tier

from .decisions import (
    ACTION_STATES,
    ACTIONS,
    DECISION_MIN_TIER,
    DECISION_TYPE,
    DecisionFields,
    apply_decision,
    decision_fields,
    get_decision,
    handle_moderation_decision,
    persist_entry,
    require_known_clause,
)
from .errors import (
    DECISION_NOT_ALLOWED,
    UNKNOWN_DECISION_TARGET,
    UNKNOWN_POLICY_CLAUSE,
    DecisionNotAllowed,
    UnknownDecisionTarget,
    UnknownPolicyClause,
)
from .models import Denylist, ModerationDecision, ensure_table, ensure_tables
from .policies import (
    DEFAULT_POLICIES_FILE,
    POLICIES_YAML_ENV,
    PolicyClause,
    PolicyClauseError,
    bundled_policies_path,
    clear_policy_cache,
    get_clause,
    get_clauses,
    load_clauses,
    parse_yaml_subset,
    policies_path,
)
from .router import router
from .tombstones import (
    TOMBSTONE,
    TOMBSTONED,
    Tombstone,
    TombstoneScope,
    get_denylist_entry,
    resolve_scope,
    tombstone_cid,
    tombstone_target,
)

__all__ = [
    "ACTIONS",
    "ACTION_STATES",
    "DECISION_MIN_TIER",
    "DECISION_NOT_ALLOWED",
    "DECISION_TYPE",
    "DEFAULT_POLICIES_FILE",
    "DecisionFields",
    "DecisionNotAllowed",
    "Denylist",
    "ModerationDecision",
    "POLICIES_YAML_ENV",
    "PolicyClause",
    "PolicyClauseError",
    "TOMBSTONE",
    "TOMBSTONED",
    "Tombstone",
    "TombstoneScope",
    "UNKNOWN_DECISION_TARGET",
    "UNKNOWN_POLICY_CLAUSE",
    "UnknownDecisionTarget",
    "UnknownPolicyClause",
    "apply_decision",
    "bundled_policies_path",
    "clear_policy_cache",
    "decision_fields",
    "ensure_table",
    "ensure_tables",
    "get_clause",
    "get_clauses",
    "get_decision",
    "get_denylist_entry",
    "handle_moderation_decision",
    "load_clauses",
    "parse_yaml_subset",
    "persist_entry",
    "policies_path",
    "require_known_clause",
    "resolve_scope",
    "router",
    "tombstone_cid",
    "tombstone_target",
]


def _install_ledger_subscriber() -> None:
    """Act on every ``moderation.decision`` once it is committed to the log."""
    from app.modules import ledger

    ledger.subscribe(DECISION_TYPE, persist_entry)


def _register_record_type() -> None:
    """Register ``moderation.decision`` with the ingest pipeline at tier 4.

    Only moderators may sign a decision.  An existing registration is left
    alone rather than conflicted with, so re-importing the package is harmless.
    """
    from app.modules import ingest

    if ingest.get(DECISION_TYPE) is None:
        ingest.register(DECISION_TYPE, handle_moderation_decision, min_tier=int(Tier.MODERATOR))


_install_ledger_subscriber()
_register_record_type()
