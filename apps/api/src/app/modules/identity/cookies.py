"""The HttpOnly refresh-token cookie (plugin: identity).

The refresh token is a long-lived bearer secret: 30 days of "whoever holds
this is the account".  Handing it to page JavaScript (the response body) puts
it one injected script away from theft, so the API delivers it *only* as a
cookie the browser will never show a script::

    Set-Cookie: scholium_refresh=<raw>; HttpOnly; Max-Age=2592000;
                Path=/v1/auth; SameSite=Lax; Secure

* ``HttpOnly`` -- document.cookie cannot read it.
* ``Path=/v1/auth`` -- the cookie is scoped to the auth endpoints that consume
  or clear it (refresh, logout), so it is not attached to any other request
  the app makes.
* ``SameSite=Lax`` (configurable via ``REFRESH_COOKIE_SAMESITE``) -- a
  third-party site cannot trigger a refresh.  The web app and the API must be
  *same-site* for the cookie to be sent at all: ``https://app.example.org``
  and ``https://api.example.org`` share a registrable domain and work, while
  ``https://app.example.org`` and ``https://api.example.net`` do not.  The
  package warns at startup when every configured ``WEB_ORIGINS`` entry is
  cross-site from the API's own public URL.
* ``Secure`` -- except over plain ``http`` on localhost (dev), where a Secure
  cookie would be discarded by the browser.

``/v1/auth/verify`` and ``/v1/auth/refresh`` set (rotate) the cookie;
``/v1/auth/refresh`` reads the token from it, and ``/v1/auth/logout`` clears
it.  The JSON bodies never carry the refresh token -- only the access token
and its expiry.  Non-browser clients still present the token in the JSON body
exactly as before (they read it from the ``Set-Cookie`` header); the cookie
wins when both are present, because the browser flow cannot read the body's
copy back.
"""

from __future__ import annotations

import os

from fastapi import Request, Response

from app.settings import settings

from .service import REFRESH_TOKEN_TTL

__all__ = [
    "DEFAULT_REFRESH_COOKIE_SAMESITE",
    "REFRESH_COOKIE_MAX_AGE",
    "REFRESH_COOKIE_NAME",
    "REFRESH_COOKIE_PATH",
    "REFRESH_COOKIE_SAMESITE",
    "clear_refresh_cookie",
    "clear_refresh_cookie_headers",
    "refresh_cookie_samesite",
    "refresh_token_from_request",
    "set_refresh_cookie",
]

#: Browser cookie the raw refresh token travels in.
REFRESH_COOKIE_NAME = "scholium_refresh"

#: The auth path tree the cookie is attached to (refresh reads it; logout clears it).
REFRESH_COOKIE_PATH = "/v1/auth"

#: Cookie lifetime in seconds, matching :data:`REFRESH_TOKEN_TTL` (30 days).
REFRESH_COOKIE_MAX_AGE = int(REFRESH_TOKEN_TTL.total_seconds())

#: Default SameSite policy.  ``Lax`` (rather than ``Strict``) keeps the cookie
#: usable when the web app and API are sibling subdomains of one registrable
#: domain, which is the deployment shape the module requires.
DEFAULT_REFRESH_COOKIE_SAMESITE = "lax"
REFRESH_COOKIE_SAMESITE = DEFAULT_REFRESH_COOKIE_SAMESITE

_VALID_SAMESITE = {"lax", "strict", "none"}

#: Hosts where plain-http dev traffic is expected; a Secure cookie there
#: would be silently dropped by the browser.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def refresh_cookie_samesite() -> str:
    """The configured ``SameSite`` policy, normalised, defaulting to ``Lax``.

    ``REFRESH_COOKIE_SAMESITE`` accepts ``lax``, ``strict`` or ``none``
    (case-insensitive).  ``settings.REFRESH_COOKIE_SAMESITE`` wins when a
    deployment (or test) sets it; otherwise the environment is read at call
    time.  Anything unrecognised falls back to ``Lax`` rather than handing an
    invalid attribute to the browser.
    """
    configured = getattr(settings, "REFRESH_COOKIE_SAMESITE", None)
    if configured is None:
        configured = os.environ.get("REFRESH_COOKIE_SAMESITE", "")
    value = str(configured).strip().lower()
    if value in _VALID_SAMESITE:
        return value
    fallback = str(REFRESH_COOKIE_SAMESITE).strip().lower()
    return fallback if fallback in _VALID_SAMESITE else DEFAULT_REFRESH_COOKIE_SAMESITE


def _cookie_secure(request: Request) -> bool:
    """``Secure`` unless this is plain http on the developer's own machine."""
    scheme = (request.url.scheme or "").lower()
    host = (request.url.hostname or "").lower()
    loopback = host in _LOOPBACK_HOSTS or host.endswith(".localhost")
    return not (scheme == "http" and loopback)


def set_refresh_cookie(response: Response, request: Request, raw_token: str) -> None:
    """Issue ``raw_token`` as the HttpOnly refresh cookie on ``response``."""
    response.set_cookie(
        REFRESH_COOKIE_NAME,
        raw_token,
        max_age=REFRESH_COOKIE_MAX_AGE,
        path=REFRESH_COOKIE_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite=refresh_cookie_samesite(),
    )


def clear_refresh_cookie(response: Response, request: Request) -> None:
    """Expire the refresh cookie (same name and path, zero lifetime)."""
    response.delete_cookie(
        REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite=refresh_cookie_samesite(),
    )


def clear_refresh_cookie_headers(request: Request) -> dict[str, str]:
    """The ``Set-Cookie`` header that expires the refresh cookie, as a dict.

    For error paths: FastAPI drops the headers of the injected ``Response``
    when a handler raises, so a problem response that must also clear the
    cookie carries this header on the exception itself.
    """
    carrier = Response()
    clear_refresh_cookie(carrier, request)
    return {"Set-Cookie": carrier.headers["set-cookie"]}


def refresh_token_from_request(request: Request) -> str | None:
    """The refresh token carried by the request's cookie, if any."""
    value = request.cookies.get(REFRESH_COOKIE_NAME)
    if isinstance(value, str) and value:
        return value
    return None
