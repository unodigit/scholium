"""Email delivery for notifications.

``notify()`` renders one :class:`Email` per notification and then either

* hands it to an SMTP server when ``SMTP_URL`` is configured, or
* records it in the outbox (a dedicated ``outbox`` logger plus a bounded
  in-process list) when it is not -- and also when an SMTP delivery fails,
  so an email is never silently dropped.  The log line names the recipient
  and subject but never the body, which can carry a verification token.

Every email built by :func:`build_email` is ``multipart/alternative``: the
plain-text body first, then the branded HTML rendering from
:mod:`.email_template`.  The plain-text part is the same text it always was.

``SMTP_URL`` accepts the usual URL forms::

    smtp://user:pass@mail.example.org:587
    smtp://mail.example.org:25?tls=1
    smtps://user:pass@mail.example.org:465
    mail.example.org:25

A bare ``host[:port]`` is treated as plain SMTP.  Port 587 (and ``?tls=1``
on an ``smtp://`` URL) enables STARTTLS; ``smtps://`` uses implicit TLS.
"""

from __future__ import annotations

import logging
import smtplib
import threading
from collections import deque
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Any, Mapping, Optional
from urllib.parse import parse_qs, unquote, urlparse

from app.settings import settings

from .email_template import render_html

__all__ = [
    "DEFAULT_FROM",
    "Email",
    "OUTBOX_MAX_ENTRIES",
    "SMTPConfig",
    "build_email",
    "get_outbox",
    "clear_outbox",
    "log_to_outbox",
    "parse_smtp_url",
    "send_email",
]

DEFAULT_FROM = "noreply@scholium.local"
DEFAULT_SUBJECT_PREFIX = "[Scholium]"

# Payload keys that may carry the recipient's email address.  Notifications
# are addressed to a DID, but email needs a real address, so callers put it in
# the payload; a DID that is itself an address (``alice@example.org``) also
# works.
_ADDRESS_KEYS = ("email", "to", "recipient", "recipient_email", "address")
_LINK_KEYS = ("link", "url", "consent_link")

outbox_logger = logging.getLogger("outbox")

#: The in-process outbox is a development/test convenience, not a queue: keep
#: it bounded so a long-running dev process cannot grow without limit.
OUTBOX_MAX_ENTRIES = 100

_outbox: deque[dict[str, Any]] = deque(maxlen=OUTBOX_MAX_ENTRIES)
_outbox_lock = threading.Lock()


@dataclass(frozen=True)
class Email:
    """A rendered notification email."""

    to: str
    from_addr: str
    subject: str
    body: str
    did: str = ""
    kind: str = ""
    notification_id: Optional[int] = None
    message: Optional[EmailMessage] = field(default=None, compare=False, repr=False)
    #: The branded HTML alternative; ``None`` sends the plain-text body alone.
    html: Optional[str] = field(default=None, repr=False)

    def as_message(self) -> EmailMessage:
        """Return the email as a stdlib :class:`EmailMessage`."""
        if self.message is not None:
            return self.message
        return _render_message(self.to, self.from_addr, self.subject, self.body, self.html)


@dataclass(frozen=True)
class SMTPConfig:
    """Connection parameters parsed from ``SMTP_URL``."""

    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    use_ssl: bool = False
    starttls: bool = False


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def _recipient(did: str, payload: Any) -> str:
    """Pick the email address for a notification.

    Preference order: an address in the payload, a DID that is itself an
    address, then the DID as-is.  The DID fallback keeps ``notify`` usable
    with the minimal signature while still attempting delivery.
    """
    if isinstance(payload, Mapping):
        for key in _ADDRESS_KEYS:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(did, str) and "@" in did:
        return did
    return did


def _render_body(did: str, kind: str, payload: Any) -> str:
    lines = [f"Notification for {did}", f"Kind: {kind}", ""]
    if isinstance(payload, Mapping):
        for key in sorted(payload, key=str):
            if key in _ADDRESS_KEYS:
                continue
            lines.append(f"{key}: {payload[key]}")
        for key in _LINK_KEYS:
            link = payload.get(key)
            if isinstance(link, str) and link:
                lines.extend(["", f"Open: {link}"])
                break
    elif payload not in (None, ""):
        lines.append(str(payload))
    return "\n".join(lines).rstrip() + "\n"


def _link_of(payload: Any) -> Optional[str]:
    """The link the notification points at (the one ``Open:`` shows), if any."""
    if isinstance(payload, Mapping):
        for key in _LINK_KEYS:
            link = payload.get(key)
            if isinstance(link, str) and link:
                return link
    return None


def _render_message(
    to: str, from_addr: str, subject: str, body: str, html: Optional[str] = None
) -> EmailMessage:
    message = EmailMessage()
    message["From"] = from_addr
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    if html is not None:
        message.add_alternative(html, subtype="html")
    return message


