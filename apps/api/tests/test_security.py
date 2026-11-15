"""Tests for access tokens and the require_tier dependency (app.security)."""

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import PlainTextResponse

from app import security
from app.main import create_app
from app.security import Principal, Tier, decode_access_token, issue_access_token, require_tier
from app.settings import settings

# 64+ bytes so that even HS512 accepts it without PyJWT warning about key length.
SECRET = "test-secret-" + "x" * 64
DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
TIER_NAMES = ["Reader", "Member", "Author", "Reviewer", "Moderator"]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


def _forge(**overrides) -> str:
    """A validly signed token whose claims are tweaked; a None value drops the claim."""
    now = _utcnow()
    claims = {
        "sub": DID,
        "tier": 1,
        "aud": security.TOKEN_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=15),
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def jwt_secret(monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", SECRET)


def _add_routes(app: FastAPI) -> FastAPI:
    app.state.ran = []

    def add_guarded_route(n: int) -> None:
        @app.get(f"/tier/{n}")
        def guarded(principal: Principal = Depends(require_tier(n))) -> dict:
            app.state.ran.append(n)
            return {"did": principal.did, "tier": principal.tier}

    for n in range(5):
        add_guarded_route(n)

    @app.get("/via-dependencies", dependencies=[Depends(require_tier(Tier.REVIEWER))])
    def via_dependencies() -> dict:
        app.state.ran.append("via-dependencies")
        return {"ok": True}

    @app.get("/whoami")
    def whoami(principal: Principal = Depends(security.get_current_principal)) -> dict:
        return {"did": principal.did, "tier": principal.tier}

    return app


@pytest.fixture
def app() -> FastAPI:
    # A stock app with no exception handlers registered: protected routes must
    # produce problem details with no help from the app.
    return _add_routes(FastAPI())


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


# --- issuing tokens ---------------------------------------------------------


def test_access_token_lives_for_15_minutes():
    assert security.ACCESS_TOKEN_TTL == timedelta(minutes=15)
    claims = _claims(issue_access_token(DID, 1))
    assert claims["exp"] - claims["iat"] == 15 * 60


def test_access_token_claims():
    claims = _claims(issue_access_token(DID, 3))
    assert claims["sub"] == DID
    assert claims["tier"] == 3
    assert claims["aud"] == security.TOKEN_AUDIENCE
    assert claims["jti"]


def test_each_token_gets_its_own_id():
    assert _claims(issue_access_token(DID, 1))["jti"] != _claims(issue_access_token(DID, 1))["jti"]


def test_token_is_timed_from_the_now_argument():
    at = datetime(2030, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    claims = _claims(issue_access_token(DID, 1, now=at))
    assert claims["iat"] == int(at.timestamp())
    assert claims["exp"] == int((at + timedelta(minutes=15)).timestamp())


@pytest.mark.parametrize("tier", range(5))
def test_token_round_trips_to_a_principal(tier):
    assert decode_access_token(issue_access_token(DID, tier)) == Principal(did=DID, tier=tier)


def test_tier_enum_members_are_accepted_and_stored_as_plain_ints():
    token = issue_access_token(DID, Tier.MODERATOR)
    assert _claims(token)["tier"] == 4
    assert type(decode_access_token(token).tier) is int


@pytest.mark.parametrize("tier", [-1, 5, 99, True, False, "2", 2.0, None])
def test_issue_rejects_a_tier_outside_0_to_4(tier):
    with pytest.raises(ValueError, match="tier"):
        issue_access_token(DID, tier)


@pytest.mark.parametrize("did", ["", None, 7])
def test_issue_rejects_a_missing_did(did):
    with pytest.raises(ValueError, match="did"):
        issue_access_token(did, 1)


# --- reading tokens ---------------------------------------------------------


def test_token_issued_just_under_15_minutes_ago_is_valid():
    token = issue_access_token(DID, 1, now=_utcnow() - timedelta(minutes=14, seconds=30))
    assert decode_access_token(token).did == DID


def test_token_issued_over_15_minutes_ago_is_expired():
    token = issue_access_token(DID, 1, now=_utcnow() - timedelta(minutes=15, seconds=5))
    with pytest.raises(security.InvalidAccessToken, match="expired"):
        decode_access_token(token)


def test_token_signed_with_another_secret_is_rejected():
    token = jwt.encode(
        {"sub": DID, "tier": 4, "aud": security.TOKEN_AUDIENCE, "iat": _utcnow(), "exp": _utcnow() + timedelta(minutes=15)},
        "some-other-secret-that-is-also-longer-than-32-bytes",
        algorithm="HS256",
    )
    with pytest.raises(security.InvalidAccessToken):
        decode_access_token(token)


def test_signing_secret_is_read_when_used_not_at_import(monkeypatch):
    token = issue_access_token(DID, 1)
    monkeypatch.setattr(settings, "JWT_SECRET", "rotated-secret-that-is-also-longer-than-32-bytes")
    with pytest.raises(security.InvalidAccessToken):
        decode_access_token(token)


def test_unsigned_token_is_rejected():
    now = _utcnow()
    token = jwt.encode(
        {"sub": DID, "tier": 4, "aud": security.TOKEN_AUDIENCE, "iat": now, "exp": now + timedelta(minutes=15)},
        None,
        algorithm="none",
    )
    with pytest.raises(security.InvalidAccessToken):
        decode_access_token(token)


def test_token_signed_with_another_algorithm_is_rejected():
    now = _utcnow()
    token = jwt.encode(
        {"sub": DID, "tier": 4, "aud": security.TOKEN_AUDIENCE, "iat": now, "exp": now + timedelta(minutes=15)},
        SECRET,
        algorithm="HS512",
    )
    with pytest.raises(security.InvalidAccessToken):
        decode_access_token(token)


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"aud": "scholium:email-verify"}, id="other-audience"),
        pytest.param({"aud": None}, id="no-audience"),
        pytest.param({"exp": None}, id="no-expiry"),
        pytest.param({"iat": None}, id="no-issued-at"),
        pytest.param({"sub": None}, id="no-subject"),
        pytest.param({"tier": None}, id="no-tier"),
        pytest.param({"tier": 5}, id="tier-too-high"),
        pytest.param({"tier": -1}, id="tier-negative"),
        pytest.param({"tier": "3"}, id="tier-is-a-string"),
        pytest.param({"tier": True}, id="tier-is-a-bool"),
    ],
)
def test_validly_signed_token_with_bad_claims_is_rejected(overrides):
    with pytest.raises(security.InvalidAccessToken):
        decode_access_token(_forge(**overrides))


