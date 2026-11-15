"""Tests for running a code bundle in the docker sandbox (feature 119).

No container is started: :class:`~.sandbox_support.FakeDocker` plays the
daemon and records what it was asked.  What these pin:

* the container is created with ``--network none``, a read-only root, CPU,
  memory and process limits, no capabilities and the bundle mounted read-only,
  and the run is limited to 10 minutes (and cannot be configured to more);
* when docker is missing, its daemon is down or its image is absent -- and for
  a missing, unsafe or entry-point-less bundle -- the result is ``not_run`` and
  nothing is started, never an exception;
* a timeout kills the container, and the container is removed on every path;
* every finding the run makes cites a line of the run log, and the log holds
  none of docker's own error text (which names host paths).
"""

from __future__ import annotations

import re
import stat
import sys
import uuid
from pathlib import Path

import pytest

from app.modules import content
from app.modules.ai_review import sandbox
from app.modules.ai_review.sandbox import (
    MAX_LOG_CHARS,
    MAX_LOG_LINES,
    MAX_TIME_LIMIT_SECONDS,
    NOT_RUN_REASONS,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_NOT_RUN,
    STATUS_PREFIX,
    STATUS_TIMEOUT,
    CommandResult,
    SandboxLimits,
    SandboxRun,
    build_create_args,
    clean_log,
    run_bundle,
    run_command,
)

from .sandbox_support import (
    CONTAINER_ID,
    HOST_SECRET,
    IMAGE_ID,
    FakeDocker,
    flag,
    make_executable,
    runnable_bundle,
    store_bundle,
    tar_bytes,
    tar_member,
    with_nonce,
    zip_bytes,
)


@pytest.fixture(autouse=True)
def default_image(monkeypatch):
    """Tests that do not name an image get the default, whatever the environment says."""
    monkeypatch.delenv(sandbox.IMAGE_ENV, raising=False)


@pytest.fixture
def docker_bin(tmp_path) -> str:
    """An executable that ``shutil.which`` finds; the runner never really runs it."""
    return str(make_executable(tmp_path / "docker"))


def run(bundle_cid, docker, docker_bin, **kwargs) -> SandboxRun:
    return run_bundle(bundle_cid, docker_bin=docker_bin, runner=docker, **kwargs)


def assert_findings_cite_the_log(result: SandboxRun) -> None:
    """Every finding of a run is evidence the verifier can find in the run log."""
    for finding in result.findings():
        assert finding.evidence.kind == "log_line"
        assert finding.evidence.log_line in result.log.split("\n")
        assert finding.evidence.log_line in result.log_lines


# --------------------------------------------------------------------------- #
# The container's isolation                                                   #
# --------------------------------------------------------------------------- #


