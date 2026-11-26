"""Harness for the end-to-end tests: real processes, real sockets, no shortcuts.

Everything here starts the *shipped* programs the way an operator does and then
talks to them over HTTP, SMTP or the command line:

* ``python -m app``                      the API (``app.__main__``, uvicorn)
* ``python -m app.worker``               the background worker
* ``python -m app.sandbox_service``      the remote sandbox runner
* ``python -m app.modules.admin``        provisioning (node key, tiers, demo data)
* ``python -m app.migrate_backend``      copy a node onto new backends
* ``python -m app.smoke``                the stack smoke check
* ``python -m scholium_cli.main``        what a third party verifies archives with

Nothing imports :mod:`app`, builds a ``FastAPI`` object or reaches into the
application's database sessions.  The only stand-ins are the *neighbours* a
node talks to in a real deployment: an S3 endpoint (:class:`FakeS3`, playing
MinIO) and a mail server (:class:`SmtpSink`, playing Mailpit).

The programs are started with the interpreter that runs the tests
(``sys.executable``), so run the suite the way the API's own tests are run::

    npm run test:system
"""

from __future__ import annotations

import atexit
import base64
import email
import hashlib
import io
import json
import os
import re
import secrets
import signal
import socket
import socketserver
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence
from urllib.parse import parse_qs, quote, unquote, urlparse
from xml.sax.saxutils import escape

import httpx
import jwt
from multiformats import CID
from nacl.signing import SigningKey
from pypdf import PdfWriter
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    encode_signature,
    sign_record,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
API_DIR = REPO_ROOT / "apps" / "api"
WEB_DIR = REPO_ROOT / "apps" / "web"

#: How long a program gets to start answering before the test gives up.  Generous:
#: the full suite shares the machine with other work, and the API imports every
#: module and creates the schema before it listens.
START_TIMEOUT = 120.0

PROBLEM_JSON = "application/problem+json"

#: Settings the application reads from the environment.  Anything the host
#: happens to export must not leak into a node under test, so every one of
#: these is removed from the inherited environment before a test's own values
#: are applied.
_APP_ENV_PREFIXES = (
    "DATABASE_URL", "TEST_DATABASE_URL", "DB_", "CONTENT_DIR", "STORAGE_BACKEND", "S3_",
    "AWS_", "NODE_KEY", "JWT_SECRET", "REVIEW_UNIQUENESS_KEY", "COMMITTEE_PUBLIC_KEY",
    "ORCID_", "ARXIV_", "AI_", "ANTHROPIC_", "OPENAI_", "OLLAMA_URL", "SMTP_URL", "JOBS_", "SANDBOX_",
    "REPRO_", "CLAMD_", "SCHOLIUM_", "WEB_ORIGINS", "RATE_LIMIT_ENABLED", "HOST", "PORT",
    "FORWARDED_ALLOW_IPS", "NEXT_PUBLIC_", "PYTEST_XDIST", "PYTEST_CURRENT_TEST",
)


# --------------------------------------------------------------------------- environment


def free_port() -> int:
    """A TCP port nothing listens on right now (the caller binds it a moment later)."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def clean_env(**overrides: Optional[str]) -> dict[str, str]:
    """The inherited environment minus every application setting, plus ``overrides``.

    ``None`` removes a variable.  ``PYTHONPATH`` always carries the API's source
    trees, so ``python -m app`` works from any working directory even when the
    workspace packages are not installed in the interpreter.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(_APP_ENV_PREFIXES)
    }
    source_dirs = [API_DIR / "src"] + sorted((API_DIR / "packages").glob("*/src"))
    existing = [env["PYTHONPATH"]] if env.get("PYTHONPATH") else []
    env["PYTHONPATH"] = os.pathsep.join([*map(str, source_dirs), *existing])
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


# --------------------------------------------------------------------------- processes


#: Every program started and not yet stopped, so that nothing outlives the test run.
_LIVE: "set[Process]" = set()


def kill_everything() -> None:
    """Stop every program still running (the backstop for an interrupted run)."""
    for process in list(_LIVE):
        process.stop(timeout=10)


atexit.register(kill_everything)


class StartupError(AssertionError):
    """A program did not come up; the message carries the tail of its log."""


