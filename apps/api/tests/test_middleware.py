"""Tests for write throttling (app.middleware)."""

from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app import middleware, security
from app.middleware import (
    ANONYMOUS_LIMIT,
    NEW_ACCOUNT_LIMIT,
    NEW_ACCOUNT_MAX_AGE,
    TIER_LIMITS,
    AccountAgeLookup,
    SlidingWindowLimiter,
    ThrottlePolicy,
    install_write_throttle,
)
from app.settings import settings

DAY = 86400
START = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
BOB = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH"


@pytest.fixture(autouse=True)
def jwt_secret(monkeypatch):
    # Long enough that PyJWT does not warn about the HMAC key size.
    monkeypatch.setattr(settings, "JWT_SECRET", "test-secret-" + "x" * 64)


@pytest.fixture(autouse=True)
def _clean_rate_limits():
    from app import db
    from sqlalchemy import text
    try:
        with db.engine.begin() as conn:
            conn.execute(text("DELETE FROM rate_limit_hits"))
    except Exception:
        pass
    yield
    try:
        with db.engine.begin() as conn:
            conn.execute(text("DELETE FROM rate_limit_hits"))
    except Exception:
        pass


class Clock:
    """A settable clock in epoch seconds."""

    def __init__(self) -> None:
        self.now = START.timestamp()

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds

    @property
    def dt(self) -> datetime:
        return datetime.fromtimestamp(self.now, timezone.utc)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def ages() -> dict:
    """DID -> account creation time; a DID that is absent is an unknown account."""
    return {}


@pytest.fixture
def calls() -> list:
    """The route handlers that actually ran."""
    return []


@pytest.fixture
def make_client(clock, ages, calls):
    def make(policy=None, **client_options) -> TestClient:
        app = FastAPI()

        @app.post("/write")
        def create() -> dict:
            calls.append("POST")
            return {"ok": True}

        @app.put("/write")
        def replace() -> dict:
            calls.append("PUT")
            return {"ok": True}

        @app.patch("/write")
        def patch() -> dict:
            calls.append("PATCH")
            return {"ok": True}

        @app.delete("/write")
        def remove() -> dict:
            calls.append("DELETE")
            return {"ok": True}

        @app.post("/conflict")
        def conflict() -> None:
            raise HTTPException(409, "already exists")

        @app.post("/boom")
        def boom() -> None:
            raise RuntimeError("kaboom")

        @app.get("/read")
        def read() -> dict:
            calls.append("GET")
            return {"ok": True}

        install_write_throttle(app, policy=policy, account_created_at=ages.get, clock=clock)
        return TestClient(app, **client_options)

    return make


def auth(did: str = ALICE, tier: int = 1) -> dict:
    return {"Authorization": f"Bearer {security.issue_access_token(did, tier)}"}


def small_policy(**overrides) -> ThrottlePolicy:
    """Tiny quotas so a test can exhaust one in a few requests."""
    values = dict(
        tier_limits={0: 2, 1: 4, 2: 6, 3: 8, 4: 10},
        new_account_limit=3,
        anonymous_limit=5,
    )
    values.update(overrides)
    return ThrottlePolicy(**values)


# --- policy -------------------------------------------------------------------


def test_new_accounts_get_20_writes_a_day_by_default():
    policy = ThrottlePolicy()
    assert NEW_ACCOUNT_LIMIT == 20
    assert policy.window == timedelta(days=1)
    for tier in security.Tier:
        assert policy.limit_for(tier, new_account=True) == min(TIER_LIMITS[tier], 20)
    assert policy.limit_for(security.Tier.MODERATOR, new_account=True) == 20


def test_higher_tiers_never_get_less_than_lower_ones():
    limits = [TIER_LIMITS[t] for t in sorted(security.Tier)]
    assert limits == sorted(limits)
    assert len(set(limits)) > 1
    assert ANONYMOUS_LIMIT >= TIER_LIMITS[0]


