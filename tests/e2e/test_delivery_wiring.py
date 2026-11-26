"""The delivery files agree with the application they deliver.

Nothing here starts a container (that is ``npm run stack:smoke``, opt-in).  It
checks the seams a container build and a compose file depend on and that no
unit test of either side would notice: the commands the files run exist, the
variables they pass are variables the application reads, the images do not run
as root, and the repository carries no secret values and no provider-specific
application code.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml  # a dependency of uvicorn[standard], which the API declares

from e2e_harness import API_DIR, REPO_ROOT, WEB_DIR, clean_env

SKIP_DIRS = {"node_modules", ".git", ".venv", ".next", ".claw-forge", "__pycache__", ".terraform",
             "test-results", "playwright-report", ".pytest_cache"}


def walk(root: Path, suffixes: tuple[str, ...]):
    for directory, names, files in os.walk(root):
        names[:] = [n for n in names if n not in SKIP_DIRS]
        for file in files:
            if file.endswith(suffixes):
                yield Path(directory) / file


def app_source() -> str:
    """Every non-test Python source file of the API, as one string."""
    return "\n".join(
        path.read_text(errors="replace")
        for path in walk(API_DIR / "src", (".py",))
        if "/tests/" not in str(path) and not path.name.startswith("test_")
    )


@pytest.fixture(scope="module")
def compose() -> dict:
    return yaml.safe_load((REPO_ROOT / "compose.yaml").read_text())


# --- compose.yaml ------------------------------------------------------------------


def test_compose_builds_from_files_that_exist(compose):
    for name, service in compose["services"].items():
        build = service.get("build")
        if build:
            context = REPO_ROOT / (build["context"] if isinstance(build, dict) else build)
            dockerfile = context / (build.get("dockerfile", "Dockerfile") if isinstance(build, dict) else "Dockerfile")
            assert dockerfile.is_file(), f"{name}: {dockerfile} does not exist"


def test_compose_runs_entrypoints_that_exist(compose):
    """``python -m <module>`` in a command must name a module that imports."""
    modules = set()
    for name, service in compose["services"].items():
        command = service.get("command")
        if isinstance(command, str):
            command = command.split()
        if command and "-m" in command:
            modules.add(command[command.index("-m") + 1])
    assert {"app.worker", "app.sandbox_service"} <= modules, modules
    for module in sorted(modules):
        found = subprocess.run(
            [sys.executable, "-c", f"import importlib.util, sys; sys.exit(0 if importlib.util.find_spec({module!r}) else 1)"],
            env=clean_env(), capture_output=True, text=True,
        )
        assert found.returncode == 0, f"compose runs `python -m {module}` but it cannot be found: {found.stderr}"


def test_compose_passes_only_settings_the_application_reads(compose):
    source = app_source()
    web_source = "\n".join(p.read_text(errors="replace") for p in walk(WEB_DIR, (".ts", ".tsx", ".js", ".mjs"))
                           if "tests" not in p.parts)
    unread = []
    for name in ("api", "worker", "sandbox", "web"):
        environment = compose["services"][name].get("environment") or {}
        names = environment if isinstance(environment, list) else list(environment)
        for variable in (v.split("=")[0] for v in names):
            haystack = web_source if name == "web" else source
            if variable not in haystack:
                unread.append(f"{name}: {variable}")
    assert not unread, f"compose sets variables nothing reads (a typo, or a setting that was renamed): {unread}"


def test_the_stack_pins_the_backends_it_exists_to_exercise(compose):
    for name in ("api", "worker"):
        environment = compose["services"][name]["environment"]
        assert environment["STORAGE_BACKEND"] == "s3", name
        assert environment["JOBS_MODE"] == "external", name
        # The stack's default database is PostgreSQL (``DATABASE_URL`` may override it).
        assert "postgresql+psycopg://" in environment["DATABASE_URL"], name
    assert "STORAGE_BACKEND" in compose["services"]["sandbox"]["environment"]


# --- ClamAV: a node started from compose.yaml can scan the bundles it is sent --------------


CLAMD_CONF = REPO_ROOT / "deploy" / "compose" / "clamd.conf"


def clamd_settings() -> dict[str, str]:
    """``Option value`` lines of deploy/compose/clamd.conf (comments and blank lines left out)."""
    settings = {}
    for line in CLAMD_CONF.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            key, _, value = line.partition(" ")
            settings[key] = value.strip()
    return settings


def test_api_and_worker_are_pointed_at_the_clamav_service(compose):
    """Without CLAMD_SOCKET every bundle scan reports "antivirus unavailable" and the version
    waits for ever; the stack's own clamav service is what the default names."""
    assert "clamav" in compose["services"], "compose.yaml defines no clamav service"
    for name in ("api", "worker"):
        service = compose["services"][name]
        assert service["environment"].get("CLAMD_SOCKET") == "${CLAMD_SOCKET:-clamav:3310}", name
        # service_started only: a scan that runs before clamd is ready waits and is retried,
        # and podman-compose waits for a healthy dependency with no timeout.
        assert service["depends_on"]["clamav"]["condition"] == "service_started", name


