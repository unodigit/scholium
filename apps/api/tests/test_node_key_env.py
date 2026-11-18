"""``NODE_KEY``: the node signing key supplied through the environment.

``Settings`` writes a ``NODE_KEY`` to an owner-only file in a private runtime
directory and points ``NODE_KEY_PATH`` at it, so every reader of the key file
keeps working.  The value must never reach a log line, a ``repr`` or an error
message, and production refuses a ``NODE_KEY`` that is not an Ed25519 key.
"""

from __future__ import annotations

import base64
import logging
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from nacl.signing import SigningKey

import app.settings as settings_module
from app.modules.ledger.origin import did_key_from_public_key, node_did, node_signing_key
from app.settings import Settings

SEED = bytes(range(32))
SIGNING_KEY = SigningKey(SEED)
PUBLIC_KEY = bytes(SIGNING_KEY.verify_key)

#: A different valid key, to tell two provisioned files apart.
OTHER_SEED = bytes(range(100, 132))

#: Distinctive and not a key, so a leak is unmistakable in any output.
SENTINEL = "SENTINEL-not-a-node-key-7f3a9c"


@pytest.fixture(autouse=True)
def private_runtime(monkeypatch, tmp_path):
    """Give each test its own key directory, under ``tmp_path``, cleaned up after."""
    runtime = tmp_path / "tmp"
    runtime.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(runtime))
    monkeypatch.setattr(settings_module, "_node_key_dir", None)
    monkeypatch.setattr(settings_module, "_node_key_dir_pid", None)
    monkeypatch.setattr(settings_module, "_node_key_files", {})
    monkeypatch.delenv("NODE_KEY", raising=False)
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    yield
    created = settings_module._node_key_dir
    if created:
        shutil.rmtree(created, ignore_errors=True)


