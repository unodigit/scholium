"""SQLite is deprecated outside tests and local development, and says so once.

The first time a process builds a SQLite engine, ``app.db`` logs one WARNING
through the ``app.db`` logger (the ``logging`` module, not ``warnings.warn``).
The API and the worker build their engines through ``app.db`` and so each log
it at most once per process; a PostgreSQL engine logs nothing.  Only the log
changes: SQLite engines are built exactly as before.
"""

import logging
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from app import db
from app.db import (
    SQLITE_DEPRECATION_MESSAGE,
    build_engine,
    reset_sqlite_deprecation_warning,
)

MESSAGE = (
    "SQLite is deprecated; use PostgreSQL and move existing data with "
    "python -m app.migrate_backend (see docs/deploy.md). "
    "SQLite remains only for tests and local development"
)

POSTGRES_URL = "postgresql://scholium:secret@db.example/scholium"

SRC = Path(__file__).resolve().parents[1] / "src"


@pytest.fixture(autouse=True)
def clean_warning_state(monkeypatch):
    """Start each test with the once-per-process flag cleared, and leave it as found.

    ``app.db`` builds the process's engine on import, so by the time any test
    runs the warning has normally been logged already.  ``monkeypatch`` puts the
    flag back afterwards so these tests never change what later tests see.
    """
    monkeypatch.setattr(db, "_sqlite_warning_logged", db._sqlite_warning_logged)
    reset_sqlite_deprecation_warning()


def _deprecation_records(caplog):
    return [
        record
        for record in caplog.records
        if record.levelno == logging.WARNING and record.getMessage() == MESSAGE
    ]


def test_message_is_the_documented_text():
    assert SQLITE_DEPRECATION_MESSAGE == MESSAGE


def test_two_sqlite_engines_log_exactly_one_warning(caplog):
    with caplog.at_level(logging.DEBUG):
        first = build_engine("sqlite://")
        second = build_engine("sqlite://")

    assert first.dialect.name == second.dialect.name == "sqlite"
    records = _deprecation_records(caplog)
    assert len(records) == 1
    assert records[0].name == "app.db"
    assert records[0].levelno == logging.WARNING
    # Nothing else about SQLite is reported at WARNING or above.
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == records


def test_postgres_engine_logs_no_warning(caplog):
    with caplog.at_level(logging.DEBUG):
        engine = build_engine(POSTGRES_URL)

    assert engine.dialect.name == "postgresql"
    assert _deprecation_records(caplog) == []
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_postgres_engines_do_not_use_up_the_warning(caplog):
    """Building PostgreSQL engines first still leaves the SQLite warning to come."""
    with caplog.at_level(logging.DEBUG):
        build_engine(POSTGRES_URL)
        build_engine(POSTGRES_URL)
        assert _deprecation_records(caplog) == []
        build_engine("sqlite://")
        build_engine(POSTGRES_URL)
        build_engine("sqlite://")

    assert len(_deprecation_records(caplog)) == 1


def test_postgres_scheme_spellings_log_no_warning(caplog):
    with caplog.at_level(logging.DEBUG):
        build_engine("postgres://scholium:secret@db.example/scholium")
        build_engine("postgresql+psycopg://scholium:secret@db.example/scholium")

    assert _deprecation_records(caplog) == []


def test_reset_lets_the_warning_be_logged_again(caplog):
    with caplog.at_level(logging.DEBUG):
        build_engine("sqlite://")
        build_engine("sqlite://")
        assert len(_deprecation_records(caplog)) == 1

        reset_sqlite_deprecation_warning()
        build_engine("sqlite://")
        build_engine("sqlite://")

    assert len(_deprecation_records(caplog)) == 2


def test_reset_is_idempotent_and_logs_nothing(caplog):
    with caplog.at_level(logging.DEBUG):
        reset_sqlite_deprecation_warning()
        reset_sqlite_deprecation_warning()

    assert caplog.records == []


def test_warning_goes_through_logging_not_the_warnings_module(caplog, recwarn):
    with caplog.at_level(logging.DEBUG):
        build_engine("sqlite://")

    assert len(_deprecation_records(caplog)) == 1
    assert [w for w in recwarn.list if "SQLite is deprecated" in str(w.message)] == []


def test_warning_is_not_logged_when_the_engine_cannot_be_built(caplog):
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(Exception):
            build_engine("sqlite+nosuchdriver://")

    assert _deprecation_records(caplog) == []
    # ... and the failed attempt did not use up the once-per-process warning.
    with caplog.at_level(logging.DEBUG):
        build_engine("sqlite://")
    assert len(_deprecation_records(caplog)) == 1


def test_sqlite_engine_options_are_unchanged_by_the_warning():
    engine = build_engine("sqlite://")

    assert engine.dialect.name == "sqlite"
    assert db._engine_options("sqlite:///./scholium.db") == {
        "connect_args": {"check_same_thread": False},
        "future": True,
    }


# --- the api and the worker ------------------------------------------------------


def _imported_process_log(module: str, database_url: str, tmp_path: Path) -> list[str]:
    """The ``name|LEVEL|message`` lines a fresh process logs importing ``module``.

    A new interpreter is the only honest "once per process": it imports the
    program the way ``python -m app`` or ``python -m app.worker`` does and
    builds whatever engine that program builds.
    """
    script = textwrap.dedent(
        f"""
        import logging, sys
        sys.path.insert(0, {str(SRC)!r})
        logging.basicConfig(
            level=logging.DEBUG, stream=sys.stdout, format="%(name)s|%(levelname)s|%(message)s"
        )
        import {module}
        """
    )
    env = dict(__import__("os").environ, DATABASE_URL=database_url)
    done = subprocess.run(
        [sys.executable, "-I", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.splitlines()


@pytest.mark.parametrize("module", ["app.main", "app.worker"])
def test_api_and_worker_each_log_the_warning_once_for_sqlite(module, tmp_path):
    lines = _imported_process_log(module, f"sqlite:///{tmp_path / 'one.db'}", tmp_path)

    assert lines.count(f"app.db|WARNING|{MESSAGE}") == 1
    assert [line for line in lines if "SQLite is deprecated" in line] == [
        f"app.db|WARNING|{MESSAGE}"
    ]


def test_api_and_worker_take_their_engine_from_app_db():
    """Both programs use ``app.db``'s engine, so ``build_engine`` is the one place that warns."""
    from app import main, worker

    assert main.db is db
    assert worker.db is db


def test_postgres_process_logs_no_warning_when_app_db_builds_its_engine(tmp_path):
    """``app.db`` builds the API's and the worker's engine when it is imported.

    Importing ``app.main`` or ``app.worker`` as well would create tables, which
    needs a live PostgreSQL server; ``app.db`` alone builds the same engine
    without connecting.
    """
    lines = _imported_process_log("app.db", POSTGRES_URL, tmp_path)

    assert [line for line in lines if "SQLite is deprecated" in line] == []
