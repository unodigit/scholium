"""The branded HTML alternative of a notification email.

:func:`render_html` turns one notification into the HTML part of a
``multipart/alternative`` message; the plain-text part is rendered elsewhere
(``emailer._render_body``) and is deliberately not touched here.

Email clients ignore most modern CSS, so the layout is the boring, reliable
kind: nested ``<table>`` elements, inline styles, no ``<svg>`` and no web
fonts.  The look follows ``docs/design.md``:

* a 600px-wide column on the warm paper background (``#FBFAF7``),
* one white card with a hairline rule,
* a header lockup -- one PNG from the web origin's
  ``/brand/scholium-lockup-email.png`` (alt ``Scholium``) that holds the mark
  and the lowercase ``scholium`` wordmark together, so the header needs no
  serif font and no second layout cell,
* ink-coloured (``#1B1D22``) body text,
* a call-to-action button in the accent blue (``#2F4BA0``) for the
  notification's link, and
* a footer saying why the email was sent and where to change notification
  settings.

Everything that did not come from this file -- the DID, the kind, every payload
key and value, and the link -- is HTML-escaped before it is written into the
markup, and a link is only ever rendered as a button when it is an ``http(s)``
URL, so a payload cannot inject markup or a ``javascript:`` target.
"""

from __future__ import annotations

from html import escape
from typing import Any, Mapping, Optional
from urllib.parse import urlsplit

from app.settings import settings

__all__ = [
    "ACCENT",
    "BRAND_LOCKUP_PATH",
    "CARD",
    "INK",
    "MAX_WIDTH",
    "NOTIFICATION_SETTINGS_PATH",
    "PAPER",
    "render_html",
    "web_origin",
]

# Colour tokens from docs/design.md (light theme).
PAPER = "#FBFAF7"
CARD = "#FFFFFF"
INK = "#1B1D22"
INK_2 = "#5A5F6B"
RULE = "#E4E1D9"
ACCENT = "#2F4BA0"

MAX_WIDTH = 600
#: The header lockup is shipped at 2x (340x64) and displayed at half that size.
LOCKUP_WIDTH = 170
LOCKUP_HEIGHT = 32

#: Where the web app serves the e-mail header lockup, relative to the web origin.
BRAND_LOCKUP_PATH = "/brand/scholium-lockup-email.png"
#: The notifications card on the reader's dashboard, where preferences live.
NOTIFICATION_SETTINGS_PATH = "/me#notifications"

_SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif"
_SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"

# Payload keys that are not details of the notification: they are the
# recipient's address (the plain-text body omits it too) and the links the
# call-to-action button carries.
_HIDDEN_KEYS = frozenset(
    {"email", "to", "recipient", "recipient_email", "address", "link", "url", "consent_link"}
)


def web_origin() -> str:
    """The browser origin the UI is served from, or ``""`` when none is set.

    ``WEB_ORIGINS`` is the list CORS uses, so its first usable ``http(s)``
    entry is where the brand mark and the settings page live.  ``*`` and blank
    entries are skipped.
    """
    for origin in settings.web_origins:
        candidate = origin.strip().rstrip("/")
        parts = urlsplit(candidate)
        if parts.scheme in ("http", "https") and parts.netloc:
            return candidate
    return ""


def _safe_url(url: Any, origin: str) -> Optional[str]:
    """``url`` as an absolute ``http(s)`` URL, or ``None`` if it is not one.

    A root-relative path (``/consent/abc``) is resolved against ``origin`` --
    the consent link is relative when no web origin is configured -- but never
    a protocol-relative ``//host`` URL.  Anything else (``javascript:``,
    ``data:``, ``mailto:``, junk) yields ``None`` so it never becomes an
    ``href``.
    """
    if not isinstance(url, str):
        return None
    candidate = url.strip()
    if not candidate or any(ch in candidate for ch in "\r\n\t "):
        return None
    if candidate.startswith("/") and not candidate.startswith("//"):
        return f"{origin}{candidate}" if origin else None
    parts = urlsplit(candidate)
    if parts.scheme.lower() in ("http", "https") and parts.netloc:
        return candidate
    return None


def _label(kind: str) -> str:
    """A readable heading for a notification kind (``consent.request`` -> ``Consent request``)."""
    words = " ".join(part for part in str(kind).replace("_", " ").replace(".", " ").split())
    return words[:1].upper() + words[1:] if words else "Notification"


def _details(payload: Any) -> list[tuple[str, str]]:
    """The ``(key, value)`` rows to show under the heading, in the plain-text order."""
    if isinstance(payload, Mapping):
        return [
            (str(key), str(payload[key]))
            for key in sorted(payload, key=str)
            if key not in _HIDDEN_KEYS
        ]
    if payload not in (None, ""):
        return [("", str(payload))]
    return []


