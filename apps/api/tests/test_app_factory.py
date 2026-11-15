"""The application factory wires kernel middleware and refuses unsafe production config."""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.middleware import WriteThrottleMiddleware
from app.settings import Settings, settings


def test_cors_preflight_allows_configured_web_origin(client):
    response = client.options(
        "/v1/auth/challenge",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_cors_rejects_unknown_origin(client):
    response = client.options(
        "/v1/auth/challenge",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in response.headers


def test_write_throttle_installed_when_enabled(monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", 1)
    app = main.create_app()
    assert WriteThrottleMiddleware in [m.cls for m in app.user_middleware]
    response = TestClient(app).post("/v1/auth/challenge", json={})
    assert "x-ratelimit-remaining" in response.headers


def test_write_throttle_absent_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", 0)
    app = main.create_app()
    assert WriteThrottleMiddleware not in [m.cls for m in app.user_middleware]


def test_production_refuses_default_secret_and_mocks():
    unsafe = Settings()
    unsafe.SCHOLIUM_ENV = "production"
    unsafe.JWT_SECRET = "change-me-in-production"
    unsafe.ORCID_MOCK = 1
    with pytest.raises(RuntimeError) as err:
        unsafe.validate_for_environment()
    assert "JWT_SECRET" in str(err.value) and "ORCID_MOCK" in str(err.value)


def test_production_accepts_safe_config():
    safe = Settings()
    safe.SCHOLIUM_ENV = "production"
    safe.JWT_SECRET = "x" * 48
    safe.ORCID_MOCK = 0
    safe.ARXIV_MOCK = 0
    safe.AI_PROVIDER = "anthropic"
    safe.WEB_ORIGINS = "https://scholium.example"
    safe.validate_for_environment()
