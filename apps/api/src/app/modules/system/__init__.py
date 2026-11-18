"""System module (plugin: system): jobs that exist to prove the deployment works.

``system.ping`` does nothing.  A job only reaches ``done`` when a runner has
claimed it from the ``jobs`` table and run its handler to the end, so a ping
that comes back done proves the whole path: the database both processes share,
a worker that loaded the application's modules, and the claim loop itself.
``python -m app.smoke`` (``npm run stack:smoke``) enqueues one from the api
container and waits for the separate worker container to finish it.

The handler lives in a module, not in ``app.smoke``, because a job kind is only
known to the processes that imported its handler: the worker registers handlers
by loading everything under ``app.modules``, and ``jobs.enqueue`` refuses a
kind its own process has no handler for.

This package exposes no ``router``; the module loader discovers it by scan.
"""

from __future__ import annotations

import logging

from app import jobs

logger = logging.getLogger(__name__)

#: The job kind ``python -m app.smoke`` enqueues.
PING_JOB_KIND = "system.ping"

__all__ = ["PING_JOB_KIND", "ping"]


def ping(payload: dict) -> None:
    """The ``system.ping`` handler: succeed, leaving a line in the runner's log."""
    logger.info("system.ping handled by worker %s", jobs.current_worker_id())


jobs.register(PING_JOB_KIND, ping)
