"""Tests for the background worker process (``app.worker``) and its schedules.

The worker runs as its own process (``python -m app.worker``), so several of
these tests drive a real child process: that is the only way to prove the
module loading, the signal handling and the exit status.  Every child is
bounded by a timeout and killed if it does not answer, so a regression fails
the test instead of hanging the suite.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import textwrap
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app import db, jobs, worker

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

#: Long enough for a fresh interpreter to import the app, short enough that a
#: wedged child cannot hold the suite.
PROCESS_TIMEOUT = 30.0

NOW = datetime(2026, 5, 4, 10, 37, 0)  # a Monday, mid-hour, mid-day
HOUR = datetime(2026, 5, 4, 10, 0, 0)
TOMORROW_SIX = datetime(2026, 5, 5, 6, 0, 0)


# --------------------------------------------------------------------------- #
# Helpers and fixtures
# --------------------------------------------------------------------------- #


def _delete_all_jobs() -> None:
    with db.SessionLocal() as session:
        session.query(jobs.Job).delete()
        session.commit()


def _rows(kind: str | None = None) -> list[jobs.Job]:
    with db.SessionLocal() as session:
        query = session.query(jobs.Job)
        if kind is not None:
            query = query.filter(jobs.Job.kind == kind)
        return list(query.order_by(jobs.Job.id))


def _dedupe_keys(kind: str) -> set[str]:
    return {(row.payload or {}).get("dedupe_key") for row in _rows(kind)} - {None}


def _row(job_id: int) -> dict:
    with db.SessionLocal() as session:
        job = session.get(jobs.Job, job_id)
        assert job is not None, f"job {job_id} is not in the table"
        return {
            "kind": job.kind,
            "payload": job.payload,
            "status": job.status,
            "run_after": job.run_after,
            "attempts": job.attempts,
        }


def _insert_job(kind: str, payload: dict | None = None, run_after: datetime | None = None) -> int:
    """Write a queued row straight to the table, as another process would."""
    with db.SessionLocal() as session:
        job = jobs.Job(
            kind=kind,
            payload={} if payload is None else payload,
            status=jobs.STATUS_QUEUED,
            run_after=run_after,
            attempts=0,
        )
        session.add(job)
        session.commit()
        return job.id


def _wait_until(predicate, timeout: float = PROCESS_TIMEOUT) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"condition not met within {timeout:.0f}s")


def _worker_env(**extra: str) -> dict[str, str]:
    """The environment for a child worker.

    ``DATABASE_URL`` is taken from the engine the test process is actually
    using, not from ``os.environ``: plugin ``conftest.py`` files rewrite the
    environment variable while modules are collected, so the two can disagree
    once the whole suite runs together.
    """
    env = os.environ.copy()
    env["DATABASE_URL"] = db.engine.url.render_as_string(hide_password=False)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(SRC) + (os.pathsep + existing if existing else "")
    env.update({key: str(value) for key, value in extra.items()})
    return env


def _spawn(*args: str, **env) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, *args],
        env=_worker_env(**env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _finish(process: subprocess.Popen, timeout: float = PROCESS_TIMEOUT) -> tuple[int, str, str]:
    """Wait for ``process``, killing it (and failing the test) on a timeout."""
    try:
        out, err = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        out, err = process.communicate()
        pytest.fail(f"worker process did not exit within {timeout:.0f}s\nstdout:\n{out}\nstderr:\n{err}")
    return process.returncode, out, err


@pytest.fixture(autouse=True)
def clean_jobs():
    """Every test starts and ends with an empty queue and a clean registry cache."""
    jobs.stop_worker()
    jobs._ensure_table()
    jobs._ensure_schedule_index(db.engine)
    _delete_all_jobs()
    jobs.schedule_registry.forget()
    registered: list[str] = []
    yield registered
    for kind in registered:
        jobs.unregister(kind)
    jobs.stop_worker()
    _delete_all_jobs()
    jobs.schedule_registry.forget()


@pytest.fixture
def handler(clean_jobs):
    """Register a handler for the duration of a test; return its call log."""

    def make(kind: str):
        calls = []

        def _handler(payload):
            calls.append(payload)

        jobs.register(kind, _handler)
        clean_jobs.append(kind)
        return calls

    return make


def _registry() -> jobs.ScheduleRegistry:
    """A fresh registry (as another worker process would build) with both schedules."""
    registry = jobs.ScheduleRegistry()
    registry.register("uploads.reap", timedelta(hours=1))
    registry.register("follows.digest", timedelta(days=1))
    return registry


# --------------------------------------------------------------------------- #
# The module's public surface
# --------------------------------------------------------------------------- #


def test_worker_re_exports_the_claim_loop_and_the_registry():
    assert worker.run_pending is jobs.run_pending
    assert worker.schedule_registry is jobs.schedule_registry
    assert worker.ScheduleRegistry is jobs.ScheduleRegistry
    assert callable(worker.main)


def test_load_prepares_the_database_and_returns_the_app():
    app = worker.load()
    assert app is not None
    # The jobs table (and its dedupe index) exist after loading.
    with db.engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM jobs")).scalar() >= 0


def test_worker_registers_the_upload_reaper_hourly_and_the_follow_digest_daily():
    assert worker.PERIODIC_SCHEDULES == {
        "uploads.reap": timedelta(hours=1),
        "follows.digest": timedelta(days=1),
    }

    worker.register_schedules()

    assert "uploads.reap" in worker.schedule_registry
    assert "follows.digest" in worker.schedule_registry
    assert worker.schedule_registry.period("uploads.reap") == timedelta(hours=1)
    assert worker.schedule_registry.period("follows.digest") == timedelta(days=1)


def test_registering_the_schedules_twice_is_harmless():
    registry = jobs.ScheduleRegistry()
    worker.register_schedules(registry)
    worker.register_schedules(registry)

    assert registry.kinds == ["uploads.reap", "follows.digest"]
    assert len(registry) == 2


# --------------------------------------------------------------------------- #
# Schedule computation
# --------------------------------------------------------------------------- #


def test_the_reaper_runs_for_the_current_hour():
    due, key = _registry().next_run("uploads.reap", NOW)

    assert due == HOUR
    assert key == "uploads.reap:2026-05-04T10:00:00"


def test_the_digest_is_queued_ahead_for_the_next_six_am():
    due, key = _registry().next_run("follows.digest", NOW)

    assert due == TOMORROW_SIX
    assert key == "follows.digest:2026-05-05"


def test_the_digest_before_six_am_runs_that_morning():
    due, key = _registry().next_run("follows.digest", datetime(2026, 5, 4, 5, 0))

    assert due == datetime(2026, 5, 4, 6, 0)
    assert key == "follows.digest:2026-05-04"


def test_an_unknown_schedule_has_no_next_run():
    with pytest.raises(KeyError):
        _registry().next_run("nobody.scheduled.this", NOW)


# --------------------------------------------------------------------------- #
# One queued job per period
# --------------------------------------------------------------------------- #


def test_one_tick_queues_one_job_per_schedule_for_the_current_period():
    registry = _registry()

    assert registry.tick(NOW) == 2

    reaper = _rows("uploads.reap")
    digest = _rows("follows.digest")
    assert len(reaper) == 1 and len(digest) == 1

    assert reaper[0].payload == {"dedupe_key": "uploads.reap:2026-05-04T10:00:00"}
    assert reaper[0].run_after == HOUR
    assert reaper[0].status == jobs.STATUS_QUEUED
    assert reaper[0].attempts == 0

    assert digest[0].payload == {"dedupe_key": "follows.digest:2026-05-05"}
    assert digest[0].run_after == TOMORROW_SIX
    assert digest[0].status == jobs.STATUS_QUEUED


def test_ticking_again_in_the_same_period_queues_nothing():
    registry = _registry()
    registry.tick(NOW)

    assert registry.tick(NOW + timedelta(minutes=10)) == 0
    assert len(_rows()) == 2

    # A different registry -- another worker sharing the database -- agrees.
    other = _registry()
    assert other.tick(NOW) == 0
    assert len(_rows()) == 2


def test_a_new_period_queues_exactly_one_more_reaper_job():
    registry = _registry()
    registry.tick(NOW)

    assert registry.tick(datetime(2026, 5, 4, 11, 5)) == 1

    reaper = _rows("uploads.reap")
    assert len(reaper) == 2
    assert {row.payload["dedupe_key"] for row in reaper} == {
        "uploads.reap:2026-05-04T10:00:00",
        "uploads.reap:2026-05-04T11:00:00",
    }
    # The digest's next period is the following day, so it is unchanged.
    assert len(_rows("follows.digest")) == 1


def test_the_dedupe_key_is_enforced_by_the_database_not_just_the_cache():
    registry = _registry()
    registry.tick(NOW)

    # Forget what this process queued: only the unique index can stop the
    # duplicate now.
    registry.forget()
    assert registry.tick(NOW) == 0
    assert len(_rows()) == 2


def test_a_periods_job_is_not_queued_again_after_it_ran(handler):
    calls = handler("test.scheduled")
    registry = jobs.ScheduleRegistry()
    registry.register(
        "test.scheduled",
        timedelta(hours=1),
        compute=lambda now: (now, "test.scheduled:period-1"),
    )

    assert registry.tick(NOW) == 1
    assert jobs.run_pending(NOW) == 1
    assert calls == [{"dedupe_key": "test.scheduled:period-1"}]
    assert _row(_rows("test.scheduled")[0].id)["status"] == jobs.STATUS_DONE

    # The same period, from this registry and from a fresh one: still one job.
    assert registry.tick(NOW) == 0
    fresh = jobs.ScheduleRegistry()
    fresh.register("test.scheduled", timedelta(hours=1), compute=lambda now: (now, "test.scheduled:period-1"))
    assert fresh.tick(NOW) == 0
    assert len(_rows("test.scheduled")) == 1


def test_the_jobs_table_rejects_two_rows_with_the_same_period_key():
    _insert_job("uploads.reap", {"dedupe_key": "uploads.reap:duplicate"})

    with pytest.raises(IntegrityError):
        _insert_job("uploads.reap", {"dedupe_key": "uploads.reap:duplicate"})

    assert len(_rows("uploads.reap")) == 1


def test_rows_without_a_dedupe_key_are_not_constrained():
    _insert_job("uploads.reap")
    _insert_job("uploads.reap")

    assert len(_rows("uploads.reap")) == 2


def test_many_threads_ticking_together_queue_one_job_per_period():
    barrier = threading.Barrier(4)
    errors: list[BaseException] = []

    def tick_twice() -> None:
        registry = _registry()
        try:
            barrier.wait(timeout=PROCESS_TIMEOUT)
            for _ in range(5):
                registry.tick(NOW)
                time.sleep(0.01)
        except BaseException as exc:  # noqa: BLE001 - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=tick_twice) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(PROCESS_TIMEOUT)
        assert not thread.is_alive()

    assert errors == []
    assert len(_rows("uploads.reap")) == 1
    assert len(_rows("follows.digest")) == 1


_TICK_SCRIPT = textwrap.dedent(
    """
    import os, time
    from datetime import datetime, timedelta
    from app import jobs

    now = datetime.fromisoformat(os.environ["SCHEDULE_NOW"])
    start_at = float(os.environ["SCHEDULE_START_AT"])
    registry = jobs.ScheduleRegistry()
    registry.register("uploads.reap", timedelta(hours=1))
    registry.register("follows.digest", timedelta(days=1))
    jobs._ensure_table()
    while time.time() < start_at:
        time.sleep(0.001)
    for _ in range(20):
        registry.tick(now)
        time.sleep(0.01)
    """
)


def test_several_worker_processes_queue_one_job_per_period():
    start_at = time.time() + 2.0
    children = [
        _spawn("-c", _TICK_SCRIPT, SCHEDULE_NOW=NOW.isoformat(), SCHEDULE_START_AT=start_at)
        for _ in range(3)
    ]
    for child in children:
        code, out, err = _finish(child, timeout=PROCESS_TIMEOUT + 5)
        assert code == 0, f"child failed\nstdout:\n{out}\nstderr:\n{err}"

    reaper = _rows("uploads.reap")
    digest = _rows("follows.digest")
    assert len(reaper) == 1
    assert len(digest) == 1
    assert reaper[0].payload == {"dedupe_key": "uploads.reap:2026-05-04T10:00:00"}
    assert digest[0].payload == {"dedupe_key": "follows.digest:2026-05-05"}


# --------------------------------------------------------------------------- #
# The process: module loading, draining and clean shutdown
# --------------------------------------------------------------------------- #


def test_the_worker_process_runs_once_and_drains_a_queued_job():
    # ``uploads.reap`` is handled by a module, so the job only runs if the
    # worker loaded the modules and the handler registered.
    job_id = _insert_job("uploads.reap", run_after=datetime(2000, 1, 1))

    code, out, err = _finish(_spawn("-m", "app.worker", "--once"))

    assert code == 0, f"stdout:\n{out}\nstderr:\n{err}"
    row = _row(job_id)
    assert row["status"] == jobs.STATUS_DONE
    assert row["attempts"] == 1


def test_the_worker_process_drains_jobs_while_it_runs_then_exits_zero_on_sigterm():
    job_id = _insert_job("uploads.reap", run_after=datetime(2000, 1, 1))
    process = _spawn("-m", "app.worker")

    try:
        _wait_until(lambda: _row(job_id)["status"] == jobs.STATUS_DONE)
        assert process.poll() is None, "the worker stopped on its own"

        process.send_signal(signal.SIGTERM)
        code, out, err = _finish(process)
    finally:
        if process.poll() is None:  # pragma: no cover - only on a test failure
            process.kill()
            process.communicate()

    assert code == 0, f"stdout:\n{out}\nstderr:\n{err}"
    assert _row(job_id)["status"] == jobs.STATUS_DONE


def test_the_worker_process_creates_the_periodic_jobs():
    process = _spawn("-m", "app.worker")

    try:
        # A worker tick writes both schedules' jobs with their period key; the
        # reaper may already have run, so the payload is what we look at.
        _wait_until(
            lambda: {row.kind for row in _rows() if (row.payload or {}).get("dedupe_key")}
            >= {"uploads.reap", "follows.digest"}
        )
        assert process.poll() is None, "the worker stopped on its own"
        process.send_signal(signal.SIGTERM)
        code, out, err = _finish(process)
    finally:
        if process.poll() is None:  # pragma: no cover - only on a test failure
            process.kill()
            process.communicate()

    assert code == 0, f"stdout:\n{out}\nstderr:\n{err}"

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    hour = now.replace(minute=0, second=0, microsecond=0)
    reaper_keys = _dedupe_keys("uploads.reap")
    digest_keys = _dedupe_keys("follows.digest")
    # The current period, or the one before it if the hour turned over while
    # the test ran.
    assert reaper_keys & {f"uploads.reap:{h.isoformat()}" for h in (hour, hour - timedelta(hours=1))}
    # The digest runs at 06:00 UTC, so its period is today's or tomorrow's run.
    today = now.date()
    assert digest_keys & {f"follows.digest:{day.isoformat()}" for day in (today, today + timedelta(days=1))}


_SLOW_SCRIPT = textwrap.dedent(
    """
    import os, time
    from app import db, jobs, worker

    def slow(payload):
        with open(os.environ["WORKER_MARKER"], "w") as handle:
            handle.write("started")
        time.sleep(float(os.environ["WORKER_SLEEP"]))

    jobs.register("test.slow", slow)
    with db.SessionLocal() as session:
        session.add(
            jobs.Job(
                kind="test.slow",
                payload={},
                status=jobs.STATUS_QUEUED,
                run_after=None,
                attempts=0,
            )
        )
        session.commit()
    worker.main([])
    """
)


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_the_worker_process_finishes_the_job_in_hand_before_exiting(tmp_path, signum):
    marker = tmp_path / "started"
    sleep_for = 2.0
    process = _spawn(
        "-c",
        _SLOW_SCRIPT,
        WORKER_MARKER=str(marker),
        WORKER_SLEEP=str(sleep_for),
    )

    try:
        _wait_until(marker.exists)
        assert process.poll() is None, "the worker exited before it could be signalled"

        signalled_at = time.monotonic()
        process.send_signal(signum)
        code, out, err = _finish(process)
        elapsed = time.monotonic() - signalled_at
    finally:
        if process.poll() is None:  # pragma: no cover - only on a test failure
            process.kill()
            process.communicate()

    assert code == 0, f"stdout:\n{out}\nstderr:\n{err}"
    # The handler was still sleeping when the signal arrived, and the worker
    # waited for it instead of exiting mid-job.
    assert elapsed >= sleep_for / 2, f"worker exited after {elapsed:.2f}s, before the job finished"

    [job] = _rows("test.slow")
    assert job.status == jobs.STATUS_DONE
    assert job.attempts == 1
