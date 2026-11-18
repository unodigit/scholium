"""Tests for the sandbox service (``python -m app.sandbox_service``).

No test starts a container: :class:`FakeDocker` (shared with the sandbox tests)
plays the docker CLI, and the service is driven in-process through
``TestClient``.  The contract tests run the real
:func:`~app.modules.ai_review.sandbox.run_remote_bundle` against the service, so
a change on either side of the wire fails here.
"""

from __future__ import annotations

import dataclasses
import hashlib
import hmac
import io
import os
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

import app as app_package
from app.modules.ai_review import sandbox
from app.modules.ai_review.sandbox import SandboxLimits, run_bundle, run_remote_bundle
from app.modules.ai_review.tests.sandbox_support import (
    FakeDocker,
    flag,
    make_executable,
    tar_bytes,
    tar_member,
    zip_bytes,
)
from app.modules.content import store as content_store
from app.sandbox_service import (
    FilesystemStore,
    ServiceConfigError,
    app as service_app,
    create_app,
    default_store,
)
from app.sandbox_service import __main__ as entry
from app.settings import settings
from scholium_record_core import compute_file_id

TOKEN = "sandbox-test-token-" + "x" * 20
AUTH = {"Authorization": f"Bearer {TOKEN}"}
PENDING = ("queued", "running")

BUNDLE = zip_bytes({"reproduce.sh": "echo hello\n"})


def cid_of(data: bytes) -> str:
    return compute_file_id(data)


class MemoryStore:
    """An object store in a dict that remembers which keys were opened."""

    def __init__(self, objects: Optional[dict[str, bytes]] = None) -> None:
        self.objects = dict(objects or {})
        self.opened: list[str] = []

    def add(self, data: bytes) -> str:
        cid = cid_of(data)
        self.objects[cid] = data
        return cid

    def open(self, key: str) -> io.BytesIO:
        self.opened.append(key)
        try:
            return io.BytesIO(self.objects[key])
        except KeyError:
            raise FileNotFoundError(key) from None


class GatedDocker(FakeDocker):
    """A FakeDocker whose ``wait`` blocks until the test opens the gate."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.gate = threading.Event()
        self.waiting = threading.Semaphore(0)

    def __call__(self, argv, timeout, merge_stderr=False):
        if self.name(argv) == "wait":
            self.waiting.release()
            self.gate.wait(15)
        return super().__call__(argv, timeout, merge_stderr)


def await_run(client: TestClient, run_id: str, *, timeout: float = 10.0) -> dict:
    """Poll ``GET /runs/{id}`` until the run is no longer pending; its reply."""
    deadline = time.monotonic() + timeout
    while True:
        reply = client.get(f"/runs/{run_id}", headers=AUTH)
        assert reply.status_code == 200, reply.text
        body = reply.json()
        if body["status"] not in PENDING:
            return body
        assert time.monotonic() < deadline, f"run still {body['status']} after {timeout}s"
        time.sleep(0.01)


def sandbox_dirs(scratch: Path) -> list[Path]:
    """The archives the service holds; ``run_archive`` has its own unpack directory."""
    return [path for path in scratch.iterdir() if path.name.startswith("scholium-sandbox-")]


@dataclass
class Harness:
    client: TestClient
    docker: FakeDocker
    store: MemoryStore
    binary: str

    def post(self, cid: str, *, limits: Optional[dict] = None, headers=AUTH):
        body: dict = {"bundle_cid": cid}
        if limits is not None:
            body["limits"] = limits
        return self.client.post("/runs", json=body, headers=headers)

    def finish(self, run_id: str, *, timeout: float = 10.0) -> dict:
        return await_run(self.client, run_id, timeout=timeout)

    def run(self, data: bytes = BUNDLE, **post) -> dict:
        """Store ``data``, POST it, wait for the run and return its final reply."""
        reply = self.post(self.store.add(data), **post)
        assert reply.status_code == 202, reply.text
        return self.finish(reply.json()["run_id"])


@pytest.fixture(autouse=True)
def clean_configuration(monkeypatch):
    """No SANDBOX_* or STORAGE_* setting of the developer's machine reaches a test."""
    for name in (
        "SANDBOX_TOKEN",
        "SANDBOX_BACKEND",
        "SANDBOX_URL",
        "SANDBOX_CONCURRENCY",
        "SANDBOX_QUEUE_LIMIT",
        "REPRO_DOCKER_IMAGE",
        "STORAGE_BACKEND",
        "HOST",
        "PORT",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(settings, "SANDBOX_TOKEN", "")
    monkeypatch.setattr(settings, "SANDBOX_BACKEND", "docker")
    monkeypatch.setattr(settings, "SANDBOX_URL", "")


@pytest.fixture
def scratch(tmp_path, monkeypatch) -> Path:
    """Where every temporary directory the service makes lands, so leaks show."""
    root = tmp_path / "scratch"
    root.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(root))
    return root


@pytest.fixture
def make_service(tmp_path, scratch):
    stack = ExitStack()
    counter = iter(range(1000))

    def build(
        *,
        store: Optional[MemoryStore] = None,
        docker: Optional[FakeDocker] = None,
        backend: str = "docker",
        **kwargs,
    ) -> Harness:
        store = store if store is not None else MemoryStore()
        docker = docker if docker is not None else FakeDocker(output=b"hello\n")
        directory = tmp_path / f"bin{next(counter)}"
        directory.mkdir()
        binary = str(make_executable(directory / backend))
        kwargs.setdefault("docker_bin", binary)
        kwargs.setdefault("podman_bin", binary)
        application = create_app(
            token=TOKEN, store=store, runner=docker, backend=backend, **kwargs
        )
        client = stack.enter_context(TestClient(application))
        return Harness(client=client, docker=docker, store=store, binary=binary)

    with stack:
        yield build


