"""What the shipped entrypoint accepts and refuses at startup.

``python -m app`` validates its environment before it listens.  An operator who
mistypes a backend, or runs production with development defaults, must get a
process that exits with the reasons -- not one that quietly serves with the
wrong storage or jobs.  And the configuration the deployment guide describes for
production, written out in full, must actually boot.
"""

from __future__ import annotations

import os
import secrets
import sys
import time

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

from e2e_harness import Process, assert_problem, free_port


def run_to_exit(node, *, timeout: float = 90.0, **overrides) -> tuple[int, str]:
    """``python -m app`` on ``node`` with ``overrides``; wait for it to give up.  (exit status, log)"""
    process = Process(
        f"{node.name}:refused", [sys.executable, "-m", "app"], env=node.settings(**overrides),
        cwd=node.root, log_path=node.root / "logs" / f"refused-{secrets.token_hex(3)}.log",
    )
    try:
        code = process.wait_for_exit(timeout=timeout)
    finally:
        process.stop()
    return code, process.log


@pytest.fixture(scope="module")
def plain(nodes):
    node = nodes.make("plain", smtp=False)
    node.init_key()
    return node


# --- refusals ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides, expected",
    [
        (dict(JOBS_MODE="sometimes"), "Unknown JOBS_MODE"),
        (dict(STORAGE_BACKEND="floppy"), "Unknown STORAGE_BACKEND"),
        (dict(SCHOLIUM_ENV="staging"), "Unknown SCHOLIUM_ENV"),
    ],
    ids=["jobs-mode", "storage-backend", "environment"],
)
def test_a_mistyped_selector_stops_the_process(plain, overrides, expected):
    code, log = run_to_exit(plain, **overrides)
    assert code != 0, log
    assert expected in log, log
    assert "Application startup complete" not in log, log


def test_production_with_development_defaults_is_refused_with_every_reason(plain):
    code, log = run_to_exit(plain, SCHOLIUM_ENV="production", JWT_SECRET=None, ORCID_MOCK=None, ARXIV_MOCK=None,
                            AI_PROVIDER=None, JOBS_MODE=None)
    assert code != 0, log
    assert "Unsafe production configuration" in log, log
    for reason in ("JWT_SECRET", "REVIEW_UNIQUENESS_KEY", "COMMITTEE_PUBLIC_KEY", "SMTP_URL",
                   "ORCID_CLIENT_ID", "ORCID_MOCK", "ARXIV_MOCK", "AI_PROVIDER", "WEB_ORIGINS"):
        assert reason in log, f"{reason} missing from the refusal:\n{log}"
    assert "Application startup complete" not in log


# --- a complete production configuration ------------------------------------------


def production_env(smtp_url: str, database_url: "str | None", **extra) -> dict:
    """The environment of ``docs/deploy.md`` for production on PostgreSQL + S3, placeholders only."""
    return dict(
        SCHOLIUM_ENV="production",
        DATABASE_URL=database_url,
        STORAGE_BACKEND="s3",
        JWT_SECRET=secrets.token_hex(32),
        REVIEW_UNIQUENESS_KEY=secrets.token_hex(32),
        COMMITTEE_PUBLIC_KEY=secrets.token_hex(32),
        SMTP_URL=smtp_url,
        ORCID_CLIENT_ID="APP-E2EPLACEHOLDER",
        ORCID_CLIENT_SECRET="e2e-placeholder-secret",
        ORCID_MOCK="0",
        ARXIV_MOCK="0",
        AI_PROVIDER="ollama",
        JOBS_MODE="thread",
        SANDBOX_BACKEND="none",
        RATE_LIMIT_ENABLED="1",
        WEB_ORIGINS="https://scholium.example.org",
        NEXT_PUBLIC_API_URL="https://api.scholium.example.org",
        **extra,
    )


#: Production refuses SQLite; the boot test needs a real PostgreSQL server.
needs_postgres = pytest.mark.skipif(
    not (os.environ.get("TEST_DATABASE_URL") or "").strip(),
    reason="needs TEST_DATABASE_URL (PostgreSQL)",
)


