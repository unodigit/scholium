"""HTTP routes for the flags plugin.

The module loader mounts this router under ``/v1``, so the routes below serve:

* ``POST /v1/flags`` -- file a flag against a paper, post, review or version.
* ``GET  /v1/flags/{id}`` -- read a flag's status and linked decision cid.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends

from app.errors import ProblemException
from app.security import Principal, Tier, get_current_principal

from . import service
from .models import ensure_table, ensure_tables

__all__ = ["router"]

router = APIRouter(prefix="/flags", tags=["flags"])


_TARGET_KEYS = ("target", "target_cid", "targetCid", "target_id", "targetId", "cid", "targetCid")
_REASON_KEYS = ("reason", "category", "reasonCategory", "reason_category", "reasonCategory", "flag_reason", "reason_category")


def _first(payload: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _to_dict(flag) -> dict[str, Any]:
    return {
        "id": flag.id,
        "flag_id": flag.id,
        "flagId": flag.id,
        "target_cid": flag.target_cid,
        "targetCid": flag.target_cid,
        "reporter_did": flag.reporter_did,
        "reporter": flag.reporter_did,
        "reason": flag.reason,
        "category": flag.reason,
        "reasonCategory": flag.reason,
        "status": flag.status,
        "decision_cid": flag.decision_cid,
        "decisionCid": flag.decision_cid,
    }


@router.post("", status_code=201)
def create_flag(
    payload: Any = Body(default=None),
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """File a flag and store it in the ``flags`` table as ``pending``."""
    ensure_tables()
    if not isinstance(payload, dict):
        payload = {}
    target = _first(payload, _TARGET_KEYS)
    reason = _first(payload, _REASON_KEYS)
    if target is None:
        raise ProblemException(422, "target is required")
    if reason is None:
        raise ProblemException(422, "reason is required")
    target = str(target).strip()
    reason = str(reason).strip()
    if not target:
        raise ProblemException(422, "target is required")
    if not reason:
        raise ProblemException(422, "reason is required")
    flag = service.create_flag(
        target_cid=target,
        reporter_did=principal.did,
        reason=reason,
    )
    return _to_dict(flag)


@router.get("/{flag_id}")
def get_flag(
    flag_id: str,
    principal: Principal = Depends(get_current_principal),
) -> dict[str, Any]:
    """Return a flag's status and linked decision cid.

    ``status`` is ``pending`` until a moderation decision resolves the flag,
    after which it carries the decided status and ``decision_cid`` the cid of
    that decision (``null`` while pending).  The reporter is notified with a
    ``flag.decided`` notification at the moment the flag is decided.

    A flag exposes its reporter's DID, so only the reporter and moderators
    (tier 4) can read it.  Anyone else gets the same 404 as for a flag that
    does not exist, so the endpoint cannot be used to probe for flag ids.
    """
    ensure_tables()
    flag = service.get_flag(flag_id)
    if flag is None or not (
        flag.reporter_did == principal.did or principal.tier >= Tier.MODERATOR
    ):
        raise ProblemException(404, f"No flag {flag_id!r}")
    return _to_dict(flag)