class TestContainerIsolation:
    @pytest.fixture
    def create(self, docker_bin):
        docker = FakeDocker()
        run(runnable_bundle(), docker, docker_bin)
        (argv,) = docker.calls_to("create")
        return argv

    def test_no_network(self, create):
        assert flag(create, "--network") == ["none"]

    def test_read_only_root_filesystem(self, create):
        assert "--read-only" in create

    def test_cpu_memory_and_process_limits(self, create):
        assert flag(create, "--cpus") == ["1"]
        assert flag(create, "--memory") == ["2048m"]
        # Swap equal to memory means no swap, so the memory limit is the limit.
        assert flag(create, "--memory-swap") == ["2048m"]
        assert flag(create, "--pids-limit") == ["256"]

    def test_no_capabilities_no_escalation_unprivileged_user(self, create):
        assert flag(create, "--cap-drop") == ["ALL"]
        assert flag(create, "--security-opt") == ["no-new-privileges"]
        assert flag(create, "--user") == ["65534:65534"]
        assert "--privileged" not in create
        assert "--cap-add" not in create

    def test_the_image_is_never_pulled_during_a_run(self, create):
        assert flag(create, "--pull") == ["never"]

    def test_the_bundle_is_mounted_read_only(self, create):
        (mount,) = flag(create, "--mount")
        options = mount.split(",")
        assert "type=bind" in options
        assert "readonly" in options
        assert "target=/bundle" in options
        # Nothing else of the host is shared.
        assert flag(create, "-v") == [] and flag(create, "--volume") == []
        assert "--volumes-from" not in create

    def test_writable_space_is_size_limited_tmpfs_only(self, create):
        by_path = {spec.split(":")[0]: spec.split(":")[1] for spec in flag(create, "--tmpfs")}
        assert set(by_path) == {"/tmp", "/work"}
        assert "size=128m" in by_path["/tmp"]
        assert "size=512m" in by_path["/work"]
        for options in by_path.values():
            assert "nosuid" in options and "nodev" in options

    def test_docker_log_is_capped_so_a_noisy_bundle_cannot_fill_the_disk(self, create):
        assert flag(create, "--log-opt") == ["max-size=1m", "max-file=1"]

    def test_the_container_is_labelled_for_sweeping(self, create):
        assert flag(create, "--label") == [sandbox.CONTAINER_LABEL]

    def test_image_and_command_come_last_and_the_command_is_not_a_shell_string(self, create):
        index = create.index(sandbox.DEFAULT_IMAGE)
        assert create[index + 1 : index + 3] == ["sh", "-c"]
        # ``sh -c SCRIPT sh COMMAND...``: the command is argv, not spliced into the script.
        assert create[index + 4 :] == ["sh", "sh", "./reproduce.sh"]

    def test_limits_follow_the_limits_given(self, docker_bin):
        docker = FakeDocker()
        limits = SandboxLimits(cpus=0.5, memory_mb=1024, pids=64, work_mb=256, tmp_mb=64)

        run(runnable_bundle(), docker, docker_bin, limits=limits)

        (argv,) = docker.calls_to("create")
        assert flag(argv, "--cpus") == ["0.5"]
        assert flag(argv, "--memory") == flag(argv, "--memory-swap") == ["1024m"]
        assert flag(argv, "--pids-limit") == ["64"]

    def test_build_create_args_is_pure(self):
        limits = SandboxLimits()
        args = build_create_args("docker", "img:1", "/src", ("python", "m.py"), limits)

        assert args[:2] == ["docker", "create"]
        assert args == build_create_args("docker", "img:1", "/src", ("python", "m.py"), limits)
        assert args[-2:] == ["python", "m.py"]


class TestTimeLimit:
    def test_the_default_is_ten_minutes(self, docker_bin):
        docker = FakeDocker()

        run(runnable_bundle(), docker, docker_bin)

        assert SandboxLimits().time_limit == MAX_TIME_LIMIT_SECONDS == 600
        assert docker.timeout_of("wait") == 600

    def test_a_shorter_limit_is_the_limit_waited_for(self, docker_bin):
        docker = FakeDocker()

        run(runnable_bundle(), docker, docker_bin, limits=SandboxLimits(time_limit=90))

        assert docker.timeout_of("wait") == 90

    @pytest.mark.parametrize("seconds", [601, 3600, 0, -1])
    def test_the_limit_cannot_exceed_ten_minutes_or_be_empty(self, seconds):
        with pytest.raises(ValueError, match="time_limit"):
            SandboxLimits(time_limit=seconds)

    def test_a_run_that_hits_the_limit_is_killed_and_reported(self, docker_bin):
        docker = FakeDocker(hang=True, output=b"epoch 1\nepoch 2\n")

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.status == STATUS_TIMEOUT
        assert result.exit_code is None and result.ran
        assert len(docker.calls_to("kill")) == 1
        assert docker.calls_to("kill")[0][-1] == CONTAINER_ID
        # What it printed before it was stopped is still evidence.
        assert result.log_lines[:2] == ("epoch 1", "epoch 2")
        assert result.status_line == (
            f"{STATUS_PREFIX}stopped: the time limit of 600 seconds was reached"
        )

    def test_the_timeout_finding_names_the_limit_and_is_low_confidence(self, docker_bin):
        result = run(runnable_bundle(), FakeDocker(hang=True), docker_bin)

        (finding,) = result.findings()

        assert "10-minute" in finding.claim
        assert (finding.severity, finding.confidence) == ("minor", "low")
        assert finding.agent == "reproducibility"
        assert_findings_cite_the_log(result)


# --------------------------------------------------------------------------- #
# What a run reports                                                          #
# --------------------------------------------------------------------------- #


