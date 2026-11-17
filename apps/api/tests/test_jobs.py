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
            "locked_until": job.locked_until,
            "worker_id": job.worker_id,
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
    assert list(cols) == [
        "id", "kind", "payload", "status", "run_after", "attempts", "locked_until", "worker_id",
    ]
    assert cols["id"].primary_key
    assert not cols["kind"].nullable
    assert not cols["payload"].nullable
    assert not cols["status"].nullable
    assert cols["run_after"].nullable
    assert cols["locked_until"].nullable
    assert cols["worker_id"].nullable


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


# --------------------------------------------------------------------------- #
# Leases
# --------------------------------------------------------------------------- #


def _insert(status: str = jobs.STATUS_QUEUED, *, kind: str = "test.job", attempts: int = 0, **columns) -> int:
    with db.SessionLocal() as session:
        job = jobs.Job(kind=kind, payload={}, status=status, attempts=attempts, **columns)
        session.add(job)
        session.commit()
        return job.id


def test_claim_takes_a_lease_naming_this_runner(handler, eager):
    handler()
    job_id = _insert()

    before = _utcnow()
    claimed = jobs._claim_next(_utcnow())
    after = _utcnow()

    assert claimed is not None and claimed.id == job_id and claimed.attempts == 1
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_RUNNING
    assert row["worker_id"] == jobs.current_worker_id()
    lease = timedelta(seconds=jobs.LEASE_SECONDS)
    assert before + lease <= row["locked_until"] <= after + lease


def test_lease_is_released_when_the_job_finishes(handler, eager):
    handler()
    job_id = jobs.enqueue("test.job")
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_DONE
    assert row["locked_until"] is None and row["worker_id"] is None


def test_lease_is_released_when_a_failed_job_is_scheduled_for_retry(handler, eager):
    handler(fn=_boom)
    job_id = jobs.enqueue("test.job")
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_QUEUED
    assert row["locked_until"] is None and row["worker_id"] is None


def test_a_leased_job_cannot_be_claimed_by_another_runner(handler, eager, monkeypatch):
    handler()
    job_id = _insert()
    assert jobs._claim_next(_utcnow()) is not None

    monkeypatch.setattr(jobs, "_WORKER_ID", "another-runner")
    assert jobs._claim_next(_utcnow()) is None
    assert jobs.run_pending() == 0
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_RUNNING
    assert row["worker_id"] != "another-runner"
    assert row["attempts"] == 1


def test_many_runners_with_their_own_identities_split_the_queue(handler, eager, monkeypatch):
    """Each job is claimed by exactly one of several runners racing for the queue."""
    handler()
    n_jobs = 40
    ids = [_insert() for _ in range(n_jobs)]
    claims: dict[int, list[int]] = {}
    lock = threading.Lock()
    errors = []

    def runner(index: int):
        try:
            while True:
                claimed = jobs._claim_next(_utcnow())
                if claimed is None:
                    return
                with lock:
                    claims.setdefault(claimed.id, []).append(index)
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=runner, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)

    assert errors == []
    assert sorted(claims) == sorted(ids)
    assert all(len(owners) == 1 for owners in claims.values())
    assert all(_row(i)["attempts"] == 1 for i in ids)


def test_claim_select_locks_the_row_with_skip_locked_on_postgresql_only():
    from sqlalchemy.dialects import postgresql, sqlite

    stmt = jobs._candidate_select(["test.job"], _utcnow(), None, lock_rows=True)
    pg = str(stmt.compile(dialect=postgresql.dialect()))
    assert pg.rstrip().endswith("FOR UPDATE SKIP LOCKED")
    assert "jobs.status" in pg and "LIMIT" in pg

    plain = jobs._candidate_select(["test.job"], _utcnow(), 7, lock_rows=False)
    assert "FOR UPDATE" not in str(plain.compile(dialect=sqlite.dialect()))


