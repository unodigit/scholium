"""``python -m app.smoke``: what ``npm run stack:smoke`` runs inside the api container.

The S3 store is moto, and a thread that drains the real ``jobs`` table stands in
for the worker container, so nothing here needs a network or a container.  The
settings are patched the way compose sets them for the api: ``STORAGE_BACKEND=s3``
and ``JOBS_MODE=external``.
"""

from __future__ import annotations

import io
import subprocess
import sys
import threading

import boto3
import pytest
from moto import mock_aws

from app import db, jobs, smoke
from app.modules.system import PING_JOB_KIND
from app.settings import settings
from app.storage import _s3_store

BUCKET = "scholium-smoke-test"
REGION = "us-east-1"


@pytest.fixture(autouse=True)
def clean_jobs():
    """An empty jobs table around every test."""
    jobs._ensure_table()

    def wipe() -> None:
        with db.SessionLocal() as session:
            session.query(jobs.Job).delete()
            session.commit()

    wipe()
    yield
    wipe()


@pytest.fixture
def bucket(monkeypatch):
    """A mocked S3 service with the bucket created, and the settings pointing at it."""
    _s3_store.cache_clear()
    with mock_aws():
        client = boto3.client(
            "s3", region_name=REGION, aws_access_key_id="admin", aws_secret_access_key="admin-secret"
        )
        client.create_bucket(Bucket=BUCKET)
        for name, value in (
            ("STORAGE_BACKEND", "s3"),
            ("S3_BUCKET", BUCKET),
            ("S3_ENDPOINT_URL", ""),
            ("S3_REGION", REGION),
            ("S3_ACCESS_KEY_ID", "test-access-key-id"),
            ("S3_SECRET_ACCESS_KEY", "test-secret-access-key-0123456789"),
            ("S3_FORCE_PATH_STYLE", 0),
        ):
            monkeypatch.setattr(settings, name, value)
        yield client
        _s3_store.cache_clear()


@pytest.fixture
def external_jobs(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_MODE", "external")


def keys_in(client) -> list[str]:
    return [item["Key"] for item in client.list_objects_v2(Bucket=BUCKET).get("Contents", [])]


class Worker:
    """Drains the jobs table on its own thread, as the worker container does."""

    def __enter__(self):
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.is_set():
            jobs.run_pending()
            self._stop.wait(0.02)

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(5)


def job_rows() -> list[tuple[str, str]]:
    with db.SessionLocal() as session:
        return [(row.kind, row.status) for row in session.query(jobs.Job).all()]


# -- the S3 blob step ----------------------------------------------------------


def test_the_blob_step_round_trips_through_the_s3_store_and_cleans_up(bucket):
    detail = smoke.check_object_store()

    assert "16384 bytes" in detail and BUCKET in detail
    assert keys_in(bucket) == []


def test_the_blob_step_writes_under_its_own_prefix(bucket, monkeypatch):
    seen: list[str] = []
    store = smoke.get_object_store()
    original = type(store).put_stream

    def spy(self, key, stream):
        seen.append(key)
        return original(self, key, stream)

    monkeypatch.setattr(type(store), "put_stream", spy)

    smoke.check_object_store()

    assert len(seen) == 1 and seen[0].startswith(smoke.BLOB_PREFIX)


def test_the_blob_step_refuses_a_process_that_is_not_on_the_s3_backend(monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "fs")

    with pytest.raises(smoke.SmokeError, match="STORAGE_BACKEND is 'fs', not 's3'"):
        smoke.check_object_store()


def test_the_blob_step_fails_on_a_blob_that_does_not_read_back_the_same(bucket, monkeypatch):
    store = smoke.get_object_store()

    class Corrupting:
        def __getattr__(self, name):
            return getattr(store, name)

        def open(self, key, **kwargs):
            return io.BytesIO(b"not what was written")

    monkeypatch.setattr(smoke, "get_object_store", lambda: Corrupting())

    with pytest.raises(smoke.SmokeError, match="differ from the 16384 bytes written"):
        smoke.check_object_store()
    assert keys_in(bucket) == []  # the failed run does not leave its blob behind


# -- the worker job step -------------------------------------------------------


def test_the_job_step_passes_when_the_worker_finishes_the_ping(external_jobs):
    with Worker():
        detail = smoke.check_worker_job(timeout=10)

    assert "marked done by the worker" in detail
    assert job_rows() == []  # the finished ping's row is removed


def test_the_job_step_times_out_naming_the_missing_worker(external_jobs):
    with pytest.raises(smoke.SmokeError, match=r"still 'queued' after 0\.3s.*is the worker running"):
        smoke.check_worker_job(timeout=0.3)

    # With no worker running a pass would have to come from this process, and the
    # row shows it did not: a system.ping is left queued for a worker to find.
    assert job_rows() == [("system.ping", jobs.STATUS_QUEUED)]


@pytest.mark.parametrize("mode", ["eager", "thread"])
def test_the_job_step_refuses_a_mode_that_would_run_the_job_in_process(monkeypatch, mode):
    monkeypatch.setattr(settings, "JOBS_MODE", mode)

    with pytest.raises(smoke.SmokeError, match=f"JOBS_MODE is '{mode}', not 'external'"):
        smoke.check_worker_job(timeout=0.2)

    assert job_rows() == []


def test_the_job_step_reports_a_ping_the_worker_gave_up_on(external_jobs, monkeypatch):
    def broken(payload):
        raise RuntimeError("handler exploded")

    monkeypatch.setitem(jobs._handlers, PING_JOB_KIND, broken)
    monkeypatch.setattr(jobs, "MAX_ATTEMPTS", 1)

    with Worker():
        with pytest.raises(smoke.SmokeError, match=r"marked failed after 1 attempt"):
            smoke.check_worker_job(timeout=10)


# -- the command ---------------------------------------------------------------


def test_main_passes_when_both_steps_pass(bucket, external_jobs, capsys):
    with Worker():
        status = smoke.main(["--job-timeout", "10"])

    out, err = capsys.readouterr()
    assert status == 0
    assert err == ""
    assert "smoke: s3 blob round trip: ok" in out
    assert "smoke: worker ping job: ok" in out
    assert out.splitlines()[-1].startswith(smoke.SUCCESS_PREFIX)


def test_main_names_the_first_failed_step_and_runs_nothing_after_it(monkeypatch, external_jobs, capsys):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "fs")

    status = smoke.main([])

    out, err = capsys.readouterr()
    assert status == 1
    assert err.startswith("smoke: FAILED at step 's3 blob round trip': ")
    assert smoke.SUCCESS_PREFIX not in out
    assert "worker ping job" not in out  # the second step never started
    assert job_rows() == []