class TestCompletedRun:
    def test_the_calls_happen_in_order_and_the_container_is_removed(self, docker_bin):
        docker = FakeDocker(output=b"hello\n")

        result = run(runnable_bundle(), docker, docker_bin)

        assert docker.names == ["version", "image inspect", "create", "start", "wait", "logs", "rm"]
        for name in ("start", "wait", "logs", "rm"):
            assert docker.calls_to(name)[0][-1] == CONTAINER_ID
        assert docker.calls_to("rm")[0][2:4] == ["-f", "-v"]
        assert result.status == STATUS_COMPLETED

    def test_log_is_the_output_then_the_sandbox_line(self, docker_bin):
        docker = FakeDocker(output=b"loading data\naccuracy: 0.91\n")

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.exit_code == 0
        assert result.log_lines == (
            "loading data",
            "accuracy: 0.91",
            f"{STATUS_PREFIX}exit status 0",
        )
        assert result.log == "loading data\naccuracy: 0.91\n" + f"{STATUS_PREFIX}exit status 0"
        assert result.reason is None
        assert result.ran

    def test_a_clean_run_has_no_finding_of_its_own(self, docker_bin):
        result = run(runnable_bundle(), FakeDocker(output=b"ok\n"), docker_bin)

        assert result.findings() == ()

    def test_the_image_and_limits_are_recorded_so_a_third_party_can_rerun(self, docker_bin):
        result = run(runnable_bundle(), FakeDocker(), docker_bin, image="registry.example/repro:3")

        assert result.image == "registry.example/repro:3"
        assert result.image_id == IMAGE_ID
        assert result.limits == SandboxLimits()

    def test_logs_are_read_with_both_streams_and_a_line_cap(self, docker_bin):
        docker = FakeDocker()

        run(runnable_bundle(), docker, docker_bin)

        (argv,) = docker.calls_to("logs")
        assert flag(argv, "--tail") == [str(MAX_LOG_LINES + 1)]
        assert docker.merged[docker.names.index("logs")] is True

    def test_the_bundle_is_unpacked_and_the_mount_source_is_the_bundle_root(self, docker_bin):
        seen = {}

        class Inspecting(FakeDocker):
            def __call__(self, argv, timeout, merge_stderr=False):
                if self.name(argv) == "create":
                    (mount,) = flag(argv, "--mount")
                    source = dict(kv.split("=", 1) for kv in mount.split(",") if "=" in kv)["source"]
                    seen["files"] = sorted(p.name for p in Path(source).iterdir())
                    seen["source"] = source
                return super().__call__(argv, timeout, merge_stderr)

        cid = runnable_bundle({"data/x.csv": "1,2\n"})

        run(cid, Inspecting(), docker_bin)

        assert "reproduce.sh" in seen["files"] and "data" in seen["files"]
        assert not Path(seen["source"]).exists(), "the unpacked bundle is removed after the run"


class TestFailedRun:
    def test_a_non_zero_exit_is_failed_with_a_low_confidence_finding(self, docker_bin):
        docker = FakeDocker(exit_code=3, output=b"Traceback (most recent call last):\nKeyError: 'x'\n")

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.status == STATUS_FAILED and result.exit_code == 3
        assert result.log_lines[-2:] == ("KeyError: 'x'", f"{STATUS_PREFIX}exit status 3")
        (finding,) = result.findings()
        assert "status 3" in finding.claim
        assert (finding.severity, finding.confidence) == ("major", "low")
        assert finding.evidence.log_line == f"{STATUS_PREFIX}exit status 3"
        assert_findings_cite_the_log(result)

    def test_a_script_that_exits_125_is_a_failed_run_not_a_docker_error(self, docker_bin):
        # 125 is what ``docker run`` itself exits with on a daemon error; the
        # create/start/wait sequence keeps the two apart.
        result = run(runnable_bundle(), FakeDocker(exit_code=125), docker_bin)

        assert result.status == STATUS_FAILED and result.exit_code == 125

    def test_oom_kill_is_named_in_the_log_and_the_finding(self, docker_bin):
        docker = FakeDocker(exit_code=137, oom=True)

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.status == STATUS_FAILED and result.oom_killed
        assert result.status_line == (
            f"{STATUS_PREFIX}stopped: the memory limit of 2048 MB was exceeded (exit status 137)"
        )
        (finding,) = result.findings()
        assert "memory limit" in finding.claim
        assert len(docker.calls_to("inspect")) == 1
        assert_findings_cite_the_log(result)

    def test_exit_137_without_the_oom_flag_is_just_a_failed_run(self, docker_bin):
        result = run(runnable_bundle(), FakeDocker(exit_code=137, oom=False), docker_bin)

        assert not result.oom_killed
        assert result.status_line == f"{STATUS_PREFIX}exit status 137"

    def test_a_clean_exit_does_not_ask_docker_about_oom(self, docker_bin):
        docker = FakeDocker()

        run(runnable_bundle(), docker, docker_bin)

        assert docker.calls_to("inspect") == []