def test_an_established_account_is_limited_by_tier_alone():
    policy = ThrottlePolicy()
    assert policy.limit_for(1, new_account=False) == TIER_LIMITS[1] > NEW_ACCOUNT_LIMIT


def test_account_age_boundary_and_unknown_age():
    policy = ThrottlePolicy()
    now = START
    assert policy.is_new(None, now)
    assert policy.is_new(now, now)
    assert policy.is_new(now - NEW_ACCOUNT_MAX_AGE + timedelta(seconds=1), now)
    assert not policy.is_new(now - NEW_ACCOUNT_MAX_AGE, now)
    assert policy.is_new(now + timedelta(hours=1), now)  # clock skew: created "in the future"


@pytest.mark.parametrize(
    "overrides",
    [
        {"tier_limits": {0: 1, 1: 1}},
        {"tier_limits": {0: 1, 1: 1, 2: 1, 3: 1, 4: 0}},
        {"tier_limits": {0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1}},
        {"new_account_limit": 0},
        {"anonymous_limit": -1},
        {"window": timedelta(0)},
    ],
)
def test_a_nonsensical_policy_is_refused(overrides):
    with pytest.raises(ValueError):
        ThrottlePolicy(**overrides)


# --- limiter ------------------------------------------------------------------


def test_the_limiter_counts_down_then_refuses(clock):
    limiter = SlidingWindowLimiter(clock=clock)
    remaining = [limiter.hit("k", 3).remaining for _ in range(3)]
    assert remaining == [2, 1, 0]
    refused = limiter.hit("k", 3)
    assert (refused.allowed, refused.remaining, refused.limit) == (False, 0, 3)


def test_the_window_slides_and_a_refusal_is_not_recorded(clock):
    limiter = SlidingWindowLimiter(clock=clock)
    assert limiter.hit("k", 2).allowed
    clock.advance(10)
    assert limiter.hit("k", 2).allowed

    clock.advance(10)
    refused = limiter.hit("k", 2)
    assert (refused.allowed, refused.retry_after) == (False, DAY - 20)

    clock.advance(10)  # retrying early neither extends nor resets the wait
    assert limiter.hit("k", 2).retry_after == DAY - 30

    clock.advance(DAY - 30)  # the first write is exactly a day old: its slot is free
    allowed = limiter.hit("k", 2)
    assert (allowed.allowed, allowed.remaining) == (True, 0)
    assert limiter.hit("k", 2).retry_after == 10  # next free slot: the second write ages out


def test_retry_after_is_whole_seconds_rounded_up(clock):
    limiter = SlidingWindowLimiter(clock=clock)
    limiter.hit("k", 1)
    clock.advance(0.4)
    assert limiter.hit("k", 1).retry_after == DAY  # 86399.6 s left


def test_keys_are_independent(clock):
    limiter = SlidingWindowLimiter(clock=clock)
    assert limiter.hit("a", 1).allowed
    assert not limiter.hit("a", 1).allowed
    assert limiter.hit("b", 1).allowed


def test_lowering_a_limit_below_current_use_waits_for_enough_hits_to_expire(clock):
    limiter = SlidingWindowLimiter(clock=clock)
    for _ in range(4):
        limiter.hit("k", 4)
        clock.advance(100)
    # 4 hits at t=0,100,200,300 (now t=400); a limit of 2 needs the 3 oldest gone.
    refused = limiter.hit("k", 2)
    assert (refused.allowed, refused.retry_after) == (False, DAY - 400 + 200)


def test_idle_keys_are_forgotten(clock):
    limiter = SlidingWindowLimiter(clock=clock)
    for n in range(50):
        limiter.hit(f"k{n}", 1)
    clock.advance(DAY + 1)
    limiter.hit("fresh", 1)
    from sqlalchemy import text
    with limiter._engine.connect() as conn:
        keys = {r[0] for r in conn.execute(text("SELECT DISTINCT key FROM rate_limit_hits")).all()}
    assert keys == {"fresh"}


