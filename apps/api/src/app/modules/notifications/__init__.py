"""Notifications module (plugin: notifications).

Feature 57: :func:`notify` persists an unread row to the ``notifications``
table and delivers an email -- through SMTP when ``SMTP_URL`` is configured,
otherwise to the outbox log.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to register the model on the shared
declarative base before ``create_app`` creates tables.
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
from .service import notify

__all__ = [
    "Email",
    "Notification",
    "build_email",
    "clear_outbox",
    "ensure_table",
    "get_outbox",
    "log_to_outbox",
    "notify",
    "parse_smtp_url",
    "send_email",
]