class Process:
    """One program running in the background, its output going to a log file."""

    def __init__(
        self,
        name: str,
        argv: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: Path,
        log_path: Path,
    ) -> None:
        self.name = name
        self.argv = list(argv)
        self.log_path = log_path
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = open(log_path, "wb")
        self.popen = subprocess.Popen(
            self.argv,
            env=dict(env),
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # SIGTERM goes to the whole group, like a service manager
        )
        _LIVE.add(self)

    # -- state

    @property
    def returncode(self) -> Optional[int]:
        return self.popen.poll()

    @property
    def alive(self) -> bool:
        return self.popen.poll() is None

    @property
    def log(self) -> str:
        if not self._log.closed:
            self._log.flush()
        try:
            return self.log_path.read_text(errors="replace")
        except FileNotFoundError:
            return ""

    def describe_failure(self, reason: str) -> str:
        status = "still running" if self.alive else f"exited with status {self.returncode}"
        tail = "\n".join(self.log.splitlines()[-40:])
        return f"{self.name}: {reason} ({status}). Log tail:\n{tail}"

    # -- waiting

    def wait_until(self, check, *, timeout: float = START_TIMEOUT, what: str = "to be ready") -> Any:
        """Poll ``check()`` until it returns something truthy; fail early if the process dies."""
        deadline = time.monotonic() + timeout
        last_error: Optional[BaseException] = None
        while time.monotonic() < deadline:
            if not self.alive:
                raise StartupError(self.describe_failure(f"stopped while waiting {what}"))
            try:
                result = check()
                if result:
                    return result
            except (httpx.HTTPError, OSError) as exc:
                last_error = exc
            time.sleep(0.2)
        raise StartupError(self.describe_failure(f"did not become ready {what} in {timeout:.0f}s ({last_error!r})"))

    def wait_for_http(self, url: str, *, timeout: float = START_TIMEOUT) -> httpx.Response:
        def probe() -> Optional[httpx.Response]:
            response = httpx.get(url, timeout=5.0)
            return response if response.status_code == 200 else None

        return self.wait_until(probe, timeout=timeout, what=f"GET {url} to answer 200")

    def wait_for_log(self, text: str, *, timeout: float = 30.0) -> None:
        self.wait_until(lambda: text in self.log, timeout=timeout, what=f"to log {text!r}")

    def wait_for_exit(self, timeout: float = 30.0) -> int:
        try:
            return self.popen.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise StartupError(self.describe_failure(f"did not exit within {timeout:.0f}s")) from None

    # -- stopping

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 30.0) -> Optional[int]:
        """Send ``sig`` to the process group and wait; kill what does not leave.

        Returns the exit status of the process (``None`` if it had to be killed).
        """
        _LIVE.discard(self)
        if self.alive:
            self._signal(sig)
            try:
                self.popen.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self._signal(signal.SIGKILL)
                self.popen.wait(timeout=10)
                self._log.close()
                return None
        self._log.close()
        return self.popen.returncode

    def _signal(self, sig: int) -> None:
        try:
            os.killpg(self.popen.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def run_command(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    cwd: Path,
    timeout: float = 180.0,
    input: Optional[str] = None,
) -> subprocess.CompletedProcess[str]:
    """Run a program to completion and return what it printed and how it ended."""
    return subprocess.run(
        list(argv),
        env=dict(env),
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        input=input,
        check=False,
    )


# --------------------------------------------------------------------------- the node


@dataclass
class Node:
    """One Scholium node: a data directory, an environment and the programs run on it.

    ``storage`` is ``"fs"`` (files under ``content/``) or ``"s3"`` (an endpoint,
    ``FakeS3`` in these tests).  ``jobs`` is the ``JOBS_MODE``.  Every setting
    can be replaced through ``env``.
    """

    root: Path
    name: str = "node"
    storage: str = "fs"
    jobs: str = "thread"
    s3: Optional["FakeS3"] = None
    smtp: Optional["SmtpSink"] = None
    env: dict[str, Optional[str]] = field(default_factory=dict)
    port: int = field(default_factory=free_port)
    api: Optional[Process] = None
    worker: Optional[Process] = None
    extra: list[Process] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    # -- paths and URLs

    @property
    def db_path(self) -> Path:
        return self.root / "scholium.db"

    @property
    def content_dir(self) -> Path:
        return self.root / "content"

    @property
    def key_path(self) -> Path:
        return self.root / "node.key"

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def settings(self, **overrides: Optional[str]) -> dict[str, str]:
        """The environment of every program of this node."""
        values: dict[str, Optional[str]] = {
            "DATABASE_URL": f"sqlite:///{self.db_path}",
            "CONTENT_DIR": str(self.content_dir),
            "NODE_KEY_PATH": str(self.key_path),
            "JWT_SECRET": "e2e-jwt-secret-" + "x" * 48,
            "ORCID_MOCK": "1",
            "ARXIV_MOCK": "1",
            "AI_PROVIDER": "fake",
            "SCHOLIUM_ENV": "dev",
            "JOBS_MODE": self.jobs,
            "STORAGE_BACKEND": self.storage,
            "SANDBOX_BACKEND": "none",
            "WEB_ORIGINS": "http://localhost:3000",
            "HOST": "127.0.0.1",
            "PORT": str(self.port),
        }
        if self.smtp is not None:
            values["SMTP_URL"] = self.smtp.url
        if self.storage == "s3":
            assert self.s3 is not None, "STORAGE_BACKEND=s3 needs an S3 endpoint"
            values.update(self.s3.settings())
        values.update(self.env)
        values.update(overrides)
        return clean_env(**values)

    # -- programs

    def python(self, *args: str, timeout: float = 180.0, **overrides: Optional[str]) -> subprocess.CompletedProcess[str]:
        """``python <args>`` on this node, to completion."""
        return run_command(
            [sys.executable, *args], env=self.settings(**overrides), cwd=self.root, timeout=timeout
        )

    def spawn(self, name: str, *args: str, **overrides: Optional[str]) -> Process:
        process = Process(
            f"{self.name}:{name}",
            [sys.executable, *args],
            env=self.settings(**overrides),
            cwd=self.root,
            log_path=self.root / "logs" / f"{name}-{len(self.extra)}.log",
        )
        self.extra.append(process)
        return process

    def admin(self, *args: str) -> subprocess.CompletedProcess[str]:
        """``python -m app.modules.admin <args>``: how an operator provisions a node."""
        return self.python("-m", "app.modules.admin", *args)

    def init_key(self) -> str:
        """Create the node's signing key (a fresh node has none) and return its ``did:key``."""
        done = self.admin("init-node")
        assert done.returncode == 0, done.stdout + done.stderr
        assert self.key_path.exists(), done.stdout + done.stderr
        return done.stdout

    def set_tier(self, did: str, tier: str) -> None:
        done = self.admin("set-tier", did, tier)
        assert done.returncode == 0, done.stdout + done.stderr

    def start_api(self, *, wait: bool = True, **overrides: Optional[str]) -> Process:
        """``python -m app``: the shipped API entrypoint."""
        self.api = Process(
            f"{self.name}:api",
            [sys.executable, "-m", "app"],
            env=self.settings(**overrides),
            cwd=self.root,
            log_path=self.root / "logs" / "api.log",
        )
        if wait:
            self.api.wait_for_http(f"{self.base_url}/healthz")
        return self.api

    def start_worker(self, **overrides: Optional[str]) -> Process:
        """``python -m app.worker``: the separate background worker."""
        self.worker = Process(
            f"{self.name}:worker",
            [sys.executable, "-m", "app.worker"],
            env=self.settings(**overrides),
            cwd=self.root,
            log_path=self.root / "logs" / "worker.log",
        )
        # The worker logs "worker <id> started" once it has loaded every module and
        # entered its claim loop; a broken worker dies first and fails the test here.
        self.worker.wait_for_log(" started", timeout=START_TIMEOUT)
        return self.worker

    def client(self, **kwargs: Any) -> httpx.Client:
        kwargs.setdefault("timeout", 30.0)
        return httpx.Client(base_url=self.base_url, **kwargs)

    def stop(self) -> None:
        for process in (self.api, self.worker, *self.extra):
            if process is not None:
                process.stop()
        self.api = None
        self.worker = None
        self.extra = []

    # -- looking at the data from the outside

    def sql(self, query: str, *params: Any) -> list[tuple]:
        """Rows from the node's SQLite file, read-only (what an operator would do with sqlite3)."""
        with closing(sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=10)) as db:
            return db.execute(query, params).fetchall()


