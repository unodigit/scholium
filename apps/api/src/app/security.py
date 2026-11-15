"""Access tokens and trust-tier authorization.

Issuing and reading tokens::

    from app import security

    token = security.issue_access_token(did, tier)   # valid for 15 minutes
    principal = security.decode_access_token(token)  # Principal(did=..., tier=...)

Protecting a route::

    from fastapi import Depends
    from app.security import Principal, Tier, require_tier

    @router.post("/papers")
    def submit(principal: Principal = Depends(require_tier(Tier.AUTHOR))): ...

    # or, when the handler does not need the caller:
    @router.get("/moderation/queue", dependencies=[Depends(require_tier(4))])

Trust tiers are 0 Reader, 1 Member, 2 Author, 3 Reviewer, 4 Moderator;
``require_tier(n)`` admits tier ``n`` and above.

Failures:

* No credentials, or a token that is malformed, forged, expired or minted for
  something else, give ``401`` with a ``WWW-Authenticate: Bearer`` challenge.
* A valid token whose tier is below ``n`` gives ``403`` naming the required tier
  and the caller's tier, both in the human-readable ``detail`` and as the
  ``required_tier`` / ``caller_tier`` members of the problem document.

Design notes:

* The tier is a claim inside the access token, so a promotion or demotion takes
  effect when the caller's next token is issued: at most 15 minutes later, or
  on the next refresh. Nothing here reads the accounts table.
* Tokens are HS256 JWTs signed with ``settings.JWT_SECRET``, read on every call.
  Verification pins the algorithm, so ``alg: none`` and algorithm-swap tokens
  are refused, and requires an audience, so a JWT signed with the same secret
  for another purpose cannot be replayed as an access token.
* The 401/403 errors are rendered as RFC 9457 problem documents
  (``application/problem+json``, with ``required_tier`` / ``caller_tier`` as
  extension members) without any app wiring. Starlette picks an exception
  handler when the exception is caught, from the dicts in the request scope, so
  the dependencies add their handler to those just before raising
  (:func:`_ensure_problem_handler`). That leans on Starlette's
  ``starlette.exception_handlers`` scope entry; if it ever disappears the errors
  are still ``HTTPException`` subclasses, so the app's generic handling answers
  403/401 with the tiers named in ``detail``.
  :func:`install_problem_handlers` registers the same handler on an app
  explicitly, and a handler the app registered for ``SecurityProblem`` itself is
  never overridden.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import IntEnum
from http import HTTPStatus
from typing import Any, Callable, NoReturn, Optional

import jwt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .settings import settings

ACCESS_TOKEN_TTL = timedelta(minutes=15)
JWT_ALGORITHM = "HS256"
TOKEN_AUDIENCE = "scholium:access"

PROBLEM_MEDIA_TYPE = "application/problem+json"
INSUFFICIENT_TIER_TYPE = "urn:scholium:problem:insufficient-tier"
UNAUTHENTICATED_TYPE = "urn:scholium:problem:unauthenticated"


class Tier(IntEnum):
    """Trust tiers. Higher tiers include everything the lower ones may do."""

    READER = 0
    MEMBER = 1
    AUTHOR = 2
    REVIEWER = 3
    MODERATOR = 4

    @property
    def label(self) -> str:
        return self.name.title()


MIN_TIER = min(Tier)
MAX_TIER = max(Tier)


def _check_tier(value: object) -> int:
    """Return ``value`` as a plain int, or raise ValueError if it is not a tier."""
    if isinstance(value, bool) or not isinstance(value, int) or not MIN_TIER <= value <= MAX_TIER:
        raise ValueError(f"trust tier must be an integer from {MIN_TIER} to {MAX_TIER}, got {value!r}")
    return int(value)


def _describe(tier: int) -> str:
    return f"tier {tier} ({Tier(tier).label})"


@dataclass(frozen=True)
class Principal:
    """The authenticated caller: who they are and their trust tier."""

    did: str
    tier: int


# --- tokens -----------------------------------------------------------------


class InvalidAccessToken(ValueError):
    """The token is malformed, forged, expired or not an access token."""


def issue_access_token(did: str, tier: int, *, now: Optional[datetime] = None) -> str:
    """Return a signed access token for ``did`` that expires 15 minutes after ``now``.

    ``now`` defaults to the current time; it exists so callers and tests can mint
    tokens at another instant. Raises ValueError for an empty ``did`` or a tier
    outside 0-4.
    """
    if not isinstance(did, str) or not did:
        raise ValueError("did must be a non-empty string")
    tier = _check_tier(tier)
    issued_at = now if now is not None else datetime.now(timezone.utc)
    claims = {
        "sub": did,
        "tier": tier,
        "aud": TOKEN_AUDIENCE,
        "iat": issued_at,
        "exp": issued_at + ACCESS_TOKEN_TTL,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, settings.JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> Principal:
    """Verify ``token`` and return its principal; raise InvalidAccessToken if it is unusable."""
    try:
        claims = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            audience=TOKEN_AUDIENCE,
            options={"require": ["exp", "iat", "sub", "aud"]},
        )
    except jwt.ExpiredSignatureError:
        raise InvalidAccessToken("The access token has expired.") from None
    except jwt.InvalidTokenError:
        raise InvalidAccessToken("The access token is invalid.") from None

    try:
        tier = _check_tier(claims.get("tier"))
    except ValueError:
        raise InvalidAccessToken("The access token carries no valid trust tier.") from None
    return Principal(did=claims["sub"], tier=tier)


# --- problem details --------------------------------------------------------


class SecurityProblem(HTTPException):
    """An ``HTTPException`` that can describe itself as an RFC 9457 problem document."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        type: str,
        headers: Optional[dict[str, str]] = None,
        **extensions: Any,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.type = type
        self.extensions = extensions

    def problem(self, instance: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": self.type,
            "title": HTTPStatus(self.status_code).phrase,
            "status": self.status_code,
            "detail": self.detail,
        }
        if instance is not None:
            body["instance"] = instance
        body.update(self.extensions)
        return body


