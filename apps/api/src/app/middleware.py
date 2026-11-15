"""Write throttling per trust tier and per account age.

Every write (``POST``, ``PUT``, ``PATCH``, ``DELETE``) spends one unit of a
rolling 24-hour quota and every write response, whatever its status, carries
``X-RateLimit-Limit`` and ``X-RateLimit-Remaining``. Reads are neither counted
nor annotated. A write over quota is answered ``429`` as RFC 9457 problem
details (``application/problem+json``) with a ``Retry-After`` header and is
never passed on to the route.

Installing it on an app (before the app starts)::

    from app.middleware import install_write_throttle

    install_write_throttle(app)

Who is throttled, and how much:

* A request carrying a valid access token is throttled per DID (the ``sub``
  claim), so rotating tokens or changing address does not reset the quota.
  Writes per day by trust tier (:data:`TIER_LIMITS`): 0 Reader 20, 1 Member
  100, 2 Author 200, 3 Reviewer 300, 4 Moderator 1000.
* **New accounts get 20 writes a day** whatever their tier
  (:data:`NEW_ACCOUNT_LIMIT`): an account is new while it is younger than
  :data:`NEW_ACCOUNT_MAX_AGE` (90 days, the same horizon the spec uses for
  young tier-2 accounts), and a new account gets the lower of the two limits.
  Account age is ``accounts.created_at``; a DID with no row, a missing table or
  an unreadable timestamp counts as brand new, the strict end.
* A request with no token, or one that fails verification, is throttled per
  client address at :data:`ANONYMOUS_LIMIT` (sign-in itself is a write that
  happens before there is a token). Behind a reverse proxy every client shares
  the proxy's address unless the server rewrites it (``uvicorn
  --proxy-headers``).

Behaviour worth knowing:

* The trust tier is the one in the access token, as in :mod:`app.security`, so a
  promotion applies from the caller's next token.
* The window slides: the quota is the number of writes in the last 24 hours,
  not since midnight. A rejected write is not recorded, so retrying early never
  extends the wait. ``Retry-After`` is whole seconds until a slot frees up.
* Every attempt that reaches the middleware counts, including ones the route
  then answers with a 4xx, so failed writes cannot be used to probe for free.
* Counters live in process memory. They are exact for one worker and reset on
  restart; with several workers each enforces its own quota.
* An unhandled exception in a route is rendered here, with the rate-limit
  headers, by the app's own ``Exception`` handler (falling back to
  :func:`app.errors.unhandled_exception_handler`), and then re-raised so the
  server still logs it. Otherwise the 500 would be produced outside this
  middleware and miss the headers.
"""

from __future__ import annotations

import inspect
import logging
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from types import MappingProxyType
from typing import Any, Callable, Deque, Mapping, Optional

from fastapi import FastAPI
from fastapi.security.utils import get_authorization_scheme_param
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import db, security
from .errors import problem_response, unhandled_exception_handler

logger = logging.getLogger(__name__)

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

WINDOW = timedelta(days=1)
TIER_LIMITS: Mapping[int, int] = MappingProxyType({0: 20, 1: 100, 2: 200, 3: 300, 4: 1000})
NEW_ACCOUNT_LIMIT = 20
NEW_ACCOUNT_MAX_AGE = timedelta(days=90)
ANONYMOUS_LIMIT = 100

RATE_LIMITED_TYPE = "urn:scholium:problem:rate-limited"
LIMIT_HEADER = "X-RateLimit-Limit"
REMAINING_HEADER = "X-RateLimit-Remaining"
RETRY_AFTER_HEADER = "Retry-After"

_SWEEP_INTERVAL = 60.0  # seconds between purges of expired keys from the limiter


# --- policy -------------------------------------------------------------------


