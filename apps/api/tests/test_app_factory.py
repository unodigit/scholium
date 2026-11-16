"""The application factory wires kernel middleware and refuses unsafe production config."""

import logging

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


def _safe_production_settings(tmp_path, monkeypatch) -> Settings:
    """A fully-configured production Settings, with every requirement satisfied."""
    node_key = tmp_path / "node.key"
    node_key.write_bytes(b"\x01" * 32)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    safe = Settings()
    safe.SCHOLIUM_ENV = "production"
    safe.JWT_SECRET = "x" * 48
    safe.ORCID_MOCK = 0
    safe.ARXIV_MOCK = 0
    safe.AI_PROVIDER = "ollama"
    safe.JOBS_EAGER = 0
    safe.WEB_ORIGINS = "https://scholium.example"
    safe.NEXT_PUBLIC_API_URL = "https://api.scholium.example"
    safe.COMMITTEE_PUBLIC_KEY = "ab" * 32
    safe.SMTP_URL = "smtp://mail.example.org:587"
    safe.ORCID_CLIENT_ID = "client-id"
    safe.ORCID_CLIENT_SECRET = "client-secret"
    safe.NODE_KEY_PATH = str(node_key)
    safe.REVIEW_UNIQUENESS_KEY = "r" * 48
    return safe


def test_production_accepts_safe_config(tmp_path, monkeypatch):
    _safe_production_settings(tmp_path, monkeypatch).validate_for_environment()


def test_production_refuses_every_missing_runtime_setting(tmp_path, monkeypatch):
    """Every unsafe/missing setting is reported in one RuntimeError."""
    unsafe = _safe_production_settings(tmp_path, monkeypatch)
    unsafe.COMMITTEE_PUBLIC_KEY = ""
    unsafe.SMTP_URL = ""
    unsafe.NODE_KEY_PATH = str(tmp_path / "missing.key")
    unsafe.ORCID_CLIENT_ID = ""
    unsafe.ORCID_CLIENT_SECRET = ""
    unsafe.AI_PROVIDER = "anthropic"
    unsafe.WEB_ORIGINS = "http://localhost:3000"
    unsafe.NEXT_PUBLIC_API_URL = "http://localhost:8000"
    unsafe.REVIEW_UNIQUENESS_KEY = ""

    with pytest.raises(RuntimeError) as err:
        unsafe.validate_for_environment()

    message = str(err.value)
    for name in (
        "COMMITTEE_PUBLIC_KEY",
        "SMTP_URL",
        "NODE_KEY_PATH",
        "ORCID_CLIENT_ID",
        "ORCID_CLIENT_SECRET",
        "ANTHROPIC_API_KEY",
        "WEB_ORIGINS",
        "NEXT_PUBLIC_API_URL",
        "REVIEW_UNIQUENESS_KEY",
    ):
        assert name in message, f"{name} not reported: {message}"


def test_production_refuses_short_review_uniqueness_key(tmp_path, monkeypatch):
    unsafe = _safe_production_settings(tmp_path, monkeypatch)
    unsafe.REVIEW_UNIQUENESS_KEY = "too-short"
    with pytest.raises(RuntimeError) as err:
        unsafe.validate_for_environment()
    assert "REVIEW_UNIQUENESS_KEY" in str(err.value)


def test_create_app_refuses_unsafe_production(monkeypatch, tmp_path):
    unsafe = _safe_production_settings(tmp_path, monkeypatch)
    for name in (
        "SCHOLIUM_ENV", "JWT_SECRET", "ORCID_MOCK", "ARXIV_MOCK", "AI_PROVIDER",
        "JOBS_EAGER", "WEB_ORIGINS", "NEXT_PUBLIC_API_URL", "COMMITTEE_PUBLIC_KEY",
        "SMTP_URL", "ORCID_CLIENT_ID", "ORCID_CLIENT_SECRET", "NODE_KEY_PATH",
        "REVIEW_UNIQUENESS_KEY",
    ):
        monkeypatch.setattr(settings, name, getattr(unsafe, name))
    monkeypatch.setattr(settings, "COMMITTEE_PUBLIC_KEY", "")
    with pytest.raises(RuntimeError) as err:
        main.create_app()
    assert "COMMITTEE_PUBLIC_KEY" in str(err.value)


def test_review_uniqueness_key_dev_default_is_derived_and_distinct(monkeypatch):
    monkeypatch.delenv("REVIEW_UNIQUENESS_KEY", raising=False)
    first = Settings()
    second = Settings()
    assert first.SCHOLIUM_ENV == "dev"
    assert len(first.REVIEW_UNIQUENESS_KEY) >= 32
    assert first.REVIEW_UNIQUENESS_KEY != first.JWT_SECRET
    assert first.REVIEW_UNIQUENESS_KEY == second.REVIEW_UNIQUENESS_KEY


def test_dev_outbox_never_logs_token_bearing_links(caplog):
    """The outbox logger must not put verification tokens in the log."""
    from app.modules.notifications.emailer import (
        build_email,
        clear_outbox,
        get_outbox,
        log_to_outbox,
    )

    token = "s3cr3t-verification-token"
    clear_outbox()
    try:
        with caplog.at_level(logging.INFO, logger="outbox"):
            email = build_email(
                "did:example:alice",
                "email.verification",
                {"email": "alice@example.org", "link": f"https://api.example/v1/verify?token={token}"},
            )
            log_to_outbox(email)

        assert "outbox email" in caplog.text
        assert token not in caplog.text
        # The body is still available from the in-process outbox.
        assert token in get_outbox()[-1]["body"]
    finally:
        clear_outbox()


def test_outbox_is_bounded():
    from app.modules.notifications.emailer import (
        OUTBOX_MAX_ENTRIES,
        build_email,
        clear_outbox,
        get_outbox,
        log_to_outbox,
    )

    clear_outbox()
    try:
        for index in range(OUTBOX_MAX_ENTRIES + 25):
            log_to_outbox(build_email(f"did:example:user{index}", "digest"))
        entries = get_outbox()
        assert len(entries) == OUTBOX_MAX_ENTRIES
        # Oldest entries are dropped; the newest are kept.
        assert entries[-1]["did"] == f"did:example:user{OUTBOX_MAX_ENTRIES + 24}"
    finally:
        clear_outbox()


def test_worker_starts_with_app_when_jobs_are_not_eager(monkeypatch):
    from app import jobs
    calls = []
    monkeypatch.setattr(settings, "JOBS_EAGER", 0)
    monkeypatch.setattr(jobs, "start_worker", lambda: calls.append("start"))
    monkeypatch.setattr(jobs, "stop_worker", lambda timeout=5.0: calls.append("stop"))
    with TestClient(main.create_app()):
        assert calls == ["start"]
    assert calls == ["start", "stop"]


def test_worker_not_started_in_eager_mode(monkeypatch):
    from app import jobs
    calls = []
    monkeypatch.setattr(settings, "JOBS_EAGER", 1)
    monkeypatch.setattr(jobs, "start_worker", lambda: calls.append("start"))
    with TestClient(main.create_app()):
        pass
    assert calls == []
