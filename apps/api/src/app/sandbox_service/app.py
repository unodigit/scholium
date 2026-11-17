"""The sandbox service: the other half of ``SANDBOX_BACKEND=remote``.

``python -m app.sandbox_service`` serves the reproducibility sandbox on its own,
so the API (and its worker) can live on machines that never run a paper's code::

    POST /runs        {"bundle_cid": "bafkrei...", "limits": {...}}  ->  202
    GET  /runs/{id}                                                   ->  200
    GET  /healthz                                                     ->  200

The API side is :func:`app.modules.ai_review.sandbox.run_remote_bundle`; this
module is written to the shape that function sends and reads.

Authentication
    Every ``/runs`` request needs ``Authorization: Bearer $SANDBOX_TOKEN``, the
    token the API holds as ``SANDBOX_TOKEN``; without it the answer is ``401``,
    before the body is read.  The comparison is :func:`hmac.compare_digest` on
    the sha-256 of each side, so neither the content nor the length of the token
    shows in how long a refusal takes.  The service refuses to start with a token
    shorter than :data:`MIN_TOKEN_LENGTH` characters (the length production
    validation asks of the API's copy).  ``/healthz`` is open, for container
    health checks, and says nothing.

``POST /runs``
    The body is ``bundle_cid`` plus optional ``limits``; its fields are exactly
    those of :class:`~app.modules.ai_review.sandbox.SandboxLimits` and anything
    else is refused, so a client cannot ask for an option the service does not
    know.  Before answering, the service fetches the bundle from its bundle
    store, **hashes the bytes while it copies them to a private temporary file**
    and compares the result with the CID.  Then:

    ``202``
        ``{"run_id": ..., "status": "queued"}``.  The run starts when one of the
        :data:`DEFAULT_CONCURRENCY` slots is free.  The bytes that were hashed
        are the bytes that run: nothing is fetched twice.
    ``401``
        no or wrong bearer token.
    ``422``
        the CID is not a file id, the limits are invalid, the store has no such
        object, the object is larger than the limits allow, or **its bytes do not
        hash to the CID**.  (``run_remote_bundle`` reads any ``422`` as
        ``bundle_unavailable``.)
    ``503``
        the service is full or its bundle store failed; ``run_remote_bundle``
        reads that as ``sandbox_unreachable``.

    Error bodies are ``{"detail": <sentence>, "code": <slug>}``; they never carry
    a path, a store error or anything else that names the host.

``GET /runs/{id}``
    ``status`` is ``queued`` or ``running`` while the run is pending, then one of
    ``completed``, ``failed``, ``timeout`` or ``not_run``.  A finished run also
    carries ``reason`` (``not_run`` only), ``exit_code``, ``log_lines`` (the
    container's output and then the one ``[scholium-sandbox]`` line),
    ``oom_killed``, ``duration``, ``image`` and ``image_id`` -- the fields of
    :class:`~app.modules.ai_review.sandbox.SandboxRun`, so the client maps the
    reply back without losing anything.  An unknown or expired id is ``404``.
    Finished runs are kept for :data:`RETAIN_SECONDS` (at most
    :data:`RETAIN_MAX` of them) and then forgotten.

How a run goes
    The bundle is run exactly as ``SANDBOX_BACKEND=docker`` or ``podman`` runs one
    on the API's own node: the same CLI probes, the same unpacking checks and the
    same container, with the same limits.  The service is never a ``remote``
    backend itself, because that would forward every run to itself.

Configuration (environment)
    ``SANDBOX_TOKEN``
        the shared bearer token (required).
    ``SANDBOX_BACKEND``
        ``docker`` (the default) or ``podman``.
    ``REPRO_DOCKER_IMAGE``
        the sandbox image, already present locally; a run never pulls one.
    ``STORAGE_BACKEND``, ``CONTENT_DIR``
        where bundles are read from; see :func:`default_store`.
    ``SANDBOX_CONCURRENCY``
        runs executing at once (default :data:`DEFAULT_CONCURRENCY`); each may
        use a CPU and 2 GB.
    ``SANDBOX_QUEUE_LIMIT``
        runs allowed to wait for a slot (default :data:`DEFAULT_QUEUE_LIMIT`);
        past that ``POST /runs`` answers ``503``.
    ``HOST``, ``PORT``
        read by ``python -m app.sandbox_service`` (default ``127.0.0.1:8001``).

The bundle is untrusted code and the service is the machine that runs it: keep
it off any network but the API's, and give it its own docker or podman.  The
service has no database, so it cannot check the file sanitizer's verdict on a
bundle; the API only sends cids it has already cleared.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Mapping, Optional, Protocol

from fastapi import APIRouter, Depends, FastAPI, Header, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError
from scholium_record_core import parse_file_cid

from app.modules.ai_review.bundle_files import extract_bundle, find_entrypoint
from app.modules.ai_review.errors import BundleError
from app.modules.ai_review.sandbox import (
    BACKEND_DOCKER,
    BACKEND_PODMAN,
    REASON_CONTAINER_UNAVAILABLE,
    REASON_DOCKER_UNAVAILABLE,
    REASON_NO_ENTRYPOINT,
    REASON_SANDBOX_ERROR,
    Runner,
    SandboxLimits,
    SandboxRun,
    resolve_backend,
    run_command,
    # The unpacking-and-running half of the local runner has no public entry
    # point that takes an archive rather than a cid (``run_bundle`` looks the
    # cid up in the content database, which this service does not have).
    # Reusing these keeps the container flags, limits and log format identical
    # to a local run; the tests run the real ``_run_container``, so a change to
    # any of them fails there.
    _MOUNT_SOURCE,
    _not_run,
    _resolve_image,
    _run_container,
    _warn,
)
from app.settings import settings

__all__ = [
    "DEFAULT_CONCURRENCY",
    "DEFAULT_QUEUE_LIMIT",
    "MIN_TOKEN_LENGTH",
    "RETAIN_MAX",
    "RETAIN_SECONDS",
    "STATUS_QUEUED",
    "STATUS_RUNNING",
    "BundleStore",
    "FilesystemStore",
    "ServiceConfigError",
    "ServiceProblem",
    "create_app",
    "default_store",
    "run_archive",
]

logger = logging.getLogger(__name__)

#: Shortest ``SANDBOX_TOKEN`` the service starts with.
MIN_TOKEN_LENGTH = 32
#: Runs executing at once, unless ``SANDBOX_CONCURRENCY`` says otherwise.
DEFAULT_CONCURRENCY = 2
#: Runs that may wait for a free slot, unless ``SANDBOX_QUEUE_LIMIT`` says otherwise.
DEFAULT_QUEUE_LIMIT = 8
#: How long a finished run can still be fetched.
RETAIN_SECONDS = 3600.0
#: The most finished runs kept, whatever their age.
RETAIN_MAX = 256

#: Pending statuses; the remote runner polls until it sees something else.
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"

#: ``POST /runs`` bodies are a cid and six numbers; anything larger is refused.
_MAX_BODY_BYTES = 16 * 1024
_CHUNK = 1024 * 1024
_PROBE_TIMEOUT = 15.0


class ServiceConfigError(ValueError):
    """The service cannot start with the configuration it was given."""


class ServiceProblem(Exception):
    """An error answer: an HTTP ``status``, a machine ``code`` and a safe sentence."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = dict(headers or {})


