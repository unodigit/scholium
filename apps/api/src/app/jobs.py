"""Background job runner backed by the ``jobs`` table.

Usage::

    from app import jobs

    @jobs.register("digest.send")
    def send_digest(payload: dict) -> None:
        ...

    jobs.enqueue("digest.send", {"user": "did:example:alice"})

``enqueue`` always persists the job first (status ``queued``) and then either

* runs it inline, on the calling thread, when ``JOBS_EAGER`` is truthy -- this
  is what keeps tests synchronous -- or
* wakes a daemon worker thread (started lazily on first use) that drains due
  jobs from the table.

Semantics:

* Delivery is at-least-once. A job is claimed with a conditional UPDATE, so it
  is never handed to two runners at once, but a job left in ``running`` by a
  crash is re-queued when the worker next starts. This assumes a single runner
  process per database.
* A handler that raises is logged and retried with exponential backoff until
  ``MAX_ATTEMPTS`` attempts have been made, after which the job is ``failed``.
  Handler errors never propagate out of ``enqueue``, eager or not.
* ``run_after`` defers a job. Deferred jobs are never run inline, even in eager
  mode; they are picked up by the worker or by an explicit ``run_pending()``.
* Only jobs whose kind has a registered handler are claimed, so rows for a kind
  nobody handles (yet) stay queued instead of being failed.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NamedTuple, Optional

from sqlalchemy import JSON, Column, DateTime, Index, Integer, Text, func, or_, select, update
from sqlalchemy.engine import Engine

from . import db
from .settings import settings

logger = logging.getLogger(__name__)

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

MAX_ATTEMPTS = 3
RETRY_BASE_SECONDS = 2.0
POLL_INTERVAL_SECONDS = 1.0

JobHandler = Callable[[Any], None]


class UnknownJobKind(LookupError):
    """Raised by ``enqueue`` when no handler is registered for the job kind."""


class Job(db.Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True)
    kind = Column(Text, nullable=False)
    payload = Column(JSON, nullable=False)
    status = Column(Text, nullable=False)
    run_after = Column(DateTime)
    attempts = Column(Integer, default=0, server_default="0")

    __table_args__ = (Index("ix_jobs_status_run_after", "status", "run_after"),)


class _Claimed(NamedTuple):
    id: int
    kind: str
    payload: Any
    attempts: int


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _utcnow() -> datetime:
    """Naive UTC "now" -- the table stores naive UTC timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _to_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=RETRY_BASE_SECONDS * 2 ** max(attempts - 1, 0))


def is_eager() -> bool:
    """True when jobs run inline on ``enqueue`` (``JOBS_EAGER=1``)."""
    return bool(settings.JOBS_EAGER)


_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def _ensure_table() -> None:
    """Create the jobs table if it is missing.

    ``main.create_app`` only creates tables for models imported by the time it
    runs, which this module -- living outside ``app.modules`` -- cannot
    guarantee, so the runner makes sure its own table exists.
    """
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            Job.__table__.create(bind=db.engine, checkfirst=True)
            _table_engine = db.engine


# --------------------------------------------------------------------------- #
# Handler registry
# --------------------------------------------------------------------------- #

_handlers: dict[str, JobHandler] = {}
_registry_lock = threading.Lock()


def register(kind: str, handler: Optional[JobHandler] = None):
    """Register ``handler`` for jobs of ``kind``.

    Works as ``register("kind", fn)`` or as a decorator ``@register("kind")``.
    Registering the same function twice is a no-op; registering a different
    function for an already-registered kind raises ``ValueError``.
    """

    def _add(fn: JobHandler) -> JobHandler:
        with _registry_lock:
            existing = _handlers.get(kind)
            if existing is not None and existing is not fn:
                raise ValueError(f"a handler is already registered for job kind {kind!r}")
            _handlers[kind] = fn
        return fn

    return _add if handler is None else _add(handler)


def unregister(kind: str) -> None:
    """Remove the handler for ``kind`` (no-op if there is none)."""
    with _registry_lock:
        _handlers.pop(kind, None)


# --------------------------------------------------------------------------- #
# Claiming and executing
# --------------------------------------------------------------------------- #


def _claim_next(now: datetime, job_id: Optional[int] = None) -> Optional[_Claimed]:
    """Atomically move one due, handled, queued job to ``running``.

    With ``job_id`` only that job is considered. Returns ``None`` when nothing
    is claimable.
    """
    kinds = list(_handlers)
    if not kinds:
        return None
    while True:
        with db.SessionLocal() as session:
            stmt = (
                select(Job.id)
                .where(
                    Job.status == STATUS_QUEUED,
                    Job.kind.in_(kinds),
                    or_(Job.run_after.is_(None), Job.run_after <= now),
                )
                .order_by(Job.id)
                .limit(1)
            )
            if job_id is not None:
                stmt = stmt.where(Job.id == job_id)
            candidate = session.execute(stmt).scalar_one_or_none()
            if candidate is None:
                return None
            # The status guard makes the claim race-safe: if another runner got
            # there first this matches zero rows and we look for another job.
            claimed = session.execute(
                update(Job)
                .where(Job.id == candidate, Job.status == STATUS_QUEUED)
                .values(status=STATUS_RUNNING, attempts=func.coalesce(Job.attempts, 0) + 1)
            )
            if claimed.rowcount == 0:
                session.rollback()
                if job_id is not None:
                    return None
                continue
            session.commit()
            job = session.get(Job, candidate)
            return _Claimed(job.id, job.kind, job.payload, job.attempts)


