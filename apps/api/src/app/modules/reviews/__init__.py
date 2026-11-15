"""Reviews plugin (plugin: reviews).

Feature 105: ``POST /v1/papers/{id}/review-invitations`` saves an invitation
to the ``review_invitations`` table, from an author or tier-4 member to a
tier-3 reviewer in the paper category.

Feature 106: ``GET /v1/papers/{id}/coi-check`` returns the conflict-of-interest
checks for the calling reviewer -- not an author, no co-authorship with an
author in the last 3 years, and a different institution from every author.
See :mod:`app.modules.reviews.coi`.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1``.
"""

from __future__ import annotations

from .coi import COI_WINDOW_YEARS, CoiCheck, CoiReport, check_conflicts
from .models import ReviewInvitation, ensure_table, ensure_tables
from .router import router
from .service import (
    create_invitation,
    create_review_invitation,
    get_invitation,
    get_review_invitation,
    is_author_or_moderator,
    is_tier3_reviewer,
    list_invitations,
    list_review_invitations,
    resolve_paper,
    resolve_version,
    save_invitation,
    save_review_invitation,
)

__all__ = [
    "COI_WINDOW_YEARS",
    "CoiCheck",
    "CoiReport",
    "ReviewInvitation",
    "check_conflicts",
    "create_invitation",
    "create_review_invitation",
    "ensure_table",
    "ensure_tables",
    "get_invitation",
    "get_review_invitation",
    "is_author_or_moderator",
    "is_tier3_reviewer",
    "list_invitations",
    "list_review_invitations",
    "resolve_paper",
    "resolve_version",
    "router",
    "save_invitation",
    "save_review_invitation",
]