def _details_table(rows: list[tuple[str, str]]) -> str:
    if not rows:
        return ""
    cells = []
    for key, value in rows:
        label = (
            f'<td valign="top" style="padding:6px 16px 6px 0;font-family:{_SANS};'
            f"font-size:14px;line-height:20px;color:{INK_2};white-space:nowrap;"
            f'">{escape(key)}</td>'
            if key
            else ""
        )
        span = "" if key else ' colspan="2"'
        cells.append(
            f"<tr>{label}"
            f'<td valign="top"{span} style="padding:6px 0;font-family:{_SANS};'
            f"font-size:14px;line-height:20px;color:{INK};word-break:break-word;"
            f'">{escape(value)}</td></tr>'
        )
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'style="margin:0 0 24px 0;border-top:1px solid {RULE};">'
        + "".join(cells)
        + "</table>"
    )


def _button(href: str) -> str:
    """A bulletproof call-to-action button: a coloured table cell around a link."""
    url = escape(href, quote=True)
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'style="margin:0 0 16px 0;"><tr>'
        f'<td align="center" bgcolor="{ACCENT}" style="background-color:{ACCENT};'
        'border-radius:6px;">'
        f'<a href="{url}" target="_blank" style="display:inline-block;padding:12px 24px;'
        f"font-family:{_SANS};font-size:16px;line-height:20px;font-weight:600;"
        f'color:#FFFFFF;text-decoration:none;border-radius:6px;">Open in Scholium</a>'
        "</td></tr></table>"
        f'<p style="margin:0 0 24px 0;font-family:{_SANS};font-size:13px;line-height:20px;'
        f"color:{INK_2};word-break:break-all;\">Button not working? Copy this link into your "
        f'browser:<br><a href="{url}" target="_blank" style="color:{ACCENT};'
        f'text-decoration:underline;">{escape(href)}</a></p>'
    )


def _lockup(origin: str) -> str:
    """The header: one image holding the mark and the ``scholium`` wordmark.

    A single out-of-the-box-safe ``<img>`` keeps the header independent of any
    font an inbox may or may not have: the lockup is outlined artwork, served
    from the web origin like the rest of the brand assets.
    """
    lockup = escape(f"{origin}{BRAND_LOCKUP_PATH}", quote=True)
    return (
        f'<img src="{lockup}" width="{LOCKUP_WIDTH}" height="{LOCKUP_HEIGHT}" '
        'alt="Scholium" border="0" style="display:block;border:0;outline:none;'
        f'text-decoration:none;width:{LOCKUP_WIDTH}px;height:{LOCKUP_HEIGHT}px;">'
    )


def render_html(
    did: str,
    kind: str,
    payload: Any = None,
    *,
    link: Optional[str] = None,
    origin: Optional[str] = None,
) -> str:
    """Render the HTML alternative for ``notify(did, kind, payload)``.

    ``link`` is the notification's call-to-action target (the caller picks it
    from the payload, as the plain-text ``Open:`` line does); it becomes the
    accent button when it is a usable ``http(s)`` URL and is left out
    otherwise.  ``origin`` overrides the configured web origin that the brand
    mark and the settings link are served from (tests, and callers that know
    where the browser is).  Every value is HTML-escaped.
    """
    base = (web_origin() if origin is None else origin.strip().rstrip("/"))
    href = _safe_url(link, base)
    settings_url = f"{base}{NOTIFICATION_SETTINGS_PATH}"
    settings_link = (
        f'<a href="{escape(settings_url, quote=True)}" target="_blank" '
        f'style="color:{ACCENT};text-decoration:underline;">notification settings</a>'
        if base
        else "notification settings"
    )

    body_font = f"font-family:{_SANS};"
    heading = escape(_label(kind))
    intro = f"There is a new notification for {escape(did)}."

    return (
        "<!DOCTYPE html>\n"
        '<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="color-scheme" content="light only">'
        f"<title>{heading}</title></head>"
        f'<body style="margin:0;padding:0;background-color:{PAPER};color:{INK};">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'bgcolor="{PAPER}" style="background-color:{PAPER};"><tr>'
        '<td align="center" style="padding:24px 12px;">'
        # The card column: fluid up to 600px (Outlook honours the width attribute).
        f'<table role="presentation" width="{MAX_WIDTH}" cellpadding="0" cellspacing="0" '
        f'border="0" style="width:100%;max-width:{MAX_WIDTH}px;">'
        f'<tr><td style="padding:0 0 16px 0;">{_lockup(base)}</td></tr>'
        f'<tr><td bgcolor="{CARD}" style="background-color:{CARD};'
        f'border:1px solid {RULE};border-radius:8px;padding:32px;">'
        f'<h1 style="margin:0 0 12px 0;font-family:{_SERIF};font-size:24px;line-height:32px;'
        f'font-weight:600;color:{INK};">{heading}</h1>'
        f'<p style="margin:0 0 20px 0;{body_font}font-size:16px;line-height:24px;'
        f'color:{INK};">{intro}</p>'
        f"{_details_table(_details(payload))}"
        f"{_button(href) if href else ''}"
        "</td></tr>"
        f'<tr><td style="padding:20px 8px 0 8px;{body_font}font-size:12px;line-height:18px;'
        f'color:{INK_2};">'
        f"You are receiving this email because a notification was addressed to your "
        f"Scholium account ({escape(did)}). "
        f"To change which notifications you receive, update your {settings_link}."
        "</td></tr></table>"
        "</td></tr></table></body></html>\n"
    )