def test_postgresql_claims_lock_rows_and_sqlite_claims_do_not(handler, eager, monkeypatch):
    handler()
    _insert()
    seen = []
    real = jobs._candidate_select

    def spy(*args, **kwargs):
        seen.append(kwargs["lock_rows"])
        return real(*args, **{**kwargs, "lock_rows": False})  # SQLite cannot run FOR UPDATE

    monkeypatch.setattr(jobs, "_candidate_select", spy)
    assert jobs._is_postgres() is False
    assert jobs._claim_next(_utcnow()) is not None
    monkeypatch.setattr(jobs, "_is_postgres", lambda: True)
    _insert()
    assert jobs._claim_next(_utcnow()) is not None
    assert seen == [False, True]


def _retire_heartbeat() -> None:
    """Let a heartbeat thread left by an earlier test (on the real, long lease) exit."""
    jobs._heartbeat_wake.set()
    _wait_until(lambda: jobs._heartbeat is None)


def test_a_runner_renews_its_lease_while_a_long_handler_runs(handler, eager, monkeypatch):
    """A handler that outlives the lease is not taken over by another runner."""
    _retire_heartbeat()
    monkeypatch.setattr(jobs, "LEASE_SECONDS", 0.6)  # renewed every 0.2s
    other_runner = []

    def slow(payload):
        for _ in range(15):  # 1.5s: well past the lease
            time.sleep(0.1)
            other_runner.append((jobs.requeue_expired(), jobs.run_pending()))

    calls = handler(fn=slow)
    job_id = jobs.enqueue("test.job")

    assert len(calls) == 1
    assert other_runner and all(result == (0, 0) for result in other_runner)
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_DONE and row["attempts"] == 1


def test_the_heartbeat_thread_exits_when_nothing_is_in_flight(handler, eager, monkeypatch):
    _retire_heartbeat()
    monkeypatch.setattr(jobs, "LEASE_SECONDS", 0.05)
    handler()
    jobs.enqueue("test.job")
    _wait_until(lambda: not any(t.name == "job-heartbeat" for t in threading.enumerate()))
    assert jobs._held == {} and jobs._heartbeat is None


# --------------------------------------------------------------------------- #
# Expired leases are re-queued by any runner
# --------------------------------------------------------------------------- #


def test_any_runner_requeues_a_running_job_whose_lease_expired(handler, eager, monkeypatch):
    calls = handler()
    job_id = _insert(
        jobs.STATUS_RUNNING, attempts=1, locked_until=_utcnow() - timedelta(seconds=1), worker_id="dead-runner"
    )

    monkeypatch.setattr(jobs, "_WORKER_ID", "survivor")
    assert jobs.requeue_expired() == 1

    row = _row(job_id)
    assert row["status"] == jobs.STATUS_QUEUED
    assert row["locked_until"] is None and row["worker_id"] is None
    assert row["attempts"] == 1
    assert calls == []


def test_run_pending_picks_up_a_job_abandoned_by_a_dead_runner(handler, eager):
    calls = handler()
    job_id = _insert(
        jobs.STATUS_RUNNING, attempts=1, locked_until=_utcnow() - timedelta(minutes=5), worker_id="dead-runner"
    )

    assert jobs.run_pending() == 1

    assert len(calls) == 1
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_DONE
    assert row["attempts"] == 2
    assert row["worker_id"] is None


def test_a_job_with_a_live_lease_is_left_alone(handler, eager):
    calls = handler()
    job_id = _insert(
        jobs.STATUS_RUNNING, attempts=1, locked_until=_utcnow() + timedelta(minutes=5), worker_id="busy-runner"
    )

    assert jobs.requeue_expired() == 0
    assert jobs.run_pending() == 0

    assert calls == []
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_RUNNING and row["worker_id"] == "busy-runner"


def test_a_running_job_without_any_lease_counts_as_expired(handler, eager):
    """Rows left by a runner that predates leases are recovered, not stuck forever."""
    handler()
    job_id = _insert(jobs.STATUS_RUNNING, attempts=1)
    assert jobs.requeue_expired() == 1
    assert _row(job_id)["status"] == jobs.STATUS_QUEUED


