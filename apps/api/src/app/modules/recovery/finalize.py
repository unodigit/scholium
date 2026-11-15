"""Finalizing a recovery request after its 72-hour contest window (plugin: recovery).

Feature 40: once three guardians have approved and the contest window has
elapsed without the old key cancelling, a background job finalizes the
recovery by appending a ``key.rotation`` record carrying the guardian proofs
and moving the account onto its new key.  From that point records signed by
the old key are refused with ``401``.

Finalization is a job on :mod:`app.jobs` (kind ``recovery.finalize``).  It
does its work only when the request is still in ``contest`` and its
``contest_until`` has passed; a cancelled or already-finalized request, or
one still inside its window, is left untouched.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select

from app import db, jobs

REQUEST_CONTEST = "contest"
from .models import RecoveryRequest, ensure_requests_table
from .rotation import apply_rotation, KEY_ROTATION_TYPE
from app.modules import ledger

__all__ = [
    "JOB_KIND",
    "finalize_recovery_request",
    "finalize_due_requests",
    "finalize_job",
]

#: Job kind registered with :mod:`app.jobs`.
JOB_KIND = "recovery.finalize"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_list(value: Any) -> list:
    return list(value) if isinstance(value, (list, tuple)) else ([] if value is None else [value])


def finalize_recovery_request(request_id: str) -> bool:
    """Finalize one request if it is due. Return True when finalized."""
    ensure_requests_table()
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        if row is None:
            return False
        if row.status != REQUEST_CONTEST:
            return False
        if row.contest_until is not None and row.contest_until > _utcnow():
            return False
        did = row.did
        new_key = row.new_public_key
        approvals = _as_list(row.approvals)
        row_id = row.id

    # Move the account onto its new key.
    try:
        apply_rotation(did, new_key)
    except Exception:
        # Leave the request open so a later run can retry.
        return False

    # Append the key.rotation record carrying the guardian proofs.
    try:
        ledger.append(
            {
                "v": 1,
                "type": KEY_ROTATION_TYPE,
                "author": did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": None,
                "body": {
                    "oldKey": did,
                    "newKey": new_key,
                    "recoveryProof": approvals,
                },
                "proofs": approvals,
            }
        )
    except Exception:
        # The rotation already landed; still mark the request finalized below.
        pass

    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, row_id)
        if row is not None and row.status == REQUEST_CONTEST:
            row.status = "finalized"
            session.commit()
    return True


def finalize_due_requests() -> int:
    """Finalize every contest request whose window has elapsed. Return count."""
    ensure_requests_table()
    finalized = 0
    with db.SessionLocal() as session:
        rows = session.scalars(
            select(RecoveryRequest).where(RecoveryRequest.status == REQUEST_CONTEST)
        ).all()
        ids = [r.id for r in rows]
    for rid in ids:
        if finalize_recovery_request(rid):
            finalized += 1
    return finalized


def finalize_job(payload: Any) -> None:
    payload = payload if isinstance(payload, dict) else {}
    request_id = payload.get("request_id") or payload.get("id")
    if isinstance(request_id, str) and request_id:
        finalize_recovery_request(request_id)
    else:
        finalize_due_requests()


# Register the handler at import time so ``jobs.enqueue`` accepts the kind.
jobs.register(JOB_KIND, finalize_job)