def test_the_limiter_is_exact_under_concurrency():
    limiter = SlidingWindowLimiter()
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _: limiter.hit("k", 20).allowed, range(400)))
    assert sum(results) == 20


def test_the_limiter_only_touches_its_state_while_holding_its_lock(clock):
    # A thread race inside hit() is too narrow to provoke reliably, so check the discipline directly.
    limiter = SlidingWindowLimiter(clock=clock)

    class GuardedHits(deque):
        def _check(self):
            assert limiter._lock.locked(), "limiter state touched without its lock"

        def append(self, item):
            self._check()
            super().append(item)

        def popleft(self):
            self._check()
            return super().popleft()

    class GuardedStore(dict):
        def setdefault(self, key, default=None):
            self._check()
            return super().setdefault(key, GuardedHits())

        def _check(self):
            assert limiter._lock.locked(), "limiter state touched without its lock"

        def __delitem__(self, key):
            self._check()
            super().__delitem__(key)

    limiter._hits = GuardedStore()
    for _ in range(3):
        limiter.hit("k", 2)
    clock.advance(DAY + 1)
    limiter.hit("k", 2)  # expires old hits (popleft) and sweeps idle keys (del)
    clock.advance(DAY + 1)
    limiter.hit("other", 2)


# --- the 429 ------------------------------------------------------------------


def test_the_21st_write_of_a_new_account_is_a_429_problem(make_client, calls):
    client = make_client()  # defaults; ALICE has no account row, so she is brand new
    headers = auth(tier=2)
    for expected in range(19, -1, -1):
        response = client.post("/write", headers=headers)
        assert response.status_code == 200
        assert response.headers["X-RateLimit-Remaining"] == str(expected)
    assert len(calls) == 20

    response = client.post("/write", headers=headers)

    assert response.status_code == 429
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["X-RateLimit-Remaining"] == "0"
    assert response.headers["X-RateLimit-Limit"] == "20"
    assert int(response.headers["Retry-After"]) == DAY
    body = response.json()
    assert body["type"] == middleware.RATE_LIMITED_TYPE
    assert body["title"] == "Too Many Requests"
    assert body["status"] == 429
    assert body["instance"] == "/write"
    assert body["detail"].startswith("New accounts can write 20 times a day")
    assert "1 day" in body["detail"]
    assert (body["limit"], body["retry_after"], body["new_account"]) == (20, DAY, True)
    assert len(calls) == 20  # the route never ran for the refused write


def test_retry_after_counts_down_and_the_write_succeeds_when_it_reaches_zero(make_client, clock):
    client = make_client(small_policy())
    headers = auth(tier=1)
    for _ in range(3):
        assert client.post("/write", headers=headers).status_code == 200
        clock.advance(60)

    refused = client.post("/write", headers=headers)
    assert refused.status_code == 429
    wait = int(refused.headers["Retry-After"])
    assert wait == DAY - 180

    clock.advance(wait - 1)
    assert client.post("/write", headers=headers).status_code == 429
    clock.advance(1)
    ok = client.post("/write", headers=headers)
    assert ok.status_code == 200
    assert ok.headers["X-RateLimit-Remaining"] == "0"


def test_the_429_names_the_tier_for_established_accounts(make_client, ages, clock):
    ages[ALICE] = clock.dt - timedelta(days=400)
    client = make_client(small_policy())
    headers = auth(tier=1)
    for _ in range(4):
        assert client.post("/write", headers=headers).status_code == 200
    refused = client.post("/write", headers=headers)
    assert refused.status_code == 429
    body = refused.json()
    assert body["detail"].startswith("Member accounts (tier 1) can write 4 times a day")
    assert body["new_account"] is False


# --- tier and account age -----------------------------------------------------