# --------------------------------------------------------------------------- #
# not_run: docker                                                             #
# --------------------------------------------------------------------------- #


class TestDockerUnavailable:
    def test_no_docker_executable(self):
        result = run_bundle(runnable_bundle(), docker_bin="no-such-docker-executable-feature-119")

        assert result.status == STATUS_NOT_RUN
        assert result.reason == "docker_unavailable"
        assert not result.ran and result.exit_code is None
        assert result.log_lines == (
            f"{STATUS_PREFIX}not run (docker_unavailable): the docker executable was not found",
        )

    def test_not_run_finding_cites_its_own_log_line(self):
        result = run_bundle(runnable_bundle(), docker_bin="no-such-docker-executable-feature-119")

        (finding,) = result.findings()

        assert "not run" in finding.claim and "docker" in finding.claim
        assert (finding.severity, finding.confidence) == ("info", "high")
        assert finding.agent == "reproducibility"
        assert finding.evidence.kind == "log_line"
        assert finding.evidence.log_line == result.log_lines[0]
        assert_findings_cite_the_log(result)

    def test_daemon_unreachable_starts_nothing(self, docker_bin, monkeypatch):
        docker = FakeDocker(server=False)
        monkeypatch.setattr(sandbox, "extract_bundle", _fail("a node without docker unpacked a bundle"))

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "docker_unavailable"
        assert result.status_line.endswith("the docker daemon could not be reached")
        assert docker.names == ["version"]

    def test_image_not_present_starts_nothing_and_is_never_pulled(self, docker_bin):
        docker = FakeDocker(image=False)

        result = run(runnable_bundle(), docker, docker_bin, image="repro/sandbox:7")

        assert result.reason == "docker_unavailable"
        assert result.status_line.endswith("the sandbox image repro/sandbox:7 is not available locally")
        assert docker.names == ["version", "image inspect"]
        assert "pull" not in [word for argv in docker.calls for word in argv]

    def test_docker_error_text_never_reaches_the_log(self, docker_bin):
        # The fake's failures carry a host path on stderr.
        for docker in (FakeDocker(server=False), FakeDocker(image=False), FakeDocker(create=False)):
            result = run(runnable_bundle(), docker, docker_bin)

            assert result.status == STATUS_NOT_RUN
            assert HOST_SECRET not in result.log
            assert "/run/user" not in result.log

    def test_docker_error_text_goes_to_the_operators_log(self, docker_bin, caplog):
        with caplog.at_level("WARNING", logger=sandbox.logger.name):
            run(runnable_bundle(), FakeDocker(server=False), docker_bin)

        assert HOST_SECRET in caplog.text

    def test_the_real_docker_cli_with_no_usable_daemon_is_not_run(self, tmp_path):
        # No fake: the stand-in "docker" is a real executable that fails every
        # command, like a docker CLI whose daemon is down.
        fake = tmp_path / "docker"
        fake.write_text("#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)

        result = run_bundle(runnable_bundle(), docker_bin=str(fake))

        assert result.status == STATUS_NOT_RUN and result.reason == "docker_unavailable"
        assert "Cannot connect" not in result.log


def _fail(message):
    def fail(*args, **kwargs):
        raise AssertionError(message)

    return fail


class TestSandboxErrors:
    def test_create_fails(self, docker_bin):
        docker = FakeDocker(create=False)

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "sandbox_error"
        assert result.status_line.endswith("the sandbox container could not be created")
        assert docker.names == ["version", "image inspect", "create"]

    @pytest.mark.parametrize("stdout", [b"", b"not a container id\n", b"WARNING: swap\n"])
    def test_create_that_does_not_print_a_container_id(self, docker_bin, stdout):
        class Odd(FakeDocker):
            def __call__(self, argv, timeout, merge_stderr=False):
                result = super().__call__(argv, timeout, merge_stderr)
                if self.name(argv) == "create":
                    return CommandResult(0, stdout)
                return result

        docker = Odd()

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "sandbox_error"
        assert "start" not in docker.names and "rm" not in docker.names

    def test_start_fails_and_the_container_is_still_removed(self, docker_bin):
        docker = FakeDocker(start=False)

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "sandbox_error"
        assert result.status_line.endswith("the sandbox container could not be started")
        assert docker.names[-1] == "rm" and docker.calls_to("rm")[0][-1] == CONTAINER_ID

    def test_lost_track_of_the_container(self, docker_bin):
        class Garbled(FakeDocker):
            def __call__(self, argv, timeout, merge_stderr=False):
                result = super().__call__(argv, timeout, merge_stderr)
                return CommandResult(0, b"???\n") if self.name(argv) == "wait" else result

        docker = Garbled()

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "sandbox_error"
        assert docker.names[-1] == "rm"

    def test_unreadable_logs_do_not_hide_the_exit_status(self, docker_bin):
        result = run(runnable_bundle(), FakeDocker(exit_code=2, logs=False), docker_bin)

        assert result.status == STATUS_FAILED
        assert result.log_lines == (f"{STATUS_PREFIX}exit status 2",)

    def test_the_container_is_removed_even_if_something_blows_up(self, docker_bin):
        class Boom(FakeDocker):
            def __call__(self, argv, timeout, merge_stderr=False):
                if self.name(argv) == "logs":
                    self.calls.append(list(argv))
                    raise KeyboardInterrupt
                return super().__call__(argv, timeout, merge_stderr)

        docker = Boom()

        with pytest.raises(KeyboardInterrupt):
            run(runnable_bundle(), docker, docker_bin)

        assert len(docker.calls_to("rm")) == 1

    def test_a_failing_rm_does_not_change_the_result(self, docker_bin, caplog):
        class StuckRm(FakeDocker):
            def __call__(self, argv, timeout, merge_stderr=False):
                result = super().__call__(argv, timeout, merge_stderr)
                return CommandResult(1, stderr=b"busy") if self.name(argv) == "rm" else result

        with caplog.at_level("WARNING", logger=sandbox.logger.name):
            result = run(runnable_bundle(), StuckRm(output=b"fine\n"), docker_bin)

        assert result.status == STATUS_COMPLETED
        assert "docker rm failed" in caplog.text

    def test_a_path_docker_cannot_mount_safely_is_refused(self, docker_bin, monkeypatch):
        docker = FakeDocker()
        monkeypatch.setattr(sandbox, "_MOUNT_SOURCE", re.compile(r"/never"))

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "sandbox_error"
        assert "create" not in docker.names


# --------------------------------------------------------------------------- #
# not_run: the bundle                                                         #
# --------------------------------------------------------------------------- #


class TestBundleProblems:
    def test_no_bundle_at_all(self, docker_bin):
        docker = FakeDocker()

        result = run(None, docker, docker_bin)

        assert result.reason == "no_bundle" and result.status == STATUS_NOT_RUN
        assert docker.calls == [], "nothing is asked of docker when there is nothing to run"
        (finding,) = result.findings()
        assert "no code bundle" in finding.claim
        assert_findings_cite_the_log(result)

    @pytest.mark.parametrize("empty", ["", None])
    def test_an_empty_cid_is_no_bundle(self, docker_bin, empty):
        assert run(empty, FakeDocker(), docker_bin).reason == "no_bundle"

    def test_a_bundle_that_is_not_in_the_store(self, docker_bin):
        docker = FakeDocker()
        absent = content.store_bytes(b"stored then lost " + bytes(8)).cid
        content.blob_path(absent).unlink()

        result = run(absent, docker, docker_bin)

        assert result.reason == "bundle_unavailable"
        assert result.status_line.endswith("the code bundle is not in the content store")
        assert "create" not in docker.names

    @pytest.mark.parametrize("cid", ["not-a-cid", "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
    def test_a_malformed_or_unknown_cid(self, docker_bin, cid):
        assert run(cid, FakeDocker(), docker_bin).reason == "bundle_unavailable"

    @pytest.mark.parametrize("scan", [content.SCAN_SCANNING, content.SCAN_FAILED])
    def test_a_bundle_the_sanitizer_has_not_cleared_is_never_run(self, docker_bin, scan):
        docker = FakeDocker()

        result = run(runnable_bundle(scan=scan), docker, docker_bin)

        assert result.reason == "bundle_unavailable"
        assert result.status_line.endswith("has not been cleared by the file sanitizer")
        assert "create" not in docker.names

    def test_a_tombstoned_bundle_is_never_run(self, docker_bin, monkeypatch):
        monkeypatch.setattr(content, "is_tombstoned", lambda cid: True)
        docker = FakeDocker()

        result = run(runnable_bundle(), docker, docker_bin)

        assert result.reason == "bundle_unavailable"
        assert result.status_line.endswith("the code bundle has been removed")
        assert "create" not in docker.names

    def test_a_blob_that_is_not_an_archive(self, docker_bin):
        cid = store_bundle(b"%PDF-1.7 " + bytes(range(50)) + b"nonce")
        docker = FakeDocker()

        result = run(cid, docker, docker_bin)

        assert result.reason == "bundle_unavailable"
        assert result.status_line.endswith("the bundle is not a zip or tar archive")
        assert "create" not in docker.names

    def test_an_unsafe_archive_is_rejected_even_though_it_was_cleared(self, docker_bin):
        data = zip_bytes(with_nonce({"reproduce.sh": "echo\n", "../evil": "x"}))
        docker = FakeDocker()

        result = run(store_bundle(data), docker, docker_bin)

        assert result.reason == "bundle_rejected"
        assert "create" not in docker.names
        (finding,) = result.findings()
        assert (finding.severity, finding.confidence) == ("minor", "medium")

    def test_an_archive_too_big_for_the_work_directory(self, docker_bin):
        # Half of /work is for the bundle, the rest for what it writes.
        small = SandboxLimits(work_mb=16, tmp_mb=16, memory_mb=256)
        assert small.max_bundle_bytes == 8 * 1024 * 1024
        docker = FakeDocker()
        big = runnable_bundle({"data.bin": "0" * (9 * 1024 * 1024)})

        result = run(big, docker, docker_bin, limits=small)

        assert result.reason == "bundle_rejected"
        assert "unpacks to more than 8 MiB" in result.status_line
        assert "create" not in docker.names

    def test_no_entry_point(self, docker_bin):
        docker = FakeDocker()
        cid = store_bundle(zip_bytes(with_nonce({"main.py": "print(1)\n"})))

        result = run(cid, docker, docker_bin)

        assert result.reason == "no_entrypoint"
        assert "reproduce.sh or run.sh" in result.status_line
        assert "create" not in docker.names
        (finding,) = result.findings()
        assert (finding.severity, finding.confidence) == ("minor", "medium")

    def test_run_sh_is_used_when_there_is_no_reproduce_sh(self, docker_bin):
        docker = FakeDocker()
        cid = store_bundle(zip_bytes(with_nonce({"run.sh": "echo\n"})))

        run(cid, docker, docker_bin)

        assert docker.calls_to("create")[0][-2:] == ["sh", "./run.sh"]

    def test_a_given_command_replaces_the_entry_point_search(self, docker_bin):
        docker = FakeDocker()
        cid = store_bundle(zip_bytes(with_nonce({"main.py": "print(1)\n"})))

        result = run(cid, docker, docker_bin, command=["python", "main.py", "--fast"])

        assert result.status == STATUS_COMPLETED
        assert docker.calls_to("create")[0][-3:] == ["python", "main.py", "--fast"]

    def test_a_tar_bundle_with_a_top_level_directory(self, docker_bin):
        # The nonce goes inside the directory too: a second top-level entry
        # would (correctly) stop ``proj`` from being the bundle root.
        files = {"proj/reproduce.sh": "echo\n", "proj/code.py": "x=1\n", "proj/.nonce": uuid.uuid4().hex}
        docker = FakeDocker()

        result = run(store_bundle(tar_bytes(files)), docker, docker_bin)

        assert result.status == STATUS_COMPLETED
        assert docker.calls_to("create")[0][-2:] == ["sh", "./reproduce.sh"]

    def test_a_second_top_level_entry_means_the_entry_point_must_be_at_the_top(self, docker_bin):
        files = {"proj/reproduce.sh": "echo\n", "README": "hello"}

        result = run(store_bundle(tar_bytes(with_nonce(files))), FakeDocker(), docker_bin)

        assert result.reason == "no_entrypoint"

    def test_a_tar_bundle_with_a_symlink_is_rejected(self, docker_bin):
        members = [(tar_member("link", b"2", link="/etc/passwd"), b"")]
        data = tar_bytes(with_nonce({"reproduce.sh": "echo\n"}), members)

        result = run(store_bundle(data), FakeDocker(), docker_bin)

        assert result.reason == "bundle_rejected"


class TestArguments:
    @pytest.mark.parametrize(
        "image", ["--privileged", "-v", "a b", "img;rm", "img\nx", "$(id)", "img`id`", "/abs", "x" * 300]
    )
    def test_a_bad_image_reference_is_refused_before_anything_runs(self, docker_bin, image):
        docker = FakeDocker()

        with pytest.raises(ValueError, match="image"):
            run(runnable_bundle(), docker, docker_bin, image=image)

        assert docker.calls == []

    @pytest.mark.parametrize("image", ["python:3.12-slim", "registry.example.com:5000/team/repro:1.2", "repro@sha256:" + "a" * 64])
    def test_good_image_references_are_used_as_given(self, docker_bin, image):
        docker = FakeDocker()

        run(runnable_bundle(), docker, docker_bin, image=image)

        assert docker.calls_to("image inspect")[0][-1] == image
        assert image in docker.calls_to("create")[0]

    def test_the_default_image_and_the_environment_override(self, docker_bin, monkeypatch):
        monkeypatch.delenv(sandbox.IMAGE_ENV, raising=False)
        docker = FakeDocker()
        run(runnable_bundle(), docker, docker_bin)
        assert docker.calls_to("image inspect")[0][-1] == sandbox.DEFAULT_IMAGE == "python:3.12-slim"

        monkeypatch.setenv(sandbox.IMAGE_ENV, "team/repro:9")
        docker = FakeDocker()
        run(runnable_bundle(), docker, docker_bin)
        assert docker.calls_to("image inspect")[0][-1] == "team/repro:9"

        docker = FakeDocker()
        run(runnable_bundle(), docker, docker_bin, image="explicit:1")
        assert docker.calls_to("image inspect")[0][-1] == "explicit:1"

    def test_a_bad_image_in_the_environment_is_a_loud_error(self, docker_bin, monkeypatch):
        monkeypatch.setenv(sandbox.IMAGE_ENV, "--privileged")

        with pytest.raises(ValueError, match="image"):
            run(runnable_bundle(), FakeDocker(), docker_bin)

    @pytest.mark.parametrize("command", [[], [""], ["python", ""], [1], "python main.py"])
    def test_a_bad_command_is_refused(self, docker_bin, command):
        with pytest.raises(ValueError, match="command"):
            run(runnable_bundle(), FakeDocker(), docker_bin, command=command)

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"cpus": 0},
            {"cpus": 65},
            {"pids": 4},
            {"work_mb": 8},
            {"tmp_mb": 8},
            {"memory_mb": 600, "work_mb": 512, "tmp_mb": 128},
        ],
    )
    def test_nonsense_limits_are_refused(self, kwargs):
        with pytest.raises(ValueError):
            SandboxLimits(**kwargs)