def test_requeue_expired_honours_the_given_time(handler, eager):
    handler()
    job_id = _insert(jobs.STATUS_RUNNING, attempts=1, locked_until=_utcnow() + timedelta(minutes=5))
    assert jobs.requeue_expired() == 0
    assert jobs.requeue_expired(now=_utcnow() + timedelta(minutes=10)) == 1
    assert _row(job_id)["status"] == jobs.STATUS_QUEUED


def test_a_job_that_keeps_killing_its_runner_is_failed_not_retried_forever(handler, eager):
    calls = handler()
    job_id = _insert(
        jobs.STATUS_RUNNING,
        attempts=jobs.MAX_ATTEMPTS,
        locked_until=_utcnow() - timedelta(seconds=1),
        worker_id="dead-runner",
    )

    assert jobs.requeue_expired() == 0
    assert jobs.run_pending() == 0

    assert calls == []
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_FAILED
    assert row["locked_until"] is None and row["worker_id"] is None


def test_worker_thread_requeues_a_job_when_its_lease_expires(handler, background, monkeypatch):
    monkeypatch.setattr(jobs, "POLL_INTERVAL_SECONDS", 0.02)
    calls = handler()
    job_id = _insert(
        jobs.STATUS_RUNNING, attempts=1, locked_until=_utcnow() + timedelta(seconds=0.3), worker_id="dead-runner"
    )

    jobs.start_worker()
    time.sleep(0.1)
    assert calls == [] and _row(job_id)["status"] == jobs.STATUS_RUNNING

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert len(calls) == 1


def test_a_runner_that_lost_its_lease_does_not_overwrite_the_new_owner(handler, eager, monkeypatch, caplog):
    handler()
    job_id = _insert(jobs.STATUS_RUNNING, attempts=1, locked_until=_utcnow() - timedelta(seconds=1))
    slow_runner = jobs._Claimed(job_id, "test.job", {}, 1, "slow-runner")
    jobs.requeue_expired()
    monkeypatch.setattr(jobs, "_WORKER_ID", "new-owner")
    taken_over = jobs._claim_next(_utcnow())
    assert taken_over is not None and taken_over.attempts == 2

    with caplog.at_level(logging.WARNING, logger=jobs.logger.name):
        jobs._finish(slow_runner, ok=True)

    row = _row(job_id)
    assert row["status"] == jobs.STATUS_RUNNING
    assert row["worker_id"] == "new-owner" and row["attempts"] == 2
    assert "lease was lost" in caplog.text


def test_a_lost_lease_is_dropped_from_renewal(handler, eager, monkeypatch):
    handler()
    job_id = _insert(jobs.STATUS_RUNNING, attempts=2, locked_until=_utcnow() + timedelta(minutes=1), worker_id="other")
    mine = jobs._Claimed(job_id, "test.job", {}, 2, "me")  # the row now belongs to "other"
    jobs._held[job_id] = mine
    try:
        jobs._renew_leases({job_id: mine})
        assert job_id not in jobs._held
        assert _row(job_id)["worker_id"] == "other"
    finally:
        jobs._held.pop(job_id, None)


# --------------------------------------------------------------------------- #
# Existing databases gain the lease columns in place
# --------------------------------------------------------------------------- #


