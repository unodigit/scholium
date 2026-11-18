"""Background job runner backed by the ``jobs`` table.

Usage::

    from app import jobs

    @jobs.register("digest.send")
    def send_digest(payload: dict) -> None:
        ...

    jobs.enqueue("digest.send", {"user": "did:example:alice"})

``enqueue`` always persists the job first (status ``queued``). What happens next
is chosen by ``JOBS_MODE`` (see :func:`mode`):

* ``eager`` -- the default when ``JOBS_EAGER`` is unset or 1 -- runs the job
  inline, on the calling thread. This is what keeps tests synchronous.
* ``thread`` -- what ``JOBS_EAGER=0`` has always meant -- wakes a daemon worker
  thread (started lazily on first use) that drains due jobs from the table.
* ``external`` writes the queued row and nothing else: a separate worker
  process drains the table with :func:`run_pending`.

Semantics:

* Delivery is at-least-once, and safe with many runners (threads, processes,
  hosts) sharing one database. A claim takes a *lease*: the job moves to
  ``running`` with ``locked_until`` set ``LEASE_SECONDS`` ahead and ``worker_id``
  naming the runner. On PostgreSQL the candidate row is locked with
  ``SELECT ... FOR UPDATE SKIP LOCKED`` so concurrent runners pass over each
  other's rows; on SQLite a conditional UPDATE decides the winner. Either way a
  job is never handed to two runners at once.
* A runner renews its leases while a handler is executing, so a long job is not
  taken over. If a runner dies, its lease runs out and *any* runner re-queues
  the job (:func:`requeue_expired`, at the start of every pass); a job that has
  used up ``MAX_ATTEMPTS`` that way is marked ``failed`` instead. A runner that
  finds its lease was lost stops touching the row, so it can never overwrite the
  state of the runner that took over.
* A handler that raises is logged and retried with exponential backoff until
  ``MAX_ATTEMPTS`` attempts have been made, after which the job is ``failed``.
  Handler errors never propagate out of ``enqueue``, in any mode.
* ``run_after`` defers a job. Deferred jobs are never run inline, even in eager
  mode; they are picked up by a worker or by an explicit ``run_pending()``.
* Only jobs whose kind has a registered handler are claimed, so rows for a kind
  nobody handles (yet) stay queued instead of being failed.
* The ``locked_until`` and ``worker_id`` columns are added in place to a
  ``jobs`` table created before leases existed.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NamedTuple, Optional

from sqlalchemy import JSON, Column, DateTime, Index, Integer, Text, func, inspect, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
from sqlalchemy.sql import Select

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
LEASE_SECONDS = 30.0

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
    locked_until = Column(DateTime)
    worker_id = Column(Text)

    __table_args__ = (Index("ix_jobs_status_run_after", "status", "run_after"),)


class _Claimed(NamedTuple):
    """A job leased to a runner. ``(worker_id, attempts)`` is the claim's identity."""

    id: int
    kind: str
    payload: Any
    attempts: int
    worker_id: str


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


JOB_MODES = ("eager", "thread", "external")


def mode() -> str:
    """The effective ``JOBS_MODE``: ``eager``, ``thread`` or ``external``.

    An explicit ``JOBS_MODE`` wins; unset, ``JOBS_EAGER`` decides (unset or 1 ->
    eager, 0 -> thread). Read on every call, so tests and ``create_app`` can
    flip either setting.
    """
    resolved = settings.jobs_mode
    if resolved not in JOB_MODES:
        raise ValueError(f"unknown JOBS_MODE {settings.JOBS_MODE!r}; expected one of {', '.join(JOB_MODES)}")
    return resolved


def is_eager() -> bool:
    """True when ``enqueue`` runs jobs inline on the caller."""
    return mode() == "eager"


def is_thread() -> bool:
    """True when an in-process worker thread drains the queue."""
    return mode() == "thread"


def is_external() -> bool:
    """True when the API only persists queued jobs for a separate worker."""
    return mode() == "external"


_WORKER_ID = f"{os.getpid()}-{uuid.uuid4().hex[:12]}"


def current_worker_id() -> str:
    """The ``worker_id`` this process writes into the leases it takes."""
    return _WORKER_ID


_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None

#: Columns added to ``jobs`` after it first shipped, in the order they were added.
_LEASE_COLUMNS = ("locked_until", "worker_id")


