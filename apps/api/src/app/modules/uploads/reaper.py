"""Garbage collection of abandoned and orphaned uploads (plugin: uploads).

An upload that is created and never finished -- the browser tab closed, the
client gave up -- would otherwise hold its staged parts in the object store
(``uploads/{id}/``) and its share of the owner's quota for ever.
:func:`reap_abandoned_uploads` deletes, for every upload that has not reached the
content store and is older than the TTL (:func:`.config.upload_ttl`, 24 hours by
default), every one of its parts and then its row. It then sweeps parts that no
upload accounts for -- what a crash between those two steps, a request that lost a
race with the deletion, or a final ``PATCH`` that died before deleting its parts
leaves behind: the upload's row is gone, or already holds its bytes in the content
store -- and the files an earlier release staged in ``CONTENT_DIR/.uploads`` that no
upload row accounts for, once those are older than the TTL too.

It also deletes *completed* uploads that their owner's records do not
reference once they are older than :func:`.config.orphan_ttl` (7 days by
default). Without that, a client could fill the content store with files that
never become paper, for free. Whose records count is decided by
:mod:`.references`: an upload is referenced only when a record its *owner*
signed names it (a manifest of the owner's version, or the owner's own
discussion post, notice or decision). A record anyone else signed -- a
standalone manifest posted by a stranger, say -- does not keep it. The upload's
*bytes* are kept whenever a record that uses the file names it, whoever signed
that record: a manifest a ``paper.version`` names (inline or by CID), or a
discussion post, notice or decision. A standalone manifest that no version
names holds nothing back, so an account cannot keep bytes for ever by posting
manifests that never become a paper. When the log cannot be read, the pass
deletes nothing -- bytes are never removed on a guess.

* An upload being appended to right now is skipped, not waited for: the reaper
  asks for the upload's lease the way a ``PATCH`` does and moves on when it is
  held. It is reaped on a later run if it is still abandoned.
* A completed upload its owner's records name is finished work and is never
  touched. Identical bytes share one blob, so the blob goes only when the last
  upload naming it is removed and no record names it.
* "Older" is measured from creation for an incomplete upload, and from
  completion (falling back to creation for rows written before
  ``completed_at`` existed) for an orphaned one.

:func:`run_reaper_job` is the ``uploads.reap`` job. It queues its own next run
(:data:`INTERVAL` later) before it works, so a failure cannot end the chain, and
:func:`.on_startup <app.modules.uploads.on_startup>` queues the first run when
jobs run on the background worker. In eager mode (``JOBS_EAGER=1``, tests and
local development) no worker ever picks up a deferred job, so nothing is queued;
reap on demand with ``jobs.enqueue(JOB_KIND)`` or :func:`reap_abandoned_uploads`.
This is blocking object-store and database I/O: call it from a worker thread.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import delete, func, inspect, select
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db, jobs
from app.modules import content
from app.storage import ObjectStoreError

from . import config, references, store

logger = logging.getLogger(__name__)

JOB_KIND = "uploads.reap"

#: How long after one run the next is due.
INTERVAL = timedelta(hours=1)


@dataclass(frozen=True)
class Reaped:
    """What one pass deleted."""

    #: Unfinished uploads removed (every staged part, and the row).
    uploads: int = 0
    #: Uploads' staged bytes removed that no unfinished upload row accounted for:
    #: one for each upload whose parts were left in the object store, and one for
    #: each stale file an earlier release staged that no row accounted for.
    orphans: int = 0
    #: Completed uploads removed because their owner's records did not name them.
    completed: int = 0
    #: Content-store rows (and their files) removed with those uploads.
    blobs: int = 0


def _utcnow() -> datetime:
    """Naive UTC "now": the tables store naive UTC timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo is not None else value