@pytest.fixture
def service(make_service) -> Harness:
    return make_service()


# --------------------------------------------------------------------------- #
# Authentication                                                              #
# --------------------------------------------------------------------------- #


class TestAuthentication:
    def test_post_without_a_token_is_401_and_the_store_is_not_touched(self, service):
        cid = service.store.add(BUNDLE)
        reply = service.post(cid, headers={})
        assert reply.status_code == 401
        assert reply.headers["www-authenticate"] == "Bearer"
        assert reply.json()["code"] == "unauthorized"
        assert service.store.opened == []
        assert service.docker.calls == []

    @pytest.mark.parametrize(
        "header",
        [
            "Bearer wrong-token",
            "Bearer ",
            "Bearer",
            f"Basic {TOKEN}",
            TOKEN,
            f"Bearer {TOKEN}x",
            f"Bearer {TOKEN[:-1]}",
            f"Bearer {TOKEN} {TOKEN}",
        ],
    )
    def test_a_wrong_token_is_401(self, service, header):
        reply = service.post(service.store.add(BUNDLE), headers={"Authorization": header})
        assert reply.status_code == 401
        assert service.store.opened == []

    def test_the_bearer_scheme_is_case_insensitive(self, service):
        reply = service.post(
            service.store.add(BUNDLE), headers={"Authorization": f"bearer {TOKEN}"}
        )
        assert reply.status_code == 202

    def test_get_needs_the_token_too_even_for_a_real_run(self, service):
        run_id = service.run()["run_id"]
        assert service.client.get(f"/runs/{run_id}").status_code == 401
        assert (
            service.client.get(
                f"/runs/{run_id}", headers={"Authorization": "Bearer nope"}
            ).status_code
            == 401
        )
        assert service.client.get("/runs/not-a-run").status_code == 401

    def test_the_token_is_checked_before_the_body(self, service):
        garbage = {"Content-Type": "application/json"}
        reply = service.client.post("/runs", content=b"{not json", headers=garbage)
        assert reply.status_code == 401
        reply = service.client.post("/runs", content=b"{not json", headers={**garbage, **AUTH})
        assert reply.status_code == 422

    def test_the_token_comparison_is_constant_time(self, service, monkeypatch):
        calls: list[tuple[bytes, bytes, bool]] = []
        real = hmac.compare_digest

        def spy(a, b):
            result = real(a, b)
            calls.append((a, b, result))
            return result

        monkeypatch.setattr(hmac, "compare_digest", spy)
        service.post(service.store.add(BUNDLE), headers={"Authorization": "Bearer wrong"})
        assert len(calls) == 1
        given, expected, matched = calls[0]
        # Both sides are fixed-length digests, whatever the caller sent.
        assert len(given) == len(expected) == hashlib.sha256().digest_size
        assert expected == hashlib.sha256(TOKEN.encode()).digest()
        assert matched is False

        calls.clear()
        service.client.get("/runs/missing", headers=AUTH)
        assert [matched for *_, matched in calls] == [True]

    def test_the_service_will_not_start_without_a_strong_token(self, monkeypatch):
        with pytest.raises(ServiceConfigError, match="SANDBOX_TOKEN"):
            create_app(store=MemoryStore())
        with pytest.raises(ServiceConfigError, match="SANDBOX_TOKEN"):
            create_app(token="x" * (service_app.MIN_TOKEN_LENGTH - 1), store=MemoryStore())
        with pytest.raises(ServiceConfigError, match="SANDBOX_TOKEN"):
            create_app(token=" " * 40, store=MemoryStore())

    def test_the_token_comes_from_the_environment(self, monkeypatch, scratch):
        monkeypatch.setenv("SANDBOX_TOKEN", TOKEN)
        with TestClient(create_app(store=MemoryStore(), runner=FakeDocker())) as client:
            assert client.get("/runs/x").status_code == 401
            assert client.get("/runs/x", headers=AUTH).status_code == 404

    def test_healthz_is_open_and_says_nothing_else(self, service):
        reply = service.client.get("/healthz")
        assert reply.status_code == 200
        assert reply.json() == {"status": "ok"}

    def test_there_are_no_interactive_docs(self, service):
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert service.client.get(path, headers=AUTH).status_code == 404


# --------------------------------------------------------------------------- #
# POST /runs: refusing                                                         #
# --------------------------------------------------------------------------- #


