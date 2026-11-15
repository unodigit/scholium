"""Reviews plugin (plugin: reviews).

Feature 105: ``POST /v1/papers/{id}/review-invitations`` saves an invitation
to the ``review_invitations`` table, from an author or tier-4 member to a
tier-3 reviewer in the paper category.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1``.
"""

from __future__ import annotations

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
    "ReviewInvitation",
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