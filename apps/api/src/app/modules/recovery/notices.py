"""What a guardian's recovery notice records: their own answer, or how it closed.

A guardian is told of a request by a ``recovery.request`` notification.  Once
it is no longer waiting for them, the notice is read as history, so it keeps
the fact that ended the wait -- the client words it from that, never from the
notice merely being read:

* the guardian approved: ``answer`` (``"approved"``) and ``answered_at``, the
  time their approval was recorded on the request;
* the request closed without their answer: ``closed`` (``"quorum"`` when enough
  guardians approved and the contest window opened, ``"finalized"`` when the
  account moved to the new key, ``"cancelled"`` when the account holder
  cancelled it), ``closed_at``, and how many of the account's guardians had
  approved (``approval_count`` of ``guardian_count``).

A guardian's own answer is never replaced by a closure.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from app.modules.notifications import resolve_for_subject

from .service import get_guardians

__all__ = [
    "NOTIFICATION_KIND",
    "guardian_of",
    "record_answer",
    "record_closure",
]

logger = logging.getLogger(__name__)

#: The kind guardians are notified of a request with.
NOTIFICATION_KIND = "recovery.request"


def guardian_of(approval: Any) -> Optional[str]:
    """The guardian DID an entry of a request's ``approvals`` names."""
    if isinstance(approval, str):
        return approval
    if isinstance(approval, dict):
        for key in ("guardian", "guardian_did", "did", "signer", "approver", "guardianDid"):
            value = approval.get(key)
            if isinstance(value, str):
                return value
    return None


def record_answer(
    guardian_did: str, request_id: str, approved_at: Optional[str], answer: str = "approved"
) -> None:
    """The guardian's own answer is on record: resolve their notice with it."""
    facts: dict[str, Any] = {"answer": answer}
    if approved_at:
        facts["answered_at"] = approved_at
    try:
        resolve_for_subject(guardian_did, NOTIFICATION_KIND, request_id, facts)
    except Exception:
        logger.exception("could not resolve %s's notice of recovery request %s", guardian_did, request_id)


def record_closure(
    request_id: str, account_did: str, closed: str, approvals: Iterable[Any]
) -> None:
    """The request closed: resolve the notice of every guardian who never answered it."""
    answered = {did for did in (guardian_of(item) for item in approvals) if did}
    guardians = get_guardians(account_did)
    facts = {
        "closed": closed,
        "closed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "approval_count": len(answered),
        "guardian_count": len(guardians),
    }
    for guardian in guardians:
        if guardian in answered:
            continue
        try:
            resolve_for_subject(guardian, NOTIFICATION_KIND, request_id, facts)
        except Exception:
            logger.exception("could not resolve %s's notice of recovery request %s", guardian, request_id)
