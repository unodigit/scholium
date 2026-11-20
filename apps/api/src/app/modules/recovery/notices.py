"""What a guardian's recovery notice records: their own answer, or how it closed.

A guardian is told of a request by a ``recovery.request`` notification.  Once
it is no longer waiting for them, the notice is read as history, so it keeps
the fact that ended the wait -- the client words it from that, never from the
notice merely being read:

* the guardian approved: ``answer`` (``"approved"``) and ``answered_at``, the
  time their approval was recorded on the request;
* enough guardians approved and the request is inside its safety window:
  ``contest_until``, when the new passkey takes over -- approved, but not
  closed;
* the request closed without their answer: ``closed`` (``"finalized"`` when the
  account moved to the new key, ``"cancelled"`` when the account holder
  cancelled it), ``closed_at``, and how many of the account's guardians had
  approved (``approval_count`` of ``guardian_count``).

A guardian's own answer is never replaced by a closure.  A cancel is the one
closure recorded beside it: every guardian of the account is told, whether or
not they had approved.  A cancel is also news, not history: each guardian's
notice is made unread again, so the bell counts it and the inbox labels it
(exactly one unread item per guardian, however often they had read it).

The account's own notice (sent to the account holder when the request is
opened) is resolved when the request closes, by cancel or completion: it gets
the same ``closed`` facts plus ``status``, so the client stops inviting a cancel.
It stays read: the account holder is the one who cancelled.

``closed_at`` is the time the request itself records
(``recovery_requests.closed_at``), so the notices and
``GET /v1/recovery/requests/{id}`` give the guardian page the same date.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from app import db
from app.modules.notifications import Notification, resolve_for_subject

from .models import RecoveryRequest, ensure_requests_table, mark_closed
from .service import get_guardians

__all__ = [
    "NOTIFICATION_KIND",
    "guardian_of",
    "record_answer",
    "record_closure",
    "recorded_closing_time",
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


def _utc_text(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _closing_time(request_id: str) -> str:
    """When the request closed, as the request records it; recorded now if it does not yet.

    The first closure wins, so a request closed twice keeps one time.  A
    request that cannot be read (or has no row) falls back to the present, so a
    notice is never written without a time.
    """
    try:
        ensure_requests_table()
        with db.SessionLocal() as session:
            row = session.get(RecoveryRequest, request_id)
            if row is not None:
                had = row.closed_at is not None
                closed_at = mark_closed(row)
                if not had:
                    session.commit()
                return _utc_text(closed_at)
    except Exception:
        logger.exception("could not record when recovery request %s closed", request_id)
    return _utc_text(datetime.now(timezone.utc))


def recorded_closing_time(request_id: str, account_did: str) -> Optional[str]:
    """When a request closed, as the account's own notice of it recorded, or ``None``.

    For a request that closed before ``recovery_requests.closed_at`` existed:
    the closure left its time (``closed_at``) on the account holder's notice.
    Read only.
    """
    with db.SessionLocal() as session:
        rows = (
            session.query(Notification)
            .filter(Notification.did == account_did, Notification.kind == NOTIFICATION_KIND)
            .order_by(Notification.id)
            .all()
        )
        for row in rows:
            payload = row.payload
            if isinstance(payload, dict) and payload.get("request_id") == request_id:
                closed_at = payload.get("closed_at")
                if isinstance(closed_at, str) and closed_at:
                    return closed_at
    return None


def _make_unread(did: str, request_id: str) -> None:
    """Make ``did``'s notice of ``request_id`` unread again.

    ``resolve_for_subject`` reads everything it resolves, which suits a notice
    that only records history.  A cancel is news: the guardian has to be alerted
    to it.  Only the latest notice of the request is reopened, so the guardian
    has exactly one unread item for it.
    """
    with db.SessionLocal() as session:
        rows = (
            session.query(Notification)
            .filter(Notification.did == did, Notification.kind == NOTIFICATION_KIND)
            .order_by(Notification.id)
            .all()
        )
        about = [
            row
            for row in rows
            if isinstance(row.payload, dict) and row.payload.get("request_id") == request_id
        ]
        if about and about[-1].read:
            about[-1].read = False
            session.commit()


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
    request_id: str,
    account_did: str,
    closed: Optional[str],
    approvals: Iterable[Any],
    *,
    contest_until: Any = None,
) -> None:
    """Resolve the notices a request's closing settles.

    Guardians who never answered the request are told how it closed.  A
    cancel is told to every guardian, the ones who approved included: the
    closure is recorded beside their own answer, which it never replaces, and
    their notice is made unread again so the cancel alerts them.  When the
    request closes (``closed`` is not ``None``) the account's own notice is
    resolved too, so it stops inviting a cancel; it stays read.

    ``closed`` is the reason the request closed (``quorum`` is no longer used
    during the safety window: pass ``None`` to record an approval instead);
    ``contest_until`` records when the new passkey takes over.
    """
    answered = {did for did in (guardian_of(item) for item in approvals) if did}
    guardians = get_guardians(account_did)
    facts: dict[str, Any] = {
        "approval_count": len(answered),
        "guardian_count": len(guardians),
    }
    if closed is not None:
        facts["closed"] = closed
        facts["closed_at"] = _closing_time(request_id)
    if contest_until is not None:
        if isinstance(contest_until, datetime):
            facts["contest_until"] = contest_until.strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            facts["contest_until"] = contest_until
    for guardian in guardians:
        if guardian in answered and closed != "cancelled":
            continue
        try:
            resolve_for_subject(guardian, NOTIFICATION_KIND, request_id, facts)
            if closed == "cancelled":
                _make_unread(guardian, request_id)
        except Exception:
            logger.exception("could not resolve %s's notice of recovery request %s", guardian, request_id)
    if closed is not None:
        # The account's own notice names the request the same way a guardian's
        # does; ``status`` is the request's status, for a client that reads that.
        try:
            resolve_for_subject(account_did, NOTIFICATION_KIND, request_id, {**facts, "status": closed})
        except Exception:
            logger.exception("could not resolve %s's notice of recovery request %s", account_did, request_id)