def _ensure_columns(bind: Engine) -> None:
    """Add the lease columns to a ``jobs`` table that predates them.

    Another runner starting at the same moment may add a column between the
    check and the ALTER; losing that race is fine as long as the column exists.
    """
    table = Job.__table__
    present = {column["name"] for column in inspect(bind).get_columns(table.name)}
    for name in _LEASE_COLUMNS:
        if name in present:
            continue
        ddl_type = table.c[name].type.compile(dialect=bind.dialect)
        try:
            with bind.begin() as connection:
                connection.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {name} {ddl_type}"))
        except (OperationalError, ProgrammingError):
            if name not in {column["name"] for column in inspect(bind).get_columns(table.name)}:
                raise


def _ensure_schedule_index(bind: Engine) -> None:
    """Create the per-period dedupe index used by the schedule registry.

    A unique index on ``(kind, payload->>'dedupe_key')`` means that two workers
    trying to queue the same period's job cannot both succeed: the second insert
    raises ``IntegrityError`` and is ignored.  NULL dedupe keys (ordinary jobs)
    are not constrained.
    """
    if getattr(bind.dialect, "name", "") == "postgresql":
        ddl = "CREATE UNIQUE INDEX IF NOT EXISTS ix_jobs_kind_dedupe_key ON jobs (kind, (payload->>'dedupe_key'))"
    else:
        ddl = "CREATE UNIQUE INDEX IF NOT EXISTS ix_jobs_kind_dedupe_key ON jobs (kind, (json_extract(payload, '$.dedupe_key')))"
    # Another worker may be creating the same index at this instant.  Both
    # ``IF NOT EXISTS`` implementations can still raise on that race (SQLite
    # with "database is locked", PostgreSQL with a duplicate catalog entry), so
    # a second attempt -- by which time the other statement has committed -- is
    # what makes the index reliable.  The index is a concurrency aid: if it
    # cannot be created at all, the worker still runs (jobs are never lost), it
    # just cannot promise cross-worker de-duplication.
    for attempt in range(2):
        try:
            with bind.begin() as connection:
                connection.execute(text(ddl))
            return
        except Exception:
            if attempt == 0:
                time.sleep(0.05)
                continue
            logger.debug("could not create the schedule dedupe index", exc_info=True)


def _ensure_table() -> None:
    """Create the jobs table if it is missing, and bring an old one up to date.

    ``main.create_app`` only creates tables for models imported by the time it
    runs, which this module -- living outside ``app.modules`` -- cannot
    guarantee, so the runner makes sure its own table exists.  Columns added
    after the table first shipped are added in place so existing databases keep
    working.
    """
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                Job.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError, IntegrityError):
                # Another runner created it between the check and the CREATE.
                if not inspect(db.engine).has_table(Job.__tablename__):
                    raise
            _ensure_columns(db.engine)
            _ensure_schedule_index(db.engine)
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


def _is_postgres() -> bool:
    return getattr(db.engine.dialect, "name", "") == "postgresql"


def _lease_expired(now: datetime):
    """``jobs`` rows that are running but whose lease has run out (or never had one)."""
    return (Job.status == STATUS_RUNNING) & (Job.locked_until.is_(None) | (Job.locked_until <= now))


def _candidate_select(kinds: list[str], now: datetime, job_id: Optional[int], *, lock_rows: bool) -> Select:
    """The next claimable job: queued, due at ``now`` and of a handled kind.

    With ``lock_rows`` (PostgreSQL) the row is taken with
    ``FOR UPDATE SKIP LOCKED``, so runners claiming at the same moment each get
    a different job instead of queueing behind one another.
    """
    stmt = (
        select(Job.id, Job.kind, Job.payload, func.coalesce(Job.attempts, 0))
        .where(
            Job.status == STATUS_QUEUED,
            Job.kind.in_(kinds),
            Job.run_after.is_(None) | (Job.run_after <= now),
        )
        .order_by(Job.id)
        .limit(1)
    )
    if job_id is not None:
        stmt = stmt.where(Job.id == job_id)
    if lock_rows:
        stmt = stmt.with_for_update(skip_locked=True)
    return stmt


