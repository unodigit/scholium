"""Running a paper's code bundle in a docker sandbox (feature 119).

The reproducibility agent reads the paper; this module is the part that runs
its code, and the only part of the AI pre-review that executes anything the
author supplied::

    run = run_bundle(bundle_cid)
    run.status        # "completed" | "failed" | "timeout" | "not_run"
    run.log_lines     # what the code printed, then one line from the sandbox
    run.findings()    # Finding objects whose evidence is a line of run.log

What the container gets
    ``docker run --network none`` semantics, spelled as ``docker create`` then
    ``start``: no network at all, a read-only root filesystem, one CPU,
    2048 MB of memory with no swap, 256 processes, no Linux capabilities, no
    privilege escalation, an unprivileged user, and a **10-minute wall-clock
    limit** (:data:`MAX_TIME_LIMIT_SECONDS`, also the ceiling of
    :class:`SandboxLimits`).  The unpacked bundle is mounted read-only at
    ``/bundle``; its files are copied into a size-limited tmpfs at ``/work``
    (the working directory and ``$HOME``) so the code can write results, and
    ``/tmp`` is a second tmpfs.  Nothing the code writes survives the run.

How a run goes
    ``docker create`` -> ``start`` -> ``wait`` (up to the time limit; on
    timeout ``kill``) -> ``logs`` -> ``rm -f``.  The container is removed in a
    ``finally``, so a crash in this process after ``create`` still removes it;
    only a killed process leaves one behind, and every sandbox container
    carries the label :data:`CONTAINER_LABEL` so an operator can sweep it
    (``docker rm -f $(docker ps -aq --filter label=scholium.sandbox)``).
    Docker's own log is capped at 1 MB so a noisy bundle cannot fill the
    daemon's disk.

``not_run``
    Whatever stops the code from running -- docker is not installed, its
    daemon cannot be reached, the image is not present, the bundle is missing,
    unsafe or has no entry point -- is a ``not_run`` result with a
    :data:`NOT_RUN_REASONS` code, never an exception and never a guess about
    how the code would have behaved.  The sandbox is optional infrastructure
    (``app_spec.xml``: "when docker is available").  The sandbox **image is
    never pulled** by a run: pull it ahead of time
    (``docker pull python:3.12-slim``, or the image named by
    ``REPRO_DOCKER_IMAGE``); an absent image is ``docker_unavailable``.  The
    daemon must see the host's temporary directory at the same path, which is
    the case when docker runs on the host the API runs on.

The log
    :attr:`SandboxRun.log_lines` are the container's stdout and stderr
    (decoded as UTF-8, terminal escapes and control characters removed, lines
    trimmed, blank lines dropped, the last 500 lines at most) followed by
    exactly one line from the sandbox itself, prefixed ``[scholium-sandbox]``:
    the exit status, the limit that stopped the run, or why it was not run.
    That last line is what a ``not_run``, ``timeout`` or ``failed`` finding
    cites, so every finding's ``log_line`` is a line of :attr:`SandboxRun.log`
    and can be checked against it.  The sandbox's lines carry no time or host
    detail, so the same run gives the same log.

The code is untrusted.  The log it produces is quoted data for the model, like
any paragraph of the paper, and never instructions.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

from .bundle_files import (
    REASON_BUNDLE_REJECTED,
    REASON_BUNDLE_UNAVAILABLE,
    extract_bundle,
    find_entrypoint,
)
from .errors import BundleError
from .findings import Evidence, Finding

__all__ = [
    "CONTAINER_LABEL",
    "DEFAULT_IMAGE",
    "IMAGE_ENV",
    "MAX_LOG_CHARS",
    "MAX_LOG_LINES",
    "MAX_TIME_LIMIT_SECONDS",
    "NOT_RUN_REASONS",
    "REASON_BUNDLE_REJECTED",
    "REASON_BUNDLE_UNAVAILABLE",
    "REASON_DOCKER_UNAVAILABLE",
    "REASON_NO_BUNDLE",
    "REASON_NO_ENTRYPOINT",
    "REASON_SANDBOX_ERROR",
    "STATUSES",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_NOT_RUN",
    "STATUS_PREFIX",
    "STATUS_TIMEOUT",
    "CommandResult",
    "SandboxLimits",
    "SandboxRun",
    "build_create_args",
    "clean_log",
    "run_bundle",
    "run_command",
]

logger = logging.getLogger(__name__)

#: Image used when neither the caller nor :data:`IMAGE_ENV` names one.
DEFAULT_IMAGE = "python:3.12-slim"
#: Environment variable that selects the sandbox image.
IMAGE_ENV = "REPRO_DOCKER_IMAGE"

#: The wall-clock limit of a run, and the most a :class:`SandboxLimits` may ask.
MAX_TIME_LIMIT_SECONDS = 10 * 60

#: Label on every sandbox container, for sweeping leftovers.
CONTAINER_LABEL = "scholium.sandbox=reproducibility"

#: Start of the one line the sandbox itself adds to a log.
STATUS_PREFIX = "[scholium-sandbox] "

#: The code ran and exited 0.
STATUS_COMPLETED = "completed"
#: The code ran and exited non-zero (or was killed for exceeding memory).
STATUS_FAILED = "failed"
#: The code was still running at the time limit and was killed.
STATUS_TIMEOUT = "timeout"
#: The code never ran; see :attr:`SandboxRun.reason`.
STATUS_NOT_RUN = "not_run"
STATUSES: tuple[str, ...] = (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_TIMEOUT,
    STATUS_NOT_RUN,
)

#: ``not_run`` reason: the version has no code bundle.
REASON_NO_BUNDLE = "no_bundle"
#: ``not_run`` reason: docker is missing, its daemon is down or the image is absent.
REASON_DOCKER_UNAVAILABLE = "docker_unavailable"
#: ``not_run`` reason: the bundle has no ``reproduce.sh`` or ``run.sh``.
REASON_NO_ENTRYPOINT = "no_entrypoint"
#: ``not_run`` reason: docker failed to create or start the container.
REASON_SANDBOX_ERROR = "sandbox_error"
NOT_RUN_REASONS: tuple[str, ...] = (
    REASON_NO_BUNDLE,
    REASON_DOCKER_UNAVAILABLE,
    REASON_BUNDLE_UNAVAILABLE,
    REASON_BUNDLE_REJECTED,
    REASON_NO_ENTRYPOINT,
    REASON_SANDBOX_ERROR,
)

#: The most log lines, and characters in all, kept from a run.
MAX_LOG_LINES = 500
MAX_LOG_CHARS = 48_000
_MAX_LINE_CHARS = 500

_SANDBOX_UID = "65534"  # "nobody"
_BUNDLE_MOUNT = "/bundle"
_WORK_DIR = "/work"
# ``sh -c SCRIPT sh COMMAND...``: copy the read-only bundle to the writable
# work directory, go there and replace the shell with the command.
_WRAPPER = f'cp -R {_BUNDLE_MOUNT}/. {_WORK_DIR}/ && cd {_WORK_DIR} && exec "$@"'

_CONTROL_TIMEOUT = 30.0
_PROBE_TIMEOUT = 15.0
_LOGS_TIMEOUT = 60.0

_IMAGE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}")
# A path docker's ``--mount`` option can carry without quoting.
_MOUNT_SOURCE = re.compile(r"/[\w./+@~-]+")
_CONTAINER_ID = re.compile(r"[0-9a-f]{12,64}")
_ANSI = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])"
)
_CONTROL = re.compile(r"[\x00-\x08\x0e-\x1f\x7f]")


@dataclass(frozen=True)
class SandboxLimits:
    """The resources a run may use.  The defaults are the spec's limits."""

    #: CPUs, as docker's ``--cpus``.
    cpus: float = 1.0
    #: Memory in MB, swap included; tmpfs contents count against it.
    memory_mb: int = 2048
    #: Most processes and threads.
    pids: int = 256
    #: Wall-clock seconds; at most :data:`MAX_TIME_LIMIT_SECONDS`.
    time_limit: float = float(MAX_TIME_LIMIT_SECONDS)
    #: Size in MB of ``/work``, where the bundle is copied and results go.
    work_mb: int = 512
    #: Size in MB of ``/tmp``.
    tmp_mb: int = 128

    def __post_init__(self) -> None:
        if not 0 < self.cpus <= 64:
            raise ValueError("cpus must be greater than 0 and at most 64")
        if self.pids < 16:
            raise ValueError("pids must be at least 16")
        if self.work_mb < 16 or self.tmp_mb < 16:
            raise ValueError("work_mb and tmp_mb must be at least 16")
        if self.memory_mb < self.work_mb + self.tmp_mb + 64:
            raise ValueError("memory_mb must exceed work_mb + tmp_mb by at least 64")
        if not 0 < self.time_limit <= MAX_TIME_LIMIT_SECONDS:
            raise ValueError(
                f"time_limit must be greater than 0 and at most {MAX_TIME_LIMIT_SECONDS} seconds"
            )

    @property
    def max_bundle_bytes(self) -> int:
        """Most the bundle may unpack to: half of ``/work``, the rest is for results."""
        return self.work_mb * 1024 * 1024 // 2


