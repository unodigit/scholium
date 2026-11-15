"""Notifications module (plugin: notifications).

Feature 57: :func:`notify` persists an unread row to the ``notifications``
table and delivers an email -- through SMTP when ``SMTP_URL`` is configured,
otherwise to the outbox log.

Feature 58: ``GET /v1/me/notifications`` lists the caller's unread and read
notifications and ``POST /v1/me/notifications/{id}/read`` marks one read.

Feature 59: when a version enters ``awaiting_consent`` every author listed on
it receives a ``consent.request`` notification carrying a link to the consent
page (:func:`notify_consent_requests`, subscribed to the submissions plugin's
``version.state_changed`` event at import time).

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to register the model on the shared
declarative base before ``create_app`` creates tables, and the ``router``
exported here is mounted under ``/v1``.
"""

from __future__ import annotations

from .consent import (
    AWAITING_CONSENT,
    CONSENT_PATH,
    CONSENT_REQUEST_KIND,
    build_consent_link,
    consent_payload,
    handle_version_state_changed,
    notify_consent_requests,
    send_consent_links,
    subscribe_consent_notifications,
    unsubscribe_consent_notifications,
)
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

# Feature 59: listen for versions entering ``awaiting_consent`` and tell every
# listed author.  Subscribing at import time is the plugin convention (the
# module loader imports every package under ``app.modules``); the call is
# idempotent, so a second app assembly neither doubles notifications nor
# needs central wiring.
subscribe_consent_notifications()


def on_startup(app=None) -> None:
    """Re-register the consent subscriber when an app is assembled.

    The subscription normally happens at import.  A test process that clears
    the event registry (as the state-event tests do) would otherwise leave the
    plugin silent for every later app; the module loader calls this hook for
    each ``create_app()``, which restores it.
    """
    subscribe_consent_notifications()


__all__ = [
    "AWAITING_CONSENT",
    "CONSENT_PATH",
    "CONSENT_REQUEST_KIND",
    "Email",
    "Notification",
    "NotificationOut",
    "build_consent_link",
    "build_email",
    "clear_outbox",
    "consent_payload",
    "ensure_table",
    "get_outbox",
    "handle_version_state_changed",
    "list_notifications",
    "log_to_outbox",
    "mark_read",
    "notify",
    "notify_consent_requests",
    "on_startup",
    "parse_smtp_url",
    "router",
    "send_consent_links",
    "send_email",
    "subscribe_consent_notifications",
    "unsubscribe_consent_notifications",
]