@dataclass(frozen=True)
class ThrottlePolicy:
    """How many writes each kind of caller gets per ``window``."""

    tier_limits: Mapping[int, int] = field(default_factory=lambda: TIER_LIMITS)
    new_account_limit: int = NEW_ACCOUNT_LIMIT
    new_account_max_age: timedelta = NEW_ACCOUNT_MAX_AGE
    anonymous_limit: int = ANONYMOUS_LIMIT
    window: timedelta = WINDOW

    def __post_init__(self) -> None:
        tiers = set(int(t) for t in security.Tier)
        if set(self.tier_limits) != tiers:
            raise ValueError(f"tier_limits must give a limit for exactly the tiers {sorted(tiers)}")
        for name, value in [
            *((f"tier_limits[{t}]", n) for t, n in self.tier_limits.items()),
            ("new_account_limit", self.new_account_limit),
            ("anonymous_limit", self.anonymous_limit),
        ]:
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer, got {value!r}")
        if self.window <= timedelta(0):
            raise ValueError("window must be positive")

    def is_new(self, created_at: Optional[datetime], now: datetime) -> bool:
        """True for an account younger than ``new_account_max_age`` (or of unknown age)."""
        return created_at is None or now - created_at < self.new_account_max_age

    def limit_for(self, tier: int, *, new_account: bool) -> int:
        """Writes per window for an authenticated caller of ``tier``."""
        limit = self.tier_limits[tier]
        return min(limit, self.new_account_limit) if new_account else limit


# --- limiter ------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """The outcome of spending one write: ``retry_after`` is 0 when ``allowed``."""

    allowed: bool
    limit: int
    remaining: int
    retry_after: int = 0


class SlidingWindowLimiter:
    """Counts writes per key over a rolling window; safe to call from any thread."""

    def __init__(self, window: timedelta = WINDOW, clock: Callable[[], float] = time.time) -> None:
        self._window = window.total_seconds()
        self._clock = clock
        self._hits: dict[str, Deque[float]] = {}
        self._lock = threading.Lock()
        self._last_sweep = clock()

    def hit(self, key: str, limit: int) -> Decision:
        """Spend one unit for ``key`` against ``limit`` if there is room, else refuse."""
        now = self._clock()
        cutoff = now - self._window
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= cutoff:
                hits.popleft()
            used = len(hits)
            if used >= limit:
                # The write is allowed again once enough old hits have expired
                # to leave room for one: that is when hits[used - limit] ages out.
                wait = hits[used - limit] + self._window - now
                return Decision(False, limit, 0, max(1, math.ceil(wait)))
            hits.append(now)
            self._sweep(now, cutoff)
            return Decision(True, limit, limit - used - 1)

    def _sweep(self, now: float, cutoff: float) -> None:
        """Forget keys whose every hit has expired, so idle callers cost nothing."""
        if now - self._last_sweep < _SWEEP_INTERVAL:
            return
        self._last_sweep = now
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]


# --- account age --------------------------------------------------------------