def _finish(job: _Claimed, ok: bool) -> None:
    if ok:
        values: dict[str, Any] = {"status": STATUS_DONE}
    elif job.attempts >= MAX_ATTEMPTS:
        values = {"status": STATUS_FAILED}
    else:
        values = {"status": STATUS_QUEUED, "run_after": _utcnow() + _backoff(job.attempts)}
    with db.SessionLocal() as session:
        session.execute(update(Job).where(Job.id == job.id).values(**values))
        session.commit()


def _execute(job: _Claimed) -> bool:
    ok = False
    try:
        handler = _handlers.get(job.kind)
        if handler is None:
            raise UnknownJobKind(f"no handler registered for job kind {job.kind!r}")
        handler(job.payload)
        ok = True
    except Exception:
        logger.exception("job %s (%s) failed on attempt %s of %s", job.id, job.kind, job.attempts, MAX_ATTEMPTS)
    _finish(job, ok)
    return ok


def _drain(cutoff: datetime, stop: Optional[threading.Event] = None) -> int:
    ran = 0
    while stop is None or not stop.is_set():
        job = _claim_next(cutoff)
        if job is None:
            break
        _execute(job)
        ran += 1
    return ran


def run_pending(now: Optional[datetime] = None) -> int:
    """Run every job that is due at ``now`` (default: the current time).

    Runs on the calling thread and returns how many attempts were made. Mostly
    useful in tests and scripts; the worker thread calls this in a loop.
    Retries scheduled by failures during the drain are not due at the drain's
    start time, so one call never loops on a failing job.
    """
    _ensure_table()
    return _drain(_to_naive_utc(now) if now is not None else _utcnow())


# --------------------------------------------------------------------------- #
# Worker thread
# --------------------------------------------------------------------------- #


class _Worker:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._loop, name="job-worker", daemon=True)

    def _loop(self) -> None:
        while not self.stop.is_set():
            # Clear *before* draining so a wake-up that arrives mid-drain makes
            # the wait below return immediately instead of being lost.
            self.wake.clear()
            try:
                _drain(_utcnow(), self.stop)
            except Exception:
                logger.exception("job worker pass failed")
            self.wake.wait(POLL_INTERVAL_SECONDS)


_worker: Optional[_Worker] = None
_worker_lock = threading.Lock()


def start_worker() -> None:
    """Start the worker thread if it is not already running.

    Jobs left in ``running`` by a previous process are put back in the queue.
    """
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.thread.is_alive():
            return
        _ensure_table()
        with db.SessionLocal() as session:
            session.execute(update(Job).where(Job.status == STATUS_RUNNING).values(status=STATUS_QUEUED))
            session.commit()
        _worker = _Worker()
        _worker.thread.start()


def stop_worker(timeout: float = 5.0) -> None:
    """Stop the worker thread, waiting up to ``timeout`` seconds for it."""
    global _worker
    with _worker_lock:
        worker, _worker = _worker, None
    if worker is None:
        return
    worker.stop.set()
    worker.wake.set()
    if worker.thread is not threading.current_thread():
        worker.thread.join(timeout)


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #


def enqueue(kind: str, payload: Optional[dict] = None, *, run_after: Optional[datetime] = None) -> int:
    """Persist a job and schedule it. Returns the job id.

    ``payload`` must be JSON-serialisable and is handed to the handler as
    decoded from the table. ``run_after`` defers the job until that time
    (naive datetimes are taken as UTC). Raises ``UnknownJobKind`` -- persisting
    nothing -- if no handler is registered for ``kind``.
    """
    if kind not in _handlers:
        raise UnknownJobKind(f"no handler registered for job kind {kind!r}")
    _ensure_table()
    due = _to_naive_utc(run_after) if run_after is not None else None
    with db.SessionLocal() as session:
        job = Job(
            kind=kind,
            payload={} if payload is None else payload,
            status=STATUS_QUEUED,
            run_after=due,
            attempts=0,
        )
        session.add(job)
        session.commit()
        job_id = job.id

    if is_eager():
        # The claim only succeeds if the job is due, so deferred jobs stay queued.
        claimed = _claim_next(_utcnow(), job_id)
        if claimed is not None:
            _execute(claimed)
    else:
        start_worker()
        worker = _worker
        if worker is not None:
            worker.wake.set()
    return job_id
