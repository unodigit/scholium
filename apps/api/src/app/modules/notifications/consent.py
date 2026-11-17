"""Consent-link notifications (feature 59).

When a version enters ``awaiting_consent`` every author listed on it has to
sign a ``coauthor.consent`` before the paper can move on.  This module listens
for the submissions plugin's ``version.state_changed`` event and sends each of
those authors one notification::

    from app.modules.submissions import subscribe_version_state_changed

    @subscribe_version_state_changed
    def send_consent_links(event):
        if event.state == "awaiting_consent":
            ...

The notification is addressed to the author's DID, uses the
:data:`CONSENT_REQUEST_KIND` kind (``consent.request`` -- the name
:mod:`app.modules.profiles` already describes as "the consent style") and
carries::

    {"paper_cid": "bafyrei...",   # the paper the version belongs to
     "version_cid": "bafyrei...", # the version awaiting consent
     "n": 2,                      # its position in the paper's chain
     "link": "http://localhost:3000/consent/bafyrei...",
     "email": "alice@example.org"}  # when a profile holds an address

``link`` is the page where the author reviews the version and signs: the web
app's ``/consent/{version}`` route (the submit shell reserves it), based on
the first configured ``WEB_ORIGINS`` entry so the same notification works in
development and production.  ``email`` is looked up best-effort from the
author's encrypted profile; when there is none the notifications plugin falls
back to the DID as the address, exactly like every other notification.

Only ``awaiting_consent`` triggers anything.  A version enters that state once
when it is first saved and may enter it again after a decline sends it back to
draft; each entry is one round of consent, so each entry notifies again.  A
failure for one author is logged and never stops the others, and the state
change itself has already been committed before this handler runs.

The subscription is registered when the plugin package is imported -- the
module loader imports every package under ``app.modules`` -- so no central
wiring is needed.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Optional
from urllib.parse import quote

from app.settings import settings

from .models import Notification
from .service import notify

__all__ = [
    "AWAITING_CONSENT",
    "CONSENT_PATH",
    "CONSENT_REQUEST_KIND",
    "build_consent_link",
    "consent_payload",
    "handle_version_state_changed",
    "notify_consent_requests",
    "send_consent_links",
    "subscribe_consent_notifications",
    "unsubscribe_consent_notifications",
]

logger = logging.getLogger(__name__)

#: The notification kind a co-author receives.  It reads as an action, like the
#: ``email.verify`` and ``recovery.request`` kinds.
CONSENT_REQUEST_KIND = "consent.request"

#: The version state that asks every listed author to sign.
AWAITING_CONSENT = "awaiting_consent"

#: The web app's consent page, addressed by the version's record cid.
CONSENT_PATH = "/consent"


def _field(event: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` from a :class:`VersionStateChanged` or a plain mapping."""
    if isinstance(event, Mapping):
        return event.get(name, default)
    return getattr(event, name, default)


def _web_base() -> str:
    """The browser origin a consent link should point at.

    ``WEB_ORIGINS`` is the same list CORS uses, so its first entry is the
    origin the UI is served from.  ``NEXT_PUBLIC_API_URL`` is the fallback for
    a deployment that configures only an absolute base URL.
    """
    origins = settings.web_origins
    if origins:
        return origins[0].strip().rstrip("/")
    return (settings.NEXT_PUBLIC_API_URL or "").strip().rstrip("/")


def build_consent_link(version_cid: str, *, base_url: Optional[str] = None) -> str:
    """Return the consent page URL for ``version_cid``.

    ``base_url`` overrides the configured origin (used by tests and callers
    that already know where the browser is); otherwise the first
    ``WEB_ORIGINS`` entry is used, then ``NEXT_PUBLIC_API_URL``.  A relative
    link results when neither is configured, which keeps CLI/unit use free of
    a host.
    """
    if not isinstance(version_cid, str) or not version_cid.strip():
        raise ValueError("build_consent_link() requires a non-empty version cid")
    base = (base_url if base_url is not None else _web_base()).strip().rstrip("/")
    return f"{base}{CONSENT_PATH}/{quote(version_cid.strip(), safe=':')}"