class TestRefusals:
    @pytest.mark.parametrize(
        "cid",
        [
            "../../etc/passwd",
            "nope",
            "",
            # A fixed input, not ``BUNDLE``: a zip embeds the current time in
            # its header, and pytest builds this test id from the value, so
            # ``cid_of(BUNDLE)`` differs between xdist workers and collection
            # fails with "different tests were collected".
            cid_of(b"a bundle that is not a file id").upper(),
            "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        ],
    )
    def test_a_cid_that_is_not_a_file_id_is_422(self, service, cid):
        reply = service.post(cid)
        assert reply.status_code == 422
        assert reply.json()["code"] == "invalid_bundle_cid"
        assert service.store.opened == []

    def test_a_bundle_the_store_does_not_have_is_422(self, service):
        reply = service.post(cid_of(b"never stored"))
        assert reply.status_code == 422
        assert reply.json()["code"] == "bundle_not_found"
        assert service.docker.calls == []

    def test_bytes_that_do_not_hash_to_the_cid_are_422_and_never_run(self, service, scratch):
        cid = cid_of(BUNDLE)
        service.store.objects[cid] = zip_bytes({"reproduce.sh": "echo tampered\n"})
        reply = service.post(cid)
        assert reply.status_code == 422
        assert reply.json()["code"] == "bundle_hash_mismatch"
        assert service.store.opened == [cid]
        assert service.docker.calls == []
        assert list(scratch.iterdir()) == []

    def test_a_single_flipped_bit_is_caught(self, service):
        cid = service.store.add(BUNDLE)
        flipped = bytearray(BUNDLE)
        flipped[len(flipped) // 2] ^= 1
        service.store.objects[cid] = bytes(flipped)
        assert service.post(cid).json()["code"] == "bundle_hash_mismatch"

    def test_a_bundle_larger_than_the_limits_allow_is_422(self, service, scratch):
        # The size check runs while streaming, before the hash is compared.
        cid = cid_of(BUNDLE)
        service.store.objects[cid] = b"\0" * (8 * 1024 * 1024 + 1)
        reply = service.post(cid, limits={"work_mb": 16})
        assert reply.status_code == 422
        assert reply.json()["code"] == "bundle_too_large"
        assert list(scratch.iterdir()) == []

    @pytest.mark.parametrize(
        "limits",
        [
            {"time_limit": sandbox.MAX_TIME_LIMIT_SECONDS + 1},
            {"time_limit": 0},
            {"cpus": 0},
            {"pids": 1},
            {"memory_mb": 100},
            {"cpus": "many"},
        ],
    )
    def test_invalid_limits_are_422_before_anything_is_fetched(self, service, limits):
        reply = service.post(service.store.add(BUNDLE), limits=limits)
        assert reply.status_code == 422
        assert service.store.opened == []

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"bundle_cid": 5},
            {"bundle_cid": cid_of(BUNDLE), "image": "evil:latest"},
            {"bundle_cid": cid_of(BUNDLE), "command": ["sh"]},
            {"bundle_cid": cid_of(BUNDLE), "limits": {"network": True}},
            {"bundle_cid": cid_of(BUNDLE), "limits": [1]},
            [cid_of(BUNDLE)],
        ],
    )
    def test_a_request_with_anything_unexpected_is_422(self, service, body):
        service.store.add(BUNDLE)
        reply = service.client.post("/runs", json=body, headers=AUTH)
        assert reply.status_code == 422
        assert service.docker.calls == []

    def test_a_body_that_is_not_json_is_422(self, service):
        reply = service.client.post("/runs", content=b"bundle_cid=abc", headers=AUTH)
        assert reply.status_code == 422

    def test_an_oversized_body_is_413(self, service):
        reply = service.client.post("/runs", content=b"x" * (16 * 1024 + 1), headers=AUTH)
        assert reply.status_code == 413

    def test_the_limits_model_has_every_field_of_sandbox_limits_and_no_other(self):
        model = set(service_app._LimitsBody.model_fields)
        assert model == {field.name for field in dataclasses.fields(SandboxLimits)}

    def test_a_store_that_fails_is_503_and_its_error_stays_private(self, make_service):
        class Broken:
            def open(self, key):
                raise RuntimeError("s3://secret-bucket on host-17 exploded")

        service = make_service(store=Broken())
        reply = service.post(cid_of(BUNDLE))
        assert reply.status_code == 503
        assert reply.json()["code"] == "store_unavailable"
        assert "secret" not in reply.text and "host-17" not in reply.text

    def test_a_read_that_fails_midway_is_503_and_leaves_nothing_behind(
        self, make_service, scratch
    ):
        class Flaky:
            closed = False

            def read(self, size=-1):
                raise OSError("/mnt/secret/path went away")

            def close(self):
                Flaky.closed = True

        class Store:
            def open(self, key):
                return Flaky()

        service = make_service(store=Store())
        reply = service.post(cid_of(BUNDLE))
        assert reply.status_code == 503
        assert "secret" not in reply.text
        assert Flaky.closed
        assert list(scratch.iterdir()) == []

    def test_refusals_do_not_use_up_capacity(self, make_service):
        service = make_service(concurrency=1, queue_limit=0)
        bad = cid_of(BUNDLE)
        service.store.objects[bad] = b"not that"
        for _ in range(3):
            assert service.post(bad).status_code == 422
            assert service.post(cid_of(b"absent")).status_code == 422
        assert service.run()["status"] == "completed"


# --------------------------------------------------------------------------- #
# POST /runs and GET /runs/{id}: running                                       #
# --------------------------------------------------------------------------- #