def build_email(
    did: str,
    kind: str,
    payload: Any = None,
    *,
    notification_id: Optional[int] = None,
    from_addr: str = DEFAULT_FROM,
) -> Email:
    """Render the email for ``notify(did, kind, payload)``.

    The message carries the plain-text ``body`` and a branded HTML alternative
    (``html``) of the same notification.
    """
    to = _recipient(did, payload)
    subject = f"{DEFAULT_SUBJECT_PREFIX} {kind}"
    body = _render_body(did, kind, payload)
    html = render_html(did, kind, payload, link=_link_of(payload))
    message = _render_message(to, from_addr, subject, body, html)
    # ``message`` is frozen now, so later payload mutation cannot change what
    # is sent.
    return Email(
        to=to,
        from_addr=from_addr,
        subject=subject,
        body=body,
        html=html,
        did=did,
        kind=kind,
        notification_id=notification_id,
        message=message,
    )


# --------------------------------------------------------------------------- #
# Outbox
# --------------------------------------------------------------------------- #


def log_to_outbox(email: Email, *, reason: str = "") -> dict[str, Any]:
    """Log ``email`` to the outbox and return the recorded entry."""
    entry: dict[str, Any] = {
        "to": email.to,
        "from": email.from_addr,
        "subject": email.subject,
        "body": email.body,
        "did": email.did,
        "kind": email.kind,
        "notification_id": email.notification_id,
    }
    if reason:
        entry["reason"] = reason
    with _outbox_lock:
        _outbox.append(entry)
    # Never put the body in the log: it can carry a verification token or
    # consent link, and INFO logs are routinely shipped off the machine.  The
    # full body stays in the bounded in-process outbox for local debugging.
    if reason:
        outbox_logger.info(
            "outbox email (not sent: %s) to=%s subject=%s kind=%s notification_id=%s",
            reason,
            email.to,
            email.subject,
            email.kind,
            email.notification_id,
        )
    else:
        outbox_logger.info(
            "outbox email to=%s subject=%s kind=%s notification_id=%s",
            email.to,
            email.subject,
            email.kind,
            email.notification_id,
        )
    return entry


def get_outbox() -> list[dict[str, Any]]:
    """Return a snapshot of the in-process outbox."""
    with _outbox_lock:
        return [dict(entry) for entry in _outbox]


def clear_outbox() -> None:
    """Empty the in-process outbox (used by tests)."""
    with _outbox_lock:
        _outbox.clear()


# --------------------------------------------------------------------------- #
# SMTP
# --------------------------------------------------------------------------- #


def parse_smtp_url(url: str) -> SMTPConfig:
    """Parse ``SMTP_URL`` into connection parameters."""
    raw = (url or "").strip()
    if not raw:
        raise ValueError("SMTP_URL is empty")
    if "://" not in raw:
        raw = "smtp://" + raw
    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme not in ("smtp", "smtps", "smtp+ssl", "smtp+starttls"):
        raise ValueError(f"unsupported SMTP_URL scheme {scheme!r}")

    use_ssl = scheme in ("smtps", "smtp+ssl")
    starttls = scheme == "smtp+starttls"
    query = {key.lower(): values for key, values in parse_qs(parsed.query).items()}
    truthy = {"1", "true", "yes", "on"}

    if not use_ssl and any(v.lower() in truthy for v in query.get("ssl", [])):
        use_ssl = True
        starttls = False
    if not use_ssl and any(v.lower() in truthy for v in query.get("tls", [])):
        starttls = True
    if parsed.port == 587 and not use_ssl:
        starttls = True

    port = parsed.port or (465 if use_ssl else 587 if starttls else 25)
    if settings.BREVO_SMTP_PORT and parsed.hostname in {
        "smtp-relay.brevo.com", "smtp-relay.sendinblue.com",
    }:
        port = settings.BREVO_SMTP_PORT
        use_ssl = port == 465
        starttls = not use_ssl
    username = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password else None
    return SMTPConfig(
        host=parsed.hostname or "localhost",
        port=port,
        username=username,
        password=password,
        use_ssl=use_ssl,
        starttls=starttls,
    )


def send_email(email: Email, smtp_url: str, *, timeout: float | None = None) -> None:
    """Deliver ``email`` through the SMTP server described by ``smtp_url``.

    Raises whatever the underlying :mod:`smtplib` call raises; ``notify``
    catches that and falls back to the outbox.
    """
    config = parse_smtp_url(smtp_url)
    client = smtplib.SMTP_SSL if config.use_ssl else smtplib.SMTP
    options = {"timeout": timeout} if timeout is not None else {}
    server = client(config.host, config.port, **options)
    try:
        if config.starttls:
            server.starttls()
        if config.username:
            server.login(config.username, config.password or "")
        server.sendmail(email.from_addr, [email.to], email.as_message().as_string())
    finally:
        try:
            server.quit()
        except Exception:  # pragma: no cover - best-effort cleanup
            pass
