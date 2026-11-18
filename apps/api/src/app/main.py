"""FastAPI application factory."""

import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Callable, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from . import db, jobs, module_loader
from .middleware import install_write_throttle
from .settings import settings
from .storage import get_object_store

logger = logging.getLogger(__name__)

#: The longest ``GET /readyz`` waits for its dependencies, all of them together.
#: A dependency that has not answered by then is reported as down: the object
#: store's client alone retries for far longer than a probe should wait.  Kept
#: below the compose healthcheck timeout so the answer arrives in time.
READYZ_TIMEOUT_SECONDS = 3.0

#: The prefix listed to prove the object store answers.  Listing writes nothing,
#: and it only succeeds when the endpoint, the credentials and the bucket (or,
#: for the filesystem driver, the directory) are all usable.
_READYZ_PROBE_PREFIX = "readyz/"


def _check_database() -> None:
    """Raise unless the database answers a trivial query."""
    with db.engine.connect() as connection:
        connection.execute(text("SELECT 1"))


def _check_object_store() -> None:
    """Raise unless the configured object store answers a (read-only) listing."""
    next(iter(get_object_store().list(_READYZ_PROBE_PREFIX)), None)


def _readiness_checks() -> tuple[tuple[str, Callable[[], None]], ...]:
    """The dependencies ``/readyz`` checks, by the name the response gives them."""
    return (("database", _check_database), ("object_store", _check_object_store))


class _Probe(threading.Thread):
    """One readiness check on its own daemon thread.

    The request waits for the probe with a deadline instead of calling the
    check inline, so a dependency that hangs costs a 503, not a stuck request.
    The thread is a daemon and outside the web server's thread pool, so a hung
    check can neither starve the other routes (``/healthz`` included) nor delay
    shutdown; it ends when the dependency's own timeout does.
    """

    def __init__(self, dependency: str, check: Callable[[], None]) -> None:
        super().__init__(name=f"readyz-{dependency}", daemon=True)
        self.dependency = dependency
        self._check = check
        self.error: Optional[Exception] = None

    def run(self) -> None:
        try:
            self._check()
        except Exception as exc:  # reported through ``error``, never raised
            self.error = exc


def _failing_dependencies() -> list[str]:
    """The names of the dependencies that did not answer in time, in check order."""
    probes = [_Probe(name, check) for name, check in _readiness_checks()]
    for probe in probes:
        probe.start()
    deadline = time.monotonic() + READYZ_TIMEOUT_SECONDS
    failing = []
    for probe in probes:
        probe.join(max(0.0, deadline - time.monotonic()))
        if probe.is_alive():
            logger.warning("readyz: %s did not answer within %.1fs", probe.dependency, READYZ_TIMEOUT_SECONDS)
            failing.append(probe.dependency)
        elif probe.error is not None:
            # The log gets the reason; the response never does (it is public).
            logger.warning(
                "readyz: %s check failed: %s: %s",
                probe.dependency, type(probe.error).__name__, probe.error,
            )
            failing.append(probe.dependency)
    return failing


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # In thread mode an in-process worker drains the queue. Eager mode runs
    # jobs inline on enqueue; external mode leaves them for a separate worker.
    if jobs.is_thread():
        jobs.start_worker()
    try:
        yield
    finally:
        if jobs.is_thread():
            jobs.stop_worker()


def create_app() -> FastAPI:
    settings.validate_for_environment()
    app = FastAPI(title="Scholium", lifespan=_lifespan)

    # Load modules first so their models register on Base.metadata.
    module_loader.load_modules(app)

    # Create database tables after modules have loaded.
    db.create_all()

    # Middleware added last runs first: CORS must wrap the throttle so that
    # preflights and 429 responses both carry CORS headers.
    if settings.RATE_LIMIT_ENABLED:
        install_write_throttle(app)
    # The refresh token travels in an HttpOnly cookie, so the browser must be
    # allowed to send credentials cross-origin -- but only to the explicitly
    # configured web origins.  With a wildcard origin Starlette would echo
    # whatever Origin asks (credentials included), so a "*" entry keeps
    # credentials off rather than opening them to every site.
    web_origins = settings.web_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=web_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        allow_headers=[
            "Authorization", "Content-Type", "Accept", "Idempotency-Key",
            "Tus-Resumable", "Upload-Length", "Upload-Offset", "Upload-Metadata",
        ],
        expose_headers=[
            "Location", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining",
            "Tus-Resumable", "Upload-Offset", "Upload-Length", "Upload-Cid",
        ],
        allow_credentials="*" not in web_origins,
        max_age=600,
    )

    # Liveness: the process is up and serving.  It deliberately touches no
    # dependency, so an outage of the database or the object store never gets
    # the API restarted for something a restart cannot fix.
    @app.get("/healthz", status_code=200)
    def healthz() -> dict:
        return {"status": "ok"}

    # Readiness: the dependencies this process needs to do its work answer.  200
    # when they all do; 503 naming each one that does not, so an operator (or a
    # load balancer holding traffic back) can tell which to look at.
    @app.get(
        "/readyz",
        status_code=200,
        responses={503: {"description": "A dependency (database, object_store) is not answering."}},
    )
    def readyz() -> JSONResponse:
        failing = _failing_dependencies()
        checks = {
            name: "unavailable" if name in failing else "ok"
            for name, _ in _readiness_checks()
        }
        body: dict = {"status": "unavailable" if failing else "ok", "checks": checks}
        if failing:
            body["failing"] = failing
        return JSONResponse(
            body,
            status_code=503 if failing else 200,
            headers={"Cache-Control": "no-store"},
        )

    return app


app = create_app()
