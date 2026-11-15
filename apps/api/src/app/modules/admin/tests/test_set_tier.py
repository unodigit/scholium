"""``python -m app.modules.admin set-tier <did> <tier>`` (feature 128)."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import admin
from app.modules import identity
from app.modules.admin import InvalidDid
from app.modules.admin.cli import main
from app.modules.identity import Account, ensure_account_table
from app.security import Tier

SRC = Path(__file__).resolve().parents[4]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _tier_of(did: str) -> int | None:
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        return None if account is None else account.tier


def _created_at(did: str) -> datetime:
    with db.SessionLocal() as session:
        return session.get(Account, did).created_at


def _make_account(did: str, tier: int = 0, created_at: datetime | None = None) -> None:
    ensure_account_table()
    with db.SessionLocal() as session:
        session.add(Account(did=did, tier=tier, created_at=created_at or _utcnow()))
        session.commit()


@pytest.fixture
def other_did() -> str:
    return did_key_from_signing_key(SigningKey.generate())


# --- the command ------------------------------------------------------------


def test_updates_the_account_and_prints_the_new_tier(did, capsys):
    _make_account(did, tier=0)

    assert main(["set-tier", did, "3"]) == 0

    out = capsys.readouterr()
    assert _tier_of(did) == 3
    assert out.out == f"{did} tier 3 (Reviewer)\n"
    assert out.err == ""


@pytest.mark.parametrize("tier", list(Tier))
def test_every_tier_can_be_set_by_number(did, tier, capsys):
    _make_account(did, tier=1 if tier != 1 else 2)

    assert main(["set-tier", did, str(int(tier))]) == 0

    assert _tier_of(did) == int(tier)
    assert f"tier {int(tier)} ({tier.label})" in capsys.readouterr().out


@pytest.mark.parametrize("spelling", ["moderator", "Moderator", "MODERATOR"])
def test_a_tier_can_be_set_by_name(did, spelling, capsys):
    _make_account(did)

    assert main(["set-tier", did, spelling]) == 0

    assert _tier_of(did) == 4
    assert "tier 4 (Moderator)" in capsys.readouterr().out


def test_demotion_works(did):
    _make_account(did, tier=4)

    assert main(["set-tier", did, "0"]) == 0

    assert _tier_of(did) == 0


def test_only_the_named_account_changes_and_created_at_is_kept(did, other_did):
    created = _utcnow() - timedelta(days=40)
    _make_account(did, tier=1, created_at=created)
    _make_account(other_did, tier=2)

    assert main(["set-tier", did, "3"]) == 0

    assert _tier_of(did) == 3
    assert _created_at(did) == created
    assert _tier_of(other_did) == 2


def test_setting_the_same_tier_again_is_fine(did, capsys):
    _make_account(did, tier=2)

    assert main(["set-tier", did, "2"]) == 0

    assert _tier_of(did) == 2
    assert "tier 2 (Author)" in capsys.readouterr().out


def test_a_did_that_has_not_signed_in_gets_an_account_at_that_tier(did, capsys):
    ensure_account_table()
    assert _tier_of(did) is None

    before = _utcnow()
    assert main(["set-tier", did, "4"]) == 0

    out = capsys.readouterr()
    assert _tier_of(did) == 4
    assert before <= _created_at(did) <= _utcnow()
    assert out.out == f"{did} tier 4 (Moderator)\n"
    assert "has not signed in yet" in out.err


# --- rejected input writes nothing ------------------------------------------


@pytest.mark.parametrize("tier", ["5", "-1", "10", "", "  ", "root", "2.0", "True", "None"])
def test_a_bad_tier_is_a_usage_error_and_changes_nothing(did, tier, capsys):
    _make_account(did, tier=1)

    with pytest.raises(SystemExit) as exit_info:
        main(["set-tier", did, tier])

    assert exit_info.value.code == 2
    assert "not a trust tier" in capsys.readouterr().err
    assert _tier_of(did) == 1


@pytest.mark.parametrize(
    "bad_did",
    [
        "alice",
        "did:key:nope",
        # A valid did:key, but secp256k1 rather than Ed25519.
        "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",
    ],
)
def test_a_bad_did_is_a_usage_error(bad_did, capsys):
    ensure_account_table()

    with pytest.raises(SystemExit) as exit_info:
        main(["set-tier", bad_did, "1"])

    assert exit_info.value.code == 2
    assert "did:key" in capsys.readouterr().err
    assert _tier_of(bad_did) is None


def _exit_code(argv: list[str]) -> int:
    try:
        return main(argv)
    except SystemExit as exc:  # argparse reports usage errors this way
        return exc.code


@pytest.mark.parametrize("argv", [[], ["set-tier"], ["set-tier", "did:key:x"], ["unknown"]])
def test_missing_or_unknown_arguments_exit_2(argv):
    assert _exit_code(argv) == 2


# --- the service ------------------------------------------------------------


def test_set_tier_reports_what_changed(did):
    _make_account(did, tier=1)

    change = admin.set_tier(did, 3)

    assert (change.did, change.previous_tier, change.tier, change.created) == (did, 1, 3, False)


def test_set_tier_reports_a_created_account(did):
    change = admin.set_tier(did, "author")

    assert (change.previous_tier, change.tier, change.created) == (None, 2, True)
    assert _tier_of(did) == 2


def test_set_tier_rejects_an_invalid_did_without_writing():
    with pytest.raises(InvalidDid):
        admin.set_tier("did:key:nope", 1)


@pytest.mark.parametrize("bad", [5, -1, True, 2.5, None, "x"])
def test_set_tier_rejects_an_invalid_tier_without_writing(did, bad):
    ensure_account_table()

    with pytest.raises(ValueError):
        admin.set_tier(did, bad)

    assert _tier_of(did) is None


def test_set_tier_survives_a_concurrent_first_sign_in(did, monkeypatch):
    """A first sign-in wins the insert race: the row exists, so retry as an update."""
    ensure_account_table()
    real_apply = admin.service._apply
    calls = []

    def colliding_apply(did_, tier):
        calls.append(tier)
        if len(calls) == 1:
            _make_account(did_, tier=0)  # the concurrent sign-in's row
            raise IntegrityError("INSERT INTO accounts", {}, Exception("UNIQUE constraint failed"))
        return real_apply(did_, tier)

    monkeypatch.setattr(admin.service, "_apply", colliding_apply)

    change = admin.set_tier(did, 3)

    assert len(calls) == 2
    assert (change.previous_tier, change.tier) == (0, 3)
    assert _tier_of(did) == 3


# --- as a real process ------------------------------------------------------


# Runs the CLI the way ``python -m`` does, optionally with the scholium_record_core
# workspace package made unimportable (as in a plain ``uv run`` without --all-packages).
_LAUNCHER = """
import runpy, sys
if sys.argv[1] == "hide-record-core":
    sys.modules["scholium_record_core"] = None  # makes `import scholium_record_core` fail