def reap_abandoned_uploads(
    now: Optional[datetime] = None,
    ttl: Optional[timedelta] = None,
    orphan_ttl: Optional[timedelta] = None,
) -> Reaped:
    """Delete expired uploads as of ``now``.

    ``ttl`` bounds incomplete uploads (default: the configured 24 hours) and
    ``orphan_ttl`` bounds completed ones their owner's records do not reference
    (default: the configured 7 days).
    """
    current = _naive_utc(now) if now is not None else _utcnow()
    cutoff = current - (ttl if ttl is not None else config.upload_ttl())

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
    completed, blobs = _reap_orphaned_uploads(
        current, orphan_ttl if orphan_ttl is not None else config.orphan_ttl()
    )
    return Reaped(uploads=uploads, orphans=_sweep_orphans(cutoff), completed=completed, blobs=blobs)


def _reap_one(upload_id: str) -> int:
    """Delete one upload's parts and row unless a request holds it; ``1`` if it went."""
    try:
        lock = store.acquire_lock(upload_id)  # the lease a PATCH (and finishing an upload) takes
    except store.UploadBusy:
        return 0
    try:
        session = db.SessionLocal()
        try:
            # Read again now that nobody can finish it under us: an upload that
            # reached the content store since we listed it is not ours to delete.
            upload = session.get(store.Upload, upload_id)
            if upload is None or upload.cid is not None:
                return 0
            # The parts go first, and a store that cannot delete them stops here
            # (the pass logs it): the row, which is what finds them again, stays
            # for the next pass instead of leaving bytes nothing accounts for.
            store.discard_parts(upload_id, best_effort=False)
            deleted = session.execute(
                delete(store.Upload).where(store.Upload.id == upload_id, store.Upload.cid.is_(None))
            ).rowcount
            session.commit()
        finally:
            session.close()
        return 1 if deleted == 1 else 0
    finally:
        lock.release()


def _reap_orphaned_uploads(now: datetime, ttl: timedelta) -> tuple[int, int]:
    """Delete completed uploads older than ``ttl`` that their owner's records do not reference.

    Returns ``(uploads removed, blobs removed)``. The record scan covers exactly
    the CIDs listed here, and an unreadable log aborts this pass: bytes must
    never be deleted on a guess that nothing references them.
    """
    cutoff = now - ttl
    session = db.SessionLocal()
    try:
        candidates = list(
            session.execute(
                select(store.Upload.id, store.Upload.cid, store.Upload.owner_did).where(
                    store.Upload.cid.is_not(None),
                    func.coalesce(store.Upload.completed_at, store.Upload.created_at) < cutoff,
                )
            )
        )
    finally:
        session.close()
    if not candidates:
        return 0, 0

    found = references.scan({cid for _, cid, _ in candidates})
    if found is None:
        return 0, 0

    uploads = blobs = 0
    for upload_id, cid, owner_did in candidates:
        if found.keeps_upload(owner_did, cid):
            continue
        try:
            removed, blob_removed = _reap_completed(upload_id, cid, file_named=found.names_file(cid))
        except Exception:
            logger.exception("could not delete the orphaned upload %s", upload_id)
            continue
        uploads += removed
        blobs += blob_removed
    return uploads, blobs


def _reap_completed(upload_id: str, cid: str, *, file_named: bool = False) -> tuple[int, int]:
    """Delete one unreferenced completed upload; also its blob when nothing else names it.

    ``file_named`` says a record that uses the file (anyone's version manifest,
    or a discussion post, notice or decision) names the bytes: the upload row
    still goes, but the file stays, since deleting it would leave that record
    pointing at nothing.
    """
    session = db.SessionLocal()
    try:
        # ``cid`` is re-checked: the row must still be the completed one we listed.
        deleted = session.execute(
            delete(store.Upload).where(store.Upload.id == upload_id, store.Upload.cid == cid)
        ).rowcount
        session.commit()
    finally:
        session.close()
    if deleted != 1:
        return 0, 0
    if file_named:
        return 1, 0

    # Identical bytes share one blob. Only the last upload naming it may remove
    # it, and only after the row is gone: a row-less file can be adopted by a
    # later store of the same bytes, whereas a row without its file would let a
    # manifest claim bytes that are not there.
    session = db.SessionLocal()
    try:
        still_uploaded = session.scalar(
            select(func.count()).select_from(store.Upload).where(store.Upload.cid == cid)
        )
        if still_uploaded:
            return 1, 0
        removed = session.execute(delete(content.Blob).where(content.Blob.cid == cid)).rowcount
        session.commit()
    finally:
        session.close()
    if removed:
        try:
            content.delete_blob(cid)
        except (OSError, ValueError, content.ContentError, ObjectStoreError):
            # The row is gone, so the bytes can never be served or claimed
            # again; a failed unlink only wastes space until the next pass.
            logger.warning("could not delete the bytes of orphaned blob %s", cid, exc_info=True)
    return 1, int(removed or 0)


