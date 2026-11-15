"""Signed email verification links for profiles (feature 178).

A profile save makes the address it stored *pending*; the system emails the
owner a link carrying a signed token, and the owner proves they control the
address by redeeming that token.  Nothing about the address itself is needed
to check a token: it is bound to the current email through an HMAC
fingerprint, so when the owner later saves a different address the old links
stop working without any lookup table of live tokens.

Token shape::

    v1.<base64url(payload)>.<base64url(HMAC-SHA256)>

``payload`` is compact JSON
``{"d": did, "i": issued_unix, "f": fingerprint, "n": nonce}``.
``f`` is an HMAC over the DID and the normalised address under a key derived
from ``JWT_SECRET`` -- an address can therefore never be read back out of a
token, and a token minted for one DID or one address cannot be replayed for
another.  The HMAC covers the encoded payload, so no field can be edited.

Links are absolute when ``NEXT_PUBLIC_API_URL`` is set (the default in every
deployment) and relative otherwise, which keeps unit tests and CLI use free of
a configured host.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote, urlencode

from app.settings import settings

__all__ = [
    "DEFAULT_VERIFICATION_TTL",
    "EMAIL_VERIFICATION_KIND",
    "TOKEN_VERSION",
    "build_verification_link",
    "email_fingerprint",
    "issue_verification_token",
    "verify_verification_token",
]

#: How long a verification link stays usable.  Long enough for an email to be
#: read after a weekend, short enough that a leaked mailbox archive is not a
#: permanent key.
DEFAULT_VERIFICATION_TTL = timedelta(hours=24)

#: Notification kind used for the verification email.  It reads as an action
#: ("verify the email"), matching the ``consent.request`` style of the
#: notifications plugin.
EMAIL_VERIFICATION_KIND = "email.verify"

TOKEN_VERSION = "v1"

_TOKEN_PREFIX = b"scholium:profile-email-verification:"
_FINGERPRINT_PREFIX = b"scholium:profile-email-fingerprint:"
#: Tolerated clock skew for a token that claims to be from slightly in the
#: future (two servers whose clocks disagree by a few seconds).
_CLOCK_SKEW_SECONDS = 60


def _secret() -> bytes:
    """The HMAC key, derived from the app secret with a domain separator."""
    return (settings.JWT_SECRET or "").encode("utf-8")


def _normalise_email(email: str) -> str:
    return (email or "").strip().lower()


def email_fingerprint(did: str, email: str) -> str:
    """Return a stable, non-reversible fingerprint binding ``email`` to ``did``.

    The address never appears in the token or in storage: only this digest is
    compared.  Lower-casing makes a case-only edit of the address keep the same
    verification, which is what mail providers do in practice.
    """
    message = b"\x00".join(
        (_FINGERPRINT_PREFIX, did.encode("utf-8"), _normalise_email(email).encode("utf-8"))
    )
    return hmac.new(_secret(), message, hashlib.sha256).hexdigest()


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _sign(body: str) -> bytes:
    return hmac.new(_secret(), _TOKEN_PREFIX + body.encode("ascii"), hashlib.sha256).digest()


def issue_verification_token(
    did: str,
    email: str,
    *,
    now: Optional[datetime] = None,
) -> str:
    """Mint a signed verification token for ``did``'s current ``email``."""
    issued = int((now or datetime.now(timezone.utc)).timestamp())
    payload = json.dumps(
        {
            "d": did,
            "i": issued,
            "f": email_fingerprint(did, email),
            # Two saves in the same second must not produce byte-identical
            # links: a nonce keeps every issued link distinguishable.
            "n": uuid.uuid4().hex,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    body = _b64encode(payload)
    return f"{TOKEN_VERSION}.{body}.{_b64encode(_sign(body))}"


def verify_verification_token(
    token: str,
    did: str,
    email: str,
    *,
    now: Optional[datetime] = None,
    ttl: timedelta = DEFAULT_VERIFICATION_TTL,
) -> bool:
    """Return whether ``token`` is an authentic, unexpired link for ``did``/``email``.

    False covers every rejection -- wrong shape, bad signature, another DID,
    an address that has since changed, or an expired link -- because a caller
    must never learn *why* a bearer token was refused.
    """
    if not isinstance(token, str):
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    version, body, signature = parts
    if version != TOKEN_VERSION:
        return False

    try:
        presented = _b64decode(signature)
    except (ValueError, TypeError):
        return False
    if not hmac.compare_digest(_sign(body), presented):
        return False

    try:
        payload = json.loads(_b64decode(body).decode("utf-8"))
    except (ValueError, TypeError):
        return False
    if not isinstance(payload, dict) or payload.get("d") != did:
        return False

    try:
        issued = int(payload["i"])
        fingerprint = payload["f"]
    except (KeyError, TypeError, ValueError):
        return False
    if not isinstance(fingerprint, str):
        return False

    current = (now or datetime.now(timezone.utc)).timestamp()
    if issued > current + _CLOCK_SKEW_SECONDS:
        return False
    if current - issued > ttl.total_seconds():
        return False

    return hmac.compare_digest(fingerprint, email_fingerprint(did, email))


def build_verification_link(did: str, token: str) -> str:
    """Return the URL a verification email points at.

    The path is the API route itself (``POST /v1/profiles/{did}/verify-email``)
    with the token in the query string, so the link works without a UI build.
    The DID's colons are legal in a path segment and are left alone; the token
    is percent-encoded.
    """
    path = f"/v1/profiles/{quote(did, safe=':')}/verify-email"
    base = (settings.NEXT_PUBLIC_API_URL or "").strip().rstrip("/")
    return f"{base}{path}?{urlencode({'token': token})}"