@pytest.mark.parametrize("token", ["", "garbage", "a.b.c", "Bearer abc"])
def test_malformed_token_is_rejected(token):
    with pytest.raises(security.InvalidAccessToken):
        decode_access_token(token)


# --- require_tier -----------------------------------------------------------


@pytest.mark.parametrize("required", range(5))
@pytest.mark.parametrize("caller", range(5))
def test_require_tier_admits_the_required_tier_and_above(client, app, required, caller):
    response = client.get(f"/tier/{required}", headers=_bearer(issue_access_token(DID, caller)))

    if caller >= required:
        assert response.status_code == 200
        assert response.json() == {"did": DID, "tier": caller}
        assert app.state.ran == [required]
    else:
        assert response.status_code == 403
        assert app.state.ran == [], "the handler must not run for a caller below the tier"


def test_403_is_problem_details_naming_both_tiers(client):
    response = client.get("/tier/3", headers=_bearer(issue_access_token(DID, 1)))
    assert response.status_code == 403
    assert response.headers["content-type"] == "application/problem+json"

    body = response.json()
    assert body["type"] == security.INSUFFICIENT_TIER_TYPE
    assert body["title"] == "Forbidden"
    assert body["status"] == 403
    assert body["instance"] == "/tier/3"
    assert body["required_tier"] == 3
    assert body["caller_tier"] == 1
    assert "tier 3 (Reviewer)" in body["detail"]
    assert "tier 1 (Member)" in body["detail"]


@pytest.mark.parametrize(
    "required,caller", [(r, c) for r in range(5) for c in range(5) if c < r]
)
def test_403_names_the_tiers_for_every_denied_pair(client, required, caller):
    response = client.get(f"/tier/{required}", headers=_bearer(issue_access_token(DID, caller)))

    body = response.json()
    assert (body["required_tier"], body["caller_tier"]) == (required, caller)
    assert f"tier {required} ({TIER_NAMES[required]})" in body["detail"]
    assert f"tier {caller} ({TIER_NAMES[caller]})" in body["detail"]


def test_require_tier_works_in_a_route_dependencies_list(client, app):
    low = client.get("/via-dependencies", headers=_bearer(issue_access_token(DID, 2)))
    assert low.status_code == 403
    assert low.json()["required_tier"] == 3
    assert app.state.ran == []

    ok = client.get("/via-dependencies", headers=_bearer(issue_access_token(DID, 3)))
    assert ok.status_code == 200
    assert app.state.ran == ["via-dependencies"]