def _author_email(author_did: str) -> Optional[str]:
    """Return ``author_did``'s stored address, or ``None`` when there is none.

    Profiles keep the address encrypted and erasable.  A missing or unreadable
    profile is not an error here: the notification is still written, and the
    emailer falls back to the DID (which may itself be an address).
    """
    try:
        from app.modules.profiles import read_profile
    except Exception:  # pragma: no cover - profiles is a shipped plugin
        logger.exception("profiles plugin unavailable; consent email left unresolved")
        return None

    try:
        profile = read_profile(author_did)
    except Exception:
        logger.exception("could not read the profile for %s", author_did)
        return None

    email = getattr(profile, "email", None)
    if isinstance(email, str) and email.strip():
        return email.strip()
    return None


def consent_payload(
    author_did: str,
    *,
    version_cid: str,
    paper_cid: Optional[str] = None,
    n: Optional[int] = None,
) -> dict[str, Any]:
    """Build the payload for one author's consent request."""
    title = None
    try:
        from app.modules.submissions import get_version

        version = get_version(version_cid)
        title = getattr(version, "title", None) if version is not None else None
    except Exception:
        title = None
    payload: dict[str, Any] = {
        "paper_cid": paper_cid,
        "version_cid": version_cid,
        "n": n,
        "link": build_consent_link(version_cid),
    }
    if isinstance(title, str) and title.strip():
        payload["title"] = title.strip()
    email = _author_email(author_did)
    if email is not None:
        payload["email"] = email
    return payload


def _listed_authors(version_cid: str) -> list[str]:
    """Return the DIDs listed on ``version_cid``, in byline order, once each."""
    try:
        from app.modules import submissions
    except Exception:  # pragma: no cover - submissions is a declared dependency
        logger.exception("submissions plugin unavailable; no authors to notify")
        return []

    try:
        rows = submissions.authorship_for(version_cid)
    except Exception:
        logger.exception("could not read the authors of version %s", version_cid)
        return []

    authors: list[str] = []
    seen: set[str] = set()
    for row in rows:
        did = getattr(row, "author_did", None)
        if isinstance(did, str) and did and did not in seen:
            seen.add(did)
            authors.append(did)
    return authors


def notify_consent_requests(event: Any) -> list[Notification]:
    """Send every author listed on the version a consent-link notification.

    ``event`` is a ``version.state_changed`` event (or an equivalent mapping).
    Anything but a transition *into* ``awaiting_consent`` returns an empty
    list.  Returns the notifications that were written, in byline order; a
    failure for one author is logged and skipped so the rest are still told.
    """
    state = _field(event, "state")
    if state != AWAITING_CONSENT:
        return []

    version_cid = _field(event, "version_cid")
    if not isinstance(version_cid, str) or not version_cid:
        logger.warning("a version.state_changed event for %r names no version", state)
        return []

    paper_cid = _field(event, "paper_cid")
    raw_n = _field(event, "n")
    version_n = raw_n if isinstance(raw_n, int) and not isinstance(raw_n, bool) else None

    sent: list[Notification] = []
    for author_did in _listed_authors(version_cid):
        try:
            payload = consent_payload(
                author_did,
                version_cid=version_cid,
                paper_cid=paper_cid if isinstance(paper_cid, str) else None,
                n=version_n,
            )
            sent.append(notify(author_did, CONSENT_REQUEST_KIND, payload))
        except Exception:
            logger.exception(
                "could not send the consent request for version %s to %s",
                version_cid,
                author_did,
            )
    return sent


def handle_version_state_changed(event: Any) -> list[Notification]:
    """Alias for :func:`notify_consent_requests`."""
    return notify_consent_requests(event)


def send_consent_links(event: Any) -> list[Notification]:
    """The subscriber's name, matching the event module's documented example."""
    return notify_consent_requests(event)


def subscribe_consent_notifications() -> None:
    """Register :func:`notify_consent_requests` for ``version.state_changed``.

    Idempotent: the events plugin refuses to register the same callable twice,
    so importing the package more than once (or calling this from an app
    startup hook) is harmless.
    """
    from app.modules.submissions import subscribe_version_state_changed

    subscribe_version_state_changed(notify_consent_requests)


def unsubscribe_consent_notifications() -> None:
    """Remove this plugin's ``version.state_changed`` subscriber (tests/teardown)."""
    from app.modules.submissions import unsubscribe_version_state_changed

    unsubscribe_version_state_changed(notify_consent_requests)