# --------------------------------------------------------------------------- neighbours


class FakeS3:
    """A small S3-compatible endpoint on a loopback port (path-style addressing).

    It stands where MinIO stands in ``compose.yaml``: the node talks to it with
    its normal S3 client and credentials, over HTTP.  It implements the calls the
    application makes (put, get with ranges, head, delete, list v2) and refuses
    a request that carries other credentials than the ones it was started with.
    """

    def __init__(self, bucket: str = "scholium-e2e") -> None:
        self.bucket = bucket
        self.access_key = "AKIAE2EPLACEHOLDER"
        self.secret_key = "e2e-placeholder-secret-not-real"
        self.objects: dict[str, bytes] = {}
        self.requests: list[tuple[str, str]] = []
        self._lock = threading.Lock()
        handler = self._handler()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def settings(self) -> dict[str, str]:
        return {
            "S3_ENDPOINT_URL": self.endpoint,
            "S3_BUCKET": self.bucket,
            "S3_REGION": "us-east-1",
            "S3_ACCESS_KEY_ID": self.access_key,
            "S3_SECRET_ACCESS_KEY": self.secret_key,
            "S3_FORCE_PATH_STYLE": "1",
        }

    def keys(self, prefix: str = "") -> list[str]:
        with self._lock:
            return sorted(key for key in self.objects if key.startswith(prefix))

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:  # silence
                pass

            # -- plumbing

            def _split(self) -> tuple[str, str, dict[str, list[str]]]:
                parsed = urlparse(self.path)
                parts = unquote(parsed.path).lstrip("/").split("/", 1)
                bucket = parts[0]
                key = parts[1] if len(parts) > 1 else ""
                return bucket, key, parse_qs(parsed.query, keep_blank_values=True)

            def _reply(self, status: int, body: bytes = b"", headers: Optional[dict[str, str]] = None,
                       content_type: str = "application/xml", length: Optional[int] = None) -> None:
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                if body or self.command != "HEAD":
                    self.send_header("Content-Type", content_type)
                # A HEAD answer states the length of the body a GET would carry.
                self.send_header("Content-Length", str(len(body) if length is None else length))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _error(self, status: int, code: str, message: str = "") -> None:
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    f"<Error><Code>{code}</Code><Message>{escape(message or code)}</Message></Error>"
                ).encode()
                self._reply(status, body)

            def _authorised(self) -> bool:
                auth = self.headers.get("Authorization", "")
                return auth.startswith("AWS4-HMAC-SHA256") and f"Credential={fake.access_key}/" in auth

            def _read_body(self) -> bytes:
                length = int(self.headers.get("Content-Length") or 0)
                data = self.rfile.read(length) if length else b""
                if "aws-chunked" in (self.headers.get("Content-Encoding") or ""):
                    data = _decode_aws_chunked(data)
                return data

            def _dispatch(self) -> None:
                with fake._lock:
                    fake.requests.append((self.command, self.path))
                if not self._authorised():
                    self._read_body()
                    return self._error(403, "AccessDenied", "bad or missing credentials")
                bucket, key, query = self._split()
                if bucket != fake.bucket:
                    self._read_body()
                    return self._error(404, "NoSuchBucket")
                getattr(self, f"_do_{self.command}")(key, query)

            do_GET = do_PUT = do_HEAD = do_DELETE = do_POST = _dispatch

            # -- verbs

            def _do_PUT(self, key: str, query: dict) -> None:
                if not key or "uploadId" in query or "partNumber" in query:
                    self._read_body()
                    return self._error(501, "NotImplemented", "multipart upload is not supported")
                data = self._read_body()
                with fake._lock:
                    fake.objects[key] = data
                self._reply(200, headers={"ETag": f'"{hashlib.md5(data).hexdigest()}"'})

            def _do_POST(self, key: str, query: dict) -> None:
                self._read_body()
                self._error(501, "NotImplemented")

            def _do_DELETE(self, key: str, query: dict) -> None:
                with fake._lock:
                    fake.objects.pop(key, None)
                self._reply(204)

            def _do_HEAD(self, key: str, query: dict) -> None:
                if not key:
                    return self._reply(200)
                with fake._lock:
                    data = fake.objects.get(key)
                if data is None:
                    return self._reply(404)
                self._reply(
                    200,
                    headers={"ETag": f'"{hashlib.md5(data).hexdigest()}"', "Accept-Ranges": "bytes"},
                    length=len(data),
                )

            def _do_GET(self, key: str, query: dict) -> None:
                if not key:
                    return self._list(query)
                with fake._lock:
                    data = fake.objects.get(key)
                if data is None:
                    return self._error(404, "NoSuchKey", "The specified key does not exist.")
                status, body, headers = 200, data, {"Accept-Ranges": "bytes"}
                requested = self.headers.get("Range")
                if requested:
                    match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested.strip())
                    if not match or (not match.group(1) and not match.group(2)):
                        return self._error(416, "InvalidRange")
                    size = len(data)
                    if match.group(1):
                        start = int(match.group(1))
                        end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
                    else:
                        start, end = max(0, size - int(match.group(2))), size - 1
                    if start >= size or start > end:
                        return self._error(416, "InvalidRange")
                    status, body = 206, data[start : end + 1]
                    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
                headers["ETag"] = f'"{hashlib.md5(data).hexdigest()}"'
                self._reply(status, body, headers, content_type="application/octet-stream")

            def _list(self, query: dict) -> None:
                prefix = query.get("prefix", [""])[0]
                limit = min(int(query.get("max-keys", ["1000"])[0]), 1000)
                after = query.get("continuation-token", [""])[0]
                if after:
                    after = base64.urlsafe_b64decode(after.encode()).decode()
                with fake._lock:
                    keys = sorted(k for k in fake.objects if k.startswith(prefix) and k > after)
                    sizes = {k: len(fake.objects[k]) for k in keys[:limit]}
                page = keys[:limit]
                truncated = len(keys) > limit
                contents = "".join(
                    f"<Contents><Key>{escape(k)}</Key><Size>{sizes[k]}</Size>"
                    "<LastModified>2026-01-01T00:00:00.000Z</LastModified>"
                    "<StorageClass>STANDARD</StorageClass></Contents>"
                    for k in page
                )
                token = (
                    "<NextContinuationToken>"
                    + base64.urlsafe_b64encode(page[-1].encode()).decode()
                    + "</NextContinuationToken>"
                    if truncated
                    else ""
                )
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                    f"<Name>{fake.bucket}</Name><Prefix>{escape(prefix)}</Prefix>"
                    f"<KeyCount>{len(page)}</KeyCount><MaxKeys>{limit}</MaxKeys>"
                    f"<IsTruncated>{'true' if truncated else 'false'}</IsTruncated>{token}{contents}"
                    "</ListBucketResult>"
                ).encode()
                self._reply(200, body)

        return Handler


