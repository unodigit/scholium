"""Production refuses the development backends: SQLite and filesystem storage.

``SCHOLIUM_ENV=production`` accepts a PostgreSQL ``DATABASE_URL`` and
``STORAGE_BACKEND=s3`` only.  Development (and every test run, which keeps the
default environment) still starts on SQLite and filesystem storage, so nothing
about the no-container test setup changes.
"""

import pytest

from app.settings import Settings

DATABASE_MESSAGE = "DATABASE_URL must be a PostgreSQL URL in production (SQLite is deprecated)"
STORAGE_MESSAGE = "STORAGE_BACKEND must be s3 in production"


def production(tmp_path, monkeypatch, **overrides) -> Settings:
    """The fully-configured production settings of ``test_app_factory``, overridden."""
    from test_app_factory import _safe_production_settings

    prod = _safe_production_settings(tmp_path, monkeypatch)
    for name, value in overrides.items():
        setattr(prod, name, value)
    return prod


def refusal(settings: Settings) -> str:
    with pytest.raises(RuntimeError) as err:
        settings.validate_for_environment()
    return str(err.value)


# --- DATABASE_URL ---------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "sqlite:///./scholium.db",
        "sqlite:////var/lib/scholium/scholium.db",
        "sqlite+pysqlite:///./scholium.db",
        "sqlite://",
        "sqlite:///:memory:",
        "mysql://scholium:secret@db.example.org/scholium",
        "mysql+pymysql://scholium:secret@db.example.org/scholium",
        "",
        "   ",
    ],
    ids=[
        "sqlite-relative",
        "sqlite-absolute",
        "sqlite-pysqlite",
        "sqlite-in-memory",
        "sqlite-memory-named",
        "mysql",
        "mysql-pymysql",
        "empty",
        "blank",
    ],
)
def test_production_refuses_a_non_postgresql_database(tmp_path, monkeypatch, url):
    message = refusal(production(tmp_path, monkeypatch, DATABASE_URL=url))
    assert message.startswith("Unsafe production configuration"), message
    assert DATABASE_MESSAGE in message, message
    assert STORAGE_MESSAGE not in message, message


def test_the_unset_database_default_is_sqlite_and_is_refused(tmp_path, monkeypatch):
    """Left alone, ``DATABASE_URL`` is ``sqlite:///./scholium.db`` -- not a production database."""
    prod = production(tmp_path, monkeypatch)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    prod.DATABASE_URL = Settings().DATABASE_URL
    assert prod.DATABASE_URL.startswith("sqlite:")
    assert DATABASE_MESSAGE in refusal(prod)


@pytest.mark.parametrize(
    "url",
    [
        "postgres://scholium:secret@db.example.org:5432/scholium",
        "postgresql://scholium:secret@db.example.org:5432/scholium",
        "postgresql+psycopg://scholium:secret@db.example.org:5432/scholium",
    ],
    ids=["postgres", "postgresql", "postgresql-psycopg"],
)
def test_production_accepts_every_postgresql_spelling_with_s3(tmp_path, monkeypatch, url):
    production(tmp_path, monkeypatch, DATABASE_URL=url).validate_for_environment()


# --- STORAGE_BACKEND ------------------------------------------------------------


def test_production_refuses_filesystem_storage(tmp_path, monkeypatch):
    message = refusal(production(tmp_path, monkeypatch, STORAGE_BACKEND="fs"))
    assert message.startswith("Unsafe production configuration"), message
    assert STORAGE_MESSAGE in message, message
    assert DATABASE_MESSAGE not in message, message


def test_production_refuses_filesystem_storage_however_it_is_spelled(tmp_path, monkeypatch):
    for spelling in ("fs", "FS", " fs "):
        message = refusal(production(tmp_path, monkeypatch, STORAGE_BACKEND=spelling))
        assert STORAGE_MESSAGE in message, message


def test_production_accepts_s3_storage(tmp_path, monkeypatch):
    production(tmp_path, monkeypatch, STORAGE_BACKEND="s3").validate_for_environment()


# --- both problems, with every other one ----------------------------------------


def test_both_backend_problems_are_listed_with_every_other_problem(tmp_path, monkeypatch):
    unsafe = production(
        tmp_path,
        monkeypatch,
        DATABASE_URL="sqlite:///./scholium.db",
        STORAGE_BACKEND="fs",
        JWT_SECRET="change-me-in-production",
        SMTP_URL="",
    )

    message = refusal(unsafe)

    assert message.startswith("Unsafe production configuration"), message
    for expected in (DATABASE_MESSAGE, STORAGE_MESSAGE, "JWT_SECRET", "SMTP_URL"):
        assert expected in message, f"{expected!r} missing from {message}"


# --- development keeps the no-container backends --------------------------------


def test_development_accepts_sqlite_and_filesystem_storage(monkeypatch):
    """The no-container setup (SQLite + ``CONTENT_DIR``) keeps starting outside production."""
    monkeypatch.delenv("SCHOLIUM_ENV", raising=False)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./scholium.db")
    monkeypatch.setenv("STORAGE_BACKEND", "fs")
    settings = Settings()
    assert settings.SCHOLIUM_ENV == "dev"
    assert settings.DATABASE_URL.startswith("sqlite:")
    assert settings.STORAGE_BACKEND == "fs"
    settings.validate_for_environment()


@pytest.mark.parametrize(
    "database_url, storage",
    [
        ("sqlite:///./scholium.db", "fs"),
        ("sqlite://", "fs"),
        ("postgresql+psycopg://scholium:secret@db.example.org:5432/scholium", "s3"),
    ],
)
def test_development_accepts_both_backend_kinds(monkeypatch, database_url, storage):
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("STORAGE_BACKEND", storage)
    monkeypatch.setenv("SCHOLIUM_ENV", "dev")
    Settings().validate_for_environment()
