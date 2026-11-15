"""Moderation plugin: public moderation policy clauses.

Exposes ``GET /v1/moderation/policies`` returning the policy clause list
(id, title, text) loaded from the ``policies.yaml`` bundled with this
module; ``MODERATION_POLICIES_YAML`` (alias ``POLICIES_YAML``) overrides
the source file. The clause loader here is the foundation the later
moderation features build on (queue, decisions citing a known clause,
author notifications).
"""

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

__all__ = [
    "DEFAULT_POLICIES_FILE",
    "POLICIES_YAML_ENV",
    "PolicyClause",
    "PolicyClauseError",
    "bundled_policies_path",
    "clear_policy_cache",
    "get_clause",
    "get_clauses",
    "load_clauses",
    "parse_yaml_subset",
    "policies_path",
    "router",
]
