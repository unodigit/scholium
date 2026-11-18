"""Smoke test for a running stack: ``python -m app.smoke``.

``npm run stack:smoke`` runs this inside the api container, where the settings
are the ones the api itself serves with (PostgreSQL, ``STORAGE_BACKEND=s3``,
``JOBS_MODE=external``).  Two steps run in order and the run stops at the first
that fails:

``s3 blob round trip``
    Writes a random blob through the S3 object store, reads it back and
    compares the bytes, then deletes it.  That needs a reachable endpoint, valid
    credentials, an existing bucket and permission to write, read and delete.

``worker ping job``
    Enqueues a ``system.ping`` job and waits for it to be marked ``done``.  This
    process only writes the queued row; it never runs the job (it refuses to
    start unless ``JOBS_MODE`` is ``external``, because any other mode would run
    the job right here and prove nothing).  So ``done`` can only mean that the
    separate worker, sharing the database, claimed the job and ran its handler.

Output goes to stdout, one line per step.  A failure prints one line to stderr,
``smoke: FAILED at step '<name>': <reason>``, and exits with status 1; success
ends with a line starting ``smoke: OK`` and exits 0.  ``scripts/stack-smoke.sh``
relies on both.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import logging
import os
import sys
import time
import uuid
from collections.abc import Callable, Sequence
from typing import Optional

from sqlalchemy import delete

from app import db, jobs
from app.modules.system import PING_JOB_KIND  # importing it registers the handler enqueue needs
from app.settings import settings
from app.storage import get_object_store

logger = logging.getLogger(__name__)

#: Every smoke blob lives under this prefix, apart from application objects.
BLOB_PREFIX = "smoke/"
#: How many random bytes the blob holds.
BLOB_BYTES = 16 * 1024
#: How long to wait for the worker, in seconds (``--job-timeout``).  The worker
#: polls every second, so this leaves room for one that is still starting.
DEFAULT_JOB_TIMEOUT = 60.0
#: How often the job's row is read while waiting.
POLL_SECONDS = 0.5

#: The line a passing run ends with; ``scripts/stack-smoke.sh`` looks for it.
SUCCESS_PREFIX = "smoke: OK"

STEP_BLOB = "s3 blob round trip"
STEP_JOB = "worker ping job"


class SmokeError(Exception):
    """A step failed.  The message is the reason, written for an operator."""


def check_object_store() -> str:
    """Write a blob through the S3 store, read it back, compare, delete it."""
    backend = settings.STORAGE_BACKEND
    if backend != "s3":
        raise SmokeError(
            f"STORAGE_BACKEND is {backend!r}, not 's3'; this process is not using the S3 store "
            "(compose starts the api and worker with STORAGE_BACKEND=s3)"
        )
    store = get_object_store()
    key = f"{BLOB_PREFIX}{uuid.uuid4().hex}"
    data = os.urandom(BLOB_BYTES)

    deleted = False
    try:
        stored = store.put_stream(key, io.BytesIO(data))
        if stored.size != len(data) or stored.sha256 != hashlib.sha256(data).digest():
            raise SmokeError(
                f"the store kept {stored.size} bytes with a different digest than the {len(data)} bytes written"
            )
        with store.open(key) as body:
            read_back = body.read()
        if read_back != data:
            raise SmokeError(f"read back {len(read_back)} bytes that differ from the {len(data)} bytes written")
        store.delete(key)
        deleted = True
        if store.exists(key):
            raise SmokeError(f"{key} is still in the store after it was deleted")
    finally:
        if not deleted:
            # Keep the original error: this is only about not leaving the blob behind.
            try:
                store.delete(key)
            except Exception:
                logger.warning("could not remove the smoke blob %s", key, exc_info=True)
    return f"{len(data)} bytes written, read back and deleted in bucket {settings.S3_BUCKET!r}"


def _job_state(job_id: int) -> Optional[tuple[str, int]]:
    """``(status, attempts)`` of a job, or ``None`` when its row is gone."""
    with db.SessionLocal() as session:
        row = session.get(jobs.Job, job_id)
        if row is None:
            return None
        return row.status, row.attempts or 0


def _why_not_done(status: str, attempts: int) -> str:
    if status == jobs.STATUS_QUEUED and attempts == 0:
        return "nothing claimed it; is the worker running, and on the same database as the api?"
    if status == jobs.STATUS_QUEUED:
        return f"it failed {attempts} attempt(s) and is waiting to retry; the worker's log has the error"
    if status == jobs.STATUS_RUNNING:
        return "a runner claimed it but has not finished"
    return "it is in an unexpected state"


def check_worker_job(timeout: float = DEFAULT_JOB_TIMEOUT) -> str:
    """Enqueue ``system.ping`` and wait for the separate worker to mark it done."""
    chosen = jobs.mode()
    if chosen != "external":
        raise SmokeError(
            f"JOBS_MODE is {chosen!r}, not 'external'; enqueueing would run the job in this process, "
            "so a done job would say nothing about the worker"
        )
    job_id = jobs.enqueue(PING_JOB_KIND, {"nonce": uuid.uuid4().hex})
    started = time.monotonic()
    deadline = started + timeout
    while True:
        state = _job_state(job_id)
        if state is None:
            raise SmokeError(f"job {job_id} disappeared from the jobs table while waiting for it")
        status, attempts = state
        if status == jobs.STATUS_DONE:
            break
        if status == jobs.STATUS_FAILED:
            raise SmokeError(
                f"job {job_id} ({PING_JOB_KIND}) was marked failed after {attempts} attempt(s); "
                "the worker's log has the error"
            )
        if time.monotonic() >= deadline:
            raise SmokeError(
                f"job {job_id} ({PING_JOB_KIND}) is still {status!r} after {timeout:g}s: "
                + _why_not_done(status, attempts)
            )
        time.sleep(POLL_SECONDS)
    elapsed = time.monotonic() - started

    # The job has served its purpose; do not leave a row behind per smoke run.
    try:
        with db.SessionLocal() as session:
            session.execute(delete(jobs.Job).where(jobs.Job.id == job_id))
            session.commit()
    except Exception:
        logger.warning("could not remove smoke job %s", job_id, exc_info=True)
    return f"job {job_id} was marked done by the worker after {elapsed:.1f}s"


def run_steps(steps: Sequence[tuple[str, Callable[[], str]]]) -> int:
    """Run ``steps`` in order; stop at the first failure and name it."""
    for name, run in steps:
        print(f"smoke: {name} ...", flush=True)
        try:
            detail = run()
        except SmokeError as exc:
            reason = str(exc)
        except Exception as exc:  # any other failure is a failed step too, never a bare traceback
            reason = f"{type(exc).__name__}: {exc}"
        else:
            print(f"smoke: {name}: ok ({detail})", flush=True)
            continue
        print(f"smoke: FAILED at step {name!r}: {reason}", file=sys.stderr, flush=True)
        return 1
    print(f"{SUCCESS_PREFIX} ({len(steps)} steps passed)", flush=True)
    return 0


def _positive_seconds(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a number of seconds") from None
    if not value > 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return value


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.smoke",
        description="Check a running stack: S3 blob round trip, then a system.ping job done by the worker.",
    )
    parser.add_argument(
        "--job-timeout",
        type=_positive_seconds,
        default=DEFAULT_JOB_TIMEOUT,
        metavar="SECONDS",
        help=f"how long to wait for the worker to finish the job (default {DEFAULT_JOB_TIMEOUT:g})",
    )
    args = parser.parse_args(argv)
    return run_steps(
        (
            (STEP_BLOB, check_object_store),
            (STEP_JOB, lambda: check_worker_job(args.job_timeout)),
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
