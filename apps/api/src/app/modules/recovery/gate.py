"""The guardians gate: no submissions until an account has set its guardians.

Design (``docs/design.md`` section 6): recovery guardians are "required before
first submission". Any route that accepts a submission enforces that with
either of these, and an account that has not set its five guardians gets
``403`` problem details of type
:data:`~app.modules.recovery.problems.GUARDIANS_REQUIRED_TYPE`::

    from fastapi import Depends
    from app.modules.recovery import require_guardians

    @router.post("/papers")
    def submit(principal: Principal = Depends(require_guardians)): ...

    # or, from code that already knows the caller's DID (an ingest handler):
    from app.modules.recovery import ensure_guardians_set

    ensure_guardians_set(author_did)

The gate is only about guardians. It does not look at trust tiers, so combine it
with :func:`app.security.require_tier` where a route needs both.
"""

from __future__ import annotations

from fastapi import Depends

from app.security import Principal, get_current_principal

from . import problems
from .service import GUARDIAN_COUNT, has_guardians

__all__ = ["ensure_guardians_set", "require_guardians"]


def ensure_guardians_set(did: str) -> None:
    """Raise the ``403`` guardians-required problem unless ``did`` has all its guardians."""
    if not has_guardians(did):
        raise problems.guardians_required(GUARDIAN_COUNT)


def require_guardians(principal: Principal = Depends(get_current_principal)) -> Principal:
    """Dependency admitting only authenticated callers who have set their guardians.

    Answers ``401`` for an unauthenticated request (as every protected route
    does) and ``403`` problem details while the caller's guardians are not set.
    Yields the caller's :class:`~app.security.Principal`.
    """
    ensure_guardians_set(principal.did)
    return principal
