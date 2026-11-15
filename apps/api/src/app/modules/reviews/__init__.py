"""Reviews plugin (plugin: reviews).

Feature 105: ``POST /v1/papers/{id}/review-invitations`` saves an invitation
to the ``review_invitations`` table, from an author or tier-4 member to a
tier-3 reviewer in the paper category.

Feature 106: ``GET /v1/papers/{id}/coi-check`` returns the conflict-of-interest
checks for the calling reviewer -- not an author, no co-authorship with an
author in the last 3 years, and a different institution from every author.
See :mod:`app.modules.reviews.coi`.

Feature 107: ``POST /v1/reviews/commit`` accepts a signed ``review.commit``
(target version, commitment, per-paper review key, nullifier) from a tier-3
member, saves it to the ``review`` table, and refuses a second review by the
same person on the same paper (``409``) or an author reviewing their own
paper (``403``).  See :mod:`app.modules.reviews.service`.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1`` and registers the
``review.commit`` handler with the ingest pipeline.
"""

from __future__ import annotations

from .coi import COI_WINDOW_YEARS, CoiCheck, CoiReport, check_conflicts
from .errors import (
    REVIEW_ALREADY_COMMITTED,
    REVIEW_NOT_AUTHORIZED,
    UNKNOWN_REVIEW_TARGET,
    ReviewAlreadyCommitted,
    ReviewNotAuthorized,
    UnknownReviewTarget,
)
from .models import Review, ReviewInvitation, ensure_table, ensure_tables
from .router import router
from .service import (
    COMMITTED,
    REVIEW_COMMIT_MIN_TIER,
    REVIEW_COMMIT_TYPE,
    ReviewCommitFields,
    apply_review_commit,
    create_invitation,
    create_review_invitation,
    find_review_by_nullifier,
    get_invitation,
    get_review,
    get_review_invitation,
    handle_review_commit,
    is_author_or_moderator,
    is_tier3_reviewer,
    list_invitations,
    list_review_invitations,
    nullifier_bytes,
    persist_review_commit,
    require_not_author,
    resolve_paper,
    resolve_review_target,
    resolve_version,
    review_commit_fields,
    save_invitation,
    save_review_invitation,
)

__all__ = [
    "COI_WINDOW_YEARS",
    "COMMITTED",
    "CoiCheck",
    "CoiReport",
    "REVIEW_ALREADY_COMMITTED",
    "REVIEW_COMMIT_MIN_TIER",
    "REVIEW_COMMIT_TYPE",
    "REVIEW_NOT_AUTHORIZED",
    "Review",
    "ReviewAlreadyCommitted",
    "ReviewCommitFields",
    "ReviewInvitation",
    "ReviewNotAuthorized",
    "UNKNOWN_REVIEW_TARGET",
    "UnknownReviewTarget",
    "apply_review_commit",
    "check_conflicts",
    "create_invitation",
    "create_review_invitation",
    "ensure_table",
    "ensure_tables",
    "find_review_by_nullifier",
    "get_invitation",
    "get_review",
    "get_review_invitation",
    "handle_review_commit",
    "is_author_or_moderator",
    "is_tier3_reviewer",
    "list_invitations",
    "list_review_invitations",
    "nullifier_bytes",
    "persist_review_commit",
    "require_not_author",
    "resolve_paper",
    "resolve_review_target",
    "resolve_version",
    "review_commit_fields",
    "router",
    "save_invitation",
    "save_review_invitation",
]


def _install_ledger_subscriber() -> None:
    """Save every ``review.commit`` once it is committed to the log."""
    from app.modules import ledger

    ledger.subscribe(REVIEW_COMMIT_TYPE, persist_review_commit)


def _register_record_type() -> None:
    """Register ``review.commit`` with the ingest pipeline.

    An existing registration is left alone rather than conflicted with, so
    re-importing the package is harmless.
    """
    from app.modules import ingest

    if ingest.get(REVIEW_COMMIT_TYPE) is None:
        ingest.register(
            REVIEW_COMMIT_TYPE,
            handle_review_commit,
            min_tier=REVIEW_COMMIT_MIN_TIER,
        )


_install_ledger_subscriber()
_register_record_type()