@pytest.fixture
def legacy_database(tmp_path, monkeypatch):
    """A database whose ``jobs`` table predates leases (no locked_until / worker_id)."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}", connect_args={"check_same_thread": False})
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload JSON NOT NULL, "
                "status TEXT NOT NULL, run_after DATETIME, attempts INTEGER DEFAULT 0)"
            )
        )
        connection.execute(text("CREATE INDEX ix_jobs_status_run_after ON jobs (status, run_after)"))
        connection.execute(
            text("INSERT INTO jobs (kind, payload, status, attempts) VALUES ('test.job', '{\"old\": 1}', 'queued', 0)")
        )
        connection.execute(
            text("INSERT INTO jobs (kind, payload, status, attempts) VALUES ('test.job', '{\"old\": 2}', 'running', 1)")
        )
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "SessionLocal", sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True))
    monkeypatch.setattr(jobs, "_table_engine", None)
    yield engine
    engine.dispose()


def test_lease_columns_are_added_in_place_to_an_existing_table(legacy_database):
    from sqlalchemy import inspect

    jobs._ensure_table()

    columns = {c["name"] for c in inspect(legacy_database).get_columns("jobs")}
    assert {"locked_until", "worker_id"} <= columns
    with db.SessionLocal() as session:
        assert session.query(jobs.Job).count() == 2  # existing rows are untouched
        assert {j.worker_id for j in session.query(jobs.Job)} == {None}


def test_a_database_that_already_has_the_columns_is_left_alone(legacy_database):
    jobs._ensure_table()
    jobs._table_engine = None
    jobs._ensure_table()  # second pass finds the columns and changes nothing


def test_jobs_queued_before_the_upgrade_still_run(handler, eager, legacy_database):
    calls = handler()

    assert jobs.run_pending() == 2  # the queued row, and the one a dead runner left running

    assert sorted(p["old"] for p, _ in calls) == [1, 2]
    with db.SessionLocal() as session:
        assert {j.status for j in session.query(jobs.Job)} == {jobs.STATUS_DONE}


def test_losing_the_race_to_add_a_column_is_fine(legacy_database, monkeypatch):
    """Another runner adding the column between our check and ALTER must not fail us."""
    from sqlalchemy import inspect, text

    real_inspect = jobs.inspect
    calls = {"n": 0}

    def racing_inspect(bind):
        inspector = real_inspect(bind)
        calls["n"] += 1
        if calls["n"] == 1:
            # Reported before the other runner's ALTER lands...
            real_get = inspector.get_columns
            columns = [c for c in real_get("jobs") if c["name"] not in jobs._LEASE_COLUMNS]
            with bind.begin() as connection:  # ...which then happens before ours.
                connection.execute(text("ALTER TABLE jobs ADD COLUMN locked_until DATETIME"))
            inspector.get_columns = lambda name, *a, **k: columns
        return inspector

    monkeypatch.setattr(jobs, "inspect", racing_inspect)
    jobs._ensure_table()

    assert {"locked_until", "worker_id"} <= {c["name"] for c in inspect(legacy_database).get_columns("jobs")}


# --------------------------------------------------------------------------- #
# JOBS_MODE: eager | thread | external
# --------------------------------------------------------------------------- #


@pytest.fixture
def external(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_MODE", "external")


@pytest.fixture
def explicit_thread(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_MODE", "thread")


@pytest.mark.parametrize(
    "jobs_mode, jobs_eager, expected",
    [
        (None, None, "eager"),  # both unset: eager is the default
        (None, "1", "eager"),
        (None, "0", "thread"),  # JOBS_EAGER=0 is what "thread" has always been
        ("eager", "0", "eager"),  # an explicit JOBS_MODE wins over JOBS_EAGER
        ("thread", "1", "thread"),
        ("external", "1", "external"),
        ("external", None, "external"),
        (" External ", None, "external"),  # whitespace and case are forgiven
    ],
)
def test_jobs_mode_environment_resolution(monkeypatch, jobs_mode, jobs_eager, expected):
    from app.settings import Settings

    for name, value in (("JOBS_MODE", jobs_mode), ("JOBS_EAGER", jobs_eager)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    resolved = Settings()
    monkeypatch.setattr(jobs, "settings", resolved)

    assert resolved.jobs_mode == expected
    assert jobs.mode() == expected
    assert (jobs.is_eager(), jobs.is_thread(), jobs.is_external()) == tuple(expected == m for m in jobs.JOB_MODES)


def test_jobs_eager_still_switches_the_mode_after_settings_are_built(monkeypatch):
    """Tests and the demo seeder flip JOBS_EAGER on a live Settings object."""
    from app.settings import Settings

    monkeypatch.delenv("JOBS_MODE", raising=False)
    live = Settings()
    live.JOBS_EAGER = 0
    assert live.jobs_mode == "thread"
    live.JOBS_EAGER = 1
    assert live.jobs_mode == "eager"
    live.JOBS_MODE = "external"
    assert live.jobs_mode == "external"


def test_an_unknown_jobs_mode_is_refused(handler, monkeypatch):
    from app.settings import Settings

    monkeypatch.setenv("JOBS_MODE", "extrenal")
    unknown = Settings()
    with pytest.raises(RuntimeError, match="JOBS_MODE"):
        unknown.validate_for_environment()

    handler()
    monkeypatch.setattr(settings, "JOBS_MODE", "extrenal")
    with pytest.raises(ValueError, match="JOBS_MODE"):
        jobs.enqueue("test.job")
    with db.SessionLocal() as session:
        assert session.query(jobs.Job).count() == 0  # nothing persisted for a bad mode


@pytest.mark.parametrize("jobs_mode, accepted", [("thread", True), ("external", True), ("eager", False)])
def test_production_accepts_thread_and_external_but_not_eager(tmp_path, monkeypatch, jobs_mode, accepted):
    from test_app_factory import _safe_production_settings

    prod = _safe_production_settings(tmp_path, monkeypatch)
    prod.JOBS_MODE = jobs_mode
    if accepted:
        prod.validate_for_environment()
    else:
        with pytest.raises(RuntimeError, match="JOBS_EAGER must be 0"):
            prod.validate_for_environment()


def test_external_mode_only_writes_a_queued_job(handler, external):
    calls = handler()
    run_after = _utcnow() - timedelta(minutes=1)

    job_id = jobs.enqueue("test.job", {"n": 1}, run_after=run_after)
    time.sleep(0.1)

    assert calls == []
    assert jobs._worker is None
    assert not any(t.name == "job-worker" for t in threading.enumerate())
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_QUEUED
    assert row["payload"] == {"n": 1} and row["attempts"] == 0
    assert row["locked_until"] is None and row["worker_id"] is None


def test_external_mode_jobs_are_drained_by_a_separate_runner(handler, external):
    calls = handler()
    ids = [jobs.enqueue("test.job", {"n": n}) for n in range(3)]
    assert calls == []

    assert jobs.run_pending() == 3  # what the worker process's claim loop does

    assert sorted(p["n"] for p, _ in calls) == [0, 1, 2]
    assert all(_row(i)["status"] == jobs.STATUS_DONE for i in ids)


def test_explicit_thread_mode_runs_jobs_on_the_worker_thread(handler, explicit_thread):
    calls = handler()

    job_id = jobs.enqueue("test.job")

    _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
    assert calls[0][1] is not threading.current_thread()
    assert calls[0][1].name == "job-worker"


def test_explicit_eager_mode_runs_inline_even_if_jobs_eager_is_off(handler, monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 0)
    monkeypatch.setattr(settings, "JOBS_MODE", "eager")
    calls = handler()

    job_id = jobs.enqueue("test.job")

    assert calls[0][1] is threading.current_thread()
    assert _row(job_id)["status"] == jobs.STATUS_DONE
    assert jobs._worker is None


@pytest.mark.parametrize(
    "jobs_mode, starts_worker", [("eager", False), ("thread", True), ("external", False)]
)
def test_app_lifespan_starts_the_worker_only_in_thread_mode(monkeypatch, jobs_mode, starts_worker):
    from fastapi.testclient import TestClient

    from app import main

    events = []
    monkeypatch.setattr(settings, "JOBS_MODE", jobs_mode)
    monkeypatch.setattr(jobs, "start_worker", lambda: events.append("start"))
    monkeypatch.setattr(jobs, "stop_worker", lambda timeout=5.0: events.append("stop"))

    with TestClient(main.create_app()):
        assert events == (["start"] if starts_worker else [])

    assert events == (["start", "stop"] if starts_worker else [])
