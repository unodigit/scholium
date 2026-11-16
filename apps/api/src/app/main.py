"""FastAPI application factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, jobs, module_loader
from .middleware import install_write_throttle
from .settings import settings


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # With JOBS_EAGER=0 jobs are queued in the jobs table; something must run
    # them. In eager mode (tests, local dev) enqueue runs each job inline.
    if not jobs.is_eager():
        jobs.start_worker()
    try:
        yield
    finally:
        if not jobs.is_eager():
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

    @app.get("/healthz", status_code=200)
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
