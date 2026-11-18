"""Database triggers that make the ``event_log`` table append-only (feature 13).

The hash chain (:mod:`app.modules.ledger.hashing`) lets anyone *detect* a
rewritten log; these triggers make the database itself *refuse* to rewrite
it.  Once installed, every statement that would change or remove an existing
row aborts with a constraint error, which SQLAlchemy surfaces as
``sqlalchemy.exc.IntegrityError`` carrying one of the messages below::

    UPDATE event_log SET body = '{}' WHERE seq = 1
    # IntegrityError: event_log is append-only: UPDATE is not permitted

    DELETE FROM event_log
    # IntegrityError: event_log is append-only: DELETE is not permitted

Three triggers are installed (SQLite and PostgreSQL):

``event_log_reject_update``
    ``BEFORE UPDATE`` -- aborts every UPDATE, whatever the columns and
    however many rows.  ``INSERT ... ON CONFLICT DO UPDATE`` runs the same
    UPDATE and is rejected too.

``event_log_reject_delete``
    ``BEFORE DELETE`` -- aborts every DELETE.

``event_log_reject_replace``
    ``BEFORE INSERT`` -- aborts an INSERT whose ``record_cid`` or ``seq``
    already exists.  This closes the one hole the two triggers above leave:
    ``INSERT OR REPLACE`` resolves a conflict by *deleting* the old row, and
    SQLite does not fire DELETE triggers for that implicit delete unless
    ``PRAGMA recursive_triggers`` is on.  A plain duplicate-CID INSERT is an
    ``IntegrityError`` either way (it used to fail on the UNIQUE constraint;
    it now fails here first, with :data:`REPLACE_REJECTED`).

The triggers guard the *statements* the application and its tools can run.
They are not access control: someone who can ``DROP TRIGGER`` or replace the
database file can still rewrite the log, which is what the hash chain and the
node-signed head (``GET /v1/sync/head``) are for.

Installation is idempotent (``CREATE TRIGGER IF NOT EXISTS`` on SQLite,
``DROP TRIGGER IF EXISTS`` + ``CREATE TRIGGER`` on PostgreSQL) and happens
on every path that can bring the table into existence or reach an existing
one: :func:`app.modules.ledger.models.ensure_table` and the
``Base.metadata.create_all`` that ``main.create_app`` runs at startup, so a
database created before this feature is upgraded in place.

SQLite and PostgreSQL are supported; on any other dialect
:func:`install_append_only_triggers` does nothing.
"""

from __future__ import annotations

from typing import Union

from sqlalchemy import event, inspect, text
from sqlalchemy.engine import Connection, Engine

__all__ = [
    "APPEND_ONLY_TRIGGERS",
    "DELETE_REJECTED",
    "PG_APPEND_ONLY_STATEMENTS",
    "PG_INTEGRITY_ERRCODE",
    "REPLACE_REJECTED",
    "UPDATE_REJECTED",
    "append_only_triggers_installed",
    "install_append_only_triggers",
]

TABLE_NAME = "event_log"

#: Error message raised for any UPDATE of an ``event_log`` row.
UPDATE_REJECTED = "event_log is append-only: UPDATE is not permitted"

#: Error message raised for any DELETE of an ``event_log`` row.
DELETE_REJECTED = "event_log is append-only: DELETE is not permitted"

#: Error message raised when an INSERT collides with an existing row (the
#: ``INSERT OR REPLACE`` route to deleting one).
REPLACE_REJECTED = "event_log is append-only: an existing entry cannot be replaced"

# SQL string literals: none of the messages above contain a quote, but escape
# anyway so a future edit cannot produce broken (or injectable) DDL.
def _literal(message: str) -> str:
    return "'" + message.replace("'", "''") + "'"


