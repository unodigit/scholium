"""The HttpOnly refresh-token cookie (plugin: identity).

The refresh token is a long-lived bearer secret: 30 days of "whoever holds
this is the account".  Handing it to page JavaScript (the response body) puts
it one injected script away from theft, so the API *issues* it as a cookie
the browser will never show a script::

    Set-Cookie: scholium_refresh=<raw>; HttpOnly; Max-Age=2592000;
                Path=/v1/auth/refresh; SameSite=strict; Secure

* ``HttpOnly`` -- document.cookie cannot read it.
* ``Path=/v1/auth/refresh`` -- the cookie is scoped to the one endpoint that
  consumes it, so it is not attached to any other request the app makes.
* ``SameSite=strict`` -- a third-party site cannot trigger a refresh.
* ``Secure`` -- except over plain ``http`` on localhost (dev), where a Secure
  cookie would be discarded by the browser.

``/v1/auth/verify`` and ``/v1/auth/refresh`` set (rotate) the cookie;
``/v1/auth/refresh`` reads the token from it, and ``/v1/auth/logout`` clears
it.  Non-browser clients may still present the token in the JSON body
exactly as before; the cookie wins when both are present, because the
browser flow cannot read the body's copy back.
"""

from __future__ import annotations

from fastapi import Request, Response

from .service import REFRESH_TOKEN_TTL

__all__ = [
    "REFRESH_COOKIE_MAX_AGE",
    "REFRESH_COOKIE_NAME",
    "REFRESH_COOKIE_PATH",
    "clear_refresh_cookie",
    "clear_refresh_cookie_headers",
    "refresh_token_from_request",
    "set_refresh_cookie",
]

#: Browser cookie the raw refresh token travels in.
REFRESH_COOKIE_NAME = "scholium_refresh"

#: The only path the cookie is ever attached to (the refresh endpoint).
REFRESH_COOKIE_PATH = "/v1/auth/refresh"

#: Cookie lifetime in seconds, matching :data:`REFRESH_TOKEN_TTL` (30 days).
REFRESH_COOKIE_MAX_AGE = int(REFRESH_TOKEN_TTL.total_seconds())

#: Hosts where plain-http dev traffic is expected; a Secure cookie there
#: would be silently dropped by the browser.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


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
        samesite="strict",
    )


def clear_refresh_cookie(response: Response, request: Request) -> None:
    """Expire the refresh cookie (same name and path, zero lifetime)."""
    response.delete_cookie(
        REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite="strict",
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