# --------------------------------------------------------------------------- #
# The log                                                                     #
# --------------------------------------------------------------------------- #


class TestCleanLog:
    def test_lines_are_split_stripped_and_blank_ones_dropped(self):
        assert clean_log(b"  a  \n\n\n\tb\r\nc\n") == ("a", "b", "c")

    def test_nothing_gives_nothing(self):
        assert clean_log(b"") == ()
        assert clean_log(b"\n \n\t\n") == ()

    def test_terminal_escapes_and_control_characters_are_removed(self):
        raw = b"\x1b[31mred\x1b[0m text\n\x1b]0;title\x07next\x00\x08\x7f line\n\x1b[2K\x1b[1Gdone\n"

        assert clean_log(raw) == ("red text", "next line", "done")

    def test_a_progress_bar_redrawn_with_carriage_returns_becomes_lines(self):
        assert clean_log(b"10%\r50%\r100%\ndone\n") == ("10%", "50%", "100%", "done")

    def test_invalid_utf8_is_replaced_not_fatal(self):
        assert clean_log(b"caf\xc3\xa9 \xff\xfe ok\n") == ("café �� ok",)

    def test_an_overlong_line_is_cut_with_an_ellipsis(self):
        (line,) = clean_log(b"x" * 5_000)

        assert len(line) == 500 and line.endswith("…")

    def test_only_the_last_lines_are_kept_and_the_first_line_says_so(self):
        raw = "\n".join(f"line {i}" for i in range(MAX_LOG_LINES + 50)).encode()

        lines = clean_log(raw)

        assert lines[0] == f"{STATUS_PREFIX}output truncated: only the last {MAX_LOG_LINES} lines are kept"
        assert len(lines) == MAX_LOG_LINES + 1
        assert lines[1] == "line 50" and lines[-1] == f"line {MAX_LOG_LINES + 49}"

    def test_the_character_budget_is_enforced_from_the_end(self):
        raw = "\n".join(f"{i:04d} " + "y" * 495 for i in range(200)).encode()  # 500 chars each

        lines = clean_log(raw)

        assert sum(len(line) for line in lines[1:]) <= MAX_LOG_CHARS
        assert lines[0].startswith(STATUS_PREFIX + "output truncated")
        assert lines[-1].startswith("0199 ")

    def test_a_log_within_the_limits_has_no_marker(self):
        lines = clean_log(b"one\ntwo\n")

        assert lines == ("one", "two")

    def test_any_way_of_splitting_the_log_gives_the_same_lines(self, docker_bin):
        # The verifier may split on "\n" or with splitlines(); both must agree.
        output = b"a\x0bb\x0cc\x1cd\xc2\x85e\xe2\x80\xa8f\ng\n"
        result = run(runnable_bundle(), FakeDocker(output=output), docker_bin)

        assert result.log.split("\n") == list(result.log_lines) == result.log.splitlines()

    def test_noisy_output_in_a_run_is_bounded(self, docker_bin):
        output = ("z" * 400 + "\n").encode() * 5_000

        result = run(runnable_bundle(), FakeDocker(output=output), docker_bin)

        assert len(result.log) <= MAX_LOG_CHARS + 2_000
        assert result.status_line == f"{STATUS_PREFIX}exit status 0"