#: Trigger name -> ``CREATE TRIGGER`` statement (SQLite).
APPEND_ONLY_TRIGGERS: dict[str, str] = {
    "event_log_reject_update": f"""
        CREATE TRIGGER IF NOT EXISTS event_log_reject_update
        BEFORE UPDATE ON {TABLE_NAME}
        BEGIN
            SELECT RAISE(ABORT, {_literal(UPDATE_REJECTED)});
        END
    """,
    "event_log_reject_delete": f"""
        CREATE TRIGGER IF NOT EXISTS event_log_reject_delete
        BEFORE DELETE ON {TABLE_NAME}
        BEGIN
            SELECT RAISE(ABORT, {_literal(DELETE_REJECTED)});
        END
    """,
    "event_log_reject_replace": f"""
        CREATE TRIGGER IF NOT EXISTS event_log_reject_replace
        BEFORE INSERT ON {TABLE_NAME}
        WHEN EXISTS (
            SELECT 1 FROM {TABLE_NAME}
            WHERE record_cid = NEW.record_cid OR seq = NEW.seq
        )
        BEGIN
            SELECT RAISE(ABORT, {_literal(REPLACE_REJECTED)});
        END
    """,
}


def _is_sqlite(bind: Union[Engine, Connection]) -> bool:
    try:
        return bind.dialect.name == "sqlite"
    except AttributeError:
        return getattr(getattr(bind, "dialect", None), "name", None) == "sqlite"


def _is_postgresql(bind: Union[Engine, Connection]) -> bool:
    try:
        return bind.dialect.name == "postgresql"
    except AttributeError:
        return getattr(getattr(bind, "dialect", None), "name", None) == "postgresql"


#: SQLSTATE class for integrity-constraint violations.  PL/pgSQL raises the
#: trigger errors with this code so psycopg maps them to ``IntegrityError``,
#: exactly as SQLite's ``RAISE(ABORT, ...)`` is mapped.
PG_INTEGRITY_ERRCODE = "23514"


def _pg_function(trigger_name: str, body: str) -> str:
    """A ``CREATE OR REPLACE`` PL/pgSQL trigger function."""
    return f"""
    CREATE OR REPLACE FUNCTION {trigger_name}() RETURNS trigger AS $$
    BEGIN
        {body}
    END;
    $$ LANGUAGE plpgsql;
    """


def _pg_raise(message: str) -> str:
    """A PL/pgSQL statement that aborts with ``message`` as an integrity error.

    ``USING MESSAGE = ...`` rather than ``RAISE EXCEPTION '%', ...`` on
    purpose: SQLAlchemy hands a ``text()`` statement to psycopg with an empty
    parameter mapping, so psycopg scans the SQL for pyformat placeholders
    before sending it.  A literal ``%'`` in a format string looks like a
    malformed placeholder and the trigger DDL would fail to install.  The
    ``MESSAGE`` form carries the text as an ordinary string literal and has no
    ``%`` to misinterpret; :func:`_install` additionally marks these
    statements parameterless.
    """
    return (
        "RAISE EXCEPTION USING\n"
        f"            MESSAGE = {_literal(message)},\n"
        f"            ERRCODE = '{PG_INTEGRITY_ERRCODE}';"
    )


def _pg_trigger(trigger_name: str, event: str) -> list[str]:
    """``DROP`` + ``CREATE`` for one row-level trigger (idempotent pair)."""
    return [
        f"DROP TRIGGER IF EXISTS {trigger_name} ON {TABLE_NAME};",
        f"""
    CREATE TRIGGER {trigger_name}
    BEFORE {event} ON {TABLE_NAME}
    FOR EACH ROW
    EXECUTE FUNCTION {trigger_name}();
    """,
    ]