@dataclass(frozen=True)
class SandboxRun:
    """What happened when a code bundle was run (or why it was not)."""

    #: One of :data:`STATUSES`.
    status: str
    #: Why nothing ran, one of :data:`NOT_RUN_REASONS`; ``None`` when something did.
    reason: Optional[str] = None
    #: The container's exit status; ``None`` for ``not_run`` and ``timeout``.
    exit_code: Optional[int] = None
    #: The code's output, then the sandbox's own last line (see the module doc).
    log_lines: tuple[str, ...] = ()
    #: Whether the kernel killed the code for exceeding the memory limit.
    oom_killed: bool = False
    #: Wall-clock seconds the container ran.
    duration: float = 0.0
    #: The image and its id (``sha256:...``) that ran the code, so a third party
    #: can use the same one.
    image: str = ""
    image_id: Optional[str] = None
    limits: Optional[SandboxLimits] = None

    def __post_init__(self) -> None:
        if self.status not in STATUSES:
            raise ValueError(f"status must be one of {', '.join(STATUSES)}")
        if (self.status == STATUS_NOT_RUN) != (self.reason is not None):
            raise ValueError("a reason is given if and only if the code was not run")
        if self.reason is not None and self.reason not in NOT_RUN_REASONS:
            raise ValueError(f"reason must be one of {', '.join(NOT_RUN_REASONS)}")
        if not self.log_lines:
            raise ValueError("a run always has at least the sandbox's own log line")

    @property
    def ran(self) -> bool:
        """Whether the code was started."""
        return self.status != STATUS_NOT_RUN

    @property
    def log(self) -> str:
        """:attr:`log_lines` joined by newlines: the run log findings are checked against."""
        return "\n".join(self.log_lines)

    @property
    def status_line(self) -> str:
        """The sandbox's own line, always the last of the log."""
        return self.log_lines[-1]

    def findings(self, agent: str = "reproducibility") -> tuple[Finding, ...]:
        """The findings the run itself supports, each citing :attr:`status_line`.

        ``completed`` gives none: a clean run is not a problem, and whether its
        output agrees with the paper is for the model to say.  The others give
        one finding saying what stopped the run, with a confidence that
        reflects how much a sandbox (no network, limited time and memory) may
        be to blame rather than the code.
        """
        if self.status == STATUS_COMPLETED:
            return ()
        if self.status == STATUS_NOT_RUN:
            assert self.reason is not None
            severity, confidence, claim = _NOT_RUN_FINDINGS[self.reason]
        elif self.status == STATUS_TIMEOUT:
            limit = self.limits.time_limit if self.limits else MAX_TIME_LIMIT_SECONDS
            severity, confidence = "minor", "low"
            claim = (
                f"The code bundle was still running when the sandbox's {_duration(limit)} "
                "time limit stopped it, so its results could not be checked."
            )
        elif self.oom_killed:
            severity, confidence = "major", "low"
            claim = (
                "The code bundle was stopped for exceeding the sandbox's memory limit, "
                "so its results could not be regenerated there."
            )
        else:
            severity, confidence = "major", "low"
            claim = (
                f"The code bundle exited with status {self.exit_code} in the sandbox, "
                "so its results could not be regenerated there."
            )
        return (
            Finding(
                agent=agent,
                claim=claim,
                severity=severity,
                confidence=confidence,
                evidence=Evidence(log_line=self.status_line),
            ),
        )