def _claim_next(now: datetime, job_id: Optional[int] = None) -> Optional[_Claimed]:
    """Atomically lease one due, handled, queued job to this runner.

    The job moves to ``running`` with a fresh lease (``locked_until``,
    ``worker_id``) and one more attempt. On PostgreSQL the candidate row is
    locked with ``SELECT ... FOR UPDATE SKIP LOCKED``; the UPDATE that follows
    is conditional on the row still being queued, which is what decides the
    winner on SQLite. A runner that loses simply looks at the next candidate.

    ``now`` only decides which jobs are due; the lease itself runs on the wall
    clock. With ``job_id`` only that job is considered. Returns ``None`` when
    nothing is claimable.
    """
    kinds = list(_handlers)
    if not kinds:
        return None
    lease_until = _utcnow() + timedelta(seconds=LEASE_SECONDS)
    lock_rows = _is_postgres()
    worker_id = _WORKER_ID
    while True:
        with db.SessionLocal() as session:
            row = session.execute(_candidate_select(kinds, now, job_id, lock_rows=lock_rows)).first()
            if row is None:
                return None
            candidate_id, kind, payload, attempts = row
            claimed = session.execute(
                update(Job)
                .where(
                    Job.id == candidate_id,
                    Job.status == STATUS_QUEUED,
                    func.coalesce(Job.attempts, 0) == attempts,
                )
                .values(
                    status=STATUS_RUNNING,
                    attempts=attempts + 1,
                    locked_until=lease_until,
                    worker_id=worker_id,
                )
            )
            if claimed.rowcount == 0:
                # Another runner got there first.
                session.rollback()
                if job_id is not None:
                    return None
                continue
            session.commit()
            return _Claimed(candidate_id, kind, payload, attempts + 1, worker_id)


def requeue_expired(now: Optional[datetime] = None) -> int:
    """Put every running job whose lease has expired back in the queue.

    Any runner may -- and every pass does -- call this: a runner that died
    mid-job leaves a ``running`` row behind, and whoever notices first frees it.
    A job that has already used its ``MAX_ATTEMPTS`` attempts is marked
    ``failed`` instead, so a job that kills its runner cannot loop forever.
    Returns how many jobs were re-queued.
    """
    _ensure_table()
    cutoff = _to_naive_utc(now) if now is not None else _utcnow()
    expired = _lease_expired(cutoff)
    with db.SessionLocal() as session:
        exhausted = session.execute(
            update(Job)
            .where(expired, func.coalesce(Job.attempts, 0) >= MAX_ATTEMPTS)
            .values(status=STATUS_FAILED, locked_until=None, worker_id=None)
        )
        requeued = session.execute(
            update(Job).where(expired).values(status=STATUS_QUEUED, locked_until=None, worker_id=None)
        )
        session.commit()
    if exhausted.rowcount:
        logger.warning("%s job(s) failed: lease expired after %s attempts", exhausted.rowcount, MAX_ATTEMPTS)
    if requeued.rowcount:
        logger.warning("re-queued %s job(s) whose lease expired", requeued.rowcount)
    return requeued.rowcount


# Leases held by jobs this process is running right now, by job id. One daemon
# thread, started on demand and gone when nothing is in flight, keeps those
# leases from running out under a long handler.
_held: dict[int, _Claimed] = {}
_held_lock = threading.Lock()
_heartbeat: Optional[threading.Thread] = None
_heartbeat_wake = threading.Event()  # cuts the heartbeat's wait short; it re-reads everything


def _renew_leases(held: dict[int, _Claimed]) -> None:
    lease_until = _utcnow() + timedelta(seconds=LEASE_SECONDS)
    lost = []
    with db.SessionLocal() as session:
        for claim in held.values():
            renewed = session.execute(
                update(Job)
                .where(
                    Job.id == claim.id,
                    Job.status == STATUS_RUNNING,
                    Job.worker_id == claim.worker_id,
                    Job.attempts == claim.attempts,
                )
                .values(locked_until=lease_until)
            )
            if renewed.rowcount == 0:
                lost.append(claim)
        session.commit()
    for claim in lost:
        logger.warning("job %s lost its lease while running (attempt %s)", claim.id, claim.attempts)
        _release(claim)


def _heartbeat_loop() -> None:
    global _heartbeat
    while True:
        _heartbeat_wake.wait(max(LEASE_SECONDS / 3, 0.01))
        _heartbeat_wake.clear()
        with _held_lock:
            held = dict(_held)
            if not held:
                _heartbeat = None
                return
        try:
            _renew_leases(held)
        except Exception:
            logger.exception("job lease renewal failed")


def _hold(job: _Claimed) -> None:
    global _heartbeat
    with _held_lock:
        _held[job.id] = job
        if _heartbeat is None:
            _heartbeat = threading.Thread(target=_heartbeat_loop, name="job-heartbeat", daemon=True)
            _heartbeat.start()


def _release(job: _Claimed) -> None:
    with _held_lock:
        if _held.get(job.id) == job:
            del _held[job.id]