@needs_postgres
def test_a_complete_production_configuration_boots(nodes):
    node = nodes.make("production", storage="s3", s3=nodes.s3())
    node.init_key()
    node.env.update(production_env(node.smtp.url, os.environ["TEST_DATABASE_URL"].strip()))
    node.start_api()
    with node.client() as http:
        assert http.get("/readyz").json()["status"] == "ok"
        # Production CORS lists exactly the configured web origin.
        preflight = http.options("/v1/records", headers={
            "Origin": "https://scholium.example.org", "Access-Control-Request-Method": "POST"})
        assert preflight.headers["access-control-allow-origin"] == "https://scholium.example.org"
        stranger = http.options("/v1/records", headers={
            "Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in stranger.headers
        assert_problem(http.get("/v1/me/dashboard"), 401)
        # No mock ORCID in production: its consent screen does not exist.
        mock = http.get("/v1/auth/orcid/mock/authorize",
                        params={"redirect_uri": "https://scholium.example.org/onboarding/orcid", "state": "x"})
        assert mock.status_code == 404, mock.text


@pytest.mark.parametrize(
    "defect, reason",
    [
        (dict(ORCID_MOCK="1"), "ORCID_MOCK must be 0"),
        (dict(AI_PROVIDER="fake"), "AI_PROVIDER must not be fake"),
        (dict(JOBS_MODE="eager"), "JOBS_EAGER must be 0"),
        (dict(RATE_LIMIT_ENABLED="0"), "RATE_LIMIT_ENABLED must be 1"),
        (dict(WEB_ORIGINS="http://localhost:3000"), "WEB_ORIGINS"),
        (dict(JWT_SECRET="change-me-in-production"), "JWT_SECRET"),
        (dict(STORAGE_BACKEND="s3", S3_BUCKET="", S3_ACCESS_KEY_ID="", S3_SECRET_ACCESS_KEY=""), "S3_BUCKET must be set"),
        (dict(SANDBOX_BACKEND="remote", SANDBOX_URL="", SANDBOX_TOKEN=""), "SANDBOX_URL must be set"),
    ],
    ids=["mock-orcid", "fake-ai", "eager-jobs", "no-throttle", "localhost-origin", "default-secret",
         "s3-without-bucket", "remote-sandbox-without-url"],
)
def test_one_unsafe_setting_is_enough_to_refuse_production(nodes, defect, reason):
    node = nodes.make("unsafe", storage="s3", s3=nodes.s3())
    node.init_key()
    database_url = (os.environ.get("TEST_DATABASE_URL") or "").strip() or None
    code, log = run_to_exit(node, **{**production_env(node.smtp.url, database_url), **defect})
    assert code != 0, log
    assert reason in log, log


# --- the node key from the environment --------------------------------------------


def test_the_node_key_can_be_supplied_through_the_environment(nodes):
    """No key file, no ``init-node``: ``NODE_KEY`` alone makes the node able to sign."""
    seed = SigningKey.generate()
    node = nodes.make("envkey", NODE_KEY=seed.encode().hex())
    assert not node.key_path.exists()
    node.start_api()
    with node.client() as http:
        head = http.get("/v1/sync/head")
        assert head.status_code == 200, head.text
        assert did_key_from_signing_key(seed) in head.text, head.text


# --- the object store going away ----------------------------------------------------


def test_an_unreachable_object_store_takes_the_node_out_of_rotation_without_restarting_it(nodes):
    """Liveness stays green (a restart would not fix S3); readiness names the dependency."""
    dead = free_port()  # nothing listens here
    node = nodes.make("s3down", storage="s3", s3=nodes.s3(),
                      S3_ENDPOINT_URL=f"http://127.0.0.1:{dead}")
    node.init_key()
    node.start_api()
    with node.client() as http:
        assert http.get("/healthz").status_code == 200
        started = time.monotonic()
        ready = http.get("/readyz")
        assert time.monotonic() - started < 10, "readiness must answer within its own deadline"
        assert ready.status_code == 503, ready.text
        assert ready.headers["cache-control"] == "no-store"
        assert ready.json() == {
            "status": "unavailable",
            "checks": {"database": "ok", "object_store": "unavailable"},
            "failing": ["object_store"],
        }
        # The rest of the API still answers: reads that need no blob are unaffected.
        assert http.get("/v1/papers").status_code == 200


def test_bad_credentials_are_reported_by_readiness_and_not_leaked(nodes):
    s3 = nodes.s3()
    node = nodes.make("s3creds", storage="s3", s3=s3, S3_SECRET_ACCESS_KEY="wrong", S3_ACCESS_KEY_ID="AKIAWRONG")
    node.init_key()
    node.start_api()
    with node.client() as http:
        ready = http.get("/readyz")
        assert ready.status_code == 503, ready.text
        assert ready.json()["failing"] == ["object_store"]
        assert "AKIAWRONG" not in ready.text and "wrong" not in ready.text.replace("unavailable", "")
        assert "AKIAWRONG" not in node.api.log, "a credential reached the log"
