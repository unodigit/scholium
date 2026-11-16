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

``compute_status`` is a pure function: it reads no table.  Feature 84 is what
keeps ``papers.status`` current: a ledger subscription (``on_status_record``)
recomputes a paper's status from the log and saves it whenever a review, notice
or moderation record for that paper is appended.  See
:mod:`app.modules.status.subscription` for which paper a record is about and how
the recompute is saved.

This package exposes no ``router``; the module loader discovers it by
convention and runs its ``on_startup`` hook, which (re)installs the
subscription.
"""

from __future__ import annotations

from typing import Optional

from fastapi import FastAPI

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
from .subscription import (
    install,
    on_status_record,
    paper_records,
    recompute_paper_status,
    record_paper_cid,
    uninstall,
)

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
    "install",
    "on_startup",
    "on_status_record",
    "paper_records",
    "recompute_paper_status",
    "record_paper_cid",
    "uninstall",
]


def on_startup(app: Optional[FastAPI] = None) -> None:
    """Module-loader hook: make sure the ledger subscription is in place.

    Runs on every ``create_app``.  The subscriber registry is process-global
    and may have been cleared since this package was first imported, so the
    subscription is installed again; :func:`install` is idempotent.
    """
    install()


# Subscribe on import too, so the status is kept current for code that imports
# the package without building an app (scripts, tests).
install()