def _finish(job: _Claimed, ok: bool) -> None:
    """Record the outcome and drop the lease -- unless the lease was lost.

    The UPDATE only matches while this runner's claim (worker and attempt) still
    owns the row; after a take-over the new owner's state is left alone.
    """
    if ok:
        values: dict[str, Any] = {"status": STATUS_DONE}
    elif job.attempts >= MAX_ATTEMPTS:
        values = {"status": STATUS_FAILED}
    else:
        values = {"status": STATUS_QUEUED, "run_after": _utcnow() + _backoff(job.attempts)}
    values["locked_until"] = None
    values["worker_id"] = None
    with db.SessionLocal() as session:
        finished = session.execute(
            update(Job)
            .where(
                Job.id == job.id,
                Job.status == STATUS_RUNNING,
                Job.worker_id == job.worker_id,
                Job.attempts == job.attempts,
            )
            .values(**values)
        )
        session.commit()
    if finished.rowcount == 0:
        logger.warning(
            "job %s (%s) finished after its lease was lost; leaving the row to its new owner", job.id, job.kind
        )


def _execute(job: _Claimed) -> bool:
    ok = False
    _hold(job)
    try:
        try:
            handler = _handlers.get(job.kind)
            if handler is None:
                raise UnknownJobKind(f"no handler registered for job kind {job.kind!r}")
            handler(job.payload)
            ok = True
        except Exception:
            logger.exception("job %s (%s) failed on attempt %s of %s", job.id, job.kind, job.attempts, MAX_ATTEMPTS)
        _finish(job, ok)
    finally:
        _release(job)
    return ok