class TestRuns:
    def test_a_good_bundle_is_202_with_a_run_id_and_runs_to_completion(self, service):
        cid = service.store.add(BUNDLE)
        reply = service.post(cid)
        assert reply.status_code == 202
        accepted = reply.json()
        assert accepted["status"] == "queued"
        run_id = accepted["run_id"]
        assert run_id and reply.headers["location"] == f"/runs/{run_id}"

        done = service.finish(run_id)
        assert done == {
            "run_id": run_id,
            "status": "completed",
            "reason": None,
            "exit_code": 0,
            "log_lines": ["hello", "[scholium-sandbox] exit status 0"],
            "oom_killed": False,
            "duration": done["duration"],
            "image": sandbox.DEFAULT_IMAGE,
            "image_id": "sha256:" + "ab" * 32,
        }
        assert done["duration"] >= 0

    def test_the_container_is_the_one_a_local_run_makes(self, service):
        service.run()
        assert service.docker.names == [
            "version", "image inspect", "create", "start", "wait", "logs", "rm",
        ]
        (create,) = service.docker.calls_to("create")
        assert create[0] == service.binary
        assert flag(create, "--network") == ["none"]
        assert flag(create, "--cpus") == ["1"]
        assert flag(create, "--memory") == ["2048m"]
        assert flag(create, "--pids-limit") == ["256"]
        assert flag(create, "--cap-drop") == ["ALL"]
        assert "--read-only" in create
        assert create[-2:] == ["sh", "./reproduce.sh"]
        (rm,) = service.docker.calls_to("rm")
        assert rm[-1] == service.docker.container_id

    def test_the_limits_in_the_request_are_the_limits_of_the_container(self, service):
        done = service.run(
            limits={"cpus": 0.5, "memory_mb": 1024, "pids": 64, "time_limit": 30}
        )
        assert done["status"] == "completed"
        (create,) = service.docker.calls_to("create")
        assert flag(create, "--cpus") == ["0.5"]
        assert flag(create, "--memory") == ["1024m"]
        assert flag(create, "--pids-limit") == ["64"]
        assert service.docker.timeout_of("wait") == 30

    def test_a_run_without_limits_gets_the_spec_limits(self, service):
        service.run()
        assert service.docker.timeout_of("wait") == sandbox.MAX_TIME_LIMIT_SECONDS

    def test_a_nonzero_exit_is_failed_with_the_output_and_the_status(self, make_service):
        service = make_service(docker=FakeDocker(exit_code=3, output=b"boom\nbad thing\n"))
        done = service.run()
        assert done["status"] == "failed"
        assert done["exit_code"] == 3
        assert done["log_lines"] == ["boom", "bad thing", "[scholium-sandbox] exit status 3"]

    def test_running_out_of_memory_is_failed_and_says_so(self, make_service):
        service = make_service(docker=FakeDocker(exit_code=137, oom=True))
        done = service.run()
        assert done["status"] == "failed"
        assert done["oom_killed"] is True
        assert "memory limit" in done["log_lines"][-1]

    def test_a_run_that_hits_the_time_limit_is_timeout(self, make_service):
        service = make_service(docker=FakeDocker(hang=True, output=b"still going\n"))
        done = service.run(limits={"time_limit": 5})
        assert done["status"] == "timeout"
        assert done["exit_code"] is None
        assert done["log_lines"][-1] == (
            "[scholium-sandbox] stopped: the time limit of 5 seconds was reached"
        )
        assert "kill" in service.docker.names and service.docker.names[-1] == "rm"

    @pytest.mark.parametrize(
        ("docker", "reason"),
        [
            (FakeDocker(server=False), "docker_unavailable"),
            (FakeDocker(image=False), "docker_unavailable"),
            (FakeDocker(create=False), "sandbox_error"),
            (FakeDocker(start=False), "sandbox_error"),
        ],
    )
    def test_what_stops_the_container_is_not_run_with_its_reason(
        self, make_service, docker, reason
    ):
        done = make_service(docker=docker).run()
        assert done["status"] == "not_run"
        assert done["reason"] == reason
        assert done["exit_code"] is None
        assert done["log_lines"][-1].startswith(f"[scholium-sandbox] not run ({reason}): ")

    def test_a_missing_cli_is_not_run_and_unpacks_nothing(self, make_service, tmp_path):
        service = make_service(docker_bin=str(tmp_path / "no-such-docker"))
        done = service.run()
        assert done["status"] == "not_run"
        assert done["reason"] == "docker_unavailable"
        assert service.docker.calls == []

    def test_podman_uses_the_podman_executable_and_its_own_reason(self, make_service, tmp_path):
        podman = make_service(backend="podman")
        podman.run()
        assert {argv[0] for argv in podman.docker.calls} == {podman.binary}
        assert Path(podman.binary).name == "podman"

        missing = make_service(backend="podman", podman_bin=str(tmp_path / "no-podman"))
        done = missing.run()
        assert (done["status"], done["reason"]) == ("not_run", "container_unavailable")

    @pytest.mark.parametrize(
        ("data", "reason"),
        [
            (zip_bytes({"README": "no entry point"}), "no_entrypoint"),
            (b"this is not an archive", "bundle_unavailable"),
            (
                tar_bytes(members=[(tar_member("reproduce.sh", b"2", link="/etc/passwd"), b"")]),
                "bundle_rejected",
            ),
            (zip_bytes({"../escape.sh": "x"}), "bundle_rejected"),
        ],
    )
    def test_a_bundle_the_sandbox_cannot_run_is_not_run_with_the_local_reason(
        self, service, data, reason
    ):
        done = service.run(data)
        assert (done["status"], done["reason"]) == ("not_run", reason)
        assert "create" not in service.docker.names

    def test_a_tar_bundle_runs_too(self, service):
        done = service.run(tar_bytes({"run.sh": "echo hi\n"}))
        assert done["status"] == "completed"
        (create,) = service.docker.calls_to("create")
        assert create[-2:] == ["sh", "./run.sh"]

    def test_a_crash_in_the_runner_is_not_run_and_its_text_stays_private(self, make_service):
        class Crashing(FakeDocker):
            def __call__(self, argv, timeout, merge_stderr=False):
                if self.name(argv) == "start":
                    raise RuntimeError("/var/run/secret-socket exploded")
                return super().__call__(argv, timeout, merge_stderr)

        service = make_service(docker=Crashing())
        done = service.run()
        assert (done["status"], done["reason"]) == ("not_run", "sandbox_error")
        assert "secret" not in "".join(done["log_lines"])
        # The container that was created is still removed.
        assert service.docker.names[-1] == "rm"

    def test_an_unknown_run_is_404(self, service):
        reply = service.client.get("/runs/no-such-run", headers=AUTH)
        assert reply.status_code == 404
        assert reply.json()["code"] == "run_not_found"

    def test_run_ids_are_distinct(self, service):
        ids = {service.run()["run_id"] for _ in range(5)}
        assert len(ids) == 5

    def test_nothing_is_left_in_the_temporary_directory(self, service, scratch):
        service.run()
        service.run(b"not an archive")
        service.run(zip_bytes({"README": "x"}))
        assert list(scratch.iterdir()) == []

    def test_finished_runs_are_forgotten_beyond_the_retention_cap(self, make_service):
        service = make_service(retain_max=2)
        ids = [service.run()["run_id"] for _ in range(4)]
        statuses = [service.client.get(f"/runs/{i}", headers=AUTH).status_code for i in ids]
        assert statuses == [404, 404, 200, 200]

    def test_finished_runs_expire(self, make_service, monkeypatch):
        class Clock:
            now = 1000.0

            def monotonic(self) -> float:
                return self.now

        clock = Clock()
        monkeypatch.setattr(service_app, "time", clock)
        service = make_service(retain_seconds=60)
        run_id = service.run()["run_id"]
        clock.now += 59
        assert service.client.get(f"/runs/{run_id}", headers=AUTH).status_code == 200
        clock.now += 2
        assert service.client.get(f"/runs/{run_id}", headers=AUTH).status_code == 404