class Unauthorized(SecurityProblem):
    """401: no usable credentials. ``error`` is the RFC 6750 error code, if any."""

    def __init__(self, detail: str, *, error: Optional[str] = None) -> None:
        challenge = "Bearer" if error is None else f'Bearer error="{error}"'
        super().__init__(401, detail, type=UNAUTHENTICATED_TYPE, headers={"WWW-Authenticate": challenge})


class InsufficientTier(SecurityProblem):
    """403: the caller is authenticated but their tier is below the one required."""

    def __init__(self, *, required: int, caller: int) -> None:
        super().__init__(
            403,
            f"This action requires {_describe(required)} or higher; the caller is {_describe(caller)}.",
            type=INSUFFICIENT_TIER_TYPE,
            required_tier=required,
            caller_tier=caller,
        )
        self.required_tier = required
        self.caller_tier = caller


def problem_response(request: Request, exc: SecurityProblem) -> JSONResponse:
    """Render ``exc`` as an ``application/problem+json`` response."""
    return JSONResponse(
        exc.problem(instance=request.url.path),
        status_code=exc.status_code,
        headers=exc.headers,
        media_type=PROBLEM_MEDIA_TYPE,
    )


def install_problem_handlers(app: FastAPI) -> None:
    """Make ``app`` render this module's 401/403 errors as RFC 9457 problem documents."""
    app.add_exception_handler(SecurityProblem, problem_response)


def _ensure_problem_handler(request: Request) -> None:
    """Make this request render ``SecurityProblem`` as problem details, if nothing else does."""
    try:
        handlers, _status_handlers = request.scope["starlette.exception_handlers"]
    except KeyError:
        return  # not running under Starlette's exception middleware: generic handling applies
    handlers.setdefault(SecurityProblem, problem_response)


def _reject(request: Request, problem: SecurityProblem) -> NoReturn:
    _ensure_problem_handler(request)
    raise problem from None


# --- dependencies -----------------------------------------------------------

_bearer = HTTPBearer(auto_error=False)


def get_current_principal(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Principal:
    """Authenticate the request from its ``Authorization: Bearer`` access token."""
    if credentials is None:
        _reject(request, Unauthorized("Authentication is required: send an 'Authorization: Bearer <access token>' header."))
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken as exc:
        _reject(request, Unauthorized(str(exc), error="invalid_token"))


def require_tier(n: int) -> Callable[..., Principal]:
    """Return a dependency that admits callers of trust tier ``n`` or above.

    The dependency yields the caller's :class:`Principal`. It answers 401 for an
    unauthenticated request and 403 problem details naming the required and the
    caller's tier when the tier is too low. ``n`` is checked here, when the
    route is declared: a ValueError for anything but an integer from 0 to 4.
    """
    required = _check_tier(n)

    def dependency(request: Request, principal: Principal = Depends(get_current_principal)) -> Principal:
        if principal.tier < required:
            _reject(request, InsufficientTier(required=required, caller=principal.tier))
        return principal

    dependency.__name__ = f"require_tier_{required}"
    return dependency
