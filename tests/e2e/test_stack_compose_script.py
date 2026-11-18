"""scripts/stack-compose.sh chooses the engine, refuses an old podman-compose
and passes the compose arguments through.

Nothing here starts a container: each test puts a fake engine executable on
``PATH`` (or names it in ``STACK_COMPOSE``) and lets the script talk to it.  A
fake records every argument it is run with, so the test can see both the
``--version`` probe and the compose command the script finally runs.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

from e2e_harness import REPO_ROOT

SCRIPT = REPO_ROOT / "scripts" / "stack-compose.sh"

COMPOSE_ARGS = ["up", "-d", "--build"]


def fake_engine(tmp_path: Path, version: str, *, name: str = "podman-compose") -> tuple[Path, Path]:
    """An executable that reports ``version`` and records the arguments it gets."""
    directory = tmp_path / "bin"
    directory.mkdir()
    calls = tmp_path / "calls.txt"
    engine = directory / name
    engine.write_text(
        "#!/bin/sh\n"
        f'calls="{calls}"\n'
        "if [ \"$1\" = \"--version\" ]; then\n"
        f"  echo \"{name} version {version}\"\n"
        "  exit 0\n"
        "fi\n"
        "for argument in \"$@\"; do printf '%s\\n' \"$argument\" >> \"$calls\"; done\n"
        "exit 0\n"
    )
    engine.chmod(engine.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return engine, calls


def run_script(tmp_path: Path, *, stack_compose: str | None, args: list[str],
               path_prefix: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Run the script with a minimal environment, so no engine leaks in from the host."""
    path = [str(path_prefix)] if path_prefix else []
    path.append(os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"))
    environment = {
        "PATH": os.pathsep.join(path),
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
    }
    if stack_compose is not None:
        environment["STACK_COMPOSE"] = stack_compose
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )


def recorded(calls: Path) -> list[str]:
    return calls.read_text().splitlines() if calls.exists() else []


def test_an_old_podman_compose_named_in_stack_compose_is_refused(tmp_path):
    engine, calls = fake_engine(tmp_path, "1.0.6")

    result = run_script(tmp_path, stack_compose=str(engine), args=COMPOSE_ARGS)

    assert result.returncode == 1, result.stderr
    output = result.stdout + result.stderr
    assert "1.0.6" in output, "the refusal must name the installed version"
    assert "1.6.0" in output, "the refusal must name the required version"
    assert "COMPOSE_PROFILES" in output and "${A:-${B}}" in output, (
        "the refusal must say why 1.6.0 is needed"
    )
    assert "pipx install podman-compose" in output, "the refusal must name the upgrade"
    assert 'STACK_COMPOSE="docker compose"' in output, "the refusal must name the docker alternative"
    # The compose command itself never ran: only the --version probe reached the engine.
    assert recorded(calls) == [], "an old podman-compose must not be allowed to run compose"


def test_an_old_auto_detected_podman_compose_is_refused(tmp_path):
    engine, calls = fake_engine(tmp_path, "1.0.6")

    result = run_script(tmp_path, stack_compose=None, args=COMPOSE_ARGS, path_prefix=engine.parent)

    assert result.returncode == 1, result.stderr
    assert "1.0.6" in result.stderr
    assert recorded(calls) == []


def test_podman_compose_1_6_0_runs_the_compose_arguments(tmp_path):
    engine, calls = fake_engine(tmp_path, "1.6.0")

    result = run_script(tmp_path, stack_compose=str(engine), args=COMPOSE_ARGS)

    assert result.returncode == 0, result.stderr
    assert recorded(calls) == ["-f", "compose.yaml", *COMPOSE_ARGS], (
        "the compose arguments must reach the engine unchanged"
    )


def test_a_newer_podman_compose_is_accepted(tmp_path):
    engine, calls = fake_engine(tmp_path, "1.7.2")

    result = run_script(tmp_path, stack_compose=str(engine), args=["down", "--remove-orphans"])

    assert result.returncode == 0, result.stderr
    assert recorded(calls) == ["-f", "compose.yaml", "down", "--remove-orphans"]


def test_a_docker_compose_engine_is_not_version_checked(tmp_path):
    # The engine is docker compose, whose --version output is not a podman-compose
    # version; the script must run it without probing a podman-compose floor.
    engine, calls = fake_engine(tmp_path, "v2.27.0", name="docker")
    engine.write_text(
        "#!/bin/sh\n"
        f'calls="{calls}"\n'
        "case \"$1 $2\" in\n"
        "  \"compose version\") echo 'Docker Compose version v2.27.0'; exit 0 ;;\n"
        "esac\n"
        "for argument in \"$@\"; do printf '%s\\n' \"$argument\" >> \"$calls\"; done\n"
        "exit 0\n"
    )
    engine.chmod(0o755)

    result = run_script(tmp_path, stack_compose=f"{engine} compose", args=COMPOSE_ARGS)

    assert result.returncode == 0, result.stderr
    assert recorded(calls) == ["compose", "-f", "compose.yaml", *COMPOSE_ARGS]


def test_the_other_stack_scripts_route_through_this_one():
    """stack:up, down, logs, reset and deps call stack-compose.sh; smoke calls stack-smoke.sh."""
    import json

    scripts = json.loads((REPO_ROOT / "package.json").read_text())["scripts"]
    for name in ("stack:up", "stack:down", "stack:logs", "stack:deps"):
        assert "scripts/stack-compose.sh" in scripts[name], name
    reset = scripts["stack:reset"]
    assert "scripts/stack-compose.sh down" in reset and "--volumes" in reset, (
        "stack:reset must delete the volumes through stack-compose.sh"
    )
    assert "scripts/stack-compose.sh up" in reset, (
        "stack:reset must start the stack again through stack-compose.sh"
    )
    assert "scripts/stack-smoke.sh" in scripts["stack:smoke"]
    smoke = (REPO_ROOT / "scripts" / "stack-smoke.sh").read_text()
    assert "scripts/stack-compose.sh" in smoke, "stack:smoke must compose through stack-compose.sh"


def test_stack_deps_names_only_the_backing_services():
    import json

    scripts = json.loads((REPO_ROOT / "package.json").read_text())["scripts"]
    command = scripts["stack:deps"]
    assert "scripts/stack-compose.sh up" in command
    for service in ("db", "minio", "minio-init", "mailpit"):
        assert service in command.split(), f"stack:deps must start {service}"
    for service in ("api", "worker", "web"):
        assert service not in command.split(), f"stack:deps must leave {service} stopped"


@pytest.mark.parametrize("version", ["0.9.9", "1.5.9"])
def test_versions_below_the_floor_are_refused(tmp_path, version):
    engine, _ = fake_engine(tmp_path, version)

    result = run_script(tmp_path, stack_compose=str(engine), args=COMPOSE_ARGS)

    assert result.returncode == 1, result.stderr
    assert version in result.stderr