class TestPendingRuns:
    def test_pending_runs_report_queued_then_running_and_finish(self, make_service, scratch):
        docker = GatedDocker(output=b"done\n")
        service = make_service(docker=docker, concurrency=1, queue_limit=2)
        try:
            first = service.post(service.store.add(BUNDLE)).json()["run_id"]
            assert docker.waiting.acquire(timeout=10), "the first run never started"
            second = service.post(service.store.add(BUNDLE + b"\n")).json()["run_id"]

            running = service.client.get(f"/runs/{first}", headers=AUTH).json()
            queued = service.client.get(f"/runs/{second}", headers=AUTH).json()
            assert running == {"run_id": first, "status": "running", "log_lines": []}
            assert queued == {"run_id": second, "status": "queued", "log_lines": []}
            # The archive of a waiting run is kept until it has run.
            assert len(sandbox_dirs(scratch)) == 2
        finally:
            docker.gate.set()
        assert service.finish(first)["status"] == "completed"
        assert service.finish(second)["status"] == "completed"
        assert list(scratch.iterdir()) == []

    def test_a_full_service_is_503_until_a_run_finishes(self, make_service):
        docker = GatedDocker()
        service = make_service(docker=docker, concurrency=1, queue_limit=1)
        try:
            ids = [service.post(service.store.add(BUNDLE + b"a")).json()["run_id"]]
            assert docker.waiting.acquire(timeout=10)
            ids.append(service.post(service.store.add(BUNDLE + b"b")).json()["run_id"])

            full = service.post(service.store.add(BUNDLE + b"c"))
            assert full.status_code == 503
            assert full.json()["code"] == "service_busy"
            assert full.headers["retry-after"] == "30"
            assert service.store.opened.count(cid_of(BUNDLE + b"c")) == 0
        finally:
            docker.gate.set()
        for run_id in ids:
            service.finish(run_id)
        assert service.post(service.store.add(BUNDLE + b"d")).status_code == 202

    def test_shutting_down_removes_the_archives_of_runs_that_never_started(
        self, make_service, scratch
    ):
        docker = GatedDocker()
        service = make_service(docker=docker, concurrency=1, queue_limit=2)
        try:
            service.post(service.store.add(BUNDLE + b"a"))
            assert docker.waiting.acquire(timeout=10)
            service.post(service.store.add(BUNDLE + b"b"))
            assert len(sandbox_dirs(scratch)) == 2
            service.client.app.state.service.close()
            assert len(sandbox_dirs(scratch)) == 1  # only the one that is running
        finally:
            docker.gate.set()
        deadline = time.monotonic() + 10
        while list(scratch.iterdir()) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert list(scratch.iterdir()) == []


# --------------------------------------------------------------------------- #
# The remote runner against the service                                        #
# --------------------------------------------------------------------------- #


