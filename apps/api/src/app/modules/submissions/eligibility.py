"""``GET /v1/submissions/eligibility`` -- what the caller may submit right now.

The wizard used to learn about the weekly limit only from the ``429`` at Sign
and submit: five steps and an upload after the author could have been told.
This route answers the same question up front, from the very code that refuses
a ``paper.genesis`` at ingest:

* the caller's trust tier (the ``accounts`` row the ingest handler reads);
* whether anything *other than a category choice* stops them now -- they must
  be an Author (tier 2) and must not have started a paper in the rolling week
  (:mod:`app.modules.submissions.limits`);
* the weekly quota ``used``/``allowed`` and, while it applies, the instant the
  next paper may be started (``next_allowed_at``, the same value the ``429``
  carries);
* the categories they hold an active endorsement in, so the Details step can
  say which chosen categories are not open to them.

The route is authenticated: the facts are about the caller's own account, so
an unauthenticated read is a ``401`` problem document like every other
authenticated read.  It writes nothing.

``may_submit`` is about the account, not the paper: a caller endorsed only in
``cs.AI`` who chooses ``cs.LG`` is told so by the wizard from
``endorsed_categories``.  A caller with no active endorsement cannot start any
paper, because a genesis needs one in every category it lists, so
``may_submit`` is ``false`` for them too.  This route never guesses -- it
reports the quota the limit code computed, including ``next_allowed_at: null``
when the rule does not apply.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from app.modules.endorsements import active_endorsements
from app.modules.ingest import author_tier
from app.security import Principal, get_current_principal

from .genesis import GENESIS_MIN_TIER
from .limits import genesis_quota

__all__ = ["EligibilityOut", "router"]

router = APIRouter(prefix="/submissions", tags=["submissions"])


def _iso(value: Optional[datetime]) -> Optional[str]:
    """``value`` as an ISO 8601 UTC instant with a ``Z`` suffix, or ``None``."""
    if value is None:
        return None
    moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EligibilityOut(BaseModel):
    """What ``GET /v1/submissions/eligibility`` serves the signed-in caller.

    ``weekly_used`` counts the caller's ``paper.genesis`` records the node
    accepted inside the rolling week, and ``weekly_allowed`` is the limit
    (:data:`~.limits.GENESIS_WEEKLY_LIMIT`).  ``next_allowed_at`` is present
    only while the weekly rule currently refuses a new paper; it is the same
    instant the ``429`` names at signing.
    """

    model_config = ConfigDict(extra="forbid")

    tier: int
    #: True when the account can start some paper now: an Author with an active
    #: endorsement, outside the weekly window. `endorsed_categories` decides
    #: whether a *particular* chosen category is open.
    may_submit: bool
    weekly_used: int
    weekly_allowed: int
    #: ISO 8601 UTC instant, or ``null`` when no weekly limit applies now.
    next_allowed_at: Optional[str] = None
    #: Categories with an active endorsement, alphabetical and de-duplicated.
    endorsed_categories: list[str]


@router.get(
    "/eligibility",
    response_model=EligibilityOut,
    summary="Report what the signed-in caller may submit now",
)
def get_eligibility(
    principal: Principal = Depends(get_current_principal),
) -> EligibilityOut:
    """Return the caller's tier, weekly quota and endorsed categories.

    The tier is read from the account table rather than the access token, so a
    tier granted after the token was issued is already reflected.  The quota is
    :func:`~.limits.genesis_quota` -- the same computation the genesis handler
    enforces -- so the early answer and the late refusal cannot disagree.
    """
    tier = author_tier(principal.did)
    quota = genesis_quota(principal.did, tier)
    categories = sorted({row.category for row in active_endorsements(principal.did)})
    return EligibilityOut(
        tier=tier,
        # A genesis needs an active endorsement in every category it lists, so
        # with no endorsement at all there is no paper this account can start,
        # whatever its tier.
        may_submit=tier >= GENESIS_MIN_TIER and bool(categories) and not quota.limited,
        weekly_used=quota.used,
        weekly_allowed=quota.allowed,
        next_allowed_at=_iso(quota.next_allowed_at),
        endorsed_categories=categories,
    )
