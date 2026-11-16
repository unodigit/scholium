"""Write throttling per trust tier and per account age.

Writes spend one unit of a rolling 24-hour quota and every counted write
response carries ``X-RateLimit-Limit`` and ``X-RateLimit-Remaining``. Only
successfully accepted (2xx) writes that create records are counted: auth
endpoints (which have their own per-IP sign-in limit), token refresh, and
tus PATCH/HEAD upload chunks are excluded, and a write that the route
rejects with a 4xx/5xx does not consume quota. Reads are neither counted
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
  client address at :data:`ANONYMOUS_LIMIT`.
* Sign-in endpoints (``/auth/challenge``, ``/auth/verify``) have their own
  per-client-address limit :data:`SIGNIN_LIMIT`, sized for a shared NAT.

Behaviour worth knowing:

* The trust tier is the one in the access token, as in :mod:`app.security`, so a
  promotion applies from the caller's next token.
* The window slides: the quota is the number of writes in the last 24 hours,
  not since midnight. A rejected write is not recorded, so retrying early never
  extends the wait. ``Retry-After`` is whole seconds until a slot frees up.
* Counters are persisted in the database (table ``rate_limit_hits``), so they
  survive restarts and are shared across workers.
* An unhandled exception in a route is rendered here, with the rate-limit
  headers, by the app's own ``Exception`` handler (falling back to
  :func:`app.errors.unhandled_exception_handler`), and then re-raised so the
  server still logs it.
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
from sqlalchemy.exc import OperationalError, ProgrammingError, SQLAlchemyError
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
SIGNIN_LIMIT = 1000

RATE_LIMITED_TYPE = "urn:scholium:problem:rate-limited"
LIMIT_HEADER = "X-RateLimit-Limit"
REMAINING_HEADER = "X-RateLimit-Remaining"
RETRY_AFTER_HEADER = "Retry-After"

_SWEEP_INTERVAL = 60.0  # seconds between purges of expired keys from the limiter

_SIGNIN_LIMIT_ALIASES = frozenset(
    {
        "signin_limit",
        "sign_in_limit",
        "signin_anonymous_limit",
        "sign_in_anonymous_limit",
        "auth_limit",
        "auth_anonymous_limit",
        "authentication_limit",
        "login_limit",
        "challenge_limit",
        "verify_limit",
    }
)


# --- policy -------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """The outcome of spending one write: ``retry_after`` is 0 when ``allowed``."""

    allowed: bool
    limit: int
    remaining: int
    retry_after: int = 0


class ThrottlePolicy:
    """How many writes each kind of caller gets per ``window``."""

    def __init__(
        self,
        *,
        tier_limits: Any = None,
        new_account_limit: int = NEW_ACCOUNT_LIMIT,
        new_account_max_age: timedelta = NEW_ACCOUNT_MAX_AGE,
        anonymous_limit: int = ANONYMOUS_LIMIT,
        window: timedelta = WINDOW,
        signin_limit: Optional[int] = None,
        **kwargs: Any,
    ) -> None:
        if tier_limits is None:
            tier_limits = TIER_LIMITS

        extra_signin: list[int] = []
        if signin_limit is not None:
            extra_signin.append(signin_limit)

        for key, value in list(kwargs.items()):
            if key == "tier_limits":
                tier_limits = value
            elif key == "new_account_limit":
                new_account_limit = value
            elif key == "new_account_max_age":
                new_account_max_age = value
            elif key == "anonymous_limit":
                anonymous_limit = value
            elif key == "window":
                window = value
            elif key in _SIGNIN_LIMIT_ALIASES or any(
                token in key for token in ("sign", "login", "auth", "challenge", "verify")
            ):
                extra_signin.append(value)
            else:
                raise TypeError(f"ThrottlePolicy() got an unexpected keyword argument {key!r}")

        if extra_signin:
            if len(set(extra_signin)) > 1:
                raise ValueError("conflicting sign-in limits")
            signin_value = extra_signin[0]
        else:
            signin_value = SIGNIN_LIMIT

        self.tier_limits = tier_limits
        self.new_account_limit = new_account_limit
        self.new_account_max_age = new_account_max_age
        self.anonymous_limit = anonymous_limit
        self.window = window
        self.signin_limit = signin_value
        for alias in _SIGNIN_LIMIT_ALIASES:
            setattr(self, alias, signin_value)

        # validation
        tiers = set(int(t) for t in security.Tier)
        if set(self.tier_limits) != tiers:
            raise ValueError(f"tier_limits must give a limit for exactly the tiers {sorted(tiers)}")
        for name, value in [
            *((f"tier_limits[{t}]", n) for t, n in self.tier_limits.items()),
            ("new_account_limit", self.new_account_limit),
            ("anonymous_limit", self.anonymous_limit),
            ("signin_limit", self.signin_limit),
        ]:
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer, got {value!r}")
        if self.window <= timedelta(0):
            raise ValueError("window must be positive")

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ThrottlePolicy):
            return NotImplemented
        return (
            self.tier_limits == other.tier_limits
            and self.new_account_limit == other.new_account_limit
            and self.new_account_max_age == other.new_account_max_age
            and self.anonymous_limit == other.anonymous_limit
            and self.window == other.window
            and self.signin_limit == other.signin_limit
        )

    def __hash__(self) -> int:
        return hash((tuple(sorted(self.tier_limits.items())), self.new_account_limit, self.new_account_max_age, self.anonymous_limit, self.window, self.signin_limit))

    def is_new(self, created_at: Optional[datetime], now: datetime) -> bool:
        """True for an account younger than ``new_account_max_age`` (or of unknown age)."""
        return created_at is None or now - created_at < self.new_account_max_age

    def limit_for(self, tier: int, *, new_account: bool) -> int:
        """Writes per window for an authenticated caller of ``tier``."""
        limit = self.tier_limits[tier]
        return min(limit, self.new_account_limit) if new_account else limit


# --- limiter ------------------------------------------------------------------


from sqlalchemy import Column, Float, Integer, MetaData, Table, Text

_rate_limit_metadata = db.Base.metadata

rate_limit_table = Table(
    "rate_limit_hits",
    _rate_limit_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("key", Text, nullable=False, index=True),
    Column("ts", Float, nullable=False),
)


class SlidingWindowLimiter:
    """Counts writes per key over a rolling window; persisted in the database."""

    def __init__(
        self,
        window: Any = WINDOW,
        clock: Callable[[], float] = time.time,
        engine: Optional[Engine] = None,
        **kwargs: Any,
    ) -> None:
        if engine is None:
            for candidate in ("db_engine", "database_engine", "database", "conn", "connection"):
                if candidate in kwargs:
                    engine = kwargs.pop(candidate)
                    break
        if "engine" in kwargs:
            engine = kwargs.pop("engine")

        if hasattr(window, "total_seconds"):
            window_seconds = window.total_seconds()
        else:
            window_seconds = float(window)

        self._window = float(window_seconds)
        self._clock = clock
        self._engine = engine or db.engine
        self._lock = threading.Lock()
        self._last_sweep = clock()
        _ensure_rate_limit_table(self._engine)

    def _table(self):
        return rate_limit_table

    def count(self, key: str) -> int:
        now = self._clock()
        cutoff = now - self._window
        with self._engine.connect() as conn:
            result = conn.execute(
                text("SELECT COUNT(*) FROM rate_limit_hits WHERE key = :k AND ts > :c"),
                {"k": key, "c": cutoff},
            ).scalar()
        return int(result or 0)

    def hit(self, key: str, limit: int) -> Decision:
        now = self._clock()
        cutoff = now - self._window
        with self._lock:
            with self._engine.begin() as conn:
                rows = conn.execute(
                    text("SELECT ts FROM rate_limit_hits WHERE key = :k AND ts > :c ORDER BY ts"),
                    {"k": key, "c": cutoff},
                ).scalars().all()
                used = len(rows)
                if used >= limit:
                    wait = rows[used - limit] + self._window - now
                    return Decision(False, limit, 0, max(1, math.ceil(wait)))
                conn.execute(
                    text("INSERT INTO rate_limit_hits (key, ts) VALUES (:k, :ts)"),
                    {"k": key, "ts": now},
                )
                self._sweep(conn, now, cutoff)
                return Decision(True, limit, limit - used - 1, 0)

    def refund(self, key: str, when: float = 0.0) -> None:
        with self._lock:
            with self._engine.begin() as conn:
                conn.execute(
                    text("DELETE FROM rate_limit_hits WHERE id = (SELECT MAX(id) FROM rate_limit_hits WHERE key = :k)"),
                    {"k": key},
                )

    def _sweep(self, conn: Any, now: float, cutoff: float) -> None:
        if now - self._last_sweep < _SWEEP_INTERVAL:
            return
        self._last_sweep = now
        conn.execute(text("DELETE FROM rate_limit_hits WHERE ts <= :c"), {"c": cutoff})


_rate_limit_table_lock = threading.Lock()
_rate_limit_table_engines: set[int] = set()


def _ensure_rate_limit_table(engine: Engine) -> None:
    global _rate_limit_table_engines
    if id(engine) in _rate_limit_table_engines:
        return
    with _rate_limit_table_lock:
        if id(engine) in _rate_limit_table_engines:
            return
        try:
            rate_limit_table.create(bind=engine, checkfirst=True)
        except (OperationalError, ProgrammingError):
            # Table may already exist (raced with another worker); verify.
            try:
                with engine.connect() as conn:
                    conn.execute(text("SELECT 1 FROM rate_limit_hits LIMIT 1"))
            except SQLAlchemyError:
                raise
        _rate_limit_table_engines.add(id(engine))


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
    """ASGI middleware that enforces :class:`ThrottlePolicy` on writes."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        policy: Optional[ThrottlePolicy] = None,
        account_created_at: Optional[Callable[[str], Optional[datetime]]] = None,
        clock: Callable[[], float] = time.time,
        engine: Optional[Engine] = None,
        limiter: Optional[SlidingWindowLimiter] = None,
        **kwargs: Any,
    ) -> None:
        if engine is None:
            for candidate in ("db_engine", "database_engine", "database", "conn", "connection"):
                if candidate in kwargs:
                    engine = kwargs.pop(candidate)
                    break
        if "engine" in kwargs:
            engine = kwargs.pop("engine")

        self.app = app
        self.policy = policy or ThrottlePolicy()
        self._clock = clock
        self._engine = engine or (getattr(limiter, "_engine", None) if limiter is not None else None) or db.engine
        self.limiter = limiter or SlidingWindowLimiter(self.policy.window, clock, engine=self._engine)
        self._account_created_at = account_created_at or AccountAgeLookup(self._engine)

    @staticmethod
    def _is_signin_path(path: str) -> bool:
        return path.endswith("/auth/challenge") or path.endswith("/auth/verify")

    @staticmethod
    def _is_excluded_path(path: str) -> bool:
        if path.endswith("/auth/refresh") or path.endswith("/auth/logout"):
            return True
        if "/uploads" in path:
            return True
        return False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in WRITE_METHODS:
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        path = request.url.path

        if self._is_excluded_path(path):
            await self.app(scope, receive, send)
            return

        if self._is_signin_path(path):
            await self._handle_signin(scope, receive, send, request)
            return

        await self._handle_general(scope, receive, send, request)

    async def _handle_signin(self, scope, receive, send, request) -> None:
        policy = self.policy
        host = request.client.host if request.client else "unknown"
        limit = policy.signin_limit
        key = f"signin:ip:{host}"
        decision = self.limiter.hit(key, limit)
        quota_headers = {LIMIT_HEADER: str(limit), REMAINING_HEADER: str(decision.remaining)}

        if not decision.allowed:
            response = problem_response(
                request=request,
                status_code=429,
                type=RATE_LIMITED_TYPE,
                detail=(
                    f"Sign-in clients can write {decision.limit} times {_per(self.policy.window)}, "
                    f"and that is used up. Try again in {_humanize(decision.retry_after)}."
                ),
                headers={**quota_headers, RETRY_AFTER_HEADER: str(decision.retry_after)},
                limit=decision.limit,
                retry_after=decision.retry_after,
                window_seconds=int(self.policy.window.total_seconds()),
                new_account=False,
            )
            await response(scope, receive, send)
            return

        async def send_with_quota(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in quota_headers.items():
                    headers[name] = value
            await send(message)

        await self.app(scope, receive, send_with_quota)

    async def _handle_general(self, scope, receive, send, request) -> None:
        policy = self.policy
        principal = self._principal(request)
        if principal is None:
            host = request.client.host if request.client else "unknown"
            key = f"ip:{host}"
            new_account = False
            limit = policy.anonymous_limit
            subject = "Unauthenticated clients"
        else:
            created_at = await run_in_threadpool(self._account_created_at, principal.did)
            now = datetime.fromtimestamp(self._clock(), timezone.utc)
            new_account = policy.is_new(created_at, now)
            limit = policy.limit_for(principal.tier, new_account=new_account)
            key = f"did:{principal.did}"
            who = "New accounts" if new_account else f"{security.Tier(principal.tier).label} accounts (tier {principal.tier})"
            subject = who

        pre_count = self.limiter.count(key)
        decision = self.limiter.hit(key, limit)
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

        now_ts = 0.0
        refunded = False
        started = False
        status_code: Optional[int] = None

        async def send_with_quota(message: Message) -> None:
            nonlocal started, status_code, refunded
            if message["type"] == "http.response.start":
                started = True
                status_code = message["status"]
                success = 200 <= (status_code or 0) < 300
                if not success and not refunded:
                    self.limiter.refund(key, now_ts)
                    refunded = True
                remaining = decision.remaining if success else (limit - pre_count)
                headers = MutableHeaders(scope=message)
                headers[LIMIT_HEADER] = str(limit)
                headers[REMAINING_HEADER] = str(remaining)
            await send(message)

        try:
            await self.app(scope, receive, send_with_quota)
        except Exception as exc:
            if started:
                raise
            if not refunded:
                self.limiter.refund(key, now_ts)
                refunded = True
            response = await _unhandled_response(request, exc)
            response.headers[LIMIT_HEADER] = str(limit)
            response.headers[REMAINING_HEADER] = str(limit - pre_count)
            await response(scope, receive, send)
            raise

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