def test_the_clamav_service_keeps_its_signatures_and_publishes_no_port(compose):
    clamav = compose["services"]["clamav"]
    assert clamav["image"] == "${CLAMAV_IMAGE:-docker.io/clamav/clamav:1.4}"
    assert clamav["restart"] == "unless-stopped"
    assert not clamav.get("ports"), f"clamd has no authentication; it must stay on the compose network: {clamav.get('ports')}"
    assert "clamav-db:/var/lib/clamav" in clamav["volumes"], "freshclam's signature database is not on a volume"
    assert "clamav-db" in compose["volumes"]
    # The image's own check, with a start period for the first signature download.
    assert "clamdcheck.sh" in clamav["healthcheck"]["test"]
    start_period = clamav["healthcheck"]["start_period"]
    assert re.fullmatch(r"\d+[ms]", start_period), start_period
    assert int(start_period[:-1]) * (60 if start_period.endswith("m") else 1) >= 300, start_period


def test_the_clamd_config_is_mounted_read_only_and_listens_on_the_stack_network_only(compose):
    mounts = [v for v in compose["services"]["clamav"]["volumes"] if "clamd.conf" in v]
    assert len(mounts) == 1, mounts
    source, target, *options = mounts[0].split(":")
    assert (REPO_ROOT / source).resolve() == CLAMD_CONF, source
    assert target == "/etc/clamav/clamd.conf"
    assert "ro" in ",".join(options).split(","), f"the config must be mounted read-only: {mounts[0]}"

    assert CLAMD_CONF.is_file(), "deploy/compose/clamd.conf does not exist"
    settings = clamd_settings()
    assert settings.get("TCPSocket") == "3310"
    # TCPAddr unset or 0.0.0.0 reaches the other containers; 127.0.0.1 would not.
    assert settings.get("TCPAddr", "0.0.0.0") == "0.0.0.0"
    assert settings.get("Foreground") == "yes"
    # clamd's maximum, so the node's 5 GiB upload limit is the only practical bound.
    for option in ("StreamMaxLength", "MaxScanSize", "MaxFileSize"):
        assert settings.get(option) == "4000M", option
    # The image's entrypoint waits for this socket before it reports clamd started.
    assert settings.get("LocalSocket") == "/run/clamav/clamd.sock"


def test_the_staged_start_brings_clamav_up_before_api_and_worker():
    text = (REPO_ROOT / "scripts" / "stack-up-staged.sh").read_text()
    application = re.search(r"^application=\(([^)]*)\)", text, re.MULTILINE)
    assert application, "stack-up-staged.sh no longer defines the application stage"
    services = application.group(1).split()
    assert "clamav" in services, services
    assert services.index("clamav") < services.index("api") < services.index("worker"), services


def test_images_do_not_run_as_root():
    for containerfile in sorted((REPO_ROOT / "deploy" / "containers").glob("*.Containerfile")):
        users = re.findall(r"^USER\s+(\S+)", containerfile.read_text(), re.MULTILINE)
        assert users, f"{containerfile.name} never drops root"
        assert users[-1] not in {"root", "0"}, f"{containerfile.name} ends as {users[-1]}"