#: reason -> (severity, confidence, claim) of the finding for a run that did not happen.
#: A problem on the node (no docker) is ``info``; one in the bundle is a gap a
#: reader would meet too.
_NOT_RUN_FINDINGS: dict[str, tuple[str, str, str]] = {
    REASON_NO_BUNDLE: (
        "info",
        "high",
        "The paper has no code bundle, so no code was run to check its results.",
    ),
    REASON_DOCKER_UNAVAILABLE: (
        "info",
        "high",
        "The code bundle was not run because the docker sandbox is not available "
        "on this node, so the paper's code is unchecked.",
    ),
    REASON_BUNDLE_UNAVAILABLE: (
        "info",
        "high",
        "The code bundle was not run because it could not be read as a cleared archive.",
    ),
    REASON_BUNDLE_REJECTED: (
        "minor",
        "medium",
        "The code bundle was not run because it holds entries the sandbox does not "
        "accept or is too large to unpack there.",
    ),
    REASON_NO_ENTRYPOINT: (
        "minor",
        "medium",
        "The code bundle was not run because it has no reproduce.sh or run.sh at its "
        "top level to start it.",
    ),
    REASON_SANDBOX_ERROR: (
        "info",
        "high",
        "The code bundle was not run because the sandbox could not start it.",
    ),
}


