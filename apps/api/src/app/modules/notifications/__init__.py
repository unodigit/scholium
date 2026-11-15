"""Notifications module (plugin: notifications).

Feature 57: :func:`notify` persists an unread row to the ``notifications``
table and delivers an email -- through SMTP when ``SMTP_URL`` is configured,
otherwise to the outbox log.

Feature 58: ``GET /v1/me/notifications`` lists the caller's unread and read
notifications and ``POST /v1/me/notifications/{id}/read`` marks one read.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to register the model on the shared
declarative base before ``create_app`` creates tables, and the ``router``
exported here is mounted under ``/v1``.
"""

from __future__ import annotations

from .emailer import (
    Email,
    build_email,
    clear_outbox,
    get_outbox,
    log_to_outbox,
    parse_smtp_url,
    send_email,
)
from .models import Notification, ensure_table
from .router import router
from .schemas import NotificationOut
from .service import list_notifications, mark_read, notify

__all__ = [
    "Email",
    "Notification",
    "NotificationOut",
    "build_email",
    "clear_outbox",
    "ensure_table",
    "get_outbox",
    "list_notifications",
    "log_to_outbox",
    "mark_read",
    "notify",
    "parse_smtp_url",
    "router",
    "send_email",
]