@pytest.mark.parametrize("tier", [0, 1, 2, 3, 4])
def test_established_accounts_get_their_tier_limit(make_client, ages, clock, tier):
    ages[ALICE] = clock.dt - NEW_ACCOUNT_MAX_AGE - timedelta(days=1)
    policy = small_policy()
    client = make_client(policy)
    allowed = 0
    while client.post("/write", headers=auth(tier=tier)).status_code == 200:
        allowed += 1
        assert allowed <= 20
    assert allowed == policy.tier_limits[tier]


@pytest.mark.parametrize("tier", [0, 1, 2, 3, 4])
def test_new_accounts_get_the_lower_of_their_tier_and_new_account_limit(make_client, ages, clock, tier):
    ages[ALICE] = clock.dt - timedelta(days=1)
    policy = small_policy()
    client = make_client(policy)
    allowed = 0
    while client.post("/write", headers=auth(tier=tier)).status_code == 200:
        allowed += 1
        assert allowed <= 20
    assert allowed == min(policy.tier_limits[tier], policy.new_account_limit)


def test_an_account_stops_being_new_when_it_ages_out(make_client, ages, clock):
    ages[ALICE] = clock.dt - NEW_ACCOUNT_MAX_AGE + timedelta(days=1)
    client = make_client(small_policy())
    headers = auth(tier=2)
    assert [client.post("/write", headers=headers).status_code for _ in range(4)] == [200, 200, 200, 429]

    clock.advance(2 * DAY)  # the account is now past the new-account age and the day's writes are spent
    assert [client.post("/write", headers=headers).status_code for _ in range(6)] == [200] * 6
    assert client.post("/write", headers=headers).status_code == 429


def test_an_account_with_no_record_is_treated_as_new(make_client):
    client = make_client(small_policy())
    headers = auth(tier=4)
    assert [client.post("/write", headers=headers).status_code for _ in range(4)] == [200, 200, 200, 429]


def test_quotas_are_per_did_and_not_per_token(make_client):
    client = make_client(small_policy())
    for _ in range(3):
        assert client.post("/write", headers=auth(ALICE)).status_code == 200  # a fresh token each time
    assert client.post("/write", headers=auth(ALICE)).status_code == 429
    bob = client.post("/write", headers=auth(BOB))
    assert (bob.status_code, bob.headers["X-RateLimit-Remaining"]) == (200, "2")


# --- anonymous callers --------------------------------------------------------


def test_unauthenticated_writes_are_throttled_per_client_address(make_client):
    one = make_client(small_policy(), client=("203.0.113.7", 5000))
    other = make_client(small_policy(), client=("203.0.113.8", 5000))  # a separate app, so it shares nothing
    statuses = [one.post("/write").status_code for _ in range(6)]
    assert statuses == [200] * 5 + [429]
    assert other.post("/write").headers["X-RateLimit-Remaining"] == "4"


def test_an_anonymous_429_says_who_is_limited(make_client):
    client = make_client(small_policy(anonymous_limit=2), client=("198.51.100.1", 1111))
    assert client.post("/write").headers["X-RateLimit-Remaining"] == "1"
    client.post("/write")
    refused = client.post("/write")
    assert refused.status_code == 429
    body = refused.json()
    assert body["detail"].startswith("Unauthenticated clients can write 2 times a day")
    assert body["new_account"] is False


@pytest.mark.parametrize(
    "authorization",
    ["Bearer not-a-jwt", "Bearer", "Basic dXNlcjpwYXNz", "garbage"],
)
def test_a_bad_credential_is_an_anonymous_write_not_a_free_pass(make_client, authorization):
    client = make_client(small_policy())
    statuses = [client.post("/write", headers={"Authorization": authorization}).status_code for _ in range(6)]
    assert statuses == [200] * 5 + [429]


def test_an_expired_token_is_an_anonymous_write(make_client):
    expired = security.issue_access_token(ALICE, 1, now=datetime.now(timezone.utc) - timedelta(hours=1))
    client = make_client(small_policy())
    response = client.post("/write", headers={"Authorization": f"Bearer {expired}"})
    assert response.headers["X-RateLimit-Limit"] == "5"  # the anonymous limit, not ALICE's