def _duration(seconds: float) -> str:
    if seconds >= 60 and seconds % 60 == 0:
        return f"{int(seconds // 60)}-minute"
    return f"{seconds:g}-second"


@dataclass(frozen=True)
class CommandResult:
    """The outcome of one docker command."""

    returncode: int
    stdout: bytes = b""
    stderr: bytes = b""
    #: The command did not finish in time and was killed.
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


#: ``(argv, timeout_seconds, merge_stderr) -> CommandResult``.  The default,
#: :func:`run_command`, runs the process; tests pass a script instead.
Runner = Callable[[Sequence[str], float, bool], CommandResult]


def run_command(
    argv: Sequence[str], timeout: float, merge_stderr: bool = False
) -> CommandResult:
    """Run ``argv`` (no shell, no stdin), capturing its output, killing it after ``timeout``.

    With ``merge_stderr`` the error stream is interleaved into ``stdout``.  A
    program that cannot be executed at all gives return code 127.
    """
    try:
        completed = subprocess.run(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return CommandResult(returncode=-1, timed_out=True)
    except OSError as exc:
        return CommandResult(returncode=127, stderr=str(exc).encode())
    return CommandResult(
        returncode=completed.returncode,
        stdout=completed.stdout or b"",
        stderr=completed.stderr or b"",
    )


def clean_log(raw: bytes) -> tuple[str, ...]:
    """Container output as log lines.

    Decodes UTF-8 (bad bytes become U+FFFD), removes terminal escape sequences
    and control characters, splits on line breaks (a carriage-return progress
    bar becomes lines), strips each line, drops blank ones, cuts a line to 500
    characters and keeps the most recent lines within :data:`MAX_LOG_LINES` and
    :data:`MAX_LOG_CHARS`.  When anything was left out, the first line says so.
    """
    text = _ANSI.sub("", raw.decode("utf-8", errors="replace"))
    lines = []
    for line in text.splitlines():
        line = _CONTROL.sub("", line).strip()
        if not line:
            continue
        if len(line) > _MAX_LINE_CHARS:
            line = line[: _MAX_LINE_CHARS - 1] + "…"
        lines.append(line)

    kept: list[str] = []
    chars = 0
    for line in reversed(lines):
        if len(kept) >= MAX_LOG_LINES or chars + len(line) > MAX_LOG_CHARS:
            break
        kept.append(line)
        chars += len(line)
    kept.reverse()
    if len(kept) < len(lines):
        kept.insert(
            0, f"{STATUS_PREFIX}output truncated: only the last {len(kept)} lines are kept"
        )
    return tuple(kept)


def build_create_args(
    docker: str,
    image: str,
    source: str,
    command: Sequence[str],
    limits: SandboxLimits,
) -> list[str]:
    """The ``docker create`` command line for one sandbox container.

    ``source`` is the host directory holding the unpacked bundle; it is
    mounted read-only.  ``command`` runs in ``/work`` after the bundle has
    been copied there.
    """
    tmpfs = "rw,exec,nosuid,nodev,size={size}m,{extra}"
    return [
        docker,
        "create",
        "--network", "none",
        "--read-only",
        "--cpus", f"{limits.cpus:g}",
        "--memory", f"{limits.memory_mb}m",
        "--memory-swap", f"{limits.memory_mb}m",
        "--pids-limit", str(limits.pids),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", f"{_SANDBOX_UID}:{_SANDBOX_UID}",
        "--pull", "never",
        "--tmpfs", "/tmp:" + tmpfs.format(size=limits.tmp_mb, extra="mode=1777"),
        "--tmpfs", f"{_WORK_DIR}:" + tmpfs.format(
            size=limits.work_mb, extra=f"uid={_SANDBOX_UID},gid={_SANDBOX_UID},mode=0755"
        ),
        "--mount", f"type=bind,source={source},target={_BUNDLE_MOUNT},readonly",
        "--env", f"HOME={_WORK_DIR}",
        "--env", "TMPDIR=/tmp",
        "--log-driver", "json-file",
        "--log-opt", "max-size=1m",
        "--log-opt", "max-file=1",
        "--label", CONTAINER_LABEL,
        image,
        "sh", "-c", _WRAPPER, "sh", *command,
    ]


def _not_run(
    reason: str,
    detail: str,
    *,
    image: str = "",
    image_id: Optional[str] = None,
    limits: Optional[SandboxLimits] = None,
) -> SandboxRun:
    return SandboxRun(
        status=STATUS_NOT_RUN,
        reason=reason,
        log_lines=(f"{STATUS_PREFIX}not run ({reason}): {detail}",),
        image=image,
        image_id=image_id,
        limits=limits,
    )


def _resolve_image(image: Optional[str]) -> str:
    chosen = image or os.environ.get(IMAGE_ENV) or DEFAULT_IMAGE
    if _IMAGE.fullmatch(chosen) is None:
        raise ValueError(f"not a docker image reference: {chosen!r}")
    return chosen


def _locate_bundle(cid: str) -> Path:
    """The stored bytes of a bundle the sanitizer has cleared.

    Raises:
        BundleError: ``bundle_unavailable`` if there is no such blob, it has
            not passed the sanitizer, or moderation has removed it.
    """
    from app.modules import content

    blob = content.get_blob(cid)
    if blob is None or not content.exists(cid):
        raise BundleError(REASON_BUNDLE_UNAVAILABLE, "the code bundle is not in the content store")
    if content.is_tombstoned(cid):
        raise BundleError(REASON_BUNDLE_UNAVAILABLE, "the code bundle has been removed")
    if blob.scan_status != content.SCAN_PASSED:
        raise BundleError(
            REASON_BUNDLE_UNAVAILABLE, "the code bundle has not been cleared by the file sanitizer"
        )
    return content.blob_path(cid)


def _warn(step: str, result: CommandResult) -> None:
    # Docker's own message can name host paths, so it goes to the operator's
    # log and never into the run log that readers and the model see.
    logger.warning(
        "sandbox: docker %s failed (exit %s%s): %s",
        step,
        result.returncode,
        ", timed out" if result.timed_out else "",
        result.stderr.decode("utf-8", errors="replace").strip()[:500],
    )


def run_bundle(
    bundle_cid: Optional[str],
    *,
    limits: Optional[SandboxLimits] = None,
    image: Optional[str] = None,
    command: Optional[Sequence[str]] = None,
    docker_bin: str = "docker",
    runner: Optional[Runner] = None,
) -> SandboxRun:
    """Run the code bundle ``bundle_cid`` in the sandbox and return what happened.

    Args:
        bundle_cid: the bundle's cid in the content store, or ``None`` if the
            version has none.  It must have passed the file sanitizer.
        limits: resource limits; defaults to the spec's.
        image: the docker image; defaults to ``$REPRO_DOCKER_IMAGE`` and then
            :data:`DEFAULT_IMAGE`.  It must already be present locally.
        command: what to run in ``/work`` instead of ``sh ./reproduce.sh`` (or
            ``run.sh``); the first word is looked up in the image.
        docker_bin: the docker executable.
        runner: runs the docker commands; defaults to :func:`run_command`.

    Returns:
        A :class:`SandboxRun`.  Problems with docker or with the bundle are a
        ``not_run`` result, not an exception.

    Raises:
        ValueError: for an ``image`` that is not an image reference or an
            empty ``command``; these are mistakes of the caller or the
            configuration, not of the paper.
    """
    limits = limits or SandboxLimits()
    image = _resolve_image(image)
    if command is not None:
        # A bare string is a sequence of one-character strings: refuse it
        # rather than run it as ``p y t h o n``.
        if isinstance(command, (str, bytes)):
            raise ValueError("command must be a sequence of words, not one string")
        command = tuple(command)
        if not command or not all(isinstance(word, str) and word for word in command):
            raise ValueError("command must be a non-empty sequence of non-empty strings")
    run = runner or run_command

    if not bundle_cid:
        return _not_run(REASON_NO_BUNDLE, "the version has no code bundle", limits=limits)

    # Docker first, so a node without it never unpacks an untrusted archive.
    docker = shutil.which(docker_bin)
    if docker is None:
        return _not_run(
            REASON_DOCKER_UNAVAILABLE, "the docker executable was not found",
            image=image, limits=limits,
        )
    server = run([docker, "version", "--format", "{{.Server.Version}}"], _PROBE_TIMEOUT, False)
    if not server.ok or not server.stdout.strip():
        _warn("version", server)
        return _not_run(
            REASON_DOCKER_UNAVAILABLE, "the docker daemon could not be reached",
            image=image, limits=limits,
        )
    found = run(
        [docker, "image", "inspect", "--format", "{{.Id}}", image], _PROBE_TIMEOUT, False
    )
    if not found.ok or not found.stdout.strip():
        _warn("image inspect", found)
        return _not_run(
            REASON_DOCKER_UNAVAILABLE, f"the sandbox image {image} is not available locally",
            image=image, limits=limits,
        )
    image_id = found.stdout.decode("utf-8", errors="replace").strip().splitlines()[-1]

    def not_run(reason: str, detail: str) -> SandboxRun:
        return _not_run(reason, detail, image=image, image_id=image_id, limits=limits)

    try:
        archive = _locate_bundle(bundle_cid)
        with tempfile.TemporaryDirectory(prefix="scholium-repro-") as workdir:
            root = extract_bundle(archive, workdir, max_bytes=limits.max_bundle_bytes)
            if command is None:
                entry = find_entrypoint(root)
                if entry is None:
                    return not_run(
                        REASON_NO_ENTRYPOINT, "the bundle has no reproduce.sh or run.sh"
                    )
                command = ("sh", f"./{entry}")
            source = str(root.resolve())
            if _MOUNT_SOURCE.fullmatch(source) is None:
                logger.warning("sandbox: unusable temporary directory path %r", source)
                return not_run(REASON_SANDBOX_ERROR, "no usable temporary directory")
            return _run_container(
                run, docker, image, image_id, source, command, limits
            )
    except BundleError as exc:
        return not_run(exc.reason, exc.detail)


def _run_container(
    run: Runner,
    docker: str,
    image: str,
    image_id: str,
    source: str,
    command: Sequence[str],
    limits: SandboxLimits,
) -> SandboxRun:
    def not_run(detail: str) -> SandboxRun:
        return _not_run(
            REASON_SANDBOX_ERROR, detail, image=image, image_id=image_id, limits=limits
        )

    created = run(build_create_args(docker, image, source, command, limits), _CONTROL_TIMEOUT, False)
    container = ""
    if created.ok:
        lines = created.stdout.decode("utf-8", errors="replace").split()
        container = lines[-1] if lines else ""
    if not _CONTAINER_ID.fullmatch(container):
        _warn("create", created)
        return not_run("the sandbox container could not be created")

    try:
        started = run([docker, "start", container], _CONTROL_TIMEOUT, False)
        if not started.ok:
            _warn("start", started)
            return not_run("the sandbox container could not be started")
        began = time.monotonic()

        waited = run([docker, "wait", container], limits.time_limit, False)
        duration = time.monotonic() - began
        exit_code: Optional[int] = None
        if waited.timed_out:
            killed = run([docker, "kill", container], _CONTROL_TIMEOUT, False)
            if not killed.ok:
                _warn("kill", killed)
        else:
            try:
                exit_code = int(waited.stdout.decode("utf-8", errors="replace").split()[-1])
            except (ValueError, IndexError):
                exit_code = None
            if not waited.ok or exit_code is None:
                _warn("wait", waited)
                return not_run("the sandbox lost track of the container")

        oom = False
        if exit_code not in (None, 0):
            inspected = run(
                [docker, "inspect", "--format", "{{.State.OOMKilled}}", container],
                _CONTROL_TIMEOUT,
                False,
            )
            oom = inspected.ok and inspected.stdout.strip().lower() == b"true"

        fetched = run(
            [docker, "logs", "--tail", str(MAX_LOG_LINES + 1), container],
            _LOGS_TIMEOUT,
            True,
        )
        if not fetched.ok:
            _warn("logs", fetched)
        output = clean_log(fetched.stdout if fetched.ok else b"")
    finally:
        removed = run([docker, "rm", "-f", "-v", container], _CONTROL_TIMEOUT, False)
        if not removed.ok:
            _warn("rm", removed)

    if exit_code is None:
        status = STATUS_TIMEOUT
        final = (
            f"{STATUS_PREFIX}stopped: the time limit of "
            f"{limits.time_limit:g} seconds was reached"
        )
    elif exit_code == 0:
        status = STATUS_COMPLETED
        final = f"{STATUS_PREFIX}exit status 0"
    elif oom:
        status = STATUS_FAILED
        final = (
            f"{STATUS_PREFIX}stopped: the memory limit of {limits.memory_mb} MB "
            f"was exceeded (exit status {exit_code})"
        )
    else:
        status = STATUS_FAILED
        final = f"{STATUS_PREFIX}exit status {exit_code}"
    return SandboxRun(
        status=status,
        exit_code=exit_code,
        log_lines=(*output, final),
        oom_killed=oom,
        duration=duration,
        image=image,
        image_id=image_id,
        limits=limits,
    )
