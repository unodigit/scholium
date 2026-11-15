"""Paper status module (plugin: status).

Feature 83: a paper's status is computed deterministically from its records::

    from app.modules import status

    status.compute_status(records)   # "preprint" | "under_review" |
                                     # "reviewed" | "contested" |
                                     # "corrected" | "retracted"

    result = status.explain_status(records)
    result.status, result.rule, result.evidence

It reads moderation, review and notice records only -- never ``ai.review``,
which is advisory and cannot change a paper's status -- and resolves
overlapping signals with a documented precedence (retracted, then contested,
then corrected, then reviewed, under review, preprint).  See
:mod:`app.modules.status.compute` for the input, the precedence table and the
review and moderation rules.

This package exposes no ``router`` and touches no table: ``compute_status`` is
a pure function.  The module loader still discovers it by convention.  A later
feature of this plugin saves the recomputed status to ``papers.status`` from a
ledger subscription.
"""

from __future__ import annotations

from .compute import (
    CONCERN_RECOMMENDATIONS,
    CORRECTION_TYPE,
    MIN_REVIEWS_FOR_REVIEWED,
    MODERATION_DECISION_TYPE,
    REJECTING_RECOMMENDATIONS,
    RETRACTION_TYPE,
    REVIEW_COMMIT_TYPE,
    REVIEW_FORMAL_TYPE,
    RULES,
    STATE_SETTING_ACTIONS,
    STATUS_CONTESTED,
    STATUS_CORRECTED,
    STATUS_PRECEDENCE,
    STATUS_PREPRINT,
    STATUS_RECORD_TYPES,
    STATUS_RETRACTED,
    STATUS_REVIEWED,
    STATUS_UNDER_REVIEW,
    STATUSES,
    SUPPORTIVE_RECOMMENDATIONS,
    StatusResult,
    compute_status,
    explain_status,
)
from .errors import InvalidRecordError, StatusError

__all__ = [
    "CONCERN_RECOMMENDATIONS",
    "CORRECTION_TYPE",
    "InvalidRecordError",
    "MIN_REVIEWS_FOR_REVIEWED",
    "MODERATION_DECISION_TYPE",
    "REJECTING_RECOMMENDATIONS",
    "RETRACTION_TYPE",
    "REVIEW_COMMIT_TYPE",
    "REVIEW_FORMAL_TYPE",
    "RULES",
    "STATE_SETTING_ACTIONS",
    "STATUSES",
    "STATUS_CONTESTED",
    "STATUS_CORRECTED",
    "STATUS_PRECEDENCE",
    "STATUS_PREPRINT",
    "STATUS_RECORD_TYPES",
    "STATUS_RETRACTED",
    "STATUS_REVIEWED",
    "STATUS_UNDER_REVIEW",
    "SUPPORTIVE_RECOMMENDATIONS",
    "StatusError",
    "StatusResult",
    "compute_status",
    "explain_status",
]
