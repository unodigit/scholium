"""Tests for the background job runner (app.jobs)."""

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from app import db, jobs
from app.settings import settings

FAR_FUTURE = datetime(2999, 1, 1)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _row(job_id: int) -> dict:
    with db.SessionLocal() as session:
        job = session.get(jobs.Job, job_id)
        assert job is not None, f"job {job_id} is not in the jobs table"
        return {
            "kind": job.kind,
            "payload": job.payload,
            "status": job.status,
            "run_after": job.run_after,
            "attempts": job.attempts,
        }


def _wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met within %.1fs" % timeout)


@pytest.fixture(autouse=True)
def clean_jobs():
    """Isolate every test: empty jobs table, no worker thread, no leftover handlers."""
    jobs.stop_worker()
    jobs._ensure_table()
    with db.SessionLocal() as session:
        session.query(jobs.Job).delete()
        session.commit()
    registered = []
    yield registered
    jobs.stop_worker()
    for kind in registered:
        jobs.unregister(kind)
    with db.SessionLocal() as session:
        session.query(jobs.Job).delete()
        session.commit()


@pytest.fixture
def handler(clean_jobs):
    """Register a handler for the duration of a test and return its call log."""

    def make(kind: str = "test.job", fn=None):
        calls = []

        def _handler(payload):
            calls.append((payload, threading.current_thread()))
            if fn is not None:
                fn(payload)

        jobs.register(kind, _handler)
        clean_jobs.append(kind)
        return calls

    return make


@pytest.fixture
def eager(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 1)


@pytest.fixture
def background(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 0)


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


def test_jobs_table_matches_spec_columns():
    cols = {c.name: c for c in jobs.Job.__table__.columns}
    assert list(cols) == ["id", "kind", "payload", "status", "run_after", "attempts"]
    assert cols["id"].primary_key
    assert not cols["kind"].nullable
    assert not cols["payload"].nullable
    assert not cols["status"].nullable
    assert cols["run_after"].nullable


def test_enqueue_persists_queued_job(handler, eager):
    handler()
    run_after = _utcnow() + timedelta(hours=1)

    job_id = jobs.enqueue("test.job", {"paper": 7, "tags": ["a", "b"], "nested": {"ok": True}}, run_after=run_after)

    assert isinstance(job_id, int)
    row = _row(job_id)
    assert row["kind"] == "test.job"
    assert row["payload"] == {"paper": 7, "tags": ["a", "b"], "nested": {"ok": True}}
    assert row["status"] == jobs.STATUS_QUEUED
    assert row["attempts"] == 0
    assert row["run_after"] == run_after


def test_enqueue_without_payload_stores_empty_object(handler, eager):
    calls = handler()
    job_id = jobs.enqueue("test.job")
    assert _row(job_id)["payload"] == {}
    assert calls[0][0] == {}


def test_enqueue_normalises_aware_run_after_to_naive_utc(handler, eager):
    handler()
    tz = timezone(timedelta(hours=5))
    aware = datetime.now(tz) + timedelta(hours=1)

    job_id = jobs.enqueue("test.job", run_after=aware)

    assert _row(job_id)["run_after"] == aware.astimezone(timezone.utc).replace(tzinfo=None)
    assert _row(job_id)["status"] == jobs.STATUS_QUEUED


def test_enqueue_unknown_kind_raises_and_persists_nothing(eager):
    with pytest.raises(jobs.UnknownJobKind):
        jobs.enqueue("nobody.handles.this", {"x": 1})
    with db.SessionLocal() as session:
        assert session.query(jobs.Job).count() == 0


def test_enqueue_creates_missing_table(handler, eager):
    handler()
    jobs.Job.__table__.drop(bind=db.engine)
    jobs._table_engine = None
    try:
        job_id = jobs.enqueue("test.job", {"n": 1})
        assert _row(job_id)["status"] == jobs.STATUS_DONE
    finally:
        jobs._ensure_table()


# --------------------------------------------------------------------------- #
# Eager mode (JOBS_EAGER=1): inline and synchronous
# --------------------------------------------------------------------------- #


def test_eager_runs_handler_inline_before_enqueue_returns(handler, eager):
    calls = handler()

    job_id = jobs.enqueue("test.job", {"n": 1})

    assert len(calls) == 1
    payload, thread = calls[0]
    assert payload == {"n": 1}
    assert thread is threading.current_thread()
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_DONE
    assert row["attempts"] == 1


def test_eager_does_not_start_a_worker_thread(handler, eager):
    handler()
    jobs.enqueue("test.job")
    assert jobs._worker is None
    assert not any(t.name == "job-worker" for t in threading.enumerate())


def test_eager_dispatches_to_the_handler_for_the_kind(handler, eager):
    a = handler("kind.a")
    b = handler("kind.b")

    jobs.enqueue("kind.b", {"which": "b"})

    assert a == []
    assert [p for p, _ in b] == [{"which": "b"}]