def test_main_names_the_job_step_when_the_blob_step_passed(bucket, external_jobs, capsys):
    status = smoke.main(["--job-timeout", "0.3"])  # no worker is running

    out, err = capsys.readouterr()
    assert status == 1
    assert "smoke: s3 blob round trip: ok" in out
    assert err.startswith("smoke: FAILED at step 'worker ping job': ")
    assert smoke.SUCCESS_PREFIX not in out


def test_main_reports_an_unreachable_store_as_a_failed_step_not_a_traceback(bucket, external_jobs, monkeypatch, capsys):
    monkeypatch.setattr(settings, "S3_BUCKET", "a-bucket-that-does-not-exist")

    status = smoke.main([])

    err = capsys.readouterr().err
    assert status == 1
    assert err.startswith("smoke: FAILED at step 's3 blob round trip': ")
    assert "Traceback" not in err


@pytest.mark.parametrize("value", ["0", "-5", "soon"])
def test_the_job_timeout_must_be_a_positive_number(value, capsys):
    with pytest.raises(SystemExit) as raised:
        smoke.main(["--job-timeout", value])

    assert raised.value.code == 2
    assert "--job-timeout" in capsys.readouterr().err


def test_python_dash_m_app_smoke_exits_non_zero_naming_the_failed_step():
    # The default test environment is SQLite, the filesystem store and eager
    # jobs: not a stack, so the first step must fail and say so.
    result = subprocess.run(
        [sys.executable, "-m", "app.smoke", "--job-timeout", "1"],
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 1, result.stdout + result.stderr
    assert "smoke: FAILED at step 's3 blob round trip'" in result.stderr


# -- the system module ---------------------------------------------------------


def test_the_module_loader_scan_registers_the_ping_handler():
    # A fresh interpreter, as the worker is: it knows only what the scan imports.
    script = (
        "import importlib, pkgutil, app.modules as m;"
        "[importlib.import_module(i.name) for i in pkgutil.iter_modules(m.__path__, 'app.modules.')];"
        "from app import jobs;"
        "assert 'system.ping' in jobs._handlers, sorted(jobs._handlers)"
    )
    result = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, timeout=120)

    assert result.returncode == 0, result.stderr


def test_the_ping_handler_marks_the_job_done(external_jobs):
    job_id = jobs.enqueue(PING_JOB_KIND, {})

    assert jobs.run_pending() == 1

    with db.SessionLocal() as session:
        assert session.get(jobs.Job, job_id).status == jobs.STATUS_DONE