def _mode(path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def _settings_with(monkeypatch, value: str) -> Settings:
    monkeypatch.setenv("NODE_KEY", value)
    return Settings()


def _production(monkeypatch, tmp_path, **overrides) -> Settings:
    """A production Settings with every requirement met except the node key."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    prod = Settings()
    prod.SCHOLIUM_ENV = "production"
    prod.JWT_SECRET = "x" * 48
    prod.ORCID_MOCK = 0
    prod.ARXIV_MOCK = 0
    prod.AI_PROVIDER = "ollama"
    prod.JOBS_EAGER = 0
    prod.WEB_ORIGINS = "https://scholium.example"
    prod.NEXT_PUBLIC_API_URL = "https://api.scholium.example"
    prod.COMMITTEE_PUBLIC_KEY = "ab" * 32
    prod.SMTP_URL = "smtp://mail.example.org:587"
    prod.ORCID_CLIENT_ID = "client-id"
    prod.ORCID_CLIENT_SECRET = "client-secret"
    prod.REVIEW_UNIQUENESS_KEY = "r" * 48
    prod.RATE_LIMIT_ENABLED = 1
    prod.DATABASE_URL = "postgresql+psycopg://scholium:scholium@db.example.org:5432/scholium"
    prod.STORAGE_BACKEND = "s3"
    prod.S3_BUCKET = "scholium-production"
    prod.S3_ACCESS_KEY_ID = "AKIAPLACEHOLDERPROD"
    prod.S3_SECRET_ACCESS_KEY = "production-placeholder-secret"
    prod.NODE_KEY_PATH = str(tmp_path / "absent.key")
    for name, value in overrides.items():
        setattr(prod, name, value)
    return prod


# --------------------------------------------------------------------------
# Formats: every key-file format that can travel in an environment variable
# --------------------------------------------------------------------------

FORMATS = {
    "hex seed": SEED.hex(),
    "uppercase hex seed": SEED.hex().upper(),
    "base64 seed": base64.b64encode(SEED).decode(),
    "hex secret key": (SEED + PUBLIC_KEY).hex(),
    "base64 secret key": base64.b64encode(SEED + PUBLIC_KEY).decode(),
    "hex seed with a trailing newline": SEED.hex() + "\n",
    "hex seed with surrounding spaces": "  " + SEED.hex() + "  ",
    # bytes.fromhex ignores inner whitespace, and so does the key-file reader.
    "hex seed wrapped over two lines": SEED.hex()[:32] + "\n" + SEED.hex()[32:],
}


@pytest.mark.parametrize("value", FORMATS.values(), ids=FORMATS.keys())
def test_node_key_is_written_to_a_file_every_reader_can_use(monkeypatch, value):
    s = _settings_with(monkeypatch, value)

    key = node_signing_key(s.NODE_KEY_PATH)
    assert key is not None
    assert bytes(key.verify_key) == PUBLIC_KEY
    assert node_did(s.NODE_KEY_PATH) == did_key_from_public_key(PUBLIC_KEY)


def test_readers_that_use_the_settings_path_see_the_key(monkeypatch):
    """Readers call ``node_signing_key()`` with no argument: they follow ``NODE_KEY_PATH``."""
    s = _settings_with(monkeypatch, SEED.hex())
    monkeypatch.setattr("app.modules.ledger.origin.settings", s)

    key = node_signing_key()
    assert key is not None and bytes(key.verify_key) == PUBLIC_KEY
    monkeypatch.delenv("NODE_DID", raising=False)
    monkeypatch.delenv("ORIGIN_NODE", raising=False)
    monkeypatch.delenv("SCHOLIUM_NODE_DID", raising=False)
    assert node_did() == did_key_from_public_key(PUBLIC_KEY)


def test_the_file_holds_the_key_in_the_format_it_was_given(monkeypatch):
    s = _settings_with(monkeypatch, SEED.hex())
    assert Path(s.NODE_KEY_PATH).read_text().strip() == SEED.hex()


# --------------------------------------------------------------------------
# Where and how the file is written
# --------------------------------------------------------------------------


def test_the_file_is_owner_only_in_a_private_directory(monkeypatch):
    s = _settings_with(monkeypatch, SEED.hex())
    path = Path(s.NODE_KEY_PATH)

    assert path.is_file()
    assert _mode(path) == 0o600
    assert path.stat().st_uid == os.geteuid()
    assert _mode(path.parent) == 0o700
    assert path.parent.stat().st_uid == os.geteuid()


@pytest.mark.parametrize("umask", [0o000, 0o022, 0o277])
def test_the_modes_do_not_depend_on_the_umask(monkeypatch, umask):
    previous = os.umask(umask)
    try:
        s = _settings_with(monkeypatch, SEED.hex())
    finally:
        os.umask(previous)

    assert _mode(s.NODE_KEY_PATH) == 0o600
    assert _mode(Path(s.NODE_KEY_PATH).parent) == 0o700
    assert node_signing_key(s.NODE_KEY_PATH) is not None


def test_the_directory_is_not_a_predictable_location(monkeypatch, tmp_path):
    first = _settings_with(monkeypatch, SEED.hex())
    directory = Path(first.NODE_KEY_PATH).parent
    assert directory.parent == tmp_path / "tmp"
    assert directory.name.startswith("scholium-node-key-")
    assert directory.name != "scholium-node-key-"


def test_a_private_xdg_runtime_dir_is_preferred(monkeypatch, tmp_path):
    runtime = tmp_path / "run-user"
    runtime.mkdir(mode=0o700)
    runtime.chmod(0o700)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))

    s = _settings_with(monkeypatch, SEED.hex())

    assert Path(s.NODE_KEY_PATH).parent.parent == runtime
    assert _mode(Path(s.NODE_KEY_PATH).parent) == 0o700


def test_a_shared_xdg_runtime_dir_is_not_used(monkeypatch, tmp_path):
    runtime = tmp_path / "run-shared"
    runtime.mkdir()
    runtime.chmod(0o755)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))

    s = _settings_with(monkeypatch, SEED.hex())

    assert Path(s.NODE_KEY_PATH).parent.parent == tmp_path / "tmp"
    assert list(runtime.iterdir()) == []


def test_settings_built_twice_share_one_file_per_key(monkeypatch):
    first = _settings_with(monkeypatch, SEED.hex())
    again = _settings_with(monkeypatch, SEED.hex())
    other = _settings_with(monkeypatch, OTHER_SEED.hex())

    assert first.NODE_KEY_PATH == again.NODE_KEY_PATH
    assert other.NODE_KEY_PATH != first.NODE_KEY_PATH
    # The first settings object still reads its own key, not the later one's.
    assert bytes(node_signing_key(first.NODE_KEY_PATH).verify_key) == PUBLIC_KEY
    assert bytes(node_signing_key(other.NODE_KEY_PATH).verify_key) == bytes(
        SigningKey(OTHER_SEED).verify_key
    )


def test_a_removed_file_is_written_again(monkeypatch):
    first = _settings_with(monkeypatch, SEED.hex())
    os.unlink(first.NODE_KEY_PATH)

    again = _settings_with(monkeypatch, SEED.hex())

    assert os.path.isfile(again.NODE_KEY_PATH)
    assert node_signing_key(again.NODE_KEY_PATH) is not None


def test_a_removed_directory_is_made_again(monkeypatch):
    first = _settings_with(monkeypatch, SEED.hex())
    shutil.rmtree(Path(first.NODE_KEY_PATH).parent)

    again = _settings_with(monkeypatch, SEED.hex())

    assert node_signing_key(again.NODE_KEY_PATH) is not None
    assert _mode(Path(again.NODE_KEY_PATH).parent) == 0o700


def test_the_file_is_removed_when_the_process_exits(tmp_path):
    src = Path(settings_module.__file__).resolve().parents[1]
    code = (
        "import os, stat\n"
        "from app.settings import settings\n"
        "from app.modules.ledger.origin import node_did\n"
        "p = settings.NODE_KEY_PATH\n"
        "print(p)\n"
        "print(oct(stat.S_IMODE(os.stat(p).st_mode)))\n"
        "print(node_did())\n"
    )
    env = {
        **os.environ,
        "PYTHONPATH": str(src),
        "NODE_KEY": SEED.hex(),
        "TMPDIR": str(tmp_path),
        "NODE_KEY_PATH": str(tmp_path / "ignored.key"),
    }
    for name in ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID", "XDG_RUNTIME_DIR"):
        env.pop(name, None)
    done = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120
    )

    assert done.returncode == 0, done.stderr
    path, mode, did = done.stdout.split()
    assert Path(path).parent.parent == tmp_path
    assert mode == "0o600"
    assert did == did_key_from_public_key(PUBLIC_KEY)
    assert not Path(path).exists(), "the key file outlived the process"
    assert not Path(path).parent.exists(), "the private directory outlived the process"
    assert SEED.hex() not in done.stdout + done.stderr


# --------------------------------------------------------------------------
# Precedence
# --------------------------------------------------------------------------


def test_node_key_takes_precedence_over_node_key_path(monkeypatch, tmp_path):
    on_disk = tmp_path / "node.key"
    on_disk.write_text(OTHER_SEED.hex())
    monkeypatch.setenv("NODE_KEY_PATH", str(on_disk))

    s = _settings_with(monkeypatch, SEED.hex())

    assert s.NODE_KEY_PATH != str(on_disk)
    assert bytes(node_signing_key(s.NODE_KEY_PATH).verify_key) == PUBLIC_KEY
    assert on_disk.read_text() == OTHER_SEED.hex(), "the operator's own key file is never touched"


@pytest.mark.parametrize("value", ["", "   ", "\n"])
def test_an_empty_node_key_changes_nothing(monkeypatch, tmp_path, value):
    path = tmp_path / "node.key"
    monkeypatch.setenv("NODE_KEY_PATH", str(path))

    s = _settings_with(monkeypatch, value)

    assert s.NODE_KEY_PATH == str(path)
    assert settings_module._node_key_dir is None, "no directory is made for a key that is not set"


def test_without_node_key_the_path_setting_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.setenv("NODE_KEY_PATH", str(tmp_path / "node.key"))
    assert Settings().NODE_KEY_PATH == str(tmp_path / "node.key")
    monkeypatch.delenv("NODE_KEY_PATH")
    assert Settings().NODE_KEY_PATH == "./data/node.key"


# --------------------------------------------------------------------------
# Production validation
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", FORMATS.values(), ids=FORMATS.keys())
def test_production_accepts_a_node_key_with_no_key_file(monkeypatch, tmp_path, value):
    prod = _production(monkeypatch, tmp_path, NODE_KEY=value)
    assert not Path(prod.NODE_KEY_PATH).exists() or prod.NODE_KEY_PATH != str(tmp_path / "absent.key")

    prod.validate_for_environment()

    assert node_signing_key(prod.NODE_KEY_PATH) is not None


def test_production_accepts_a_node_key_read_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("NODE_KEY", SEED.hex())
    monkeypatch.setenv("NODE_KEY_PATH", str(tmp_path / "absent.key"))
    prod = _production(monkeypatch, tmp_path, NODE_KEY_PATH=Settings().NODE_KEY_PATH)

    prod.validate_for_environment()


BAD_KEYS = {
    "not hex or base64": SENTINEL,
    "a short word": "not-a-key",
    "31 bytes of hex": "00" * 31,
    "33 bytes of hex": "00" * 33,
    "65 bytes of hex": "00" * 65,
    "31 bytes of base64": base64.b64encode(bytes(range(31))).decode(),
    "odd-length hex": "0" * 63,
    # 32 printable characters: the key-file loader would take these as a raw seed.
    "32 raw characters": "this-is-not-hex-or-b64-key!!!!!",
    "non-ascii text": "kéy" * 20,
}


@pytest.mark.parametrize("value", BAD_KEYS.values(), ids=BAD_KEYS.keys())
def test_production_rejects_a_node_key_that_is_not_an_ed25519_key(monkeypatch, tmp_path, value):
    prod = _production(monkeypatch, tmp_path, NODE_KEY=value)

    with pytest.raises(RuntimeError) as err:
        prod.validate_for_environment()

    message = str(err.value)
    assert "NODE_KEY must hold a valid Ed25519 key" in message, message
    assert value.strip() not in message
    assert value.strip() not in repr(err.value)


def test_a_bad_node_key_is_rejected_even_when_a_key_file_exists(monkeypatch, tmp_path):
    """Falling back to NODE_KEY_PATH would run a node on a key the operator did not choose."""
    on_disk = tmp_path / "node.key"
    on_disk.write_text(SEED.hex())
    prod = _production(monkeypatch, tmp_path, NODE_KEY_PATH=str(on_disk), NODE_KEY=SENTINEL)

    with pytest.raises(RuntimeError) as err:
        prod.validate_for_environment()

    assert "NODE_KEY must hold a valid Ed25519 key" in str(err.value)


def test_a_bad_node_key_never_reaches_the_key_file(monkeypatch):
    s = _settings_with(monkeypatch, SENTINEL)

    assert s.NODE_KEY_PATH == "./data/node.key" or s.NODE_KEY_PATH == os.environ["NODE_KEY_PATH"]
    assert settings_module._node_key_dir is None
    assert s.apply_node_key() is False


def test_a_bad_node_key_is_reported_alongside_every_other_problem(monkeypatch, tmp_path):
    prod = _production(
        monkeypatch, tmp_path, NODE_KEY=SENTINEL, SMTP_URL="", JWT_SECRET="change-me-in-production"
    )

    with pytest.raises(RuntimeError) as err:
        prod.validate_for_environment()

    message = str(err.value)
    for name in ("NODE_KEY must", "SMTP_URL", "JWT_SECRET"):
        assert name in message, message
    assert SENTINEL not in message


def test_dev_does_not_refuse_a_bad_node_key(monkeypatch):
    s = _settings_with(monkeypatch, SENTINEL)
    s.validate_for_environment()


def test_production_without_any_node_key_still_requires_the_key_file(monkeypatch, tmp_path):
    prod = _production(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError) as err:
        prod.validate_for_environment()

    assert "NODE_KEY_PATH must point at an existing node key file" in str(err.value)


def test_production_validation_provisions_a_node_key_assigned_after_construction(monkeypatch, tmp_path):
    prod = _production(monkeypatch, tmp_path)
    prod.NODE_KEY = SEED.hex()

    prod.validate_for_environment()

    assert prod.NODE_KEY_PATH != str(tmp_path / "absent.key")
    assert _mode(prod.NODE_KEY_PATH) == 0o600


def test_production_reports_a_key_file_that_cannot_be_written(monkeypatch, tmp_path):
    def refuse(*args, **kwargs):
        raise PermissionError(13, "Permission denied", str(tmp_path / "tmp"))

    monkeypatch.setattr(tempfile, "mkdtemp", refuse)
    prod = _production(monkeypatch, tmp_path, NODE_KEY=SEED.hex())

    with pytest.raises(RuntimeError) as err:
        prod.validate_for_environment()

    message = str(err.value)
    assert "NODE_KEY could not be written to a private key file" in message, message
    assert SEED.hex() not in message


# --------------------------------------------------------------------------
# The value never leaks
# --------------------------------------------------------------------------

SECRETS = {
    "a valid hex key": SEED.hex(),
    "a valid base64 key": base64.b64encode(SEED).decode(),
    "a valid secret key": (SEED + PUBLIC_KEY).hex(),
    "an invalid key": SENTINEL,
}


@pytest.mark.parametrize("value", SECRETS.values(), ids=SECRETS.keys())
def test_node_key_is_not_in_repr_or_str(monkeypatch, value):
    s = _settings_with(monkeypatch, value)

    for text in (repr(s), str(s), f"{s}", f"{s!r}"):
        assert value not in text
        assert "NODE_KEY=" not in text.replace("NODE_KEY_PATH=", "")
    assert s.NODE_KEY == value, "the attribute itself is still there for code that needs it"


@pytest.mark.parametrize("value", SECRETS.values(), ids=SECRETS.keys())
def test_node_key_is_not_logged(monkeypatch, caplog, capsys, value):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("NODE_KEY_PATH", "/somewhere/else.key")

    s = _settings_with(monkeypatch, value)
    s.apply_node_key()

    out = capsys.readouterr()
    for text in (caplog.text, out.out, out.err):
        assert value not in text
        assert value.strip() not in text


def test_node_key_is_not_logged_when_the_file_cannot_be_written(monkeypatch, caplog, capsys):
    caplog.set_level(logging.DEBUG)

    def refuse(*args, **kwargs):
        raise PermissionError(13, "Permission denied", "/private/dir")

    monkeypatch.setattr(tempfile, "mkdtemp", refuse)

    s = _settings_with(monkeypatch, SEED.hex())

    assert s.NODE_KEY_PATH != ""
    out = capsys.readouterr()
    assert "could not be written" in caplog.text
    for text in (caplog.text, out.out, out.err):
        assert SEED.hex() not in text


def test_a_write_that_fails_leaves_no_partial_key_behind(monkeypatch):
    real_fdopen = os.fdopen

    def failing_fdopen(fd, *args, **kwargs):
        handle = real_fdopen(fd, *args, **kwargs)

        def boom(_data):
            raise OSError(28, "No space left on device")

        handle.write = boom
        return handle

    monkeypatch.setattr(os, "fdopen", failing_fdopen)

    with pytest.raises(OSError):
        _settings_with(monkeypatch, SEED.hex()).apply_node_key()

    directory = settings_module._node_key_dir
    assert directory is not None and os.listdir(directory) == []


def test_the_value_does_not_appear_in_the_production_error_for_a_valid_key(monkeypatch, tmp_path):
    prod = _production(monkeypatch, tmp_path, NODE_KEY=SEED.hex(), SMTP_URL="")

    with pytest.raises(RuntimeError) as err:
        prod.validate_for_environment()

    assert "SMTP_URL" in str(err.value)
    assert SEED.hex() not in str(err.value)
    assert SEED.hex() not in repr(err.value)