def _decode_aws_chunked(data: bytes) -> bytes:
    """The payload of an ``aws-chunked`` body (chunk-size line, bytes, CRLF, ... then trailers)."""
    out = io.BytesIO()
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        line_end = bytes(view[offset:]).find(b"\r\n")
        if line_end < 0:
            break
        size = int(bytes(view[offset : offset + line_end]).split(b";")[0] or b"0", 16)
        offset += line_end + 2
        if size == 0:
            break
        out.write(view[offset : offset + size])
        offset += size + 2
    return out.getvalue()


@dataclass
class Mail:
    sender: str
    recipients: list[str]
    message: Message

    @property
    def subject(self) -> str:
        return str(self.message.get("Subject", ""))

    @property
    def body(self) -> str:
        if self.message.is_multipart():
            parts = [p.get_payload(decode=True) for p in self.message.walk() if p.get_content_type() == "text/plain"]
            return "\n".join(p.decode("utf-8", "replace") for p in parts if p)
        payload = self.message.get_payload(decode=True)
        return payload.decode("utf-8", "replace") if payload else ""


class SmtpSink:
    """A mail server that keeps what it is sent (``SMTP_URL=smtp://127.0.0.1:<port>``)."""

    def __init__(self) -> None:
        self.mails: list[Mail] = []
        self._lock = threading.Lock()
        sink = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                def send(line: str) -> None:
                    self.wfile.write(line.encode() + b"\r\n")
                    self.wfile.flush()

                send("220 e2e-sink ESMTP ready")
                sender, recipients = "", []
                while True:
                    raw = self.rfile.readline()
                    if not raw:
                        return
                    command = raw.decode("utf-8", "replace").strip()
                    verb = command.split(" ", 1)[0].upper()
                    if verb in ("EHLO", "HELO"):
                        send("250 e2e-sink")
                    elif verb == "MAIL":
                        sender, recipients = command.split(":", 1)[1].strip(), []
                        send("250 ok")
                    elif verb == "RCPT":
                        recipients.append(command.split(":", 1)[1].strip().strip("<>"))
                        send("250 ok")
                    elif verb == "DATA":
                        send("354 end with <CRLF>.<CRLF>")
                        lines = []
                        while True:
                            line = self.rfile.readline()
                            if not line or line in (b".\r\n", b".\n"):
                                break
                            lines.append(line[1:] if line.startswith(b"..") else line)
                        message = email.message_from_bytes(b"".join(lines))
                        with sink._lock:
                            sink.mails.append(Mail(sender, list(recipients), message))
                        send("250 queued")
                    elif verb in ("RSET", "NOOP"):
                        send("250 ok")
                    elif verb == "QUIT":
                        send("221 bye")
                        return
                    else:
                        send("502 not implemented")

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = Server(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"smtp://127.0.0.1:{self.port}"

    def to(self, address_part: str) -> list[Mail]:
        with self._lock:
            return [m for m in self.mails if any(address_part in r for r in m.recipients)]

    def wait_for(self, predicate, *, timeout: float = 45.0, what: str = "a matching mail") -> Mail:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                for mail in self.mails:
                    if predicate(mail):
                        return mail
            time.sleep(0.2)
        with self._lock:
            seen = [(m.recipients, m.subject) for m in self.mails]
        raise AssertionError(f"no mail arrived: expected {what} within {timeout:.0f}s; saw {seen}")

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


#: The standard antivirus test string (harmless: it only trips scanners).
EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


class FakeClamd:
    """A ``clamd`` on a loopback port: the daemon an operator points ``CLAMD_SOCKET`` at.

    It speaks the real protocol (``VERSION``, ``PING``, and ``INSTREAM`` with
    length-prefixed chunks) and reports the EICAR test string as malware and
    everything else as clean.  ``scanned`` keeps what it was asked to scan.
    """

    def __init__(self) -> None:
        self.scanned: list[bytes] = []
        self._lock = threading.Lock()
        daemon = self

        class Handler(socketserver.StreamRequestHandler):
            def _command(self) -> tuple[bytes, bool]:
                # As clamd reads it: zCMD\0 and nCMD\n are delimited, anything
                # else is a legacy newline-terminated command.
                first = self.rfile.read(1)
                if first in (b"z", b"n"):
                    end = b"\0" if first == b"z" else b"\n"
                    command = b""
                    while (byte := self.rfile.read(1)) not in (end, b""):
                        command += byte
                    return command, True
                return (first + self.rfile.readline()).strip(), False

            def handle(self) -> None:
                command, prefixed = self._command()
                if command == b"VERSION":
                    self.wfile.write(b"ClamAV 1.4.2/27500/Wed Nov 18 06:00:00 2026\0")
                elif command == b"PING":
                    self.wfile.write(b"PONG\0")
                elif command == b"INSTREAM" and prefixed:
                    # Real clamd (1.4.7) answers "UNKNOWN COMMAND" to an
                    # unprefixed INSTREAM, so this fake does too.
                    data = io.BytesIO()
                    while True:
                        header = self.rfile.read(4)
                        if len(header) < 4:
                            return
                        size = int.from_bytes(header, "big")
                        if size == 0:
                            break
                        data.write(self.rfile.read(size))
                    content = data.getvalue()
                    with daemon._lock:
                        daemon.scanned.append(content)
                    verdict = b"stream: Eicar-Test-Signature FOUND" if EICAR in content else b"stream: OK"
                    self.wfile.write(verdict + b"\0")
                else:
                    self.wfile.write(b"UNKNOWN COMMAND\0")
                self.wfile.flush()

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = Server(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def address(self) -> str:
        """The value of ``CLAMD_SOCKET``."""
        return f"127.0.0.1:{self.port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


# --------------------------------------------------------------------------- people


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assert_problem(response: httpx.Response, status: int) -> dict:
    """Assert ``response`` is an RFC 9457 problem document with ``status``; return it."""
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), dict(response.headers)
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def blank_pdf(pages: int = 1, width: int = 72) -> bytes:
    """A minimal valid PDF (``width`` makes distinct files distinct bytes)."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=width, height=72)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def text_pdf(*lines: str) -> bytes:
    """A small PDF whose single page carries ``lines`` as a text layer (Helvetica, one line each)."""

    def escape(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    stream = "BT /F1 11 Tf\n" + "".join(
        f"1 0 0 1 72 {720 - 20 * i} Tm ({escape(line)}) Tj\n" for i, line in enumerate(lines)
    ) + "ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def code_bundle(script: str = "#!/bin/sh\necho reproduced 42\n") -> bytes:
    """A gzipped tar holding one executable ``reproduce.sh``: the code bundle of a paper."""
    import tarfile

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        data = script.encode()
        entry = tarfile.TarInfo("reproduce.sh")
        entry.size = len(data)
        entry.mode = 0o755
        archive.addfile(entry, io.BytesIO(data))
    return buffer.getvalue()


def _refresh_cookie(response: httpx.Response) -> str:
    for header in response.headers.get_list("set-cookie"):
        if header.lower().startswith("scholium_refresh="):
            return header.split(";", 1)[0].split("=", 1)[1]
    raise AssertionError(f"no scholium_refresh cookie: {response.headers.get_list('set-cookie')}")


class Actor:
    """A person with a fresh ``did:key`` who uses the node only over HTTP."""

    def __init__(self, node: Node, client: httpx.Client) -> None:
        self.node = node
        self.client = client
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.access_token: Optional[str] = None
        self.refresh_token: Optional[str] = None

    def sign_in(self) -> "Actor":
        challenge = self.client.post("/v1/auth/challenge", json={"did": self.did})
        assert challenge.status_code == 200, challenge.text
        nonce = challenge.json()["nonce"]
        signature = encode_signature(self.seed.sign(nonce.encode("utf-8")).signature)
        verified = self.client.post(
            "/v1/auth/verify", json={"did": self.did, "nonce": nonce, "signature": signature}
        )
        assert verified.status_code == 200, verified.text
        self._keep(verified)
        return self

    def refresh(self) -> None:
        assert self.refresh_token, "sign in first"
        refreshed = self.client.post("/v1/auth/refresh", json={"refresh_token": self.refresh_token})
        assert refreshed.status_code == 200, refreshed.text
        self._keep(refreshed)

    def _keep(self, response: httpx.Response) -> None:
        self.access_token = response.json()["access_token"]
        self.refresh_token = _refresh_cookie(response)

    @property
    def headers(self) -> dict[str, str]:
        assert self.access_token, "sign in first"
        return {"Authorization": f"Bearer {self.access_token}"}

    @property
    def tier(self) -> int:
        assert self.access_token
        return int(jwt.decode(self.access_token, options={"verify_signature": False})["tier"])

    def promote(self, tier: str) -> "Actor":
        """Appoint this actor with the operator's admin command, then fetch a token that carries it."""
        self.node.set_tier(self.did, tier)
        self.refresh()
        return self

    def link_orcid(self, orcid: str) -> dict:
        start = self.client.get("/v1/auth/orcid/start", headers=self.headers)
        assert start.status_code == 200, start.text
        completed = self.client.post(
            "/v1/auth/orcid/complete",
            json={"code": f"mock-{orcid}", "state": start.json()["state"]},
            headers=self.headers,
        )
        assert completed.status_code == 200, completed.text
        return completed.json()

    def record(self, record_type: str, body: dict, *, prev: Any = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": now(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )

    def submit(self, record: dict) -> httpx.Response:
        return self.client.post("/v1/records", json=record, headers=self.headers)

    def upload(self, data: bytes) -> str:
        """Upload ``data`` over tus (create, then PATCH); return the content id the node computed."""
        created = self.client.post(
            "/v1/uploads",
            headers={**self.headers, "Tus-Resumable": "1.0.0", "Upload-Length": str(len(data))},
        )
        assert created.status_code == 201, created.text
        upload_id = created.headers["Location"].rsplit("/", 1)[-1]
        patched = self.client.patch(
            f"/v1/uploads/{upload_id}",
            content=data,
            headers={
                **self.headers,
                "Tus-Resumable": "1.0.0",
                "Content-Type": "application/offset+octet-stream",
                "Upload-Offset": "0",
            },
        )
        assert patched.status_code == 204, patched.text
        cid = patched.headers.get("Upload-Cid")
        assert cid, dict(patched.headers)
        return cid


# --------------------------------------------------------------------------- journeys


PROFILE = {"name": "Ada Lovelace", "affiliation": "Analytical Engine Co.", "email": "ada@example.org"}
ORCID_ID = "0000-0002-1825-0097"


def poll(check, *, timeout: float = 60.0, what: str = "the condition", interval: float = 0.3) -> Any:
    """Call ``check()`` until it returns something truthy; fail with ``what`` after ``timeout``."""
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = check()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"timed out after {timeout:.0f}s waiting for {what}; last value: {last!r}")


def verification_path(mail: Mail) -> tuple[str, str]:
    """``(did, token)`` of the link an email-verification mail carries."""
    match = re.search(r"Open:\s*(\S+)", mail.body)
    assert match, f"no link in the verification mail: {mail.body!r}"
    params = parse_qs(urlparse(match.group(1)).query)
    return params["did"][0], params["token"][0]


@dataclass
class Published:
    """What a published, listed paper consists of."""

    author: Actor
    moderator: Actor
    coauthors: list[Actor]
    pdf: bytes
    file_cid: str
    manifest_cid: str
    paper_cid: str
    version_cid: str
    short_id: str
    title: str
    #: A sentence of the manuscript's text layer, which extraction must find.
    sentence: str
    #: ``{path: content id}`` of every file the manifest lists.
    files: dict[str, str] = field(default_factory=dict)


def make_author(node: Node, client: httpx.Client, endorser: Actor) -> Actor:
    """A signed-in, email-verified, ORCID-linked author endorsed in ``cs.AI`` (tier 2).

    The verification mail is read from the node's mail server, as the author would.
    """
    assert node.smtp is not None, "the node needs an SmtpSink to verify an email address"
    author = Actor(node, client).sign_in()
    saved = client.put(f"/v1/profiles/{author.did}", json=PROFILE, headers=author.headers)
    assert saved.status_code == 200, saved.text
    mail = node.smtp.wait_for(
        lambda m: "verify-email" in m.body and author.did in unquote(m.body),
        what=f"the verification mail for {author.did}",
    )
    did, token = verification_path(mail)
    assert did == author.did
    verified = client.post(f"/v1/profiles/{quote(did, safe=':')}/verify-email", params={"token": token})
    assert verified.status_code in (200, 204), verified.text
    author.link_orcid(ORCID_ID)
    author.refresh()
    endorsement = endorser.record(
        "endorsement", {"endorsee": author.did, "category": "cs.AI", "statement": "ok"}
    )
    accepted = endorser.submit(endorsement)
    assert accepted.status_code == 201, accepted.text
    author.refresh()
    assert author.tier == 2
    return author


def publish_listed_paper(
    node: Node,
    client: httpx.Client,
    *,
    title: str = "End-to-end paper",
    pdf: Optional[bytes] = None,
    extra_files: Sequence[tuple[str, bytes, str, str]] = (),
    wait: float = 90.0,
) -> Published:
    """Run the whole submission over HTTP until a moderator has listed the paper.

    Every step goes through the public API; the only things done another way
    are the ones an operator does on the command line (the moderator's tier,
    through ``python -m app.modules.admin``) and reading the verification mail
    from the mail server.  Scanning runs on
    whatever executes jobs for this node: the worker process, the in-process
    thread, or eagerly.
    """
    # A moderator may endorse in any category, so the first author of a fresh node
    # is vouched for by the moderator the operator appointed.
    moderator = Actor(node, client).sign_in().promote("moderator")
    assert moderator.tier == 4
    author = make_author(node, client, moderator)
    co1 = Actor(node, client).sign_in()
    co2 = Actor(node, client).sign_in()

    sentence = f"Reproducible findings travel the whole system {secrets.token_hex(4)}."
    pdf = pdf or text_pdf(title, "", sentence)
    file_cid = author.upload(pdf)
    assert file_cid == compute_file_id(pdf), "the node's content id is not the sha-256 CID of the bytes"

    files = [{"path": "main.pdf", "cid": file_cid, "size": len(pdf),
              "mediaType": "application/pdf", "role": "manuscript"}]
    for path, data, media_type, role in extra_files:
        files.append({"path": path, "cid": author.upload(data), "size": len(data),
                      "mediaType": media_type, "role": role})
    manifest = author.record("manifest", {"files": files})
    assert author.submit(manifest).status_code == 201

    genesis = author.record(
        "paper.genesis",
        {"title": title, "abstract": "A paper that travels the whole system.", "categories": ["cs.AI"],
         "licence": "CC-BY-4.0", "authors": [author.did, co1.did, co2.did]},
    )
    started = author.submit(genesis)
    assert started.status_code == 201, started.text
    short_id = started.json().get("shortId") or started.json().get("short_id")
    assert short_id == derive_short_id(genesis["id"]), started.text

    version = author.record(
        "paper.version",
        {"paper": genesis["id"], "n": 1, "title": f"{title} v1", "abstract": "The first version.",
         "authors": [{"did": who.did, "position": i, "creditRoles": ["Conceptualization"]}
                     for i, who in enumerate((author, co1, co2), start=1)],
         "manifest": manifest["id"], "licence": "CC-BY-4.0", "changeNote": "v1"},
        prev=genesis["id"],
    )
    assert author.submit(version).status_code == 201

    for who in (author, co1, co2):
        consent = who.record(
            "coauthor.consent",
            {"version": version["id"], "role": "Conceptualization", "decision": "accept"},
        )
        assert who.submit(consent).status_code == 201

    # Scanning is a job: it runs on the worker, the thread or inline.  It ends with
    # the version in the moderator's queue, its scan passed.
    def queued() -> Optional[dict]:
        listing = client.get("/v1/moderation/queue", headers=moderator.headers)
        assert listing.status_code == 200, listing.text
        return next((item for item in listing.json() if item["version_cid"] == version["id"]), None)

    item = poll(queued, timeout=wait, what="the scanned version to reach the moderation queue")
    assert item["scan_result"] == "passed", item
    assert item["short_id"] == short_id

    clause = client.get("/v1/moderation/policies").json()[0]["id"]
    decision = moderator.record(
        "moderation.decision",
        {"target": version["id"], "action": "list", "clause": clause, "reason": "ok"},
    )
    listed = moderator.submit(decision)
    assert listed.status_code == 201, listed.text
    assert listed.json()["state"] == "listed", listed.text

    return Published(
        author=author, moderator=moderator, coauthors=[co1, co2], pdf=pdf, file_cid=file_cid,
        manifest_cid=manifest["id"], paper_cid=genesis["id"], version_cid=version["id"],
        short_id=short_id, title=f"{title} v1", sentence=sentence,
        files={f["path"]: f["cid"] for f in files},
    )


# --------------------------------------------------------------------------- content checks


def cid_of(data: bytes) -> str:
    return compute_file_id(data)


def assert_bytes_match_cid(data: bytes, cid: str) -> None:
    """The bytes hash to the content id they are served under."""
    assert str(CID.decode(cid)) == cid
    assert compute_file_id(data) == cid, "served bytes do not hash to their CID"


def json_of(response: httpx.Response) -> Any:
    assert response.status_code == 200, f"{response.request.method} {response.request.url}: {response.status_code} {response.text}"
    return response.json()