class TestRemoteRunnerContract:
    """``run_remote_bundle`` (the API's half) talking to the service for real."""

    def remote(self, service: Harness, cid: str, *, token: str = TOKEN, **kwargs):
        return run_remote_bundle(
            cid,
            sandbox_url="http://testserver",
            sandbox_token=token,
            http_client=service.client,
            poll_interval=0.01,
            **kwargs,
        )

    def test_a_completed_run_comes_back_as_a_sandbox_run(self, service):
        run = self.remote(service, service.store.add(BUNDLE))
        assert run.status == "completed"
        assert run.exit_code == 0
        assert run.log_lines == ("hello", "[scholium-sandbox] exit status 0")
        assert run.image == sandbox.DEFAULT_IMAGE
        assert run.image_id == "sha256:" + "ab" * 32
        assert run.findings() == ()

    def test_run_bundle_with_the_remote_backend_reaches_the_service(self, service):
        run = run_bundle(
            service.store.add(BUNDLE),
            backend="remote",
            sandbox_url="http://testserver/runs",
            sandbox_token=TOKEN,
            http_client=service.client,
            poll_interval=0.01,
        )
        assert run.status == "completed"

    def test_the_limits_the_client_sends_are_enforced(self, service):
        limits = SandboxLimits(cpus=0.5, memory_mb=1024, pids=64, time_limit=45.0)
        run = self.remote(service, service.store.add(BUNDLE), limits=limits)
        assert run.status == "completed"
        (create,) = service.docker.calls_to("create")
        assert flag(create, "--cpus") == ["0.5"]
        assert flag(create, "--memory") == ["1024m"]
        assert flag(create, "--pids-limit") == ["64"]
        assert service.docker.timeout_of("wait") == 45.0

    def test_a_failed_run_keeps_its_exit_status_and_output(self, make_service):
        service = make_service(docker=FakeDocker(exit_code=2, output=b"Traceback\nboom\n"))
        run = self.remote(service, service.store.add(BUNDLE))
        assert (run.status, run.exit_code) == ("failed", 2)
        assert run.log_lines == ("Traceback", "boom", "[scholium-sandbox] exit status 2")
        (finding,) = run.findings()
        assert finding.evidence.log_line == "[scholium-sandbox] exit status 2"
        assert finding.evidence.log_line in run.log_lines

    def test_oom_and_timeout_survive_the_trip(self, make_service):
        service = make_service(docker=FakeDocker(exit_code=137, oom=True))
        run = self.remote(service, service.store.add(BUNDLE))
        assert (run.status, run.oom_killed) == ("failed", True)

        service = make_service(docker=FakeDocker(hang=True))
        run = self.remote(service, service.store.add(BUNDLE), limits=SandboxLimits(time_limit=7))
        assert run.status == "timeout"
        assert run.exit_code is None
        assert "7 seconds" in run.status_line

    def test_not_run_keeps_its_reason(self, make_service):
        service = make_service(docker=FakeDocker(server=False))
        run = self.remote(service, service.store.add(BUNDLE))
        assert (run.status, run.reason) == ("not_run", "docker_unavailable")
        assert run.status_line.startswith("[scholium-sandbox] not run (docker_unavailable)")

        service = make_service()
        run = self.remote(service, service.store.add(zip_bytes({"README": "x"})))
        assert (run.status, run.reason) == ("not_run", "no_entrypoint")

    def test_a_wrong_token_is_a_sandbox_error_not_a_run(self, service):
        run = self.remote(service, service.store.add(BUNDLE), token="the-wrong-token-" + "y" * 20)
        assert (run.status, run.reason) == ("not_run", "sandbox_error")
        assert service.docker.calls == []

    def test_bytes_that_do_not_hash_to_the_cid_are_bundle_unavailable(self, service):
        cid = service.store.add(BUNDLE)
        service.store.objects[cid] = b"something else entirely"
        run = self.remote(service, cid)
        assert (run.status, run.reason) == ("not_run", "bundle_unavailable")
        assert service.docker.calls == []

    def test_a_full_service_reads_as_unreachable(self, make_service):
        docker = GatedDocker()
        service = make_service(docker=docker, concurrency=1, queue_limit=0)
        try:
            service.post(service.store.add(BUNDLE + b"a"))
            assert docker.waiting.acquire(timeout=10)
            run = self.remote(service, service.store.add(BUNDLE + b"b"))
            assert (run.status, run.reason) == ("not_run", "sandbox_unreachable")
        finally:
            docker.gate.set()


# --------------------------------------------------------------------------- #
# Configuration and the bundle store                                           #
# --------------------------------------------------------------------------- #


