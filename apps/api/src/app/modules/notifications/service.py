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

__all__ = ["notify"]

logger = logging.getLogger(__name__)


def notify(did: str, kind: str, payload: Optional[Any] = None) -> Notification:
    """Persist an unread notification for ``did`` and email it.

    ``payload`` must be JSON-serialisable (it is stored in the ``payload``
    JSON column and rendered into the email body).  Returns the persisted
    :class:`~app.modules.notifications.models.Notification`.
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
