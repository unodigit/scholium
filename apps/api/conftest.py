"""Root pytest configuration: hermetic, per-worker state for every test path.

Runs before any test module imports ``app`` (settings are read at import time),
so tests under src/, packages/ and tests/ never share a database, content
directory or node key between xdist workers or with a developer's local data.

``TEST_DATABASE_URL`` selects a PostgreSQL test lane (``npm run test:pg`` sets
it, and CI exports it).  Every xdist worker then gets a database of its own on
that server -- ``scholium_test_<run token>_<worker>``, for example
``scholium_test_3f9a1c_gw0`` -- which is dropped again when the worker exits.
The random per-run token keeps concurrent runs on one machine (or against one
shared server) from ever meeting in the same database.  With the variable
unset nothing changes: each worker keeps its own throwaway SQLite file.
"""

import atexit
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path

import pytest

_worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
_state = Path(tempfile.mkdtemp(prefix=f"scholium-test-{_worker}-"))

#: The server a PostgreSQL test lane points pytest at. ``npm run test:pg`` and
#: CI set it; every other run leaves it unset and stays on SQLite.
_TEST_DATABASE_URL = (os.environ.get("TEST_DATABASE_URL") or "").strip()

#: Environment variable carrying the random token shared by every worker of one
#: run. The pytest controller sets it before xdist spawns its workers (they
#: inherit the controller's environment), and ``scripts/test-pg.sh`` sets it for
#: the whole run, so all workers of one invocation use the same token.
_RUN_TOKEN_ENV = "SCHOLIUM_TEST_RUN_TOKEN"

#: ``(admin URL, database name)`` when this process provisioned a database.
_postgres_database: "tuple[str, str] | None" = None


def _normalise_postgres_url(url: str) -> str:
    """Rewrite ``postgres://``/``postgresql://`` to the psycopg (v3) driver.

    The same normalisation ``app.db`` applies; keeping it local means the test
    harness can create databases before importing any application module.
    """
    for scheme in ("postgres://", "postgresql://"):
        if url.startswith(scheme):
            return "postgresql+psycopg://" + url[len(scheme):]
    return url


def _redacted(url: str) -> str:
    """``url`` without its password, for an error message that may be logged."""
    from sqlalchemy.engine import make_url

    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return "<unparsable database URL>"


def _run_token() -> str:
    """The per-run token, generated once and shared with child processes."""
    token = os.environ.get(_RUN_TOKEN_ENV, "").strip()
    if not re.fullmatch(r"[0-9a-f]{6,12}", token):
        token = secrets.token_hex(3)
        os.environ[_RUN_TOKEN_ENV] = token
    return token


def _worker_database_name(worker: str, token: str) -> str:
    """``scholium_test_<token>_<worker>``; PostgreSQL's 63-byte limit is ample."""
    suffix = re.sub(r"[^a-z0-9]+", "", worker.lower()) or "gw0"
    return f"scholium_test_{token}_{suffix}"


def _admin_engine(url: str):
    """An AUTOCOMMIT engine for ``CREATE DATABASE`` / ``DROP DATABASE``."""
    from sqlalchemy import create_engine

    return create_engine(url, isolation_level="AUTOCOMMIT", future=True)


def _drop_worker_database() -> None:
    """Drop this process's database, best effort, at interpreter exit."""
    global _postgres_database
    connection_info, _postgres_database = _postgres_database, None
    if connection_info is None:
        return
    admin_url, name = connection_info
    try:
        from sqlalchemy import text

        # Close the application's pooled connections first; anything still open
        # is terminated by WITH (FORCE) below.
        try:
            from app import db as app_db

            app_db.engine.dispose()
        except Exception:
            pass
        admin = _admin_engine(admin_url)
        try:
            with admin.connect() as connection:
                connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        except Exception:
            # WITH (FORCE) needs PostgreSQL 13+; plain DROP still removes an
            # idle database, and a database left behind cannot collide with a
            # later run because the token is random.
            try:
                with admin.connect() as connection:
                    connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
            except Exception:
                pass
        finally:
            admin.dispose()
    except Exception:
        pass