def test_eager_defers_jobs_with_future_run_after(handler, eager):
    calls = handler()
    job_id = jobs.enqueue("test.job", run_after=_utcnow() + timedelta(hours=1))

    assert calls == []
    assert _row(job_id)["status"] == jobs.STATUS_QUEUED
    assert jobs.run_pending() == 0
    assert calls == []

    assert jobs.run_pending(now=_utcnow() + timedelta(hours=2)) == 1
    assert len(calls) == 1
    assert _row(job_id)["status"] == jobs.STATUS_DONE


def test_eager_runs_jobs_with_past_run_after_immediately(handler, eager):
    calls = handler()
    job_id = jobs.enqueue("test.job", run_after=_utcnow() - timedelta(minutes=1))
    assert len(calls) == 1
    assert _row(job_id)["status"] == jobs.STATUS_DONE


def test_eager_handler_can_enqueue_another_job(handler, eager):
    inner = handler("inner")
    handler("outer", fn=lambda payload: jobs.enqueue("inner", {"from": payload["id"]}))

    outer_id = jobs.enqueue("outer", {"id": 5})

    assert [p for p, _ in inner] == [{"from": 5}]
    assert _row(outer_id)["status"] == jobs.STATUS_DONE


@pytest.mark.parametrize("env_value, inline", [("1", True), ("0", False)])
def test_jobs_eager_environment_variable_selects_inline_or_worker(handler, monkeypatch, env_value, inline):
    """JOBS_EAGER=1 -> inline on the caller's thread; JOBS_EAGER=0 -> worker thread."""
    from app.settings import Settings

    monkeypatch.setenv("JOBS_EAGER", env_value)
    monkeypatch.setattr(jobs, "settings", Settings())
    calls = handler()

    job_id = jobs.enqueue("test.job", {"n": 1})

    assert jobs.is_eager() is inline
    if inline:
        # Synchronous: nothing to wait for.
        assert _row(job_id)["status"] == jobs.STATUS_DONE
    else:
        _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert len(calls) == 1
    assert (calls[0][1] is threading.current_thread()) is inline


# --------------------------------------------------------------------------- #
# Failures and retries
# --------------------------------------------------------------------------- #


def _boom(payload):
    raise RuntimeError("boom")


def test_failing_handler_does_not_raise_and_is_scheduled_for_retry(handler, eager, caplog):
    calls = handler(fn=_boom)

    with caplog.at_level(logging.ERROR, logger=jobs.logger.name):
        job_id = jobs.enqueue("test.job")

    assert len(calls) == 1
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_QUEUED
    assert row["attempts"] == 1
    assert row["run_after"] > _utcnow()
    assert any("boom" in (r.exc_text or "") for r in caplog.records)


def test_job_fails_permanently_after_max_attempts(handler, eager):
    calls = handler(fn=_boom)
    job_id = jobs.enqueue("test.job")

    # Each pass runs the retry once; none loops on the job within a single drain.
    for _ in range(jobs.MAX_ATTEMPTS + 2):
        jobs.run_pending(now=FAR_FUTURE)

    row = _row(job_id)
    assert row["status"] == jobs.STATUS_FAILED
    assert row["attempts"] == jobs.MAX_ATTEMPTS
    assert len(calls) == jobs.MAX_ATTEMPTS


def test_job_that_succeeds_on_retry_is_done(handler, eager):
    state = {"n": 0}

    def flaky(payload):
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError("first attempt fails")

    handler(fn=flaky)
    job_id = jobs.enqueue("test.job")
    assert _row(job_id)["status"] == jobs.STATUS_QUEUED

    assert jobs.run_pending(now=FAR_FUTURE) >= 1

    row = _row(job_id)
    assert row["status"] == jobs.STATUS_DONE
    assert row["attempts"] == 2


def test_retry_is_not_run_before_backoff_elapses(handler, eager):
    calls = handler(fn=_boom)
    jobs.enqueue("test.job")
    assert len(calls) == 1

    assert jobs.run_pending() == 0
    assert len(calls) == 1


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #


def test_register_works_as_decorator_and_returns_the_function(clean_jobs):
    clean_jobs.append("deco.kind")

    @jobs.register("deco.kind")
    def fn(payload):
        return None

    assert callable(fn)
    assert jobs._handlers["deco.kind"] is fn


def test_register_same_function_twice_is_idempotent(clean_jobs):
    clean_jobs.append("dup.kind")

    def fn(payload):
        return None

    jobs.register("dup.kind", fn)
    jobs.register("dup.kind", fn)


def test_register_different_function_for_same_kind_raises(clean_jobs):
    clean_jobs.append("dup.kind")
    jobs.register("dup.kind", lambda payload: None)
    with pytest.raises(ValueError):
        jobs.register("dup.kind", lambda payload: None)


def test_unregister_removes_handler(clean_jobs):
    jobs.register("tmp.kind", lambda payload: None)
    jobs.unregister("tmp.kind")
    jobs.unregister("tmp.kind")  # no-op the second time
    with pytest.raises(jobs.UnknownJobKind):
        jobs.enqueue("tmp.kind")