def test_api_image_copies_repository_files_readable_by_its_non_root_user():
    """A checkout built under umask 007 leaves files mode 660, owned by a uid the
    container's user (10001) is not; a RUN chmod -R a+rX over every copied path,
    before USER, makes them readable. Not COPY --chmod=a+rX: podman 4.9's builder
    rejects symbolic modes ("Error parsing chmod a+rX")."""
    containerfile = REPO_ROOT / "deploy" / "containers" / "api.Containerfile"
    lines = [line.strip() for line in _logical_lines(containerfile.read_text())]
    copies = [
        line
        for line in lines
        if re.match(r"^COPY\b", line, re.IGNORECASE) and "--from=" not in line
    ]
    assert copies, "api.Containerfile copies no repository files"
    symbolic = [line for line in copies if re.search(r"--chmod=(?![0-7]+(\s|$))", line)]
    assert not symbolic, f"podman 4.9 cannot build a symbolic COPY --chmod: {symbolic}"
    user_at = next(i for i, line in enumerate(lines) if re.match(r"^USER\b", line, re.IGNORECASE))
    chmods = [line for line in lines[:user_at] if re.match(r"^RUN\s+chmod\s+-R\s+a\+rX\s", line)]
    assert chmods, "no RUN chmod -R a+rX before USER: a umask 007 checkout lands mode 660"
    covered = set(" ".join(chmods).split())
    sources = [
        part
        for line in copies
        for part in [p for p in line.split()[1:] if not p.startswith("--")][:-1]
    ]
    missing = [source for source in sources if source not in covered]
    assert not missing, (
        f"these copied paths stay mode 660 for the image's non-root user: {missing}"
    )
    copied = " ".join(copies)
    for source in ("apps/api/pyproject.toml", "apps/api/uv.lock", "apps/api/packages", "apps/api/src"):
        assert source in copied, f"api.Containerfile no longer copies {source}"


# --- the root package.json -----------------------------------------------------------


def test_the_root_package_json_holds_scripts_only_and_the_default_test_needs_no_containers():
    package = json.loads((REPO_ROOT / "package.json").read_text())
    for forbidden in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        assert forbidden not in package, f"root package.json gained {forbidden}: add dependencies to a workspace"
    assert {"test:pg", "stack:up", "stack:down", "stack:logs", "stack:reset", "stack:smoke",
            "infra:check", "test:system"} <= set(package["scripts"])
    default = package["scripts"]["test"]
    for opt_in in ("podman", "docker", "compose", "tofu", "stack:", "test:pg", "infra:", "test:system", "tests/e2e"):
        assert opt_in not in default, f"`npm test` runs `{opt_in}`; containers are opt-in: {default}"


def test_every_script_a_package_script_runs_exists():
    package = json.loads((REPO_ROOT / "package.json").read_text())
    for name, command in package["scripts"].items():
        for script in re.findall(r"\bbash\s+(\S+)", command):
            assert (REPO_ROOT / script).is_file(), f"npm run {name} runs {script}, which does not exist"


# --- what must not be in the repository --------------------------------------------


SECRET_PATTERNS = {
    "an AWS access key id": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "an Anthropic API key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "a private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),
    "a GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    "a Cloudflare-style API token": re.compile(r"\bcf[a-z]{0,2}_[A-Za-z0-9_-]{30,}"),
}


def test_no_secret_values_are_committed():
    found = []
    candidates = [REPO_ROOT / "compose.yaml", REPO_ROOT / ".env.example"]
    for suffixes in ((".tf", ".tfvars", ".yaml", ".yml", ".sh", ".md", ".example", ".json"),):
        for root in ("infra", "deploy", "scripts", "docs"):
            candidates.extend(walk(REPO_ROOT / root, suffixes))
    for path in candidates:
        if not path.is_file():
            continue
        text = path.read_text(errors="replace")
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                found.append(f"{path.relative_to(REPO_ROOT)}: {label}")
    assert not found, found


def test_env_example_carries_placeholders_not_values():
    text = (REPO_ROOT / ".env.example").read_text()
    assigned = dict(re.findall(r"^\s*([A-Z][A-Z0-9_]*)=(.*)$", text, re.MULTILINE))
    for secret in ("JWT_SECRET", "ORCID_CLIENT_SECRET", "SMTP_URL", "ANTHROPIC_API_KEY", "S3_SECRET_ACCESS_KEY",
                   "SANDBOX_TOKEN", "NODE_KEY", "REVIEW_UNIQUENESS_KEY"):
        value = assigned.get(secret, "").strip()
        assert not value or re.search(r"change|example|placeholder|local|your|xxx", value, re.I), (
            f".env.example sets {secret} to what looks like a real value"
        )
    # Every selector of the cloud-agnostic architecture is documented where an operator will look.
    for selector in ("STORAGE_BACKEND", "JOBS_MODE", "SANDBOX_BACKEND", "S3_BUCKET", "DATABASE_URL"):
        assert selector in text, f".env.example does not mention {selector}"