# --- headers on every write ---------------------------------------------------


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_every_write_method_is_counted_and_annotated(make_client, calls, method):
    client = make_client(small_policy())
    response = getattr(client, method)("/write", headers=auth())
    assert response.status_code == 200
    assert response.headers["X-RateLimit-Remaining"] == "2"
    assert response.headers["X-RateLimit-Limit"] == "3"
    assert calls == [method.upper()]


def test_the_remaining_count_is_shared_across_write_methods(make_client):
    client = make_client(small_policy())
    headers = auth()
    remaining = [
        client.post("/write", headers=headers).headers["X-RateLimit-Remaining"],
        client.put("/write", headers=headers).headers["X-RateLimit-Remaining"],
        client.delete("/write", headers=headers).headers["X-RateLimit-Remaining"],
    ]
    assert remaining == ["2", "1", "0"]


def test_a_write_the_route_rejects_still_carries_the_header_and_counts(make_client):
    client = make_client(small_policy())
    response = client.post("/conflict", headers=auth())
    assert response.status_code == 409
    assert response.headers["X-RateLimit-Remaining"] == "3"


def test_a_write_to_an_unknown_path_or_method_still_carries_the_header(make_client):
    client = make_client(small_policy())
    missing = client.post("/nowhere", headers=auth())
    wrong_method = client.put("/conflict", headers=auth())
    assert (missing.status_code, wrong_method.status_code) == (404, 405)
    assert missing.headers["X-RateLimit-Remaining"] == "3"
    assert wrong_method.headers["X-RateLimit-Remaining"] == "3"


def test_a_validation_failure_still_carries_the_header(make_client):
    client = make_client(small_policy())

    @client.app.post("/typed")  # routes are looked up per request, so adding one now is fine
    def typed(count: int) -> dict:
        return {"count": count}

    response = client.post("/typed?count=nope", headers=auth())
    assert response.status_code == 422
    assert response.headers["X-RateLimit-Remaining"] == "3"


def test_an_unhandled_error_is_a_500_problem_with_the_header_and_is_still_raised(make_client):
    client = make_client(small_policy(), raise_server_exceptions=False)
    response = client.post("/boom", headers=auth())
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["X-RateLimit-Remaining"] == "3"
    assert response.json()["status"] == 500

    strict = make_client(small_policy())  # the default client re-raises server errors
    with pytest.raises(RuntimeError, match="kaboom"):
        strict.post("/boom", headers=auth())


def test_an_unhandled_error_uses_the_apps_own_handler_when_it_has_one(make_client):
    from starlette.responses import PlainTextResponse

    client = make_client(small_policy(), raise_server_exceptions=False)

    async def teapot(request, exc):
        return PlainTextResponse("custom", status_code=500)

    client.app.add_exception_handler(Exception, teapot)
    response = client.post("/boom", headers=auth())
    assert (response.status_code, response.text) == (500, "custom")
    assert response.headers["X-RateLimit-Remaining"] == "3"


def test_reads_are_neither_counted_nor_annotated(make_client, calls):
    client = make_client(small_policy())
    headers = auth()
    for _ in range(10):
        response = client.get("/read", headers=headers)
        assert response.status_code == 200
        assert "X-RateLimit-Remaining" not in response.headers
        assert "X-RateLimit-Limit" not in response.headers
    assert client.head("/read", headers=headers).status_code in (200, 405)
    assert client.options("/read", headers=headers).status_code in (200, 405)
    assert client.post("/write", headers=headers).headers["X-RateLimit-Remaining"] == "2"
    assert calls.count("GET") == 10


def test_a_throttled_account_can_still_read(make_client):
    client = make_client(small_policy())
    headers = auth()
    for _ in range(4):
        client.post("/write", headers=headers)
    assert client.post("/write", headers=headers).status_code == 429
    assert client.get("/read", headers=headers).status_code == 200