# --------------------------------------------------------------------------- #
# Where bundles come from                                                     #
# --------------------------------------------------------------------------- #


class BundleStore(Protocol):
    """The part of an object store the service reads: the bytes stored under a key.

    ``open`` returns a binary readable (``read(n)`` gives up to ``n`` bytes and
    ``b""`` at the end; ``close()`` is called if it has one) and raises
    ``FileNotFoundError`` or ``KeyError`` when nothing is stored under ``key``.
    The key is the bundle's cid.
    """

    def open(self, key: str) -> BinaryIO: ...


class FilesystemStore:
    """Bundles in a directory, one file per cid: the layout of ``CONTENT_DIR``.

    This reads the directory the API's content store writes (``STORAGE_BACKEND=fs``)
    as it is today, so no migration is involved.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def open(self, key: str) -> BinaryIO:
        # Callers hand in a validated cid; a key that could leave the directory
        # is refused here as well, whoever the caller is.
        if not key or key.startswith(".") or key != Path(key).name or "\0" in key:
            raise ValueError("not an object key")
        return open(self.root / key, "rb")


def _configured(name: str, default: str = "") -> str:
    """The live environment, else ``default``; blank counts as unset."""
    live = os.environ.get(name)
    return live.strip() if live is not None and live.strip() else default


def default_store() -> BundleStore:
    """The bundle store ``STORAGE_BACKEND`` selects.

    ``fs`` (the default) reads ``CONTENT_DIR``.

    Raises:
        ServiceConfigError: for any other backend.  The object-store package
            (``app.storage``, with its S3 driver) is not part of this build; when
            it is, this function is the one place that hands the service its
            ``open``.  Failing here is deliberate: reading ``CONTENT_DIR`` while
            the API writes to a bucket would make every run a "bundle not found".
    """
    backend = _configured("STORAGE_BACKEND", "fs").lower()
    if backend != "fs":
        raise ServiceConfigError(
            f"STORAGE_BACKEND={backend!r} is not available to the sandbox service; "
            "only 'fs' (reading CONTENT_DIR) is supported until app.storage is installed"
        )
    return FilesystemStore(Path(_configured("CONTENT_DIR", settings.CONTENT_DIR)))


# --------------------------------------------------------------------------- #
# Running one archive                                                         #
# --------------------------------------------------------------------------- #


def run_archive(
    archive: Path,
    *,
    limits: SandboxLimits,
    image: str,
    binary: str,
    backend: str,
    runner: Optional[Runner] = None,
) -> SandboxRun:
    """Run the zip or tar ``archive`` in a container and return what happened.

    This is what ``SANDBOX_BACKEND=docker`` / ``podman`` does with a bundle once
    it has the bytes (:func:`app.modules.ai_review.sandbox.run_bundle`), minus
    the lookup in the content database: probe the CLI, daemon and image first (so
    a node without them never unpacks an untrusted archive), unpack, find the
    entry point, run the container.  Like ``run_bundle`` it returns ``not_run``
    for anything that stops the code from running, and never raises for one.
    """
    run = runner or run_command
    unavailable = (
        REASON_CONTAINER_UNAVAILABLE
        if backend == BACKEND_PODMAN
        else REASON_DOCKER_UNAVAILABLE
    )

    executable = shutil.which(binary)
    if executable is None:
        return _not_run(
            unavailable, f"the {backend} executable was not found", image=image, limits=limits
        )
    server = run([executable, "version", "--format", "{{.Server.Version}}"], _PROBE_TIMEOUT, False)
    if not server.ok or not server.stdout.strip():
        _warn("version", server, backend)
        return _not_run(
            unavailable, f"the {backend} daemon could not be reached", image=image, limits=limits
        )
    found = run(
        [executable, "image", "inspect", "--format", "{{.Id}}", image], _PROBE_TIMEOUT, False
    )
    if not found.ok or not found.stdout.strip():
        _warn("image inspect", found, backend)
        return _not_run(
            unavailable,
            f"the sandbox image {image} is not available locally",
            image=image,
            limits=limits,
        )
    image_id = found.stdout.decode("utf-8", errors="replace").strip().splitlines()[-1]

    def not_run(reason: str, detail: str) -> SandboxRun:
        return _not_run(reason, detail, image=image, image_id=image_id, limits=limits)

    try:
        with tempfile.TemporaryDirectory(prefix="scholium-repro-") as workdir:
            root = extract_bundle(archive, workdir, max_bytes=limits.max_bundle_bytes)
            entry = find_entrypoint(root)
            if entry is None:
                return not_run(REASON_NO_ENTRYPOINT, "the bundle has no reproduce.sh or run.sh")
            source = str(root.resolve())
            if _MOUNT_SOURCE.fullmatch(source) is None:
                logger.warning("sandbox service: unusable temporary directory path %r", source)
                return not_run(REASON_SANDBOX_ERROR, "no usable temporary directory")
            return _run_container(
                run, executable, image, image_id, source, ("sh", f"./{entry}"), limits, backend
            )
    except BundleError as exc:
        return not_run(exc.reason, exc.detail)


# --------------------------------------------------------------------------- #
# The runs the service has accepted                                           #
# --------------------------------------------------------------------------- #


@dataclass
class _Run:
    id: str
    limits: SandboxLimits
    #: Holds the fetched archive until the run ends.
    directory: Path
    status: str = STATUS_QUEUED
    result: Optional[SandboxRun] = None
    finished: Optional[float] = None

    def reply(self) -> dict[str, Any]:
        """The ``GET /runs/{id}`` body: the fields ``run_remote_bundle`` reads."""
        result = self.result
        if result is None:
            return {"run_id": self.id, "status": self.status, "log_lines": []}
        return {
            "run_id": self.id,
            "status": result.status,
            "reason": result.reason,
            "exit_code": result.exit_code,
            "log_lines": list(result.log_lines),
            "oom_killed": result.oom_killed,
            "duration": result.duration,
            "image": result.image,
            "image_id": result.image_id,
        }


class RunService:
    """Fetches, verifies and runs bundles, and remembers the runs for a while."""

    def __init__(
        self,
        *,
        store: BundleStore,
        backend: str,
        binary: str,
        image: str,
        runner: Optional[Runner],
        concurrency: int,
        queue_limit: int,
        retain_seconds: float,
        retain_max: int,
    ) -> None:
        self._store = store
        self._backend = backend
        self._binary = binary
        self._image = image
        self._runner = runner
        self._capacity = concurrency + queue_limit
        self._retain_seconds = retain_seconds
        self._retain_max = retain_max
        self._executor = ThreadPoolExecutor(
            max_workers=concurrency, thread_name_prefix="sandbox-run"
        )
        self._lock = threading.Lock()
        self._runs: dict[str, _Run] = {}
        #: Runs accepted (or being fetched) that have not finished.
        self._unfinished = 0

    # -- intake -------------------------------------------------------------

    def accept(self, cid: str, limits: SandboxLimits) -> str:
        """Fetch and verify bundle ``cid``, start a run for it and return its id.

        Raises:
            ServiceProblem: ``503`` when full or when the store fails, ``422``
                when the bundle is missing, too large or does not hash to ``cid``.
        """
        with self._lock:
            if self._unfinished >= self._capacity:
                raise ServiceProblem(
                    503,
                    "service_busy",
                    "the sandbox service is running as many bundles as it accepts; try again later",
                    {"Retry-After": "30"},
                )
            self._unfinished += 1

        directory: Optional[Path] = None
        run: Optional[_Run] = None
        try:
            directory = Path(tempfile.mkdtemp(prefix="scholium-sandbox-"))
            self._fetch(cid, directory / "bundle", limits.max_bundle_bytes)
            run = _Run(id=uuid.uuid4().hex, limits=limits, directory=directory)
            with self._lock:
                self._runs[run.id] = run
                self._prune_locked()
            self._executor.submit(self._execute, run)
        except BaseException:
            with self._lock:
                self._unfinished -= 1
                if run is not None:
                    self._runs.pop(run.id, None)
            if directory is not None:
                shutil.rmtree(directory, ignore_errors=True)
            raise
        logger.info("sandbox service: accepted run %s for %s", run.id, cid)
        return run.id

    def _fetch(self, cid: str, destination: Path, max_bytes: int) -> None:
        """Copy the stored bytes of ``cid`` to ``destination`` and check their hash."""
        wanted = parse_file_cid(cid).raw_digest
        try:
            source = self._store.open(cid)
        except (FileNotFoundError, KeyError):
            raise ServiceProblem(
                422, "bundle_not_found", "the bundle is not in the service's object store"
            ) from None
        except Exception:
            logger.exception("sandbox service: the object store failed to open %s", cid)
            raise ServiceProblem(
                503, "store_unavailable", "the bundle could not be fetched from the object store"
            ) from None

        digest = hashlib.sha256()
        size = 0
        try:
            with destination.open("wb") as out:
                while True:
                    chunk = source.read(_CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ServiceProblem(
                            422,
                            "bundle_too_large",
                            f"the bundle is larger than the {max_bytes} bytes these limits allow",
                        )
                    digest.update(chunk)
                    out.write(chunk)
        except ServiceProblem:
            raise
        except Exception:
            logger.exception("sandbox service: reading %s from the object store failed", cid)
            raise ServiceProblem(
                503, "store_unavailable", "the bundle could not be fetched from the object store"
            ) from None
        finally:
            close = getattr(source, "close", None)
            if callable(close):
                close()

        if not hmac.compare_digest(digest.digest(), wanted):
            raise ServiceProblem(
                422,
                "bundle_hash_mismatch",
                "the stored bytes do not hash to the bundle's cid",
            )

    # -- execution ----------------------------------------------------------

    def _execute(self, run: _Run) -> None:
        with self._lock:
            run.status = STATUS_RUNNING
        try:
            result = run_archive(
                run.directory / "bundle",
                limits=run.limits,
                image=self._image,
                binary=self._binary,
                backend=self._backend,
                runner=self._runner,
            )
        except Exception:
            # Never the exception text: it can name host paths.
            logger.exception("sandbox service: run %s failed unexpectedly", run.id)
            result = _not_run(
                REASON_SANDBOX_ERROR,
                "the sandbox service could not run the bundle",
                image=self._image,
                limits=run.limits,
            )
        finally:
            shutil.rmtree(run.directory, ignore_errors=True)
        with self._lock:
            run.result = result
            run.status = result.status
            run.finished = time.monotonic()
            self._unfinished -= 1
            self._prune_locked()
        logger.info("sandbox service: run %s finished: %s", run.id, result.status)

    def _prune_locked(self) -> None:
        """Forget finished runs that are old or beyond the retention cap."""
        now = time.monotonic()
        finished = sorted(
            (run for run in self._runs.values() if run.finished is not None),
            key=lambda run: run.finished or 0.0,
        )
        fresh = [run for run in finished if now - (run.finished or 0.0) <= self._retain_seconds]
        keep = {run.id for run in fresh[max(0, len(fresh) - self._retain_max):]}
        for run in finished:
            if run.id not in keep:
                del self._runs[run.id]

    # -- queries and shutdown ----------------------------------------------

    def reply(self, run_id: str) -> Optional[dict[str, Any]]:
        """The ``GET /runs/{id}`` body, or ``None`` for an unknown or expired id."""
        with self._lock:
            self._prune_locked()
            run = self._runs.get(run_id)
            return run.reply() if run is not None else None

    def close(self) -> None:
        """Stop taking work.  A run in progress finishes (and removes its container)."""
        self._executor.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            for run in self._runs.values():
                if run.status == STATUS_QUEUED:
                    shutil.rmtree(run.directory, ignore_errors=True)


# --------------------------------------------------------------------------- #
# HTTP                                                                        #
# --------------------------------------------------------------------------- #


class _LimitsBody(BaseModel):
    """``limits`` of ``POST /runs``: :class:`SandboxLimits`' fields, all optional."""

    model_config = ConfigDict(extra="forbid")

    cpus: Optional[float] = None
    memory_mb: Optional[int] = None
    pids: Optional[int] = None
    time_limit: Optional[float] = None
    work_mb: Optional[int] = None
    tmp_mb: Optional[int] = None


