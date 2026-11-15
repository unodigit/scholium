"""Dashboard plugin (plugin: me).

Feature 126: ``GET /v1/me/dashboard`` returns the caller's home screen in one
document -- ``needs_attention`` (consents to sign, review invitations, author
replies, moderation outcomes), ``my_papers`` with each paper's status and
review counts, and ``my_reviews`` with each review's sealed or revealed state.

The module keeps no table of its own: the view is assembled from the
projections the submissions, consents, reviews, notifications, moderation and
flags plugins already keep.  See :mod:`app.modules.me.service` for how each
part is derived -- in particular how the caller's own reviews are found
through the review escrow's HMAC token rather than a plaintext mapping.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to mount the ``router`` under ``/v1``.
"""

from __future__ import annotations

from .router import router
from .service import ATTENTION_KINDS, INVITATION_PENDING, build_dashboard

__all__ = [
    "ATTENTION_KINDS",
    "INVITATION_PENDING",
    "build_dashboard",
    "router",
]
