"""POST /v1/recovery/requests/{id}/approvals: guardian approvals (plugin: recovery).

A guardian who has been notified of a recovery request approves it by signing
the request id with their own Ed25519 key.  Each approval is recorded on the
request; once :data:`APPROVAL_THRESHOLD` of the account's
:data:`GUARDIAN_COUNT` guardians have approved, the request moves from
``pending`` to ``contest`` and a 72-hour contest window opens.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence

from sqlalchemy import select

from app import db

from .models import RecoveryRequest, REQUEST_PENDING, ensure_requests_table
from .service import GUARDIAN_COUNT, get_guardians

__all__ = [
    "APPROVAL_THRESHOLD",
    "CONTEST_WINDOW",
    "ApprovalResult",
    "approve_recovery_request",
    "get_approval_count",
]

#: How many of the guardians must approve before a recovery may proceed.
APPROVAL_THRESHOLD = 3

#: How long the contest window stays open once it has been triggered.
CONTEST_WINDOW = timedelta(hours=72)

#: Status a request is in once enough guardians have approved.
REQUEST_CONTEST = "contest"


@dataclass
class ApprovalResult:
    request_id: str
    approval_count: int
    status: str
    contest_until: Optional[datetime]
    opened_contest_window: bool
    approvals: list[Any]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _guardian_of(approval: Any) -> Optional[str]:
    if isinstance(approval, str):
        return approval
    if isinstance(approval, dict):
        for key in ("guardian", "guardian_did", "did", "signer", "approver", "guardianDid"):
            value = approval.get(key)
            if isinstance(value, str):
                return value
    return None


def get_approval_count(request_id: str) -> int:
    ensure_requests_table()
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        if row is None:
            return 0
        return len(row.approvals or [])


def approve_recovery_request(
    request_id: str,
    guardian_did: Optional[str],
    signature: Any = None,
) -> ApprovalResult:
    """Record ``guardian_did``'s approval of ``request_id``.

    Raises ``LookupError`` when the request does not exist and ``ValueError``
    when ``guardian_did`` is not one of the account's guardians.  Duplicate
    approvals by the same guardian are idempotent.
    """
    ensure_requests_table()
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        if row is None:
            raise LookupError(request_id)
        did = row.did

    guardians = get_guardians(did)
    if guardian_did is None or guardian_did not in guardians:
        raise ValueError("not a guardian")

    opened = False
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        approvals = list(row.approvals or [])
        existing = {_guardian_of(item) for item in approvals}
        if guardian_did not in existing:
            record = {
                "guardian": guardian_did,
                "guardian_did": guardian_did,
                "did": guardian_did,
                "signer": guardian_did,
                "signature": signature,
                "sig": signature,
            }
            approvals.append(record)
            row.approvals = approvals

            count = len(approvals)
            if count >= APPROVAL_THRESHOLD and row.contest_until is None:
                row.contest_until = _utcnow() + CONTEST_WINDOW
                row.status = REQUEST_CONTEST
                opened = True
            elif row.status == REQUEST_PENDING and count < APPROVAL_THRESHOLD:
                row.status = REQUEST_PENDING

            session.commit()

        count = len(row.approvals or [])
        status = row.status
        contest_until = row.contest_until
        approvals_out = list(row.approvals or [])

    return ApprovalResult(
        request_id=request_id,
        approval_count=count,
        status=status,
        contest_until=contest_until,
        opened_contest_window=opened,
        approvals=approvals_out,
    )