def _sweep_orphans(cutoff: datetime) -> int:
    """Delete staged bytes no unfinished upload accounts for; return how many uploads' bytes went."""
    return _sweep_orphan_parts() + _sweep_legacy_staged(cutoff)


#: How many upload ids are looked up in the database at a time while sweeping.
_SWEEP_BATCH = 500


def _sweep_orphan_parts() -> int:
    """Delete the parts of uploads that cannot use them; return how many uploads' parts went.

    A part belongs to an unfinished upload, so one whose upload has no row (it
    was reaped, or its row never survived) or whose row already holds its bytes
    in the content store (the move died before deleting them) is garbage, and
    goes at once: a row is created before any part is written, so there is no
    young part of a row that does not exist yet to spare.
    """
    try:
        staged = store.staged_upload_ids()
    except (ObjectStoreError, OSError):
        logger.warning("could not list the staged upload parts", exc_info=True)
        return 0

    swept = 0
    session = db.SessionLocal()
    try:
        for offset in range(0, len(staged), _SWEEP_BATCH):
            batch = staged[offset : offset + _SWEEP_BATCH]
            finished = {
                upload_id: cid
                for upload_id, cid in session.execute(
                    select(store.Upload.id, store.Upload.cid).where(store.Upload.id.in_(batch))
                )
            }
            for upload_id in batch:
                if upload_id in finished and finished[upload_id] is None:
                    continue  # unfinished: the parts are in use
                try:
                    swept += 1 if store.discard_parts(upload_id, best_effort=False) else 0
                except (ObjectStoreError, OSError):
                    logger.warning("could not delete the orphaned parts of upload %s", upload_id, exc_info=True)
    finally:
        session.close()
    return swept


def _sweep_legacy_staged(cutoff: datetime) -> int:
    """Delete files an earlier release staged in ``CONTENT_DIR/.uploads`` that belong to no upload.

    Only files older than ``cutoff`` go. Nothing writes there now, so what is
    left is an upgrade's leftovers: uploads whose row exist are adopted into the
    object store when next appended to, and the rest are found here.
    """
    directory = store.legacy_staging_dir()
    if directory is None:  # no CONTENT_DIR configured
        return 0
    try:
        entries = list(os.scandir(directory))
    except OSError:  # nothing staged by an earlier release
        return 0
    cutoff_timestamp = cutoff.replace(tzinfo=timezone.utc).timestamp()

    swept = 0
    session = db.SessionLocal()
    try:
        for entry in entries:
            try:
                path = store.legacy_staged_path(entry.name)  # ValueError: not a name we give staged files
                if path is None or not entry.is_file(follow_symlinks=False):
                    continue
                if entry.stat(follow_symlinks=False).st_mtime >= cutoff_timestamp:
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
    logger.info(
        "upload reaper: %s abandoned upload(s), %s orphaned staged upload(s), %s unreferenced completed upload(s) "
        "and %s of their blob(s) deleted",
        result.uploads,
        result.orphans,
        result.completed,
        result.blobs,
    )


# Register at import time so ``jobs.enqueue`` accepts the kind and a worker claims
# it; the module loader imports every plugin package.
jobs.register(JOB_KIND, run_reaper_job)
