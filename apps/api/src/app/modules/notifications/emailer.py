"""Email delivery for notifications.

``notify()`` renders one :class:`Email` per notification and then either

* hands it to an SMTP server when ``SMTP_URL`` is configured, or
* logs it to the outbox (a dedicated ``outbox`` logger plus an in-process
  list) when it is not -- and also when an SMTP delivery fails, so an email
  is never silently dropped.

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
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Any, Mapping, Optional
from urllib.parse import parse_qs, unquote, urlparse

__all__ = [
    "DEFAULT_FROM",
    "Email",
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

_outbox: list[dict[str, Any]] = []
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

    def as_message(self) -> EmailMessage:
        """Return the email as a stdlib :class:`EmailMessage`."""
        if self.message is not None:
            return self.message
        return _render_message(self.to, self.from_addr, self.subject, self.body)


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


def _render_message(to: str, from_addr: str, subject: str, body: str) -> EmailMessage:
    message = EmailMessage()
    message["From"] = from_addr
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    return message


def build_email(
    did: str,
    kind: str,
    payload: Any = None,
    *,
    notification_id: Optional[int] = None,
    from_addr: str = DEFAULT_FROM,
) -> Email:
    """Render the email for ``notify(did, kind, payload)``."""
    to = _recipient(did, payload)
    subject = f"{DEFAULT_SUBJECT_PREFIX} {kind}"
    body = _render_body(did, kind, payload)
    message = _render_message(to, from_addr, subject, body)
    # ``message`` is frozen now, so later payload mutation cannot change what
    # is sent.
    return Email(
        to=to,
        from_addr=from_addr,
        subject=subject,
        body=body,
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
    if reason:
        outbox_logger.info(
            "outbox email (not sent: %s) to=%s subject=%s body=%s",
            reason,
            email.to,
            email.subject,
            email.body,
        )
    else:
        outbox_logger.info(
            "outbox email to=%s subject=%s body=%s",
            email.to,
            email.subject,
            email.body,
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


def send_email(email: Email, smtp_url: str) -> None:
    """Deliver ``email`` through the SMTP server described by ``smtp_url``.

    Raises whatever the underlying :mod:`smtplib` call raises; ``notify``
    catches that and falls back to the outbox.
    """
    config = parse_smtp_url(smtp_url)
    if config.use_ssl:
        server = smtplib.SMTP_SSL(config.host, config.port)
    else:
        server = smtplib.SMTP(config.host, config.port)
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
