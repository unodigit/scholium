"""Garbage collection of abandoned uploads (plugin: uploads).

An upload that is created and never finished -- the browser tab closed, the
client gave up -- would otherwise hold its staged bytes in ``CONTENT_DIR/.uploads``
and its share of the owner's quota for ever. :func:`reap_abandoned_uploads`
deletes, for every upload that has not reached the content store and is older
than the TTL (:func:`.config.upload_ttl`, 24 hours by default), both the row and
the staged bytes. It then sweeps staged files that no upload row accounts for
(what a crash between the two steps, or a request that lost a race with the
deletion, leaves behind) once they are older than the TTL too.

* An upload being appended to right now is skipped, not waited for: the reaper
  asks for the upload's lock the way a ``PATCH`` does and moves on when it is
  held. It is reaped on a later run if it is still abandoned.
* An upload whose bytes are in the content store (``cid`` set) is finished and is
  never touched; the content store is not this module's to clean.
* "Older" is measured from creation, as the TTL is a bound on how long an
  incomplete upload may exist.

:func:`run_reaper_job` is the ``uploads.reap`` job. It queues its own next run
(:data:`INTERVAL` later) before it works, so a failure cannot end the chain, and
:func:`.on_startup <app.modules.uploads.on_startup>` queues the first run when
jobs run on the background worker. In eager mode (``JOBS_EAGER=1``, tests and
local development) no worker ever picks up a deferred job, so nothing is queued;
reap on demand with ``jobs.enqueue(JOB_KIND)`` or :func:`reap_abandoned_uploads`.
This is blocking file and database I/O: call it from a worker thread.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import delete, inspect, select
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db, jobs

from . import config, store

logger = logging.getLogger(__name__)

JOB_KIND = "uploads.reap"

#: How long after one run the next is due.
INTERVAL = timedelta(hours=1)


@dataclass(frozen=True)
class Reaped:
    """What one pass deleted."""

    #: Unfinished uploads removed (row and staged bytes).
    uploads: int = 0
    #: Staged files removed that no upload row accounted for.
    orphans: int = 0


def _utcnow() -> datetime:
    """Naive UTC "now": the tables store naive UTC timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo is not None else value


def reap_abandoned_uploads(now: Optional[datetime] = None, ttl: Optional[timedelta] = None) -> Reaped:
    """Delete the unfinished uploads older than ``ttl`` (default: the configured TTL) as of ``now``."""
    cutoff = (_naive_utc(now) if now is not None else _utcnow()) - (ttl if ttl is not None else config.upload_ttl())

    session = db.SessionLocal()
    try:
        expired = list(
            session.scalars(select(store.Upload.id).where(store.Upload.cid.is_(None), store.Upload.created_at < cutoff))
        )
    finally:
        session.close()

    uploads = 0
    for upload_id in expired:
        try:
            uploads += _reap_one(upload_id)
        except Exception:
            # One upload that cannot be removed must not keep the rest from it.
            logger.exception("could not delete the abandoned upload %s", upload_id)
    return Reaped(uploads=uploads, orphans=_sweep_orphans(cutoff))


def _reap_one(upload_id: str) -> int:
    """Delete one upload's row and staged bytes unless a request holds it; ``1`` if it went."""
    try:
        staged = store.open_staged(upload_id)  # the lock a PATCH (and finishing an upload) takes
    except store.UploadBusy:
        return 0
    try:
        session = db.SessionLocal()
        try:
            # ``cid`` is re-checked: an upload finished since we listed it is not ours to delete.
            deleted = session.execute(
                delete(store.Upload).where(store.Upload.id == upload_id, store.Upload.cid.is_(None))
            ).rowcount
            session.commit()
        finally:
            session.close()
        store.discard_staged(upload_id)
        return 1 if deleted == 1 else 0
    finally:
        staged.close()


def _sweep_orphans(cutoff: datetime) -> int:
    """Delete staged files older than ``cutoff`` that belong to no upload; return how many."""
    try:
        entries = list(os.scandir(store.staging_dir()))
    except (OSError, RuntimeError):  # nothing staged yet, or no CONTENT_DIR configured
        return 0
    cutoff_timestamp = cutoff.replace(tzinfo=timezone.utc).timestamp()

    swept = 0
    session = db.SessionLocal()
    try:
        for entry in entries:
            try:
                path = store.staged_path(entry.name)  # ValueError: not a name we give staged files
                if not entry.is_file(follow_symlinks=False) or entry.stat(follow_symlinks=False).st_mtime >= cutoff_timestamp:
                    continue
                if session.get(store.Upload, entry.name) is not None:
                    continue
                path.unlink()
                swept += 1
            except (OSError, ValueError):
                continue
    finally:
        session.close()
    return swept


# --------------------------------------------------------------------------- #
# The job
# --------------------------------------------------------------------------- #


def _ensure_jobs_table() -> None:
    """Create the ``jobs`` table if it is missing (plugins start before ``create_all``)."""
    try:
        jobs.Job.__table__.create(bind=db.engine, checkfirst=True)
    except (OperationalError, ProgrammingError):
        # ``checkfirst`` is not atomic: another process may have created it.
        if not inspect(db.engine).has_table(jobs.Job.__tablename__):
            raise


def _reaper_job_queued() -> bool:
    with db.SessionLocal() as session:
        waiting = session.execute(
            select(jobs.Job.id).where(jobs.Job.kind == JOB_KIND, jobs.Job.status == jobs.STATUS_QUEUED).limit(1)
        ).first()
    return waiting is not None


def schedule_reaper(*, delay: timedelta = INTERVAL, now: Optional[datetime] = None) -> Optional[int]:
    """Queue a reaper run ``delay`` from ``now`` unless one is already waiting.

    Returns the new job's id, or ``None`` when an ``uploads.reap`` job is already
    queued. Written straight to the table rather than through
    :func:`app.jobs.enqueue`: ``enqueue`` also starts the worker thread, which the
    application's lifespan owns, and a job that is not due yet needs no waking.
    The worker finds it by its poll.
    """
    _ensure_jobs_table()
    if _reaper_job_queued():
        return None
    due = _naive_utc(now) if now is not None else _utcnow()
    with db.SessionLocal() as session:
        job = jobs.Job(kind=JOB_KIND, payload={}, status=jobs.STATUS_QUEUED, run_after=due + delay, attempts=0)
        session.add(job)
        session.commit()
        return job.id


def run_reaper_job(payload: Any = None) -> None:
    """The ``uploads.reap`` job handler: queue the next run, then reap."""
    schedule_reaper()
    result = reap_abandoned_uploads()
    logger.info("upload reaper: %s abandoned upload(s) and %s orphaned staged file(s) deleted", result.uploads, result.orphans)


# Register at import time so ``jobs.enqueue`` accepts the kind and a worker claims
# it; the module loader imports every plugin package.
jobs.register(JOB_KIND, run_reaper_job)