def _prepare_postgres_database() -> str:
    """Create this worker's database on ``TEST_DATABASE_URL``'s server.

    Returns the URL pointing at it.  Only PostgreSQL gets a database per
    worker; any other ``TEST_DATABASE_URL`` is used verbatim, since there is
    nothing to provision on e.g. SQLite.
    """
    global _postgres_database
    from sqlalchemy import text
    from sqlalchemy.engine import make_url

    base = _normalise_postgres_url(_TEST_DATABASE_URL)
    if make_url(base).get_backend_name() != "postgresql":
        return base

    name = _worker_database_name(_worker, _run_token())
    admin = _admin_engine(base)
    try:
        with admin.connect() as connection:
            exists = connection.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :name"),
                {"name": name},
            ).scalar()
            if not exists:
                # The identifier is generated here and quoted, never user input.
                connection.execute(text(f'CREATE DATABASE "{name}"'))
    except Exception as exc:
        raise RuntimeError(
            "TEST_DATABASE_URL points at a PostgreSQL server where the per-worker "
            f"database {name!r} could not be created ({_redacted(base)}): {exc}"
        ) from exc
    finally:
        admin.dispose()

    _postgres_database = (base, name)
    atexit.register(_drop_worker_database)
    return make_url(base).set(database=name).render_as_string(hide_password=False)


os.environ["DATABASE_URL"] = (
    _prepare_postgres_database()
    if _TEST_DATABASE_URL
    else f"sqlite:///{_state / 'scholium.db'}"
)
os.environ["CONTENT_DIR"] = str(_state / "content")
os.environ["NODE_KEY_PATH"] = str(_state / "node.key")
os.environ.setdefault("JOBS_EAGER", "1")
os.environ.setdefault("ORCID_MOCK", "1")
os.environ.setdefault("ARXIV_MOCK", "1")
os.environ.setdefault("AI_PROVIDER", "fake")
# The shared app would otherwise throttle the whole suite; the throttle has its own tests.
os.environ["RATE_LIMIT_ENABLED"] = "0"
os.environ.pop("SCHOLIUM_ENV", None)

if _TEST_DATABASE_URL:
    # Bind the engine now, with every per-worker setting above already in the
    # environment. Several plugin test/conftest.py files rewrite DATABASE_URL
    # to a SQLite file when PYTEST_XDIST_WORKER is set; they are imported
    # during collection, after this file. Importing app.db first means the
    # process is already bound to its per-worker PostgreSQL database, and those
    # assignments only change an environment variable nothing reads again.
    _src = Path(__file__).resolve().parent / "src"
    if str(_src) not in sys.path:
        sys.path.insert(0, str(_src))
    import app.db  # noqa: E402,F401


@pytest.fixture(autouse=True)
def _restore_subscriber_registries():
    """Give every test the subscribers it started with, and put them back.

    Plugins subscribe to the ledger (and the version.state_changed event) once,
    when they are imported.  Some tests clear or replace subscribers to isolate
    what they observe; without this, whichever test an xdist worker ran earlier
    decides whether a later test in another module still has, say, the
    subscriber that settles flags when a moderation decision lands.

    A plugin first imported during a test subscribes at import time and will
    never subscribe again, so those newly-imported subscribers are kept; only
    what tests registered (or removed) is restored.
    """
    try:
        from app.modules.ledger import service as ledger_service
    except Exception:  # pragma: no cover - a test path that never imports app
        ledger_service = None
    try:
        from app.modules.submissions import events as submission_events
    except Exception:  # pragma: no cover - a test path that never imports app
        submission_events = None

    if ledger_service is not None:
        with ledger_service._subscribers_lock:
            ledger_saved = {kind: list(bucket) for kind, bucket in ledger_service._subscribers.items()}
    if submission_events is not None:
        with submission_events._subscribers_lock:
            state_saved = list(submission_events._subscribers)

    yield

    if ledger_service is not None:
        with ledger_service._subscribers_lock:
            for kind, bucket in ledger_service._subscribers.items():
                for callback in bucket:
                    module = getattr(callback, "__module__", "") or ""
                    is_test_code = ".tests." in module or module.rsplit(".", 1)[-1].startswith("test_")
                    kept = ledger_saved.setdefault(kind, [])
                    if not is_test_code and callback not in kept:
                        kept.append(callback)
            ledger_service._subscribers.clear()
            ledger_service._subscribers.update(
                {kind: list(bucket) for kind, bucket in ledger_saved.items() if bucket}
            )
    if submission_events is not None:
        with submission_events._subscribers_lock:
            for callback in submission_events._subscribers:
                module = getattr(callback, "__module__", "") or ""
                is_test_code = ".tests." in module or module.rsplit(".", 1)[-1].startswith("test_")
                if not is_test_code and callback not in state_saved:
                    state_saved.append(callback)
            submission_events._subscribers[:] = state_saved
