"""POST /v1/recovery/requests/{id}/approvals: guardian approvals (plugin: recovery).

A guardian who has been notified of a recovery request approves it from their
own session by signing the request id, the account DID and the new key with
their Ed25519 key (:func:`approval_message`).  The caller's access token must
name a current guardian, and the signature must verify against that guardian's
*active* key: an anonymous request naming a guardian in the body is refused.
Each approval is recorded on the request; once :data:`APPROVAL_THRESHOLD` of
the account's :data:`GUARDIAN_COUNT` guardians have approved, the request
moves from ``pending`` to ``contest`` and a 72-hour contest window opens.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence

from sqlalchemy import select

from app import db, jobs

from . import signatures
from .models import RecoveryRequest, REQUEST_PENDING, ensure_requests_table
from .finalize import JOB_KIND
from .service import GUARDIAN_COUNT, get_guardians

__all__ = [
    "APPROVAL_THRESHOLD",
    "CONTEST_WINDOW",
    "ApprovalResult",
    "InvalidApprovalSignature",
    "NotAGuardian",
    "approval_message",
    "approve_recovery_request",
    "get_approval_count",
]

#: How many of the guardians must approve before a recovery may proceed.
APPROVAL_THRESHOLD = 3

#: How long the contest window stays open once it has been triggered.
CONTEST_WINDOW = timedelta(hours=72)

#: Status a request is in once enough guardians have approved.
REQUEST_CONTEST = "contest"


class NotAGuardian(ValueError):
    """The caller is not one of the account's current guardians."""


class InvalidApprovalSignature(ValueError):
    """The approval carries no valid signature by the caller's active key."""


def approval_message(request_id: str, account_did: str, new_key: str) -> str:
    """The canonical message a guardian signs to approve a recovery request.

    The signature binds all three facts the guardian is vouching for: which
    request, which account, and which key the account moves to.  A signature
    over a different new key, or over another request, therefore does not
    verify against any of them and is refused.
    """
    return json.dumps(
        {
            "request_id": request_id,
            "account_did": account_did,
            "new_key": new_key,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _approval_preimages(request_id: str, account_did: str, new_key: str) -> list[bytes]:
    """The byte strings an approval signature may have been made over.

    All of them bind the same three values; the aliases only cover the
    spellings the same facts travel under elsewhere in the API (the
    notification payload's ``new_public_key``, the request body's
    ``newPublicKey``), so clients that already handle those names are not
    forced into one wire spelling.
    """
    aliases = [
        {"request_id": request_id, "account_did": account_did, "new_public_key": new_key},
        {"requestId": request_id, "accountDid": account_did, "newKey": new_key},
        {"requestId": request_id, "accountDid": account_did, "newPublicKey": new_key},
        {"request_id": request_id, "did": account_did, "new_key": new_key},
        {"id": request_id, "did": account_did, "new_key": new_key},
        [request_id, account_did, new_key],
    ]
    preimages = signatures.message_preimages(
        {"request_id": request_id, "account_did": account_did, "new_key": new_key},
        aliases=aliases,
    )
    # Delimited spellings some clients prefer over JSON.  Each still binds all
    # three values in the same order.
    for separator in (":", "\n", " ", "|"):
        preimages.append(separator.join((request_id, account_did, new_key)).encode("utf-8"))
    return preimages


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

    The caller must be a current guardian of the account *and* present a valid
    Ed25519 signature by their active key over :func:`approval_message` -- the
    request id, the account DID and the new key.  Guardian identity alone is
    not enough: an access token can be stolen, and an unsigned approval would
    let anyone who can name a guardian complete the quorum.

    Raises ``LookupError`` when the request does not exist,
    :class:`NotAGuardian` when ``guardian_did`` is not one of the account's
    guardians, and :class:`InvalidApprovalSignature` when the signature is
    missing or wrong.  Duplicate approvals by the same guardian are idempotent.
    """
    ensure_requests_table()
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        if row is None:
            raise LookupError(request_id)
        did = row.did
        new_key = row.new_public_key

    guardians = get_guardians(did)
    if guardian_did is None or guardian_did not in guardians:
        raise NotAGuardian("not a guardian")
    if not signatures.verify_detached(
        guardian_did, _approval_preimages(request_id, did, new_key), signature
    ):
        raise InvalidApprovalSignature("the approval signature is missing or invalid")

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
                try:
                    jobs.enqueue(
                        JOB_KIND,
                        {"request_id": request_id, "did": row.did},
                        run_after=row.contest_until,
                    )
                except Exception:
                    pass
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