class TestConfiguration:
    @pytest.mark.parametrize("backend", ["remote", "none"])
    def test_the_service_never_runs_as_a_remote_or_disabled_backend(self, backend):
        with pytest.raises(ServiceConfigError, match="docker or podman"):
            create_app(token=TOKEN, store=MemoryStore(), backend=backend)

    def test_an_unknown_backend_is_refused(self):
        with pytest.raises(ServiceConfigError, match="not a sandbox backend"):
            create_app(token=TOKEN, store=MemoryStore(), backend="lxc")

    def test_the_backend_comes_from_sandbox_backend(self, monkeypatch, scratch, tmp_path):
        monkeypatch.setenv("SANDBOX_BACKEND", "podman")
        docker = FakeDocker()
        store = MemoryStore()
        podman = str(make_executable(tmp_path / "podman"))
        application = create_app(token=TOKEN, store=store, runner=docker, podman_bin=podman)
        with TestClient(application) as client:
            cid = store.add(BUNDLE)
            run_id = client.post("/runs", json={"bundle_cid": cid}, headers=AUTH).json()["run_id"]
            assert await_run(client, run_id)["status"] == "completed"
        assert {argv[0] for argv in docker.calls} == {podman}

    def test_the_image_comes_from_the_environment(self, monkeypatch, make_service):
        monkeypatch.setenv("REPRO_DOCKER_IMAGE", "registry.example/repro:1")
        service = make_service()
        service.run()
        (create,) = service.docker.calls_to("create")
        assert "registry.example/repro:1" in create

    def test_a_bad_image_reference_is_refused_at_startup(self):
        with pytest.raises(ServiceConfigError, match="not a docker image"):
            create_app(token=TOKEN, store=MemoryStore(), image="not an image; rm -rf /")

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("SANDBOX_CONCURRENCY", "many"),
            ("SANDBOX_CONCURRENCY", "0"),
            ("SANDBOX_QUEUE_LIMIT", "-1"),
        ],
    )
    def test_bad_numbers_are_refused_at_startup(self, monkeypatch, name, value):
        monkeypatch.setenv(name, value)
        with pytest.raises(ServiceConfigError, match=name):
            create_app(token=TOKEN, store=MemoryStore())

    def test_concurrency_and_queue_limit_come_from_the_environment(
        self, monkeypatch, make_service
    ):
        monkeypatch.setenv("SANDBOX_CONCURRENCY", "1")
        monkeypatch.setenv("SANDBOX_QUEUE_LIMIT", "0")
        docker = GatedDocker()
        service = make_service(docker=docker)
        try:
            assert service.post(service.store.add(BUNDLE + b"a")).status_code == 202
            assert docker.waiting.acquire(timeout=10)
            assert service.post(service.store.add(BUNDLE + b"b")).status_code == 503
        finally:
            docker.gate.set()


