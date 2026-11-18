"""SQLAlchemy engine, session and declarative base.

``DATABASE_URL`` selects the dialect: SQLite (the default) or PostgreSQL.
PostgreSQL URLs are served by the psycopg (v3) driver, whichever of the three
conventional spellings they use, and get a connection pool that checks
connections out only after a liveness ping.  Both dialects expose the same
engine object, sessions and metadata here, so no application code has to know
which database it is talking to.
"""

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import declarative_base, sessionmaker

from .settings import settings

#: URL spellings that mean "PostgreSQL"; normalised to the psycopg driver.
_POSTGRES_SCHEMES = ("postgres://", "postgresql://")

#: Stable key for the session-level ``pg_advisory_lock`` that serialises table
#: creation.  Every replica pointed at the same database must use the same
#: number, so it is a fixed constant and must never be changed casually.
_CREATE_ALL_LOCK_ID = 7_421_930_816_129_345


def normalise_database_url(database_url: str) -> str:
    """Return ``database_url`` in the form SQLAlchemy should hand to a driver.

    ``postgres://`` (the Heroku spelling) and ``postgresql://`` are rewritten
    to ``postgresql+psycopg://`` so psycopg (v3) is used rather than whatever
    driver SQLAlchemy would otherwise guess.  An explicit driver
    (``postgresql+psycopg://``, ``postgresql+psycopg2://``, ...) is respected,
    and every other URL -- SQLite above all -- is returned unchanged.
    """
    url = (database_url or "").strip()
    for scheme in _POSTGRES_SCHEMES:
        if url.startswith(scheme):
            return "postgresql+psycopg://" + url[len(scheme):]
    return url


def _engine_options(database_url: str) -> dict:
    """``create_engine`` keyword arguments for ``database_url``'s dialect.

    SQLite keeps exactly the options it has always had.  PostgreSQL gets the
    pool requested through ``DB_POOL_SIZE`` / ``DB_MAX_OVERFLOW`` and
    ``pool_pre_ping``, so a connection dropped by a restarted or failed-over
    server is replaced instead of surfacing as a request error.
    """
    if database_url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}, "future": True}
    options: dict = {"future": True}
    if make_url(database_url).get_backend_name() == "postgresql":
        options.update(
            pool_pre_ping=True,
            pool_size=max(0, settings.DB_POOL_SIZE),
            max_overflow=max(0, settings.DB_MAX_OVERFLOW),
        )
    return options


def build_engine(database_url: str) -> Engine:
    """An engine for ``database_url``, normalised and configured for its dialect."""
    url = normalise_database_url(database_url)
    return create_engine(url, **_engine_options(url))


_DATABASE_URL = normalise_database_url(settings.DATABASE_URL)
engine = build_engine(_DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def _create_all_postgres() -> None:
    """``create_all`` on PostgreSQL, serialised across replicas.

    ``checkfirst`` is not atomic: replicas booting together each see a missing
    table and every one of them runs ``CREATE TABLE``, so all but one fail.
    A session-level advisory lock held on one connection for the whole pass
    makes the second replica wait, then see the finished schema and do
    nothing.  The lock is released explicitly; if that is impossible the
    connection is discarded so the server-side session -- and with it the
    lock -- goes away.
    """
    with engine.connect() as connection:
        connection.execute(
            text("SELECT pg_advisory_lock(:key)"), {"key": _CREATE_ALL_LOCK_ID}
        )
        connection.commit()
        try:
            Base.metadata.create_all(bind=connection)
            connection.commit()
        finally:
            if connection.in_transaction():
                connection.rollback()
            try:
                connection.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _CREATE_ALL_LOCK_ID}
                )
                connection.commit()
            except Exception:
                # Never mask a CREATE TABLE failure with an unlock failure;
                # dropping the connection closes the session and frees the
                # server-side lock.
                connection.invalidate()


def create_all() -> None:
    """Create every registered table.

    ``checkfirst`` is not atomic: another process sharing the database (a second
    worker or test runner) may create a table between the existence check and
    the CREATE. A second pass sees that table and is a no-op.  On PostgreSQL
    the whole pass runs under an advisory lock so replicas that start together
    cannot race each other into duplicate ``CREATE TABLE`` errors.
    """
    if engine.dialect.name == "postgresql":
        _create_all_postgres()
        return
    try:
        Base.metadata.create_all(bind=engine)
    except OperationalError as exc:
        if "already exists" not in str(exc):
            raise
        Base.metadata.create_all(bind=engine)