PROVIDER = re.compile(r"\b(cloudflare|hetzner|aws|amazon|azure|gcp|digitalocean|backblaze|linode|vultr)\b", re.I)
CLOUD_SDKS = {"boto3_only": re.compile(
    r"^\s*(?:import|from)\s+(azure|google|cloudflare|oci|hcloud|digitalocean|aioboto3|s3fs|minio|libcloud)\b",
    re.MULTILINE)}


def test_application_code_is_not_tied_to_a_cloud_provider():
    """No provider SDK but boto3 (as a plain S3 client), no provider names, outside ``infra/``."""
    offenders = []
    for path in walk(REPO_ROOT / "apps", (".py", ".ts", ".tsx", ".js", ".mjs")):
        relative = path.relative_to(REPO_ROOT)
        text = path.read_text(errors="replace")
        if CLOUD_SDKS["boto3_only"].search(text):
            offenders.append(f"{relative}: imports a provider SDK")
        if PROVIDER.search(text):
            offenders.append(f"{relative}: names a cloud provider")
    assert not offenders, offenders

    # boto3 is an S3 *API* client: the only place that imports it is the S3 driver.
    importers = [
        str(p.relative_to(REPO_ROOT)) for p in walk(API_DIR / "src", (".py",))
        if re.search(r"^\s*(?:import|from)\s+(boto3|botocore)\b", p.read_text(errors="replace"), re.MULTILINE)
        and "/tests/" not in str(p) and not p.name.startswith("test_")
    ]
    assert importers == ["apps/api/src/app/storage/s3.py"], importers


# --- infra/: OpenTofu ----------------------------------------------------------------

SECRETISH = re.compile(r"secret|token|password|passphrase|private_key|api_key|credential", re.I)
#: A variable whose name looks secret but which only names something (``token_name``).
NOT_SECRET = {"token_name"}


def tofu_blocks(kind: str):
    """``(file, name, body)`` of every ``variable`` / ``output`` block under ``infra/``."""
    for path in walk(REPO_ROOT / "infra", (".tf",)):
        text = path.read_text()
        for match in re.finditer(rf'^{kind} "([^"]+)" \{{', text, re.MULTILINE):
            depth, index = 1, match.end()
            while depth and index < len(text):
                depth += (text[index] == "{") - (text[index] == "}")
                index += 1
            yield path.relative_to(REPO_ROOT), match.group(1), text[match.end():index - 1]


def test_secret_opentofu_outputs_are_sensitive():
    unmarked = [
        f"{path}: output {name}"
        for path, name, body in tofu_blocks("output")
        if SECRETISH.search(name) and not re.search(r"^\s*sensitive\s*=\s*true", body, re.MULTILINE)
    ]
    assert not unmarked, unmarked
    assert any(SECRETISH.search(name) for _, name, _ in tofu_blocks("output")), "the check found no secret outputs at all"


def test_secret_opentofu_variables_are_sensitive_and_carry_no_value():
    problems = []
    seen = 0
    for path, name, body in tofu_blocks("variable"):
        if not SECRETISH.search(name) or name in NOT_SECRET:
            continue
        seen += 1
        if not re.search(r"^\s*sensitive\s*=\s*true", body, re.MULTILINE):
            problems.append(f"{path}: variable {name} is not sensitive")
        default = re.search(r"^\s*default\s*=\s*(.+)$", body, re.MULTILINE)
        if default and default.group(1).strip() not in {'""', "null"}:
            problems.append(f"{path}: variable {name} has a default value")
    assert seen, "the check found no secret variables at all"
    assert not problems, problems


def _logical_lines(text: str):
    """Join backslash-continued lines, as a shell/Dockerfile parser would."""
    out = []
    buf = ""
    for line in text.splitlines():
        if buf:
            buf += " " + line.strip()
        else:
            buf = line
        if buf.rstrip().endswith("\\"):
            buf = buf.rstrip()[:-1]
            continue
        out.append(buf)
        buf = ""
    if buf:
        out.append(buf)
    return out


def test_delivery_files_do_not_default_to_sqlite():
    for containerfile in sorted((REPO_ROOT / "deploy" / "containers").glob("*.Containerfile")):
        for line in _logical_lines(containerfile.read_text()):
            stripped = line.strip()
            if re.match(r"^(ENV|ARG)\b", stripped, re.I):
                assert "sqlite" not in stripped.lower(), (
                    f"{containerfile.name}: ENV/ARG holds a sqlite URL: {stripped}"
                )
    for line in (REPO_ROOT / ".env.example").read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", stripped):
            assert "sqlite" not in stripped.lower(), (
                f".env.example uncommented KEY=value holds a sqlite URL: {stripped}"
            )