def test_healthz_is_not_affected_by_the_throttle():
    app = FastAPI()

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    install_write_throttle(app)
    response = TestClient(app).get("/healthz")
    assert response.status_code == 200
    assert "X-RateLimit-Remaining" not in response.headers


# --- account age from the accounts table --------------------------------------


@pytest.fixture
def accounts_engine():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE accounts (did TEXT PRIMARY KEY, tier INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL)")
        )
    yield engine
    engine.dispose()


def _insert_account(engine, did: str, created_at) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO accounts (did, tier, created_at) VALUES (:did, 1, :created_at)"),
            {"did": did, "created_at": created_at},
        )


def test_account_age_is_read_from_the_accounts_table(accounts_engine):
    _insert_account(accounts_engine, ALICE, "2025-01-02 03:04:05.000000")  # how SQLite stores a naive UTC datetime
    _insert_account(accounts_engine, BOB, "2025-01-02T03:04:05+02:00")
    lookup = AccountAgeLookup(accounts_engine)
    assert lookup(ALICE) == datetime(2025, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert lookup(BOB) == datetime(2025, 1, 2, 1, 4, 5, tzinfo=timezone.utc)
    assert lookup("did:key:unknown") is None


def test_an_unreadable_timestamp_or_missing_table_means_unknown_age():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    assert AccountAgeLookup(engine)(ALICE) is None  # there is no accounts table at all
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE accounts (did TEXT PRIMARY KEY, tier INTEGER, created_at TEXT)"))
        conn.execute(text("INSERT INTO accounts VALUES (:did, 1, 'last tuesday')"), {"did": ALICE})
    assert AccountAgeLookup(engine)(ALICE) is None
    engine.dispose()


def test_found_accounts_are_cached_but_misses_are_not(accounts_engine):
    lookup = AccountAgeLookup(accounts_engine)
    assert lookup(ALICE) is None
    _insert_account(accounts_engine, ALICE, "2025-01-02 03:04:05")  # created after the first (new-account) request
    assert lookup(ALICE) is not None
    with accounts_engine.begin() as conn:
        conn.execute(text("DELETE FROM accounts"))
    assert lookup(ALICE) is not None  # served from the cache


def test_the_default_lookup_throttles_by_the_real_accounts_table(accounts_engine, clock):
    old = (clock.dt - timedelta(days=365)).strftime("%Y-%m-%d %H:%M:%S.%f")
    young = (clock.dt - timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S.%f")
    _insert_account(accounts_engine, ALICE, old)
    _insert_account(accounts_engine, BOB, young)

    app = FastAPI()

    @app.post("/write")
    def create() -> dict:
        return {"ok": True}

    install_write_throttle(
        app,
        policy=small_policy(),
        account_created_at=AccountAgeLookup(accounts_engine),
        clock=clock,
    )
    client = TestClient(app)

    alice = [client.post("/write", headers=auth(ALICE, 1)).status_code for _ in range(5)]
    bob = [client.post("/write", headers=auth(BOB, 1)).status_code for _ in range(5)]
    assert alice == [200, 200, 200, 200, 429]  # tier 1 allows 4
    assert bob == [200, 200, 200, 429, 429]  # a 3-day-old account gets 3


def test_the_default_lookup_uses_the_app_database_and_fails_safe(clock):
    """With no accounts table in the app database the caller is simply a new account."""
    app = FastAPI()

    @app.post("/write")
    def create() -> dict:
        return {"ok": True}

    install_write_throttle(app, clock=clock)  # real AccountAgeLookup over app.db.engine
    response = TestClient(app).post("/write", headers=auth(f"did:key:z6Mk-no-such-account-{id(app)}", 4))
    assert response.status_code == 200
    assert response.headers["X-RateLimit-Limit"] == str(NEW_ACCOUNT_LIMIT)
    assert response.headers["X-RateLimit-Remaining"] == str(NEW_ACCOUNT_LIMIT - 1)