# --------------------------------------------------------------------------- #
# SandboxRun and the real command runner                                      #
# --------------------------------------------------------------------------- #


class TestSandboxRun:
    def test_every_not_run_reason_has_a_finding_that_cites_its_line(self):
        for reason in NOT_RUN_REASONS:
            run_ = sandbox._not_run(reason, "because")

            (finding,) = run_.findings()

            assert run_.status == STATUS_NOT_RUN and run_.reason == reason
            assert finding.evidence.log_line == f"{STATUS_PREFIX}not run ({reason}): because"
            assert finding.claim.endswith(".") and "\n" not in finding.claim
            assert_findings_cite_the_log(run_)

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"status": "exploded", "log_lines": ("x",)},
            {"status": STATUS_NOT_RUN, "log_lines": ("x",)},  # no reason
            {"status": STATUS_COMPLETED, "reason": "docker_unavailable", "log_lines": ("x",)},
            {"status": STATUS_NOT_RUN, "reason": "because", "log_lines": ("x",)},
            {"status": STATUS_COMPLETED, "exit_code": 0},  # no log at all
        ],
    )
    def test_inconsistent_runs_cannot_be_built(self, kwargs):
        with pytest.raises(ValueError):
            SandboxRun(**kwargs)

    def test_a_timeout_with_a_shorter_limit_says_so(self):
        limits = SandboxLimits(time_limit=90)
        run_ = SandboxRun(status=STATUS_TIMEOUT, log_lines=("x",), limits=limits)

        (finding,) = run_.findings()

        assert "90-second" in finding.claim

    def test_a_ten_minute_limit_is_worded_in_minutes(self):
        run_ = SandboxRun(status=STATUS_TIMEOUT, log_lines=("x",))

        assert "10-minute" in run_.findings()[0].claim