def test_403_is_problem_details_on_the_real_app():
    # cq-3: the application itself, not just a bare FastAPI app, refuses with a reason.
    real = _add_routes(create_app())
    response = TestClient(real).get("/tier/2", headers=_bearer(issue_access_token(DID, 1)))

    assert response.status_code == 403
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert (body["required_tier"], body["caller_tier"]) == (2, 1)
    assert "tier 2 (Author)" in body["detail"] and "tier 1 (Member)" in body["detail"]


def test_install_problem_handlers_registers_the_same_rendering():
    wired = _add_routes(FastAPI())
    security.install_problem_handlers(wired)
    response = TestClient(wired).get("/tier/4", headers=_bearer(issue_access_token(DID, 2)))

    assert response.status_code == 403
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["required_tier"] == 4


def test_a_handler_the_app_registered_for_security_problems_is_not_overridden():
    custom = _add_routes(FastAPI())

    @custom.exception_handler(security.SecurityProblem)
    def own_handler(request: Request, exc: security.SecurityProblem):
        return PlainTextResponse("custom", status_code=exc.status_code)

    response = TestClient(custom).get("/tier/4", headers=_bearer(issue_access_token(DID, 2)))
    assert (response.status_code, response.text) == (403, "custom")


def test_403_still_names_both_tiers_when_the_scope_has_no_exception_handlers(monkeypatch):
    # If Starlette stopped exposing its handler dicts, the errors are still
    # HTTPExceptions: the generic handling must answer 403 with the tiers in detail.
    monkeypatch.setattr(security, "_ensure_problem_handler", lambda request: None)
    response = TestClient(_add_routes(FastAPI())).get("/tier/4", headers=_bearer(issue_access_token(DID, 2)))

    assert response.status_code == 403
    assert response.headers["content-type"] == "application/json"
    assert "tier 4 (Moderator)" in response.json()["detail"]
    assert "tier 2 (Author)" in response.json()["detail"]


def test_ensure_problem_handler_tolerates_a_scope_without_handler_dicts():
    security._ensure_problem_handler(Request({"type": "http", "headers": []}))  # must not raise


@pytest.mark.parametrize("n", [-1, 5, 100, True, "2", 2.0, None])
def test_require_tier_rejects_an_invalid_tier_at_declaration(n):
    with pytest.raises(ValueError, match="tier"):
        require_tier(n)


def test_require_tier_accepts_tier_enum_members():
    assert callable(require_tier(Tier.MODERATOR))


# --- authentication failures ------------------------------------------------


def test_missing_credentials_are_401_with_a_bearer_challenge(client, app):
    response = client.get("/tier/0")

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["www-authenticate"] == "Bearer"
    body = response.json()
    assert body["type"] == security.UNAUTHENTICATED_TYPE
    assert body["title"] == "Unauthorized"
    assert body["status"] == 401
    assert body["instance"] == "/tier/0"
    assert "required_tier" not in body
    assert app.state.ran == []


def test_invalid_token_is_401_naming_the_bearer_error(client):
    response = client.get("/tier/0", headers=_bearer("not-a-token"))

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["www-authenticate"] == 'Bearer error="invalid_token"'
    assert "invalid" in response.json()["detail"]


def test_expired_token_is_401(client, app):
    token = issue_access_token(DID, 4, now=_utcnow() - timedelta(minutes=16))
    response = client.get("/tier/0", headers=_bearer(token))

    assert response.status_code == 401
    assert "expired" in response.json()["detail"]
    assert app.state.ran == []


def test_a_non_bearer_scheme_is_401(client):
    response = client.get("/tier/0", headers={"Authorization": f"Basic {issue_access_token(DID, 4)}"})
    assert response.status_code == 401


def test_a_low_tier_caller_with_a_bad_token_is_401_not_403(client):
    # Authentication is checked before the tier, so a forged tier-4 claim is a 401.
    token = jwt.encode(
        {"sub": DID, "tier": 4, "aud": security.TOKEN_AUDIENCE, "iat": _utcnow(), "exp": _utcnow() + timedelta(minutes=15)},
        "some-other-secret-that-is-also-longer-than-32-bytes",
        algorithm="HS256",
    )
    assert client.get("/tier/4", headers=_bearer(token)).status_code == 401


def test_get_current_principal_returns_the_caller_for_any_tier(client):
    response = client.get("/whoami", headers=_bearer(issue_access_token(DID, 0)))
    assert response.status_code == 200
    assert response.json() == {"did": DID, "tier": 0}