class TestBundleStore:
    def test_the_default_store_reads_content_dir(self, monkeypatch, tmp_path):
        monkeypatch.setenv("CONTENT_DIR", str(tmp_path / "content"))
        store = default_store()
        assert isinstance(store, FilesystemStore)
        assert store.root == tmp_path / "content"

    def test_content_dir_defaults_to_the_apps_setting(self, monkeypatch):
        monkeypatch.delenv("CONTENT_DIR", raising=False)
        assert default_store().root == Path(settings.CONTENT_DIR)

    def test_a_backend_the_service_cannot_read_stops_it_starting(self, monkeypatch):
        monkeypatch.setenv("STORAGE_BACKEND", "gcs")
        with pytest.raises(ServiceConfigError, match="STORAGE_BACKEND"):
            default_store()
        with pytest.raises(ServiceConfigError, match="STORAGE_BACKEND"):
            create_app(token=TOKEN)

    def test_s3_without_a_bucket_stops_it_starting(self, monkeypatch):
        monkeypatch.setenv("STORAGE_BACKEND", "s3")
        monkeypatch.setattr(settings, "STORAGE_BACKEND", "s3")
        monkeypatch.setattr(settings, "S3_BUCKET", "")
        with pytest.raises(ServiceConfigError, match="S3_BUCKET"):
            default_store()
        with pytest.raises(ServiceConfigError, match="S3_BUCKET"):
            create_app(token=TOKEN)

    def test_s3_is_read_through_the_applications_object_store(self, request, monkeypatch, tmp_path):
        """The service meets the API in the bucket the API writes to (``STORAGE_BACKEND=s3``)."""
        import boto3
        from moto import mock_aws

        from app.storage import _s3_store

        # The S3 client is cached per configuration; one built under moto must not
        # outlive it.
        _s3_store.cache_clear()
        request.addfinalizer(_s3_store.cache_clear)
        bucket = "scholium-sandbox-test"
        credentials = dict(access_key_id="test-access-key-id", secret_access_key="test-SECRET-access-key")
        monkeypatch.setenv("STORAGE_BACKEND", "s3")
        for name, value in dict(
            STORAGE_BACKEND="s3", S3_BUCKET=bucket, S3_REGION="us-east-1", S3_ENDPOINT_URL="",
            S3_ACCESS_KEY_ID=credentials["access_key_id"], S3_SECRET_ACCESS_KEY=credentials["secret_access_key"],
        ).items():
            monkeypatch.setattr(settings, name, value)
        archive = zip_bytes({"reproduce.sh": "echo hi\n", ".nonce": os.urandom(8).hex()})
        cid = cid_of(archive)
        with mock_aws():
            boto3.client(
                "s3", region_name="us-east-1", aws_access_key_id=credentials["access_key_id"],
                aws_secret_access_key=credentials["secret_access_key"],
            ).create_bucket(Bucket=bucket)
            from app.storage import get_object_store

            get_object_store().put_stream(cid, io.BytesIO(archive))

            docker = FakeDocker(output=b"from the bucket\n")
            binary = str(make_executable(tmp_path / "docker"))
            application = create_app(token=TOKEN, runner=docker, docker_bin=binary)
            with TestClient(application) as client:
                reply = client.post("/runs", json={"bundle_cid": cid}, headers=AUTH)
                assert reply.status_code == 202, reply.text
                done = await_run(client, reply.json()["run_id"])
                assert done["status"] == "completed"
                assert done["log_lines"] == ["from the bucket", "[scholium-sandbox] exit status 0"]
                # A bundle that is not in the bucket is the same 422 as on disk.
                missing = client.post("/runs", json={"bundle_cid": cid_of(b"never stored")}, headers=AUTH)
                assert missing.status_code == 422, missing.text
                # Bytes in the bucket that do not hash to their key are refused.
                get_object_store().put_stream(cid_of(b"wanted"), io.BytesIO(b"swapped"))
                swapped = client.post("/runs", json={"bundle_cid": cid_of(b"wanted")}, headers=AUTH)
                assert swapped.status_code == 422, swapped.text

    def test_it_reads_what_the_content_store_wrote(self, monkeypatch, scratch, tmp_path):
        """Existing ``CONTENT_DIR`` data is read as it is: no migration."""
        archive = zip_bytes({"reproduce.sh": "echo hi\n", ".nonce": os.urandom(8).hex()})
        written = content_store.write_bytes(archive)
        monkeypatch.setenv("CONTENT_DIR", str(content_store.content_dir()))
        docker = FakeDocker(output=b"from disk\n")
        binary = str(make_executable(tmp_path / "docker"))
        application = create_app(token=TOKEN, runner=docker, docker_bin=binary)
        with TestClient(application) as client:
            reply = client.post("/runs", json={"bundle_cid": written.cid}, headers=AUTH)
            assert reply.status_code == 202, reply.text
            done = await_run(client, reply.json()["run_id"])
        assert done["status"] == "completed"
        assert done["log_lines"] == ["from disk", "[scholium-sandbox] exit status 0"]

    def test_a_filesystem_store_never_leaves_its_directory(self, tmp_path):
        (tmp_path / "root").mkdir()
        (tmp_path / "secret").write_bytes(b"s")
        store = FilesystemStore(tmp_path / "root")
        for key in ("../secret", "/etc/passwd", "a/b", ".tmp", "", "x\0y"):
            with pytest.raises(ValueError):
                store.open(key)

    def test_a_filesystem_store_reports_a_missing_object(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            FilesystemStore(tmp_path).open(cid_of(b"absent"))

    def test_the_filesystem_store_serves_the_service(self, tmp_path, make_service):
        (tmp_path / "content").mkdir()
        (tmp_path / "content" / cid_of(BUNDLE)).write_bytes(BUNDLE)
        service = make_service(store=FilesystemStore(tmp_path / "content"))
        done = service.finish(service.post(cid_of(BUNDLE)).json()["run_id"])
        assert done["status"] == "completed"


# --------------------------------------------------------------------------- #
# python -m app.sandbox_service                                                #
# --------------------------------------------------------------------------- #


class TestEntryPoint:
    @pytest.fixture
    def served(self, monkeypatch):
        calls: list[dict] = []

        def fake_run(application, **kwargs):
            calls.append({"app": application, **kwargs})

        monkeypatch.setattr(entry.uvicorn, "run", fake_run)
        monkeypatch.setenv("SANDBOX_TOKEN", TOKEN)
        monkeypatch.setenv("CONTENT_DIR", str(Path(tempfile.gettempdir()) / "unused-content"))
        return calls

    def test_it_serves_on_loopback_port_8001_by_default(self, served):
        assert entry.main([]) == 0
        (call,) = served
        assert (call["host"], call["port"]) == ("127.0.0.1", 8001)
        assert call["app"].state.service is not None

    def test_host_and_port_come_from_the_environment(self, served, monkeypatch):
        monkeypatch.setenv("HOST", "0.0.0.0")
        monkeypatch.setenv("PORT", "9100")
        assert entry.main([]) == 0
        assert (served[0]["host"], served[0]["port"]) == ("0.0.0.0", 9100)

    def test_flags_beat_the_environment(self, served, monkeypatch):
        monkeypatch.setenv("HOST", "0.0.0.0")
        monkeypatch.setenv("PORT", "9100")
        assert entry.main(["--host", "10.0.0.5", "--port", "9200"]) == 0
        assert (served[0]["host"], served[0]["port"]) == ("10.0.0.5", 9200)

    def test_a_missing_token_exits_2_and_starts_nothing(self, served, monkeypatch, capsys):
        monkeypatch.delenv("SANDBOX_TOKEN")
        assert entry.main([]) == 2
        assert served == []
        err = capsys.readouterr().err
        assert "SANDBOX_TOKEN" in err and TOKEN not in err

    def test_a_bad_port_exits_2(self, served, monkeypatch, capsys):
        monkeypatch.setenv("PORT", "eight")
        assert entry.main([]) == 2
        assert served == []
        assert "PORT" in capsys.readouterr().err

    def test_python_dash_m_runs_the_package(self, tmp_path):
        env = {
            key: value for key, value in os.environ.items() if not key.startswith("SANDBOX_")
        }
        env["PYTHONPATH"] = os.pathsep.join(
            [str(Path(app_package.__file__).parents[1]), env.get("PYTHONPATH", "")]
        )
        base = [sys.executable, "-m", "app.sandbox_service"]

        helped = subprocess.run(
            [*base, "--help"], env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120
        )
        assert helped.returncode == 0, helped.stderr
        assert "python -m app.sandbox_service" in helped.stdout

        refused = subprocess.run(
            base, env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120
        )
        assert refused.returncode == 2
        assert "SANDBOX_TOKEN" in refused.stderr
        assert "RuntimeWarning" not in refused.stderr