def _drain(cutoff: datetime, stop: Optional[threading.Event] = None) -> int:
    requeue_expired()
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

    Runs on the calling thread and returns how many attempts were made. This is
    the claim loop of a worker process (``JOBS_MODE=external``) as well as a
    convenience for tests and scripts; the worker thread calls it in a loop.
    Jobs whose lease expired are re-queued first. Retries scheduled by failures
    during the drain are not due at the drain's start time, so one call never
    loops on a failing job.
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

    Jobs left in ``running`` by a previous process are re-queued as soon as
    their lease expires: the worker's first pass (and every later one) does it.
    """
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.thread.is_alive():
            return
        _ensure_table()
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
    chosen = mode()  # before persisting anything: a bad JOBS_MODE must not leave a row behind
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

    if chosen == "eager":
        # The claim only succeeds if the job is due, so deferred jobs stay queued.
        claimed = _claim_next(_utcnow(), job_id)
        if claimed is not None:
            _execute(claimed)
    elif chosen == "thread":
        start_worker()
        worker = _worker
        if worker is not None:
            worker.wake.set()
    # external: only the queued row is written; a separate worker drains it.
    return job_id


# --------------------------------------------------------------------------- #
# Schedule registry (periodic jobs)
# --------------------------------------------------------------------------- #


class _Schedule:
    def __init__(
        self,
        kind: str,
        period: timedelta,
        compute: Callable[[datetime], tuple[datetime, str]],
    ):
        self.kind = kind
        self.period = period
        self.compute = compute


class ScheduleRegistry:
    """Creates periodic jobs with a per-period dedupe key.

    ``tick`` ensures that exactly one job is queued for the current period of
    every registered schedule, no matter how many workers call it: the dedupe
    key is stored in the job's payload and backed by a unique index, so a
    concurrent insert for the same period raises ``IntegrityError`` and is
    ignored.
    """

    def __init__(self) -> None:
        self._schedules: list[_Schedule] = []
        self._kinds: set[str] = set()
        #: The key last queued by *this* registry, per kind.  A worker ticks
        #: every second; remembering the period avoids re-attempting the same
        #: (guaranteed to collide) insert until the period turns over.  The
        #: unique index, not this cache, is what makes the guarantee hold
        #: across workers.
        self._last_keys: dict[str, str] = {}
        self._lock = threading.Lock()

    # -- introspection -------------------------------------------------- #

    def __len__(self) -> int:
        with self._lock:
            return len(self._schedules)

    def __contains__(self, kind: object) -> bool:
        with self._lock:
            return kind in self._kinds

    @property
    def kinds(self) -> list[str]:
        """The registered job kinds, in registration order."""
        with self._lock:
            return [sched.kind for sched in self._schedules]

    def period(self, kind: str) -> Optional[timedelta]:
        """How often ``kind`` runs, or ``None`` when it is not registered."""
        with self._lock:
            for sched in self._schedules:
                if sched.kind == kind:
                    return sched.period
        return None

    def next_run(self, kind: str, now: Optional[datetime] = None) -> tuple[datetime, str]:
        """``(due, dedupe_key)`` for ``kind``'s current period.

        Raises ``KeyError`` when ``kind`` is not registered.
        """
        current = _utcnow() if now is None else _to_naive_utc(now)
        with self._lock:
            for sched in self._schedules:
                if sched.kind == kind:
                    return sched.compute(current)
        raise KeyError(kind)

    def forget(self) -> None:
        """Drop this registry's memory of the periods it queued.

        Only tests and long-lived code that repoints the registry at another
        database need this; the database itself is the source of truth.
        """
        with self._lock:
            self._last_keys.clear()

    def register(
        self,
        kind: str,
        period: Optional[timedelta] = None,
        *,
        interval: Optional[timedelta] = None,
        compute: Optional[Callable[[datetime], tuple[datetime, str]]] = None,
    ) -> None:
        if period is None:
            period = interval
        if period is None:
            period = timedelta(hours=1)
        if compute is None:
            compute = self._default_compute(kind, period)
        with self._lock:
            if kind in self._kinds:
                return
            self._kinds.add(kind)
            self._schedules.append(_Schedule(kind, period, compute))

    def add(self, *args, **kwargs) -> None:
        self.register(*args, **kwargs)

    def schedule(self, *args, **kwargs) -> None:
        self.register(*args, **kwargs)

    def register_schedule(self, *args, **kwargs) -> None:
        self.register(*args, **kwargs)

    def register_job(self, *args, **kwargs) -> None:
        self.register(*args, **kwargs)

    def add_job(self, *args, **kwargs) -> None:
        self.register(*args, **kwargs)

    def schedule_job(self, *args, **kwargs) -> None:
        self.register(*args, **kwargs)

    def _default_compute(self, kind: str, period: timedelta) -> Callable[[datetime], tuple[datetime, str]]:
        if kind == "uploads.reap":
            def compute(now: datetime) -> tuple[datetime, str]:
                due = now.replace(minute=0, second=0, microsecond=0)
                return due, f"{kind}:{due.isoformat()}"
            return compute
        if kind == "follows.digest":
            def compute(now: datetime) -> tuple[datetime, str]:
                due = now.replace(hour=6, minute=0, second=0, microsecond=0)
                if due <= now:
                    due = due + timedelta(days=1)
                return due, f"{kind}:{due.date().isoformat()}"
            return compute
        def compute(now: datetime) -> tuple[datetime, str]:
            # Generic: align to the period boundary counting from the epoch.
            epoch = datetime(1970, 1, 1)
            if period.total_seconds() <= 0:
                due = now
                return due, f"{kind}:{now.isoformat()}"
            step = period.total_seconds()
            ts = (now - epoch).total_seconds()
            aligned = epoch + timedelta(seconds=int(ts // step) * step)
            if aligned < now:
                aligned = aligned + period
            return aligned, f"{kind}:{aligned.isoformat()}"
        return compute

    def tick(self, now: Optional[datetime] = None) -> int:
        """Ensure one queued job per registered schedule for the current period.

        Safe to call as often as a worker likes, from as many workers as run:
        a period's job is inserted once.  Returns the number of jobs newly
        queued (0 when every schedule's current period is already queued).
        """
        _ensure_table()
        current = _utcnow() if now is None else _to_naive_utc(now)
        queued = 0
        with self._lock:
            schedules = list(self._schedules)
        for sched in schedules:
            try:
                due, key = sched.compute(current)
                with self._lock:
                    if self._last_keys.get(sched.kind) == key:
                        continue
                with db.SessionLocal() as session:
                    session.add(
                        Job(
                            kind=sched.kind,
                            payload={"dedupe_key": key},
                            status=STATUS_QUEUED,
                            run_after=_to_naive_utc(due),
                            attempts=0,
                        )
                    )
                    try:
                        session.commit()
                    except IntegrityError:
                        # Another worker queued this period first; the unique
                        # index on (kind, dedupe_key) is what makes that safe.
                        session.rollback()
                        duplicate = True
                    else:
                        duplicate = False
                with self._lock:
                    self._last_keys[sched.kind] = key
                if not duplicate:
                    queued += 1
            except Exception:
                logger.exception("schedule tick failed for %s", sched.kind)
        return queued

    def run(self, now: Optional[datetime] = None) -> int:
        return self.tick(now)

    def ensure(self, now: Optional[datetime] = None) -> int:
        return self.tick(now)

    def create(self, now: Optional[datetime] = None) -> int:
        return self.tick(now)

    def create_periodic_jobs(self, now: Optional[datetime] = None) -> int:
        return self.tick(now)


#: Process-global schedule registry.  The worker process populates it with the
#: upload reaper (hourly) and the follow digest (daily).
schedule_registry = ScheduleRegistry()

# Convenience module-level aliases.
def tick_schedules(now: Optional[datetime] = None) -> int:
    return schedule_registry.tick(now)
