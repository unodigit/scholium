"""Persisting and delivering notifications.

``notify(did, kind, payload)`` is the single entry point other modules use::

    from app.modules.notifications import notify

    notify("did:example:alice", "consent.request", {
        "email": "alice@example.org",
        "paper_cid": "bafyrei...",
        "link": "https://scholium.example/consent/123",
    })

The notification is always persisted first (unread) and the email is a
best-effort side effect: when ``SMTP_URL`` is set it is sent through SMTP,
otherwise (or if SMTP delivery fails) it is logged to the outbox.  Email
problems never lose the notification or raise out of ``notify``.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

from app import db
from app.settings import settings

from .emailer import build_email, log_to_outbox, send_email
from .models import Notification, ensure_table

__all__ = ["list_notifications", "mark_read", "notify"]

logger = logging.getLogger(__name__)

#: Payload members that name the subject of a notification, most specific first.
#: Two unread notifications with the same kind, recipient and subject describe
#: the same fact, so a retried event must not add a duplicate row.  Kinds whose
#: payload names no subject (``digest``, a bare ``{"n": 1}``) carry no subject
#: and are never de-duplicated.
_SUBJECT_KEYS = (
    "version_cid",
    "request_id",
    # An appeal is its own subject: two appeals may contest the same decision.
    "appeal_cid",
    "flag_id",
    "decision_cid",
    "target_cid",
    "appeal_id",
    "paper_cid",
    "record_cid",
)


def _subject_of(payload: Any) -> Optional[tuple[str, str]]:
    """The ``(payload key, value)`` that names what a notification is about."""
    if not isinstance(payload, Mapping):
        return None
    for key in _SUBJECT_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return key, value.strip()
    return None


def _unread_notification_for_subject(
    session: Any, did: str, kind: str, subject: tuple[str, str]
) -> Optional[Notification]:
    """Return ``did``'s unread notification of ``kind`` about ``subject``, if any."""
    rows = (
        session.query(Notification)
        .filter(
            Notification.did == did,
            Notification.kind == kind,
            Notification.read.is_(False),
        )
        .order_by(Notification.id)
        .all()
    )
    return next((row for row in rows if _subject_of(row.payload) == subject), None)


def notify(did: str, kind: str, payload: Optional[Any] = None) -> Notification:
    """Persist an unread notification for ``did`` and email it.

    ``payload`` must be JSON-serialisable (it is stored in the ``payload``
    JSON column and rendered into the email body).  Returns the persisted
    :class:`~app.modules.notifications.models.Notification`.

    When the payload names a subject (a version, request, decision or paper)
    and the same recipient already has an *unread* notification of the same
    kind about it, that row is returned instead of writing a second one: a
    repeated event tells the reader the same fact, and two identical unread
    rows would ask them to deal with it twice.  Once the first row is read, a
    later event is a new announcement and gets its own row.
    """
    if not isinstance(did, str) or not did.strip():
        raise ValueError("notify() requires a non-empty did")
    if not isinstance(kind, str) or not kind.strip():
        raise ValueError("notify() requires a non-empty kind")

    stored_payload: Any = {} if payload is None else payload
    if isinstance(stored_payload, Mapping):
        stored_payload = dict(stored_payload)

    ensure_table()

    session = db.SessionLocal()
    # Keep attribute values readable after commit/close; callers routinely use
    # the returned object (its ``id`` especially) outside this function.
    session.expire_on_commit = False
    try:
        subject = _subject_of(stored_payload)
        if subject is not None:
            duplicate = _unread_notification_for_subject(session, did, kind, subject)
            if duplicate is not None:
                # The same fact is already waiting for the reader; no second
                # row and no second email.
                return duplicate
        notification = Notification(
            did=did,
            kind=kind,
            payload=stored_payload,
            read=False,
        )
        session.add(notification)
        session.commit()
        notification_id = notification.id
    finally:
        session.close()

    email = build_email(did, kind, stored_payload, notification_id=notification_id)
    smtp_url = (settings.SMTP_URL or "").strip()
    if smtp_url:
        try:
            send_email(email, smtp_url)
        except Exception:
            logger.exception(
                "SMTP delivery failed for notification %s (%s); logging to outbox",
                notification_id,
                kind,
            )
            log_to_outbox(email, reason="smtp delivery failed")
    else:
        log_to_outbox(email)

    return notification


def _require_did(did: str) -> str:
    """Validate a caller DID the same way :func:`notify` validates its recipient."""
    if not isinstance(did, str) or not did.strip():
        raise ValueError("a non-empty did is required")
    return did


def list_notifications(did: str) -> list[Notification]:
    """Return every notification addressed to ``did``, oldest first.

    Both unread and read rows come back, ordered by ``id`` (insertion order),
    so the caller can render an inbox and count the unread ones itself.
    """
    _require_did(did)
    ensure_table()

    with db.SessionLocal() as session:
        return (
            session.query(Notification)
            .filter(Notification.did == did)
            .order_by(Notification.id)
            .all()
        )


def mark_read(did: str, notification_id: int) -> Optional[Notification]:
    """Mark one of ``did``'s notifications read; return None if there is no such row.

    Only rows addressed to ``did`` are matched, so one account can neither see
    nor flip another account's notification, and a missing row and somebody
    else's row are indistinguishable (both None -- the router answers 404).
    Marking an already-read notification is a successful no-op.
    """
    _require_did(did)
    ensure_table()

    session = db.SessionLocal()
    # Keep attribute values readable after commit/close; the router serialises
    # the returned row into its response.
    session.expire_on_commit = False
    try:
        notification = (
            session.query(Notification)
            .filter(Notification.id == notification_id, Notification.did == did)
            .one_or_none()
        )
        if notification is None or notification.read:
            return notification
        notification.read = True
        session.commit()
        return notification
    finally:
        session.close()
