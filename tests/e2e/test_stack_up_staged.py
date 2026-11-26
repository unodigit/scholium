"""scripts/stack-up-staged.sh starts the compose stack in dependency stages.

``npm run stack:up`` and ``npm run stack:deps`` run it.  It starts db, minio and
mailpit, waits until each is healthy, starts the one-shot minio-init and waits for
it to exit 0, and (stack:up only) builds and starts clamav (round 27: the bundle scanner, first), api, worker and web.  Every
``up`` carries ``--no-deps``: podman-compose 1.6 creates containers with
``--requires`` and podman 4.9 then refuses to start api or worker once minio-init
has exited, so the script does the ordering itself instead of depending on
``depends_on``.

Nothing here starts a container.  The scripts are copied into a temporary
repository layout and run against a fake engine named in ``STACK_COMPOSE``.  The
fake keeps state: it records every call (and what ``ps`` told the script) in a
JSON-lines file, lets a service exist only after an ``up`` named it, and prints
``ps`` tables in the shape of ``podman ps`` or of ``docker compose ps`` with the
status each scenario scripts for that service.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from e2e_harness import REPO_ROOT

SCRIPT_NAME = "stack-up-staged.sh"

HEALTHY = "Up 12 seconds (healthy)"
STARTING = "Up 3 seconds (starting)"
EXITED_OK = "Exited (0) 2 seconds ago"
EXITED_FAILED = "Exited (1) 2 seconds ago"
RUNNING = "Up 4 seconds"

# What `ps` reports once every service has had time to settle.
SETTLED = {
    "db": [HEALTHY],
    "minio": [HEALTHY],
    "mailpit": [HEALTHY],
    "minio-init": [EXITED_OK],
    "api": [HEALTHY],
    "worker": [HEALTHY],
    "web": [HEALTHY],
    "sandbox": [HEALTHY],
}

# The fake engine.  `statuses` maps a service to the statuses its container shows on
# successive `ps` calls after it was started; the last one repeats.
FAKE_ENGINE = r'''
import json
import sys
from pathlib import Path

state_dir = Path(sys.argv[1])
argv = sys.argv[2:]
config = json.loads((state_dir / "config.json").read_text())
events = state_dir / "events.jsonl"
started_file = state_dir / "started.json"
started = json.loads(started_file.read_text()) if started_file.exists() else {}


def record(**extra):
    with events.open("a") as handle:
        handle.write(json.dumps({"argv": argv, **extra}) + "\n")


if argv[:1] == ["--version"]:
    print("podman-compose version 1.6.0")
    sys.exit(0)

# stack-compose.sh puts `-f compose.yaml` in front of the compose command.
assert argv[:2] == ["-f", "compose.yaml"], argv
command = argv[2:]
verb = command[0]

if verb == "up":
    services = [word for word in command[1:] if not word.startswith("-")]
    record(services=services)
    if config.get("up_exit"):
        print("fake engine: up failed", file=sys.stderr)
        sys.exit(config["up_exit"])
    for service in services:
        started[service] = 0
    started_file.write_text(json.dumps(started))
    sys.exit(0)

if verb == "ps":
    show_all = "-a" in command[1:]
    if show_all and not config.get("ps_all", True):
        print("usage: podman-compose ps [-h] [-q] [-f FORMAT]", file=sys.stderr)
        record(error="no -a")
        sys.exit(2)
    rows = []
    shown = {}
    for service, polls in started.items():
        statuses = config["statuses"].get(service, ["Created"])
        status = statuses[min(polls, len(statuses) - 1)]
        started[service] = polls + 1
        if config["style"] == "docker" and status.startswith("Exited") and not show_all:
            continue  # docker compose ps hides exited containers without -a
        shown[service] = status
        project = "scholium"
        stem = config["alias"].get(service, service)  # what the row calls the service
        if config["style"] == "podman":
            rows.append(["0123456789ab", "docker.io/library/" + stem + ":local", "\"run\"",
                         "20 seconds ago", status, "127.0.0.1:1234->1234/tcp", f"{project}_{stem}_1"])
        else:
            rows.append([f"{project}-{stem}-1", "docker.io/library/" + stem + ":local", "\"run\"",
                         stem, "20 seconds ago", status, "127.0.0.1:1234->1234/tcp"])
    started_file.write_text(json.dumps(started))
    if config["style"] == "podman":
        print("WARN[0000] \"/\" is not a shared mount, this could cause issues", file=sys.stderr)
        header = ["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"]
    else:
        header = ["NAME", "IMAGE", "COMMAND", "SERVICE", "CREATED", "STATUS", "PORTS"]
    for row in [header, *rows]:
        print("  ".join(row))
    record(shown=shown, all=show_all)
    sys.exit(0)

record(unexpected=True)
sys.exit(3)
'''


class Stack:
    """A temporary repository layout whose compose engine is the fake above."""

    def __init__(self, root: Path, *, statuses: dict[str, list[str]], style: str = "podman",
                 ps_all: bool = True, up_exit: int = 0, alias: dict[str, str] | None = None) -> None:
        self.root = root
        self.state = root / "fake-state"
        self.state.mkdir()
        scripts = root / "scripts"
        scripts.mkdir()
        for name in (SCRIPT_NAME, "stack-compose.sh"):
            shutil.copy(REPO_ROOT / "scripts" / name, scripts / name)
        merged = {**SETTLED, **statuses}
        (self.state / "config.json").write_text(json.dumps({
            "statuses": merged, "style": style, "ps_all": ps_all, "up_exit": up_exit,
            "alias": alias or {},
        }))
        program = self.state / "engine.py"
        program.write_text(FAKE_ENGINE)
        # A shell wrapper named podman-compose: stack-compose.sh holds it to the 1.6.0
        # floor, and a shebang naming the venv's python could exceed the length limit.
        engine = root / "bin" / "podman-compose"
        engine.parent.mkdir()
        engine.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{program}" "{self.state}" "$@"\n')
        engine.chmod(engine.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self.engine = engine

    def run(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(self.root),
            "TMPDIR": str(self.root),
            "STACK_COMPOSE": str(self.engine),
            "STACK_UP_POLL_INTERVAL": "0.05",
            **(env or {}),
        }
        return subprocess.run(
            ["bash", str(self.root / "scripts" / SCRIPT_NAME), *args],
            cwd=self.root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def events(self) -> list[dict]:
        path = self.state / "events.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    def calls(self) -> list[list[str]]:
        """The compose commands the script ran, without `-f compose.yaml`; `--version` probes left out."""
        return [event["argv"][2:] for event in self.events() if event["argv"][:1] != ["--version"]]

    def ups(self) -> list[dict]:
        return [event for event in self.events() if event["argv"][2:3] == ["up"]]


@pytest.fixture(params=["podman", "docker"])
def style(request) -> str:
    """Both table shapes the script reads: podman ps (NAMES last) and docker compose ps (SERVICE column)."""
    return request.param


def make_stack(tmp_path: Path, **kwargs) -> Stack:
    return Stack(tmp_path, **kwargs)


def index_of(events: list[dict], predicate) -> int:
    for position, event in enumerate(events):
        if predicate(event):
            return position
    raise AssertionError(f"no matching event in {events}")


def is_up(*services: str):
    return lambda event: event["argv"][2:3] == ["up"] and event.get("services") == list(services)


# --- the order of the calls ------------------------------------------------------------


def test_stack_up_runs_the_three_stages_in_order(tmp_path, style):
    stack = make_stack(tmp_path, style=style, statuses={
        "db": [STARTING, HEALTHY],
        "minio": [STARTING, STARTING, HEALTHY],
        "mailpit": [HEALTHY],
        "minio-init": [RUNNING, RUNNING, EXITED_OK],
    })

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    events = stack.events()
    stage1 = index_of(events, is_up("db", "minio", "mailpit"))
    stage2 = index_of(events, is_up("minio-init"))
    stage3 = index_of(events, is_up("clamav", "api", "worker", "web"))
    assert stage1 < stage2 < stage3, "the stages must run in dependency order"
    assert stage1 == 0, "nothing may be asked of the engine before the backing services are started"

    # Stage 2 starts only after db, minio and mailpit were each seen healthy.
    before_stage2 = [event.get("shown", {}) for event in events[stage1:stage2]]
    for service in ("db", "minio", "mailpit"):
        assert any(shown.get(service) == HEALTHY for shown in before_stage2), (
            f"minio-init was started before {service} reported healthy"
        )
    # Stage 3 starts only after minio-init was seen to exit 0, not while it was still running.
    between = [event.get("shown", {}) for event in events[stage2:stage3]]
    assert any(shown.get("minio-init") == EXITED_OK for shown in between), (
        "clamav, api, worker and web were started before minio-init exited with status 0"
    )
    assert [shown["minio-init"] for shown in between if "minio-init" in shown][:1] == [RUNNING], (
        "the scenario must show minio-init still running before it exits"
    )


def test_every_up_passes_no_deps_and_the_last_one_builds(tmp_path, style):
    stack = make_stack(tmp_path, style=style, statuses={})

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    ups = [event["argv"][2:] for event in stack.ups()]
    assert ups == [
        ["up", "-d", "--no-deps", "db", "minio", "mailpit"],
        ["up", "-d", "--no-deps", "minio-init"],
        ["up", "-d", "--no-deps", "--build", "--remove-orphans", "clamav", "api", "worker", "web"],
    ]
    # Anything else the script asked of the engine is a status query.
    others = [call for call in stack.calls() if call[0] != "up"]
    assert others and all(call[0] == "ps" for call in others), others


def test_deps_only_stops_after_minio_init_and_never_touches_the_application(tmp_path, style):
    stack = make_stack(tmp_path, style=style, statuses={"minio-init": [RUNNING, EXITED_OK]})

    result = stack.run("--deps-only")

    assert result.returncode == 0, result.stdout + result.stderr
    ups = [event["argv"][2:] for event in stack.ups()]
    assert ups == [
        ["up", "-d", "--no-deps", "db", "minio", "mailpit"],
        ["up", "-d", "--no-deps", "minio-init"],
    ]
    everything = json.dumps(stack.events())
    for service in ("clamav", "api", "worker", "web"):
        assert f'"{service}"' not in everything, f"--deps-only mentioned {service}"
    assert "--build" not in everything, "--deps-only must not build images"
    assert stack.events()[-1].get("shown", {}).get("minio-init") == EXITED_OK, (
        "the last thing --deps-only does is confirm minio-init exited"
    )


def test_the_sandbox_joins_the_last_stage_when_its_profile_is_enabled(tmp_path):
    stack = make_stack(tmp_path, statuses={})

    result = stack.run(env={"COMPOSE_PROFILES": "other, sandbox"})

    assert result.returncode == 0, result.stdout + result.stderr
    assert stack.ups()[-1]["services"] == ["clamav", "api", "worker", "web", "sandbox"]


def test_the_sandbox_profile_is_read_from_dot_env_like_compose_does(tmp_path):
    stack = make_stack(tmp_path, statuses={})
    (tmp_path / ".env").write_text("# local\nCOMPOSE_PROFILES=sandbox  # opt in\n")

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert stack.ups()[-1]["services"] == ["clamav", "api", "worker", "web", "sandbox"]


def test_the_sandbox_stays_out_without_its_profile(tmp_path):
    stack = make_stack(tmp_path, statuses={})
    (tmp_path / ".env").write_text("COMPOSE_PROFILES=other\n")

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert stack.ups()[-1]["services"] == ["clamav", "api", "worker", "web"]


# --- minio-init, which only `ps -a` shows under docker compose ----------------------------


def test_an_exited_minio_init_is_found_with_ps_a_when_plain_ps_hides_it(tmp_path):
    stack = make_stack(tmp_path, style="docker", statuses={"minio-init": [EXITED_OK]})

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert any(call == ["ps", "-a"] for call in stack.calls()), "plain ps cannot show an exited container"


def test_podman_compose_ps_has_no_dash_a_and_is_not_asked_for_it(tmp_path):
    # podman-compose ps lists every container and rejects -a; plain ps already shows minio-init.
    stack = make_stack(tmp_path, style="podman", ps_all=False, statuses={"minio-init": [EXITED_OK]})

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not any(call == ["ps", "-a"] for call in stack.calls())


# --- giving up -------------------------------------------------------------------------


@pytest.mark.parametrize("stuck", ["db", "minio", "mailpit"])
def test_a_backing_service_that_never_turns_healthy_times_out_naming_it(tmp_path, style, stuck):
    stack = make_stack(tmp_path, style=style, statuses={stuck: [STARTING]})

    started = time.monotonic()
    result = stack.run(env={"STACK_UP_TIMEOUT": "2"})
    elapsed = time.monotonic() - started

    assert result.returncode == 1, result.stdout + result.stderr
    assert f"{stuck} was not healthy after 2s" in result.stderr
    assert f"last status: {STARTING}" in result.stderr, result.stderr
    assert elapsed >= 1, "it gave up before the timeout"
    assert elapsed < 30, "it waited much longer than the timeout"
    # Nothing after the failed wait was started: neither the bucket job nor the application.
    assert not any(is_up("minio-init")(event) for event in stack.events())
    assert not any(is_up("clamav", "api", "worker", "web")(event) for event in stack.events())


def test_an_unhealthy_status_is_not_taken_for_healthy(tmp_path, style):
    stack = make_stack(tmp_path, style=style, statuses={"db": ["Up 9 seconds (unhealthy)"]})

    result = stack.run(env={"STACK_UP_TIMEOUT": "1"})

    assert result.returncode == 1, result.stdout + result.stderr
    assert "db was not healthy after 1s; last status: Up 9 seconds (unhealthy)" in result.stderr


def test_a_container_that_only_resembles_the_service_is_not_taken_for_it(tmp_path, style):
    # The only row is for a service called "xdb": its name ends in "db", but it is not db.
    stack = make_stack(tmp_path, style=style, statuses={}, alias={"db": "xdb"})

    result = stack.run(env={"STACK_UP_TIMEOUT": "1"})

    assert result.returncode == 1, result.stdout + result.stderr
    assert "db was not healthy after 1s; last status: not listed by ps" in result.stderr


def test_minio_is_not_confused_with_minio_init(tmp_path, style):
    # minio never turns healthy; minio-init's row (and its "minio" prefix) must not stand in for it.
    stack = make_stack(tmp_path, style=style, statuses={"minio": [STARTING], "minio-init": [HEALTHY]})

    result = stack.run(env={"STACK_UP_TIMEOUT": "1"})

    assert result.returncode == 1, result.stdout + result.stderr
    assert f"minio was not healthy after 1s; last status: {STARTING}" in result.stderr


def test_a_minio_init_that_keeps_running_times_out_and_the_application_is_not_started(tmp_path, style):
    stack = make_stack(tmp_path, style=style, statuses={"minio-init": [RUNNING]})

    result = stack.run(env={"STACK_UP_TIMEOUT": "2"})

    assert result.returncode == 1, result.stdout + result.stderr
    assert "minio-init had not exited with status 0 after 2s" in result.stderr
    assert f"last status: {RUNNING}" in result.stderr
    assert not any(is_up("clamav", "api", "worker", "web")(event) for event in stack.events())


def test_a_minio_init_that_exited_non_zero_fails_at_once(tmp_path, style):
    stack = make_stack(tmp_path, style=style, statuses={"minio-init": [EXITED_FAILED]})

    started = time.monotonic()
    result = stack.run(env={"STACK_UP_TIMEOUT": "60"})
    elapsed = time.monotonic() - started

    assert result.returncode == 1, result.stdout + result.stderr
    assert "minio-init exited with a non-zero status" in result.stderr
    assert f"last status: {EXITED_FAILED}" in result.stderr
    assert elapsed < 30, "a bucket job that already failed cannot succeed later; the script must not wait"
    assert not any(is_up("clamav", "api", "worker", "web")(event) for event in stack.events())


def test_the_wait_ends_with_the_deps_only_mode_too(tmp_path):
    stack = make_stack(tmp_path, statuses={"minio-init": [RUNNING]})

    result = stack.run("--deps-only", env={"STACK_UP_TIMEOUT": "1"})

    assert result.returncode == 1, result.stdout + result.stderr
    assert "minio-init had not exited with status 0 after 1s" in result.stderr


def test_the_default_timeout_is_300_seconds(tmp_path):
    stack = make_stack(tmp_path, statuses={})

    result = stack.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "waiting for db to be healthy (up to 300s)" in result.stdout
    assert "waiting for minio-init to exit with status 0 (up to 300s)" in result.stdout


def test_a_failing_compose_command_ends_the_script_with_its_status(tmp_path):
    stack = make_stack(tmp_path, statuses={}, up_exit=3)

    result = stack.run()

    assert result.returncode == 3, result.stdout + result.stderr
    assert "up -d --no-deps db minio mailpit" in result.stderr
    assert [call[0] for call in stack.calls()] == ["up"], "nothing may follow a failed start"


@pytest.mark.parametrize("value", ["abc", "0", "-5", "1.5"])
def test_a_bad_timeout_is_refused_before_anything_runs(tmp_path, value):
    stack = make_stack(tmp_path, statuses={})

    result = stack.run(env={"STACK_UP_TIMEOUT": value})

    assert result.returncode == 2, result.stdout + result.stderr
    assert "STACK_UP_TIMEOUT" in result.stderr and value in result.stderr
    assert stack.events() == []


@pytest.mark.parametrize("value", ["abc", "0", "0.0", "-1", "1.2.3"])
def test_a_bad_poll_interval_is_refused_before_anything_runs(tmp_path, value):
    stack = make_stack(tmp_path, statuses={})

    result = stack.run(env={"STACK_UP_POLL_INTERVAL": value})

    assert result.returncode == 2, result.stdout + result.stderr
    assert "STACK_UP_POLL_INTERVAL" in result.stderr
    assert stack.events() == []


def test_an_unknown_argument_is_refused(tmp_path):
    stack = make_stack(tmp_path, statuses={})

    result = stack.run("--everything")

    assert result.returncode == 2, result.stdout + result.stderr
    assert "--everything" in result.stderr
    assert stack.events() == []


# --- the wiring ------------------------------------------------------------------------


def test_stack_up_and_stack_deps_run_the_staged_script():
    scripts = json.loads((REPO_ROOT / "package.json").read_text())["scripts"]

    assert scripts["stack:up"].split() == ["bash", f"scripts/{SCRIPT_NAME}"]
    assert scripts["stack:deps"].split() == ["bash", f"scripts/{SCRIPT_NAME}", "--deps-only"]
    assert (REPO_ROOT / "scripts" / SCRIPT_NAME).is_file()


def test_the_script_composes_through_the_engine_selector_only():
    text = (REPO_ROOT / "scripts" / SCRIPT_NAME).read_text()

    assert "scripts/stack-compose.sh" in text
    for engine in ("podman-compose", "docker compose", "podman "):
        for line in text.splitlines():
            code = line.split("#", 1)[0]
            assert engine not in code, f"the script must not call {engine} itself: {line}"
