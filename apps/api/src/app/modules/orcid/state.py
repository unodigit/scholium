"""Signed OAuth ``state`` values for the ORCID link flow (plugin: orcid).

``GET /v1/auth/orcid/start`` hands the browser an ORCID authorize URL whose
``state`` query parameter is a compact HS256 JSON Web Token signed with
``settings.JWT_SECRET``.  The value is self-contained, so the later
``POST /v1/auth/orcid/complete`` can verify it without server-side storage,
and a tampered or expired state is refused::

    state = sign_state(did="did:key:z6Mk...")
    claims = verify_state(state)          # raises InvalidState if unusable

Claims:

``purpose``
    Always :data:`STATE_PURPOSE`.  The signed value is purpose-bound, so a
    state cannot be replayed as an access token (or vice versa) even though
    both are signed with the same secret.
``iat`` / ``exp``
    Issue and expiry instants.  A state is good for :data:`STATE_TTL`.
``jti``
    A random identifier, unique per issue; two calls never share a state.
``nonce``
    A second, independent 256-bit random value for correlating the redirect back from ORCID.
``did``
    Present only when the caller was authenticated: the DID of the access
    token that called ``/start``, which the resulting ORCID credential is to
    be bound to.  It is never copied from a request parameter.  It names who
    *started* the flow, not who is finishing it, so ``/complete`` also
    requires the caller's own access token to carry this very DID.

There is deliberately no ``aud`` claim: the value is not a bearer credential
and ``/complete`` authenticates it by its signature and ``purpose`` alone.
"""

from __future__ import annotations

import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt

from app.settings import settings

__all__ = [
    "InvalidState",
    "NONCE_BYTES",
    "STATE_ALGORITHM",
    "STATE_PURPOSE",
    "STATE_TTL",
    "consume_state",
    "is_state_consumed",
    "mark_state_consumed",
    "sign_state",
    "verify_and_consume_state",
    "verify_state",
]

#: How long a state handed to ORCID stays valid after it is issued.
STATE_TTL = timedelta(minutes=10)

#: Random bytes behind each state nonce (256 bits).
NONCE_BYTES = 32

#: Signature algorithm; symmetric because the same node verifies the state.
STATE_ALGORITHM = "HS256"

#: Claim that binds a state to this flow and to no other token type.
STATE_PURPOSE = "scholium:orcid-state"


class InvalidState(ValueError):
    """The state is malformed, forged, expired or not an ORCID state."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def sign_state(
    *,
    did: Optional[str] = None,
    nonce: Optional[str] = None,
    now: Optional[datetime] = None,
) -> str:
    """Return a fresh signed state, optionally bound to ``did``.

    ``now`` defaults to the current time and exists so callers and tests can
    mint a state at another instant.  Raising ``ValueError`` for an empty
    ``did`` (when one is supplied) keeps a blank identifier out of the signed
    claims.
    """
    issued_at = _utcnow() if now is None else now
    claims: dict[str, Any] = {
        "purpose": STATE_PURPOSE,
        "nonce": nonce if nonce is not None else secrets.token_urlsafe(NONCE_BYTES),
        "jti": uuid.uuid4().hex,
        "iat": issued_at,
        "exp": issued_at + STATE_TTL,
    }
    if did is not None:
        if not isinstance(did, str) or not did.strip():
            raise ValueError("did must be a non-empty string when supplied")
        claims["did"] = did
    return jwt.encode(claims, settings.JWT_SECRET, algorithm=STATE_ALGORITHM)


def verify_state(state: str) -> dict[str, Any]:
    """Verify ``state`` and return its claims.

    Raises :class:`InvalidState` when the value is not a state this node
    signed, has expired, or carries another purpose.
    """
    if not isinstance(state, str) or not state:
        raise InvalidState("The OAuth state is missing.")

    options: dict[str, Any] = {
        "require": ["exp", "iat", "jti", "purpose"],
        "verify_aud": False,
    }

    try:
        claims = jwt.decode(
            state,
            settings.JWT_SECRET,
            algorithms=[STATE_ALGORITHM],
            options=options,
        )
    except jwt.ExpiredSignatureError:
        raise InvalidState("The OAuth state has expired.") from None
    except jwt.InvalidTokenError:
        raise InvalidState("The OAuth state is invalid.") from None

    if claims.get("purpose") != STATE_PURPOSE:
        raise InvalidState("The OAuth state is not an ORCID state.")
    return claims


# --------------------------------------------------------------------------- #
# Single-use tracking
# --------------------------------------------------------------------------- #

#: Identifiers (``jti``) of states that have been consumed by ``/complete``.
#: Kept in memory for the lifetime of the process; a consumed state can never
#: be redeemed a second time, which closes the replay window that made the
#: flow vulnerable to login CSRF.
_CONSUMED_STATES: set[str] = set()
_CONSUMED_LOCK = threading.Lock()


def mark_state_consumed(jti: Any) -> bool:
    """Record ``jti`` as consumed.  Return ``True`` if newly consumed.

    A falsy or non-string identifier is refused (returns ``False``) rather
    than being recorded, so a state that carries no ``jti`` can never be
    marked used.
    """
    if not isinstance(jti, str) or not jti.strip():
        return False
    with _CONSUMED_LOCK:
        if jti in _CONSUMED_STATES:
            return False
        _CONSUMED_STATES.add(jti)
        return True


def is_state_consumed(jti: Any) -> bool:
    """Return whether ``jti`` has already been consumed."""
    if not isinstance(jti, str) or not jti.strip():
        return False
    with _CONSUMED_LOCK:
        return jti in _CONSUMED_STATES


def consume_state(state: str) -> dict[str, Any]:
    """Verify ``state`` and mark it consumed; raise :class:`InvalidState` if unusable or replayed."""
    claims = verify_state(state)
    jti = claims.get("jti")
    if not mark_state_consumed(jti):
        raise InvalidState("The OAuth state has already been used.")
    return claims


#: Alias used by callers that want the verify-and-consume step named explicitly.
verify_and_consume_state = consume_state
