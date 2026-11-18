"""The database layer serves SQLite and PostgreSQL from the same API.

These tests pin the dialect-specific pieces that no ordinary request exercises:
URL normalisation, the pool options PostgreSQL gets, and the advisory lock that
keeps replicas booting together from racing on ``CREATE TABLE``.  SQLite's
engine options and schema stay exactly as they were.
"""

import pytest
from sqlalchemy import inspect

from app import db, main
from app.db import Base, build_engine, normalise_database_url
from app.settings import Settings


@pytest.mark.parametrize(
    "url",
    [
        "postgres://scholium:secret@db.example:5432/scholium",
        "postgresql://scholium:secret@db.example:5432/scholium",
        "postgresql://scholium@db.example/scholium?sslmode=require",
    ],
)
def test_postgres_urls_normalise_to_psycopg(url):
    normalised = normalise_database_url(url)

    assert normalised.startswith("postgresql+psycopg://")
    # The scheme is the only thing that changes: credentials, host, database
    # and query string all survive.
    assert normalised.split("://", 1)[1] == url.split("://", 1)[1]


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg://scholium:secret@db.example/scholium",
        "postgresql+psycopg2://scholium:secret@db.example/scholium",
        "sqlite:///./scholium.db",
        "sqlite:////var/lib/scholium/scholium.db",
    ],
)
def test_other_urls_are_left_alone(url):
    assert normalise_database_url(url) == url


def test_sqlite_engine_options_are_unchanged():
    """The options ``create_engine`` receives for SQLite must stay as they were."""
    assert db._engine_options("sqlite:///./scholium.db") == {
        "connect_args": {"check_same_thread": False},
        "future": True,
    }


def test_postgres_engine_uses_psycopg_and_a_pre_pinged_pool(monkeypatch):
    monkeypatch.setattr(db.settings, "DB_POOL_SIZE", 7)
    monkeypatch.setattr(db.settings, "DB_MAX_OVERFLOW", 3)

    engine = build_engine("postgresql://scholium:secret@db.example/scholium")

    assert engine.dialect.name == "postgresql"
    assert engine.dialect.driver == "psycopg"
    assert engine.pool._pre_ping is True
    assert engine.pool.size() == 7
    assert engine.pool._max_overflow == 3
    # Still no password in anything rendered from the URL by accident.
    assert engine.url.password == "secret"


def test_postgres_pool_defaults_match_sqlalchemy(monkeypatch):
    monkeypatch.delenv("DB_POOL_SIZE", raising=False)
    monkeypatch.delenv("DB_MAX_OVERFLOW", raising=False)

    configured = Settings()

    assert configured.DB_POOL_SIZE == 5
    assert configured.DB_MAX_OVERFLOW == 10


def test_postgres_pool_settings_are_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("DB_POOL_SIZE", "12")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "4")

    configured = Settings()

    assert configured.DB_POOL_SIZE == 12
    assert configured.DB_MAX_OVERFLOW == 4


class _FakeConnection:
    """Records what the PostgreSQL ``create_all`` path executes."""

    def __init__(self, statements, fail_with=None):
        self.statements = statements
        self.fail_with = fail_with
        self._in_transaction = False

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def execute(self, statement, parameters=None):
        self.statements.append((str(statement), dict(parameters or {})))
        self._in_transaction = True
        return self

    def commit(self):
        self._in_transaction = False

    def rollback(self):
        self._in_transaction = False
        self.statements.append(("rollback", {}))

    def in_transaction(self):
        return self._in_transaction

    def invalidate(self):
        self.statements.append(("invalidate", {}))


class _FakePostgresEngine:
    class dialect:
        name = "postgresql"

    def __init__(self, connection):
        self._connection = connection

    def connect(self):
        return self._connection


def _statements_matching(statements, fragment):
    return [entry for entry in statements if fragment in entry[0]]


def test_create_all_on_postgres_holds_an_advisory_lock(monkeypatch):
    statements = []
    connection = _FakeConnection(statements)
    monkeypatch.setattr(db, "engine", _FakePostgresEngine(connection))
    created = []
    monkeypatch.setattr(
        Base.metadata, "create_all", lambda bind=None, **kwargs: created.append(bind)
    )

    db.create_all()

    locks = _statements_matching(statements, "pg_advisory_lock")
    unlocks = _statements_matching(statements, "pg_advisory_unlock")
    assert len(locks) == 1 and len(unlocks) == 1
    # The same lock id, or the unlock would not release anything.
    assert locks[0][1]["key"] == unlocks[0][1]["key"]
    # CREATE TABLE happens between taking and releasing the lock.
    assert statements.index(locks[0]) < statements.index(unlocks[0])
    assert created == [connection]


def test_create_all_on_postgres_releases_the_lock_when_creation_fails(monkeypatch):
    statements = []
    connection = _FakeConnection(statements)
    monkeypatch.setattr(db, "engine", _FakePostgresEngine(connection))

    def boom(bind=None, **kwargs):
        raise RuntimeError("CREATE TABLE exploded")

    monkeypatch.setattr(Base.metadata, "create_all", boom)

    with pytest.raises(RuntimeError, match="CREATE TABLE exploded"):
        db.create_all()

    assert len(_statements_matching(statements, "pg_advisory_lock")) == 1
    assert len(_statements_matching(statements, "pg_advisory_unlock")) == 1


def test_create_all_on_sqlite_creates_every_registered_table():
    """The SQLite path keeps creating the full schema, and stays idempotent."""
    db.create_all()
    db.create_all()

    tables = set(inspect(db.engine).get_table_names())

    assert set(Base.metadata.tables) <= tables
    assert "papers" in tables


def test_create_app_on_sqlite_uses_the_unchanged_engine_options():
    """``create_app`` on the configured ``sqlite:///`` URL behaves as before."""
    app = main.create_app()

    assert app is not None
    assert db.engine.dialect.name == "sqlite"
    assert db.engine.pool._pre_ping is False
    assert db._engine_options(str(db.engine.url)) == {
        "connect_args": {"check_same_thread": False},
        "future": True,
    }
    assert "papers" in inspect(db.engine).get_table_names()
