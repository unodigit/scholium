"""``/healthz`` is liveness; ``/readyz`` is readiness (database and object store)."""

import threading
import time

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws
from sqlalchemy import create_engine

from app import main
from app.main import app
from app.settings import settings
from app.storage import ObjectStoreError, _s3_store


def test_healthz_returns_200():
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200


# -- fixtures ---------------------------------------------------------------------------------------

BUCKET = "scholium-readyz"
REGION = "test-region-1"


@pytest.fixture
def broken_database(monkeypatch, tmp_path):
    """The live engine replaced by one that cannot open its database."""
    unreachable = create_engine(f"sqlite:///{tmp_path / 'missing-directory' / 'scholium.db'}")
    monkeypatch.setattr(main.db, "engine", unreachable)


@pytest.fixture
def broken_object_store(monkeypatch):
    """An object store that refuses every call, with a secret in its error text."""

    def refuse():
        raise ObjectStoreError("could not list: endpoint https://user:hunter2@objects.internal")

    monkeypatch.setattr(main, "get_object_store", refuse)


@pytest.fixture
def s3_bucket(monkeypatch):
    """``STORAGE_BACKEND=s3`` pointed at a mocked bucket that exists."""
    _s3_store.cache_clear()
    for name, value in (
        ("STORAGE_BACKEND", "s3"),
        ("S3_BUCKET", BUCKET),
        ("S3_ENDPOINT_URL", ""),
        ("S3_REGION", REGION),
        ("S3_ACCESS_KEY_ID", "test-access-key-id"),
        ("S3_SECRET_ACCESS_KEY", "test-SECRET-access-key-0123456789"),
        ("S3_FORCE_PATH_STYLE", 0),
    ):
        monkeypatch.setattr(settings, name, value)
    with mock_aws():
        yield boto3.client(
            "s3", region_name=REGION, aws_access_key_id="admin", aws_secret_access_key="admin-secret"
        )
    _s3_store.cache_clear()


def readyz():
    return TestClient(app).get("/readyz")


# -- /readyz: ready ---------------------------------------------------------------------------------


def test_readyz_is_200_when_the_database_and_the_object_store_answer():
    response = readyz()

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {"database": "ok", "object_store": "ok"},
    }
    assert response.headers["cache-control"] == "no-store"


def test_readyz_needs_no_credentials():
    # Probes (compose, a load balancer) carry no token and no cookies.
    assert TestClient(app).get("/readyz", headers={}).status_code == 200


def test_readyz_is_200_when_the_s3_bucket_exists(s3_bucket):
    s3_bucket.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})

    response = readyz()

    assert response.status_code == 200
    assert response.json()["checks"] == {"database": "ok", "object_store": "ok"}


def test_readyz_writes_nothing_to_the_object_store(s3_bucket):
    s3_bucket.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})

    assert readyz().status_code == 200

    assert s3_bucket.list_objects_v2(Bucket=BUCKET).get("KeyCount", 0) == 0


# -- /readyz: not ready -----------------------------------------------------------------------------


def test_readyz_is_503_naming_the_database_when_it_does_not_answer(broken_database):
    response = readyz()

    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {"database": "unavailable", "object_store": "ok"},
        "failing": ["database"],
    }
    assert response.headers["cache-control"] == "no-store"


def test_readyz_is_503_naming_the_object_store_when_it_does_not_answer(broken_object_store):
    response = readyz()

    assert response.status_code == 503
    assert response.json() == {
        "status": "unavailable",
        "checks": {"database": "ok", "object_store": "unavailable"},
        "failing": ["object_store"],
    }


def test_readyz_is_503_naming_a_missing_s3_bucket(s3_bucket):
    # The bucket was never created: a reachable endpoint is not a usable store.
    response = readyz()

    assert response.status_code == 503
    assert response.json()["failing"] == ["object_store"]


def test_readyz_names_every_failing_dependency(broken_database, broken_object_store):
    response = readyz()

    assert response.status_code == 503
    assert response.json()["failing"] == ["database", "object_store"]
    assert response.json()["checks"] == {"database": "unavailable", "object_store": "unavailable"}


def test_readyz_is_503_when_the_object_store_is_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "s3")
    monkeypatch.setattr(settings, "S3_BUCKET", "")

    response = readyz()

    assert response.status_code == 503
    assert response.json()["failing"] == ["object_store"]


def test_readyz_does_not_leak_the_reason_a_dependency_failed(broken_object_store, broken_database):
    text = readyz().text

    assert "hunter2" not in text
    assert "objects.internal" not in text
    assert "missing-directory" not in text


def test_readyz_logs_why_a_dependency_failed(broken_object_store, caplog):
    with caplog.at_level("WARNING", logger="app.main"):
        readyz()

    assert any("object_store" in r.getMessage() and "ObjectStoreError" in r.getMessage() for r in caplog.records)


def test_readyz_gives_up_on_a_dependency_that_hangs(monkeypatch):
    release = threading.Event()

    class Hanging:
        def list(self, prefix=""):
            release.wait(30)
            return iter(())

    monkeypatch.setattr(main, "get_object_store", Hanging)
    monkeypatch.setattr(main, "READYZ_TIMEOUT_SECONDS", 0.3)
    try:
        started = time.monotonic()
        response = readyz()
        elapsed = time.monotonic() - started
    finally:
        release.set()

    assert response.status_code == 503
    assert response.json()["failing"] == ["object_store"]
    assert response.json()["checks"]["database"] == "ok"
    assert elapsed < 5, "the probe must answer at its deadline, not wait for the hung dependency"


def test_the_checks_share_one_deadline(monkeypatch):
    # Two hung dependencies cost one timeout, not two: the checks run together.
    release = threading.Event()
    monkeypatch.setattr(
        main,
        "_readiness_checks",
        lambda: (("database", lambda: release.wait(30)), ("object_store", lambda: release.wait(30))),
    )
    monkeypatch.setattr(main, "READYZ_TIMEOUT_SECONDS", 1.0)
    try:
        started = time.monotonic()
        response = readyz()
        elapsed = time.monotonic() - started
    finally:
        release.set()

    assert response.json()["failing"] == ["database", "object_store"]
    # Run one after the other the two would take at least 2.0s.
    assert elapsed < 1.9


# -- /healthz stays a liveness check ----------------------------------------------------------------


def test_healthz_does_not_depend_on_the_database_or_the_object_store(
    broken_database, broken_object_store
):
    client = TestClient(app)

    assert client.get("/readyz").status_code == 503
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_startup_initializes_s3_before_the_first_readiness_request(s3_bucket, monkeypatch):
    s3_bucket.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    monkeypatch.setattr(settings, "JOBS_MODE", "eager")

    with TestClient(app) as client:
        assert _s3_store.cache_info().currsize == 1
        assert client.get("/readyz").status_code == 200
        assert _s3_store.cache_info().misses == 1