class _RunBody(BaseModel):
    """The body of ``POST /runs``."""

    model_config = ConfigDict(extra="forbid")

    bundle_cid: str
    limits: Optional[_LimitsBody] = None


def _parse_run_body(raw: bytes) -> tuple[str, SandboxLimits]:
    try:
        body = _RunBody.model_validate_json(raw)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in error['loc']) or 'body'}: {error['msg']}"
            for error in exc.errors(include_url=False, include_input=False, include_context=False)
        )
        raise ServiceProblem(422, "invalid_request", f"invalid request: {problems}") from None
    try:
        parse_file_cid(body.bundle_cid)
    except ValueError:
        raise ServiceProblem(
            422, "invalid_bundle_cid", "bundle_cid is not a canonical file id"
        ) from None
    given = body.limits.model_dump(exclude_none=True) if body.limits is not None else {}
    try:
        return body.bundle_cid, SandboxLimits(**given)
    except ValueError as exc:
        raise ServiceProblem(422, "invalid_limits", f"invalid limits: {exc}") from None


async def _read_body(request: Request) -> bytes:
    """The request body, refusing more than :data:`_MAX_BODY_BYTES` without buffering it."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_BODY_BYTES:
            raise ServiceProblem(413, "request_too_large", "the request body is too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _bearer_check(token: str):
    """A dependency that answers ``401`` unless the request carries ``token``."""
    expected = hashlib.sha256(token.encode("utf-8")).digest()

    def require_token(authorization: Optional[str] = Header(default=None)) -> None:
        scheme, _, credential = (authorization or "").partition(" ")
        supplied = credential.strip() if scheme.lower() == "bearer" else ""
        # Headers arrive latin-1 decoded; this recovers the bytes the client sent.
        given = hashlib.sha256(supplied.encode("latin-1", errors="replace")).digest()
        if not hmac.compare_digest(given, expected):
            raise ServiceProblem(
                401,
                "unauthorized",
                "a valid bearer token is required",
                {"WWW-Authenticate": "Bearer"},
            )

    return require_token


def _int_setting(name: str, explicit: Optional[int], default: int, minimum: int) -> int:
    if explicit is not None:
        value = explicit
    else:
        raw = _configured(name)
        try:
            value = int(raw) if raw else default
        except ValueError:
            raise ServiceConfigError(f"{name} must be an integer, got {raw!r}") from None
    if value < minimum:
        raise ServiceConfigError(f"{name} must be at least {minimum}")
    return value


def create_app(
    *,
    token: Optional[str] = None,
    store: Optional[BundleStore] = None,
    backend: Optional[str] = None,
    image: Optional[str] = None,
    runner: Optional[Runner] = None,
    docker_bin: str = "docker",
    podman_bin: str = "podman",
    concurrency: Optional[int] = None,
    queue_limit: Optional[int] = None,
    retain_seconds: float = RETAIN_SECONDS,
    retain_max: int = RETAIN_MAX,
) -> FastAPI:
    """Build the sandbox service's ASGI app.

    Every argument defaults to its environment variable (see the module doc);
    the arguments exist so a test, or another entry point, can supply them.

    Args:
        token: the shared bearer token; at least :data:`MIN_TOKEN_LENGTH` characters.
        store: where bundles are read from; defaults to :func:`default_store`.
        backend: ``docker`` or ``podman``.
        image: the sandbox image.
        runner: runs the container CLI's commands; defaults to a real subprocess.
        docker_bin: the docker executable.
        podman_bin: the podman executable.
        concurrency: runs executing at once.
        queue_limit: runs allowed to wait for a slot.
        retain_seconds: how long a finished run can still be fetched.
        retain_max: the most finished runs kept.

    Raises:
        ServiceConfigError: for a missing or short token, a backend other than
            ``docker`` and ``podman``, a bad image reference, a bad number or a
            store the service cannot read.
    """
    if token is None:
        token = _configured("SANDBOX_TOKEN", settings.SANDBOX_TOKEN)
    shared_token = token.strip()
    if len(shared_token) < MIN_TOKEN_LENGTH:
        raise ServiceConfigError(
            f"SANDBOX_TOKEN must be set to a random value of at least {MIN_TOKEN_LENGTH} characters"
        )
    try:
        chosen_backend = resolve_backend(backend)
        chosen_image = _resolve_image(image)
    except ValueError as exc:
        raise ServiceConfigError(str(exc)) from None
    if chosen_backend not in (BACKEND_DOCKER, BACKEND_PODMAN):
        raise ServiceConfigError(
            "SANDBOX_BACKEND must be docker or podman for the sandbox service, "
            f"not {chosen_backend!r}"
        )
    binary = podman_bin if chosen_backend == BACKEND_PODMAN else docker_bin
    if shutil.which(binary) is None:
        logger.warning(
            "sandbox service: %s was not found; every run will be reported as not_run", binary
        )

    service = RunService(
        store=store if store is not None else default_store(),
        backend=chosen_backend,
        binary=binary,
        image=chosen_image,
        runner=runner,
        concurrency=_int_setting("SANDBOX_CONCURRENCY", concurrency, DEFAULT_CONCURRENCY, 1),
        queue_limit=_int_setting("SANDBOX_QUEUE_LIMIT", queue_limit, DEFAULT_QUEUE_LIMIT, 0),
        retain_seconds=retain_seconds,
        retain_max=retain_max,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            yield
        finally:
            service.close()

    # No interactive docs: the service has one client and nothing to browse.
    app = FastAPI(
        title="Scholium sandbox service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.service = service

    @app.exception_handler(ServiceProblem)
    async def problem_handler(_: Request, exc: ServiceProblem) -> JSONResponse:
        return JSONResponse(
            {"detail": exc.message, "code": exc.code},
            status_code=exc.status,
            headers=exc.headers,
        )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    router = APIRouter(dependencies=[Depends(_bearer_check(shared_token))])

    @router.post("/runs", status_code=202)
    async def create_run(request: Request, response: Response) -> dict[str, str]:
        # The body is parsed here, after the token check, rather than declared as
        # a parameter: FastAPI reads a declared body before it runs dependencies,
        # which would answer a malformed body 422 to a caller with no token.
        bundle_cid, limits = _parse_run_body(await _read_body(request))
        run_id = await run_in_threadpool(service.accept, bundle_cid, limits)
        response.headers["Location"] = f"/runs/{run_id}"
        return {"run_id": run_id, "status": STATUS_QUEUED}

    @router.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        reply = service.reply(run_id)
        if reply is None:
            raise ServiceProblem(404, "run_not_found", "no such run")
        return reply

    app.include_router(router)
    return app