# --------------------------------------------------------------------------- #
# Worker thread (JOBS_EAGER=0)
# --------------------------------------------------------------------------- #


def test_worker_runs_handler_on_a_separate_thread(handler, background):
    calls = handler()

    job_id = jobs.enqueue("test.job", {"n": 1})

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert len(calls) == 1
    payload, thread = calls[0]
    assert payload == {"n": 1}
    assert thread is not threading.current_thread()
    assert thread.name == "job-worker"
    assert thread.daemon
    assert _row(job_id)["attempts"] == 1


def test_worker_picks_up_jobs_that_were_already_queued(handler, background):
    calls = handler()
    with db.SessionLocal() as session:
        job = jobs.Job(kind="test.job", payload={"old": True}, status=jobs.STATUS_QUEUED, attempts=0)
        session.add(job)
        session.commit()
        job_id = job.id

    jobs.start_worker()

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert [p for p, _ in calls] == [{"old": True}]


def test_worker_requeues_jobs_interrupted_while_running(handler, background):
    calls = handler()
    with db.SessionLocal() as session:
        job = jobs.Job(kind="test.job", payload={}, status=jobs.STATUS_RUNNING, attempts=1)
        session.add(job)
        session.commit()
        job_id = job.id

    jobs.start_worker()

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert len(calls) == 1


def test_worker_waits_for_run_after(handler, background):
    calls = handler()
    job_id = jobs.enqueue("test.job", run_after=_utcnow() + timedelta(hours=1))
    # Give the worker a moment: a deferred job must not run.
    time.sleep(0.2)
    assert calls == []
    assert _row(job_id)["status"] == jobs.STATUS_QUEUED


def test_worker_retries_a_failing_job_then_gives_up(handler, background, monkeypatch):
    monkeypatch.setattr(jobs, "RETRY_BASE_SECONDS", 0.0)
    monkeypatch.setattr(jobs, "POLL_INTERVAL_SECONDS", 0.02)
    calls = handler(fn=_boom)

    job_id = jobs.enqueue("test.job")

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_FAILED)
    assert _row(job_id)["attempts"] == jobs.MAX_ATTEMPTS
    assert len(calls) == jobs.MAX_ATTEMPTS


def test_worker_survives_a_handler_that_raises(handler, background):
    handler("bad", fn=_boom)
    good = handler("good")

    jobs.enqueue("bad")
    good_id = jobs.enqueue("good", {"n": 1})

    _wait_until(lambda: _row(good_id)["status"] == jobs.STATUS_DONE)
    assert len(good) == 1


def test_start_worker_is_idempotent_and_stop_worker_stops_it(handler, background):
    handler()
    jobs.start_worker()
    first = jobs._worker.thread
    jobs.start_worker()
    assert jobs._worker.thread is first
    assert first.is_alive()

    jobs.stop_worker()

    assert not first.is_alive()
    assert jobs._worker is None
    jobs.stop_worker()  # stopping twice is fine


def test_worker_can_be_restarted_after_stop(handler, background):
    calls = handler()
    jobs.start_worker()
    jobs.stop_worker()

    job_id = jobs.enqueue("test.job")

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert len(calls) == 1


def test_worker_leaves_jobs_without_a_handler_queued(handler, background):
    calls = handler()
    with db.SessionLocal() as session:
        orphan = jobs.Job(kind="orphan.kind", payload={}, status=jobs.STATUS_QUEUED, attempts=0)
        session.add(orphan)
        session.commit()
        orphan_id = orphan.id

    good_id = jobs.enqueue("test.job")

    _wait_until(lambda: _row(good_id)["status"] == jobs.STATUS_DONE)
    assert _row(orphan_id)["status"] == jobs.STATUS_QUEUED
    assert _row(orphan_id)["attempts"] == 0
    assert len(calls) == 1


# --------------------------------------------------------------------------- #
# Claiming is exclusive
# --------------------------------------------------------------------------- #


def test_concurrent_runners_never_run_a_job_twice(handler, eager):
    seen = []
    lock = threading.Lock()

    def record(payload):
        with lock:
            seen.append(payload["n"])

    handler(fn=record)
    n_jobs = 30
    for n in range(n_jobs):
        jobs.enqueue("test.job", {"n": n}, run_after=_utcnow() + timedelta(hours=1))
    cutoff = _utcnow() + timedelta(hours=2)

    errors = []

    def run():
        try:
            jobs.run_pending(now=cutoff)
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)

    assert errors == []
    assert sorted(seen) == list(range(n_jobs))
    with db.SessionLocal() as session:
        assert session.query(jobs.Job).filter(jobs.Job.status == jobs.STATUS_DONE).count() == n_jobs


def test_claim_by_id_is_a_no_op_for_a_job_that_is_already_running(handler, eager):
    handler()
    job_id = jobs.enqueue("test.job", run_after=_utcnow() + timedelta(hours=1))

    first = jobs._claim_next(FAR_FUTURE, job_id)
    second = jobs._claim_next(FAR_FUTURE, job_id)

    assert first is not None and first.id == job_id and first.attempts == 1
    assert second is None
