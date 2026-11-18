"""SQLAlchemy engine, session and declarative base.

``DATABASE_URL`` selects the dialect: SQLite (the default) or PostgreSQL.
PostgreSQL URLs are served by the psycopg (v3) driver, whichever of the three
conventional spellings they use, and get a connection pool that checks
connections out only after a liveness ping.  Both dialects expose the same
engine object, sessions and metadata here, so no application code has to know
which database it is talking to.
"""

from sqlalchemy import create_engine, event, text
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
            # SQLAlchemy only memoises ``CursorResult.rowcount`` for UPDATE and
            # DELETE; for any other statement it reports -1 unless asked.
            # SQLite's driver answers late and correctly, so code such as the
            # quota-guarded ``INSERT ... SELECT`` and ``ON CONFLICT DO NOTHING``
            # claims, which read ``rowcount`` to learn whether a row went in,
            # worked there by accident. Preserving it makes the answer the
            # same on both dialects.
            execution_options={"preserve_rowcount": True},
        )
    return options


def _pin_session_time_zone(dbapi_connection, _record) -> None:
    """Make every new PostgreSQL connection read and write time as UTC.

    Every timestamp the application writes is naive UTC, and SQLite keeps it as
    written. PostgreSQL reads a naive value bound to a ``timestamptz`` column
    (the uploads tables) in the *session's* time zone, and converts ``now()``
    for a plain ``timestamp`` column the same way, so a server, role or
    ``PGTZ`` set to anything but UTC would shift both. The ``options`` startup
    parameter cannot be relied on for this (libpq applies ``PGTZ`` after it),
    so the zone is set on the connection itself.
    """
    autocommit = dbapi_connection.autocommit
    dbapi_connection.autocommit = True
    try:
        with dbapi_connection.cursor() as cursor:
            cursor.execute("SET TIME ZONE 'UTC'")
    finally:
        dbapi_connection.autocommit = autocommit


def build_engine(database_url: str) -> Engine:
    """An engine for ``database_url``, normalised and configured for its dialect."""
    url = normalise_database_url(database_url)
    engine = create_engine(url, **_engine_options(url))
    if engine.dialect.name == "postgresql":
        event.listen(engine, "connect", _pin_session_time_zone)
    return engine


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


#: The range of a 32-bit ``INTEGER`` column, which is what PostgreSQL gives
#: ``Integer`` (SQLite's is 64-bit). SQLAlchemy casts a bound value to the
#: column's type there, so a Python integer outside this range does not just
#: match nothing: the statement fails with "integer out of range".
INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1


def fits_int32(value: int) -> bool:
    """Whether ``value`` can be compared for equality with an ``Integer`` column.

    A caller-supplied number outside the range cannot equal any stored row, so
    a lookup by it should answer "not found" (as SQLite does) rather than send
    the database a value it refuses.
    """
    return INT32_MIN <= value <= INT32_MAX


def clamp_int32(value: int) -> int:
    """``value`` limited to the ``Integer`` range, for ``<``, ``<=``, ``>`` and ``>=``.

    Against a column that cannot leave the range, a bound beyond it selects
    every row or none exactly as the unclamped number would, so the clamped
    comparison answers the same on SQLite and PostgreSQL. Do not use it for
    equality: it would turn "no such number" into "the largest one".
    """
    return max(INT32_MIN, min(INT32_MAX, value))


def lock_transaction(session, name: str) -> None:
    """Make this transaction wait for any other holding the lock called ``name``.

    For read-modify-write sequences whose steps cannot be one statement, such
    as "delete a version's rows, insert the new ones".  SQLite has one writer
    at a time, so two such sequences never overlap and nothing is needed.
    PostgreSQL runs them concurrently under READ COMMITTED: each deletes what
    it can see, then each inserts, and the second insert meets the first's
    committed rows.  A transaction-level advisory lock keyed by ``name`` lines
    them up instead; it is released by ``COMMIT`` or ``ROLLBACK``, so a failed
    transaction cannot strand it.  Take it before the first read of the data
    it protects.
    """
    if session.get_bind().dialect.name == "postgresql":
        session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:name, 0))"), {"name": name}
        )


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