#: Statements that install the same three append-only triggers on PostgreSQL.
#: Functions are created with ``CREATE OR REPLACE`` and triggers with
#: ``DROP ... IF EXISTS`` + ``CREATE`` so installation is idempotent.  The
#: messages are interpolated from the same constants the SQLite triggers use,
#: so the two dialects can never drift apart.
PG_APPEND_ONLY_STATEMENTS: list[str] = [
    _pg_function(
        "event_log_reject_update",
        _pg_raise(UPDATE_REJECTED),
    ),
    *_pg_trigger("event_log_reject_update", "UPDATE"),
    _pg_function(
        "event_log_reject_delete",
        _pg_raise(DELETE_REJECTED),
    ),
    *_pg_trigger("event_log_reject_delete", "DELETE"),
    _pg_function(
        "event_log_reject_replace",
        f"""IF EXISTS (
            SELECT 1 FROM {TABLE_NAME}
            WHERE record_cid = NEW.record_cid OR seq = NEW.seq
        ) THEN
            {_pg_raise(REPLACE_REJECTED)}
        END IF;
        RETURN NEW;""",
    ),
    *_pg_trigger("event_log_reject_replace", "INSERT"),
]


def install_append_only_triggers(bind: Union[Engine, Connection]) -> None:
    """Install the append-only triggers on ``event_log`` (idempotent).

    ``bind`` is an engine (the triggers are committed) or a connection (they
    join its transaction, as inside a ``create_all`` event).  The table must
    already exist.  Does nothing on an unsupported dialect.
    """
    if not (_is_sqlite(bind) or _is_postgresql(bind)):
        return
    if isinstance(bind, Engine):
        with bind.begin() as connection:
            _install(connection)
    else:
        _install(bind)


def _install(connection: Connection) -> None:
    if _is_sqlite(connection):
        statements = APPEND_ONLY_TRIGGERS.values()
    elif _is_postgresql(connection):
        statements = PG_APPEND_ONLY_STATEMENTS
    else:
        return
    for statement in statements:
        # These are DDL statements with no parameters.  Saying so explicitly
        # makes SQLAlchemy call the driver's ``execute(statement)`` without a
        # parameter mapping, so psycopg does not run its pyformat placeholder
        # scanner over the PL/pgSQL body (see ``_pg_raise``).
        connection.execute(text(statement).execution_options(no_parameters=True))


def _sqlite_trigger_names(connection: Connection) -> set[str]:
    rows = connection.execute(
        text("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = :table"),
        {"table": TABLE_NAME},
    )
    return {row[0] for row in rows}


def _postgres_trigger_names(connection: Connection) -> set[str]:
    from sqlalchemy import inspect as _inspect

    if not _inspect(connection).has_table(TABLE_NAME):
        return set()
    try:
        rows = connection.execute(
            text(
                "SELECT tgname FROM pg_trigger "
                "WHERE tgrelid = CAST(:table AS regclass) AND NOT tgisinternal"
            ),
            {"table": TABLE_NAME},
        )
        return {row[0] for row in rows}
    except Exception:
        return set()


def append_only_triggers_installed(bind: Union[Engine, Connection]) -> bool:
    """Whether every append-only trigger exists on ``event_log``."""
    if _is_sqlite(bind):
        query_needed = True
    elif _is_postgresql(bind):
        query_needed = True
    else:
        return False

    if isinstance(bind, Engine):
        with bind.connect() as connection:
            if _is_sqlite(bind):
                present = _sqlite_trigger_names(connection)
            else:
                present = _postgres_trigger_names(connection)
    else:
        if _is_sqlite(bind):
            present = _sqlite_trigger_names(bind)
        else:
            present = _postgres_trigger_names(bind)
    return set(APPEND_ONLY_TRIGGERS) <= present


def install_on_create_all(metadata) -> None:
    """Install the triggers whenever ``metadata.create_all`` finishes.

    ``create_all`` skips a table that already exists, so a per-table
    ``after_create`` listener would never upgrade a database created before
    this feature.  The metadata-level event fires on every ``create_all``;
    the table check keeps it harmless when ``create_all`` was asked for a
    subset of tables, or when the table is absent.
    """

    @event.listens_for(metadata, "after_create")
    def _after_create(target, connection, **kw):  # noqa: ARG001 - SQLAlchemy signature
        if connection.dialect.name in ("sqlite", "postgresql") and inspect(connection).has_table(TABLE_NAME):
            _install(connection)