def _as_utc(value: Any) -> Optional[datetime]:
    """A timestamp as an aware UTC datetime; SQLite hands back strings, naive means UTC."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


class AccountAgeLookup:
    """Reads ``accounts.created_at`` for a DID; None if there is no usable answer.

    Accounts that exist are cached, because their creation time never changes.
    A miss is not cached, so an account created after its first (new-account)
    request is picked up on the next one.
    """

    def __init__(self, engine: Optional[Engine] = None, *, max_cached: int = 10_000) -> None:
        self._engine = engine
        self._max_cached = max_cached
        self._cache: dict[str, datetime] = {}

    def __call__(self, did: str) -> Optional[datetime]:
        cached = self._cache.get(did)
        if cached is not None:
            return cached
        try:
            with (self._engine or db.engine).connect() as conn:
                row = conn.execute(text("SELECT created_at FROM accounts WHERE did = :did"), {"did": did}).first()
        except SQLAlchemyError:
            # No accounts table yet (or the database is unreachable): the caller
            # is treated as a new account, which is the safe side to err on.
            logger.debug("could not read the age of account %s", did, exc_info=True)
            return None
        created_at = _as_utc(row[0]) if row is not None else None
        if created_at is not None:
            if len(self._cache) >= self._max_cached:
                self._cache.clear()
            self._cache[did] = created_at
        return created_at


# --- middleware ---------------------------------------------------------------


def _humanize(seconds: int) -> str:
    """``3 hours 12 minutes``: the two largest units of ``seconds``."""
    parts = []
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60), ("second", 1)):
        count, seconds = divmod(seconds, size)
        if count:
            parts.append(f"{count} {unit}{'' if count == 1 else 's'}")
    return " ".join(parts[:2]) or "0 seconds"


def _per(window: timedelta) -> str:
    return "a day" if window == timedelta(days=1) else f"every {_humanize(int(window.total_seconds()))}"


def _bearer_token(request: Request) -> Optional[str]:
    scheme, token = get_authorization_scheme_param(request.headers.get("authorization"))
    return token if scheme.lower() == "bearer" and token else None


async def _unhandled_response(request: Request, exc: Exception) -> Response:
    """The response the app would give an unhandled ``exc``, for adding headers to."""
    handlers = getattr(request.scope.get("app"), "exception_handlers", None) or {}
    handler = handlers.get(Exception) or handlers.get(500) or unhandled_exception_handler
    response = handler(request, exc)
    return await response if inspect.isawaitable(response) else response


class WriteThrottleMiddleware:
    """ASGI middleware that enforces :class:`ThrottlePolicy` on every write.

    ``account_created_at`` maps a DID to its account's creation time (None if
    unknown) and defaults to reading the ``accounts`` table; ``clock`` returns
    the current time in epoch seconds. Both exist so tests can control them.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        policy: Optional[ThrottlePolicy] = None,
        account_created_at: Optional[Callable[[str], Optional[datetime]]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.app = app
        self.policy = policy or ThrottlePolicy()
        self.limiter = SlidingWindowLimiter(self.policy.window, clock)
        self._account_created_at = account_created_at or AccountAgeLookup()
        self._clock = clock

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in WRITE_METHODS:
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        decision, new_account, subject = await self._spend(request)
        quota_headers = {LIMIT_HEADER: str(decision.limit), REMAINING_HEADER: str(decision.remaining)}

        if not decision.allowed:
            response = problem_response(
                request=request,
                status_code=429,
                type=RATE_LIMITED_TYPE,
                detail=(
                    f"{subject} can write {decision.limit} times {_per(self.policy.window)}, "
                    f"and that is used up. Try again in {_humanize(decision.retry_after)}."
                ),
                headers={**quota_headers, RETRY_AFTER_HEADER: str(decision.retry_after)},
                limit=decision.limit,
                retry_after=decision.retry_after,
                window_seconds=int(self.policy.window.total_seconds()),
                new_account=new_account,
            )
            await response(scope, receive, send)
            return

        started = False

        async def send_with_quota(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = MutableHeaders(scope=message)
                for name, value in quota_headers.items():
                    headers[name] = value
            await send(message)

        try:
            await self.app(scope, receive, send_with_quota)
        except Exception as exc:
            if started:
                raise
            response = await _unhandled_response(request, exc)
            for name, value in quota_headers.items():
                response.headers[name] = value
            await response(scope, receive, send)
            raise  # the 500 is already on the wire; re-raise so the server logs it

    async def _spend(self, request: Request) -> tuple[Decision, bool, str]:
        """Charge this write to its caller: (decision, caller is a new account, who to name in a 429)."""
        policy = self.policy
        principal = self._principal(request)
        if principal is None:
            host = request.client.host if request.client else "unknown"
            decision = self.limiter.hit(f"ip:{host}", policy.anonymous_limit)
            return decision, False, "Unauthenticated clients"

        created_at = await run_in_threadpool(self._account_created_at, principal.did)
        now = datetime.fromtimestamp(self._clock(), timezone.utc)
        new_account = policy.is_new(created_at, now)
        limit = policy.limit_for(principal.tier, new_account=new_account)
        decision = self.limiter.hit(f"did:{principal.did}", limit)
        who = "New accounts" if new_account else f"{security.Tier(principal.tier).label} accounts (tier {principal.tier})"
        return decision, new_account, who

    @staticmethod
    def _principal(request: Request) -> Optional[security.Principal]:
        token = _bearer_token(request)
        if token is None:
            return None
        try:
            return security.decode_access_token(token)
        except security.InvalidAccessToken:
            return None  # the route's own auth answers 401; until then it is an anonymous write


def install_write_throttle(app: FastAPI, **options: Any) -> FastAPI:
    """Throttle writes to ``app``; ``options`` are :class:`WriteThrottleMiddleware`'s.

    Starlette refuses to add middleware once the app has started, so call this
    while the app is being built (the module loader's ``on_startup`` hook runs
    in time).
    """
    app.add_middleware(WriteThrottleMiddleware, **options)
    return app