class TestRunCommand:
    def test_captures_output_and_exit_status(self):
        result = run_command(["sh", "-c", "echo out; echo err >&2; exit 3"], 10)

        assert result.returncode == 3 and not result.ok and not result.timed_out
        assert result.stdout == b"out\n" and result.stderr == b"err\n"

    def test_merges_stderr_into_stdout_in_order_when_asked(self):
        result = run_command(["sh", "-c", "echo a; echo b >&2; echo c"], 10, True)

        assert result.stdout == b"a\nb\nc\n" and result.stderr == b""

    def test_a_command_that_outlives_the_timeout_is_killed(self):
        result = run_command([sys.executable, "-c", "import time; time.sleep(30)"], 0.3)

        assert result.timed_out and not result.ok

    def test_a_program_that_cannot_be_executed(self, tmp_path):
        result = run_command([str(tmp_path / "absent")], 5)

        assert result.returncode == 127 and not result.ok

    def test_stdin_is_closed(self):
        result = run_command(["sh", "-c", "cat; echo end"], 10)

        assert result.stdout == b"end\n"

    def test_the_arguments_are_not_interpreted_by_a_shell(self):
        result = run_command(["echo", "$(echo injected); echo more"], 10)

        assert result.stdout == b"$(echo injected); echo more\n"

    def test_run_command_is_what_run_bundle_uses_by_default(self, tmp_path, monkeypatch):
        calls = []

        def spy(argv, timeout, merge_stderr=False):
            calls.append(list(argv))
            return CommandResult(1)

        monkeypatch.setattr(sandbox, "run_command", spy)
        fake = make_executable(tmp_path / "docker")

        result = run_bundle(runnable_bundle(), docker_bin=str(fake))

        assert result.reason == "docker_unavailable"
        assert calls and calls[0][1] == "version"
