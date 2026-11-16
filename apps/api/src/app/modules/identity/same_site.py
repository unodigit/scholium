"""Same-site requirements for the refresh cookie (plugin: identity).

The refresh token lives in an ``HttpOnly`` cookie.  Browsers only send a
``SameSite=Lax``/``Strict`` cookie when the page making the request and the
API are *same-site*: they share a registrable domain.  ``app.example.org``
calling ``api.example.org`` works; ``app.example.org`` calling
``api.example.net`` does not -- the browser silently drops the cookie and
every refresh looks like "signed out".

This module documents the requirement in code and checks it at startup:
:func:`check_same_site_configuration` (wired through the module loader's
``on_startup`` hook) logs a warning when every configured ``WEB_ORIGINS``
entry is cross-site from the API's own public URL (``NEXT_PUBLIC_API_URL``).
A deployment that deliberately sets ``REFRESH_COOKIE_SAMESITE=None`` (which
needs ``Secure`` and the third-party-cookie allowances of the browsers in use)
is not warned about.
"""

from __future__ import annotations

import ipaddress
import logging
from urllib.parse import urlparse

from app.settings import settings

from .cookies import refresh_cookie_samesite

__all__ = [
    "check_same_site_configuration",
    "cross_site_web_origins",
    "is_same_site",
    "on_startup",
    "site_key",
]

logger = logging.getLogger(__name__)

#: Hosts that only ever mean "this machine"; they are all mutually same-site.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}

#: Two-label public suffixes where the registrable domain is the last three
#: labels (``app.example.co.uk`` -> ``example.co.uk``).  A pragmatic list, not
#: the full Public Suffix List: a false "cross-site" here only logs a warning.
_MULTI_LABEL_SUFFIXES = {
    "ac.uk",
    "co.in",
    "co.jp",
    "co.nz",
    "co.uk",
    "com.au",
    "com.br",
    "com.cn",
    "com.mx",
    "com.sg",
    "com.tr",
    "edu.au",
    "gov.uk",
    "net.au",
    "net.nz",
    "org.au",
    "org.uk",
}


def _hostname(value: str) -> str:
    """The hostname of a URL (or a bare ``host[:port]``)."""
    text = (value or "").strip()
    if not text:
        return ""
    if "://" in text:
        return (urlparse(text).hostname or "").lower()
    return text.split("/", 1)[0].rsplit(":", 1)[0].strip("[]").lower()


def site_key(url_or_host: str) -> str:
    """The site a host belongs to: its registrable domain, or a loopback key.

    ``app.example.org`` and ``api.example.org`` both map to ``example.org``;
    every loopback spelling maps to ``localhost`` so local development (web on
    port 3000, API on 8000) is same-site without configuration.
    """
    host = _hostname(url_or_host).rstrip(".")
    if not host:
        return ""
    if host in _LOOPBACK_HOSTS or host.endswith(".localhost"):
        return "localhost"
    # An IP address is its own site (no registrable-domain decomposition).
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if ".".join(labels[-2:]) in _MULTI_LABEL_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def is_same_site(first: str, second: str) -> bool:
    """True when ``first`` and ``second`` share a site (and may share cookies)."""
    first_key = site_key(first)
    second_key = site_key(second)
    return bool(first_key) and first_key == second_key


def cross_site_web_origins() -> list[str]:
    """Configured web origins that are cross-site from the API's public URL."""
    api_url = (settings.NEXT_PUBLIC_API_URL or "").strip()
    if not api_url:
        return []
    return [
        origin
        for origin in settings.web_origins
        if origin and not is_same_site(origin, api_url)
    ]


def check_same_site_configuration() -> bool:
    """Warn when the refresh cookie cannot work; return whether we warned.

    Runs at startup through the module loader.  If there is no configured web
    origin there is nothing to check.  If *every* origin is cross-site from
    the API, no browser session can ever send the refresh cookie under the
    configured SameSite policy, so say so loudly instead of leaving operators
    to discover it as "users are signed out".
    """
    origins = [origin for origin in settings.web_origins if origin]
    if not origins:
        return False
    cross_site = cross_site_web_origins()
    if len(cross_site) != len(origins):
        return False
    if refresh_cookie_samesite() == "none":
        # Cross-site cookies are the explicit, configured intent here.
        return False

    logger.warning(
        "Refresh cookie will not work: every WEB_ORIGINS entry (%s) is "
        "cross-site from the API's public URL (%s). The web app and API must "
        "be same-site (for example https://app.example.org and "
        "https://api.example.org) for SameSite=%s cookies to be sent.",
        ", ".join(origins),
        settings.NEXT_PUBLIC_API_URL,
        refresh_cookie_samesite(),
    )
    return True


def on_startup(app=None) -> None:
    """Module-loader startup hook: check the refresh-cookie site configuration."""
    check_same_site_configuration()