sys.argv = ["python -m app.modules.admin", *sys.argv[2:]]
runpy.run_module("app.modules.admin", run_name="__main__", alter_sys=True)
"""


def _run(*args: str, database: Path, hide_record_core: bool = False) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "DATABASE_URL": f"sqlite:///{database}",
        "PYTHONPATH": os.pathsep.join([str(SRC), os.environ.get("PYTHONPATH", "")]),
    }
    mode = "hide-record-core" if hide_record_core else "normal"
    return subprocess.run(
        [sys.executable, "-c", _LAUNCHER, mode, *args],
        env=env,
        cwd=database.parent,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_runs_as_python_dash_m(did, tmp_path):
    database = tmp_path / "admin.db"

    first = _run("set-tier", did, "2", database=database)
    second = _run("set-tier", did, "reviewer", database=database)

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    assert second.stdout == f"{did} tier 3 (Reviewer)\n"
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT tier FROM accounts WHERE did = ?", (did,)).fetchall() == [(3,)]


def test_exit_status_is_2_for_a_bad_tier_when_run_as_a_process(did, tmp_path):
    result = _run("set-tier", did, "9", database=tmp_path / "admin.db")

    assert result.returncode == 2
    assert "not a trust tier" in result.stderr
    assert result.stdout == ""


def test_works_without_the_record_core_workspace_package(did, tmp_path):
    """``uv run python -m app.modules.admin`` does not install workspace members."""
    database = tmp_path / "admin.db"

    result = _run("set-tier", did, "4", database=database, hide_record_core=True)

    assert result.returncode == 0, result.stderr
    assert result.stdout == f"{did} tier 4 (Moderator)\n"
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT tier FROM accounts WHERE did = ?", (did,)).fetchall() == [(4,)]


def test_the_hiding_trick_really_blocks_the_identity_plugin(tmp_path):
    """Guards the test above: importing identity must fail when record-core is hidden."""
    env = {**os.environ, "PYTHONPATH": str(SRC), "DATABASE_URL": f"sqlite:///{tmp_path / 'x.db'}"}
    code = "import sys; sys.modules['scholium_record_core'] = None; import app.modules.identity"
    result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=60)

    assert result.returncode != 0
    assert "scholium_record_core" in result.stderr


# --- the local mirrors stay in step with the identity plugin ----------------


def test_validate_did_agrees_with_the_identity_plugin(did, other_did):
    samples = [
        did,
        other_did,
        "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",  # secp256k1
        "did:key:nope",
        "did:key:z",
        "did:key:z0OIl",  # characters outside base58btc
        "did:key:" + did[len("did:key:") :],
        did + "x",
        did[:-1],
        did.replace("did:key:z", "did:key:f"),
        did.upper(),
        "did:web:example.com",
        "",
        "alice",
        None,
        42,
        b"did:key:z6Mk",
    ]
    for sample in samples:
        try:
            identity.validate_did(sample)
            expected = True
        except identity.InvalidDid:
            expected = False
        try:
            admin.validate_did(sample)
            actual = True
        except InvalidDid:
            actual = False
        assert actual == expected, f"validate_did disagrees on {sample!r}: admin={actual}, identity={expected}"
    assert admin.validate_did(did) == did


def test_accounts_table_mirrors_the_identity_model():
    def shape(table):
        return {
            c.name: (type(c.type), c.primary_key, c.nullable, str(c.server_default.arg) if c.server_default else None)
            for c in table.columns
        }

    assert admin.service.accounts.name == Account.__table__.name
    assert shape(admin.service.accounts) == shape(Account.__table__)
