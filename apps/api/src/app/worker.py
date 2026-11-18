"""Background worker process.

Run with ``python -m app.worker``.  The process loads every application module
(so all job handlers register), creates the database tables, and then drains due
jobs in a loop.

Periodic jobs are created by :data:`app.jobs.schedule_registry`: the upload
reaper hourly and the follow digest daily.  Each job carries a per-period
``dedupe_key`` in its payload, backed by a unique index, so any number of
workers can run the loop without ever queueing a period's job twice.

On SIGTERM or SIGINT the worker stops claiming new jobs, finishes the job
currently in hand, and exits with status 0.  ``python -m app.worker --once``
runs a single pass (create the due periodic jobs, drain the queue) and exits,
which is handy for cron-style deployments and for tests.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from . import db, jobs, module_loader

logger = logging.getLogger(__name__)

#: The schedule the worker process maintains: job kind -> how often it runs.
PERIODIC_SCHEDULES: dict[str, timedelta] = {
    "uploads.reap": timedelta(hours=1),
    "follows.digest": timedelta(days=1),
}
SCHEDULES = PERIODIC_SCHEDULES

# Re-exported so ``worker.schedule_registry`` is the registry the loop ticks.
schedule_registry = jobs.schedule_registry
scheduler = schedule_registry
ScheduleRegistry = jobs.ScheduleRegistry


def register_schedules(registry: Optional[jobs.ScheduleRegistry] = None) -> None:
    """Register the periodic schedules on ``registry`` (the process registry by default).

    Registration is idempotent, so calling this from several places is safe.
    """
    target = jobs.schedule_registry if registry is None else registry
    for kind, period in PERIODIC_SCHEDULES.items():
        try:
            target.register(kind, period)
        except Exception:
            logger.exception("could not register the %s schedule", kind)


_register_schedules = register_schedules


def load() -> Any:
    """Import every module (registering handlers) and prepare the database."""
    from fastapi import FastAPI

    app = FastAPI()
    module_loader.load_modules(app)
    db.create_all()
    jobs._ensure_table()
    register_schedules()
    return app


_loaded: Optional[Any] = None


def _load_once() -> Any:
    global _loaded
    if _loaded is None:
        _loaded = load()
    return _loaded


def tick_schedules(now: Optional[datetime] = None) -> int:
    """Create the current period's job for every registered schedule."""
    return jobs.schedule_registry.tick(now)


def drain(now: Optional[datetime] = None) -> int:
    """Drain the jobs that are due right now (one worker pass, on this thread)."""
    return jobs.run_pending(now)


run_pending = jobs.run_pending


def drain_once(now: Optional[datetime] = None) -> int:
    return drain(now)


def run_once(now: Optional[datetime] = None) -> int:
    """One full worker pass: create the due periodic jobs, then drain the queue."""
    _load_once()
    tick_schedules(now)
    return jobs.run_pending(now)


def _install_signal_handlers(stop_event: threading.Event) -> None:
    """Stop the loop on SIGTERM/SIGINT, without interrupting the job in hand."""

    def _handle_signal(signum: int, frame: Any) -> None:
        logger.info("received signal %s; finishing the current job before exit", signum)
        stop_event.set()

    if threading.current_thread() is not threading.main_thread():
        # Signals can only be installed from the main thread; a caller that
        # runs main() in a thread drives the loop with its own stop event.
        logger.debug("not the main thread; leaving signal handlers alone")
        return
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(signum, _handle_signal)
        except (ValueError, OSError):  # pragma: no cover - platform specific
            logger.debug("could not install a handler for signal %s", signum, exc_info=True)


def main(argv: Optional[list[str]] = None) -> int:
    args = list(argv) if argv is not None else list(sys.argv[1:])
    if "--once" in args or "once" in args:
        run_once()
        return 0

    stop_event = threading.Event()
    _install_signal_handlers(stop_event)
    _load_once()
    logger.info("worker %s started", jobs.current_worker_id())

    try:
        while not stop_event.is_set():
            try:
                tick_schedules()
            except Exception:
                logger.exception("schedule tick failed")
            # The drain checks the stop event between jobs, so a signal that
            # arrives while a handler runs lets that handler finish first.
            try:
                jobs._drain(jobs._utcnow(), stop_event)
            except Exception:
                logger.exception("drain pass failed")
            stop_event.wait(jobs.POLL_INTERVAL_SECONDS)
    except KeyboardInterrupt:  # SIGINT before the handler was installed
        stop_event.set()
    logger.info("worker stopped")
    return 0


# Auto-load on import, like ``app.main`` builds the app on import, so that
# importing this module registers every handler and the periodic schedules.
_loaded = _load_once()

# Common aliases.
run = main
run_worker = main
start = main
run_once_worker = run_once
load_modules = load
setup = load
init = load
tick = tick_schedules
run_schedule = tick_schedules
run_scheduler = tick_schedules
tick_scheduler = tick_schedules
create_periodic_jobs = tick_schedules


if __name__ == "__main__":
    raise SystemExit(main())
