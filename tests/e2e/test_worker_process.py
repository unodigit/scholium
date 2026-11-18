"""Jobs across processes: the API queues them, ``python -m app.worker`` runs them.

``JOBS_MODE=external`` is the cloud shape: the API only writes job rows, and any
number of separate workers claim them.  This is the stack's own smoke check
(``python -m app.smoke``, what ``npm run stack:smoke`` runs inside the api
container) driven against a real API, a real worker and an S3 endpoint:

* with no worker running, the ping job is *not* run by the API -- the check
  fails naming its step -- so a pass can only mean a worker ran it;
* with a worker, the same check passes, and the blob round trip through the
  object store leaves nothing behind;
* the worker maintains the periodic schedule without queueing a period twice,
  and a SIGTERM lets it finish and exit 0.
"""

from __future__ import annotations

import signal

import pytest

from e2e_harness import poll


@pytest.fixture(scope="module")
def stack(nodes):
    node = nodes.make("jobs", storage="s3", jobs="external")
    node.init_key()
    node.start_api()
    return node


def test_without_a_worker_nobody_runs_the_job(stack):
    smoke = stack.python("-m", "app.smoke", "--job-timeout", "4")
    assert smoke.returncode == 1, smoke.stdout + smoke.stderr
    assert "worker ping job" in smoke.stderr, smoke.stderr
    # The object-store step ran first and passed; the failure is only the missing worker.
    assert "s3 blob round trip" in smoke.stdout, smoke.stdout
    statuses = [row[0] for row in stack.sql("SELECT status FROM jobs WHERE kind = 'system.ping'")]
    assert statuses and set(statuses) == {"queued"}, statuses


def test_a_separate_worker_runs_the_job(stack):
    stack.start_worker()
    smoke = stack.python("-m", "app.smoke", "--job-timeout", "60")
    assert smoke.returncode == 0, smoke.stdout + smoke.stderr
    assert smoke.stdout.strip().splitlines()[-1].startswith("smoke: OK"), smoke.stdout
    # The earlier, unclaimed ping was picked up as well once a worker existed.
    poll(
        lambda: {row[0] for row in stack.sql("SELECT status FROM jobs WHERE kind = 'system.ping'")} == {"done"},
        timeout=30, what="every ping job to be done",
    )
    assert stack.s3.keys("smoke/") == [], "the smoke check left its blob in the bucket"


def test_the_worker_keeps_one_job_per_period_for_each_schedule(stack):
    rows = stack.sql(
        "SELECT kind, payload FROM jobs WHERE kind IN ('uploads.reap', 'follows.digest') AND payload LIKE '%dedupe_key%'"
    )
    keys = [(kind, payload) for kind, payload in rows]
    assert {kind for kind, _ in keys} == {"uploads.reap", "follows.digest"}, keys
    assert len(set(keys)) == len(keys), f"a period was queued twice: {keys}"


def test_the_worker_finishes_and_exits_cleanly_on_sigterm(stack):
    worker = stack.worker
    assert worker is not None and worker.alive
    assert worker.stop(signal.SIGTERM, timeout=30) == 0, worker.log
    assert "worker stopped" in worker.log, worker.log


def test_a_one_shot_worker_drains_the_queue_and_exits(stack):
    """``python -m app.worker --once``: for cron-style deployments."""
    pending = stack.spawn("smoke", "-m", "app.smoke", "--job-timeout", "90")
    poll(
        lambda: any(row[0] == "queued" for row in stack.sql("SELECT status FROM jobs WHERE kind = 'system.ping'")),
        timeout=60, what="the smoke check to queue its ping",
    )
    once = stack.python("-m", "app.worker", "--once", timeout=120)
    assert once.returncode == 0, once.stdout + once.stderr
    assert pending.wait_for_exit(timeout=90) == 0, pending.log
    assert "smoke: OK" in pending.log, pending.log
