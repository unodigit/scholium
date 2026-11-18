"""The ``search_fts`` index and the operations on it (plugin: search).

Top row of the table (SQLite) -- ``app_spec.xml``,
``database_schema/search_fts``::

    search_fts(version_cid UNINDEXED, title, abstract, body)   -- FTS5

and, on PostgreSQL, the same fields plus the author DIDs of the version and a
weighted ``tsvector`` behind a GIN index::

    search_fts(version_cid, title, authors, abstract, body, document tsvector)

One row per *listed* version.  ``title`` and ``abstract`` are the signed
metadata from ``paper_versions``, ``authors`` is the version's byline
(``authorship`` rows, in order) and ``body`` is the version's extracted text
-- its ``version_texts`` paragraphs (the ``checks`` plugin) in reading order,
separated by a blank line.  ``version_cid`` is the key a search result is
mapped back to a version with.

The index is a *projection* of ``paper_versions``, never a second source of
truth: :func:`sync_version` looks at the version's current state and makes the
index agree with it -- a ``listed`` version is (re)written, anything else is
removed.  Because every write goes through that one function it is idempotent,
and a late, repeated or out-of-order notification cannot leave the index
disagreeing with the database.  :func:`rebuild_index` does the same for every
version, which repairs the one gap an in-process subscription has: a process
that dies between committing a transition and delivering its notification.

Two dialects, one table
-----------------------

SQLite uses an FTS5 virtual table with no uniqueness guarantee, so "replace"
is a DELETE followed by an INSERT in one transaction (``BEGIN IMMEDIATE``
holds the write lock first).  PostgreSQL has no FTS5; the table is an ordinary
one keyed by ``version_cid``, with a ``document`` column generated from the
four text columns by :data:`WEIGHTED_DOCUMENT` -- title weight ``A``, authors
``B``, abstract ``C``, body ``D`` -- and a GIN index on it.  "Replace" there is
a single ``INSERT ... ON CONFLICT (version_cid) DO UPDATE``, which is atomic on
its own and needs no client-side write lock across processes.

Every other operation (:func:`get_entry`, :func:`remove_entry`,
:func:`sync_version`, :func:`rebuild_index`) is dialect-neutral SQL and
behaves the same on both.  What differs is only the query the search module
runs against the table; :mod:`app.modules.search.query` builds the matching
one and keeps the ranking convention (title matches rank first) the same.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import event, select, text
from sqlalchemy.engine import Connection

from app import db
from app.modules import checks
from app.modules.submissions import (
    LISTED,
    PaperVersion,
    authorship_for,
    ensure_tables,
    get_version,
)

__all__ = [
    "BODY_SEPARATOR",
    "IndexedVersion",
    "TABLE_NAME",
    "WEIGHTED_DOCUMENT",
    "ensure_table",
    "get_entry",
    "is_indexed",
    "rebuild_index",
    "remove_entry",
    "supported",
    "sync_version",
    "upsert_entry",
]

TABLE_NAME = "search_fts"

#: Joins a version's paragraphs into the ``body`` column.
BODY_SEPARATOR = "\n\n"

#: The dialects :func:`supported` accepts.
_SUPPORTED_DIALECTS = ("sqlite", "postgresql")

# SQLite: the FTS5 virtual table, unchanged from feature 85.
_CREATE_SQLITE_TABLE = f"""
    CREATE VIRTUAL TABLE IF NOT EXISTS {TABLE_NAME} USING fts5(
        version_cid UNINDEXED,
        title,
        abstract,
        body
    )
"""

#: The weighted document of the PostgreSQL table: one ``tsvector`` built from
#: the four searchable columns, each in its own weight class.  ``A`` (title)
#: ranks first, ``B`` (authors) and ``C`` (abstract) follow, ``D`` (body) last
#: -- the same order FTS5's BM25 weights give title over abstract over body.
#: ``'simple'`` rather than a stemming configuration keeps the tokenisation
#: close to FTS5's ``unicode61`` tokenizer: case-folded words, no stemming.
#: Every function and cast here is immutable, which PostgreSQL requires of a
#: generated column expression.
WEIGHTED_DOCUMENT = """
    setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(authors, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(abstract, '')), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(body, '')), 'D')
"""

# PostgreSQL: an ordinary table whose ``document`` tsvector is generated from
# the text columns, so any write to them re-weights the document atomically.
_CREATE_POSTGRES_TABLE = f"""
    CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
        version_cid text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        authors text NOT NULL DEFAULT '',
        abstract text NOT NULL DEFAULT '',
        body text NOT NULL DEFAULT '',
        document tsvector GENERATED ALWAYS AS ({WEIGHTED_DOCUMENT}) STORED
    )
"""

#: Name of the GIN index over the PostgreSQL ``document`` column.
POSTGRES_GIN_INDEX = f"{TABLE_NAME}_document_gin"

_CREATE_POSTGRES_INDEX = f"""
    CREATE INDEX IF NOT EXISTS {POSTGRES_GIN_INDEX}
    ON {TABLE_NAME} USING GIN (document)
"""

_POSTGRES_UPSERT = f"""
    INSERT INTO {TABLE_NAME} (version_cid, title, authors, abstract, body)
    VALUES (:cid, :title, :authors, :abstract, :body)
    ON CONFLICT (version_cid) DO UPDATE
    SET title = EXCLUDED.title,
        authors = EXCLUDED.authors,
        abstract = EXCLUDED.abstract,
        body = EXCLUDED.body
"""


@dataclass(frozen=True)
class IndexedVersion:
    """One row of ``search_fts``."""

    version_cid: str
    title: str
    abstract: str
    body: str


def _dialect_name() -> str:
    return getattr(db.engine.dialect, "name", "")


def _is_postgres() -> bool:
    return _dialect_name() == "postgresql"


def supported() -> bool:
    """Whether the configured database can hold the index.

    Both dialects can: SQLite through FTS5, PostgreSQL through a weighted
    ``tsvector`` with a GIN index.  Any other database reports ``False`` and
    every operation here becomes a no-op.
    """
    return _dialect_name() in _SUPPORTED_DIALECTS


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #


def _create_sqlite(connection: Connection) -> None:
    connection.execute(text(_CREATE_SQLITE_TABLE))


def _create_postgres(connection: Connection) -> None:
    """Create the PostgreSQL table and its GIN index (idempotent)."""
    connection.execute(text(_CREATE_POSTGRES_TABLE))
    connection.execute(text(_CREATE_POSTGRES_INDEX))


def _create_for(connection: Connection) -> None:
    """Create the index in the shape of ``connection``'s dialect.

    The dialect is read from the connection when it has one (the engines
    ``create_all`` and ``ensure_table`` hand us always do); otherwise the
    configured engine decides, which keeps a bare recording connection usable
    in tests.
    """
    dialect = getattr(getattr(connection, "dialect", None), "name", None)
    if dialect is None:
        dialect = _dialect_name()
    if dialect == "postgresql":
        _create_postgres(connection)
    elif dialect == "sqlite":
        _create_sqlite(connection)


def _create_on_create_all(target, connection: Connection, **kwargs) -> None:
    # ``main.create_app`` runs ``Base.metadata.create_all`` after the modules
    # load.  The index is not a SQLAlchemy model, so create ours alongside
    # them; ``IF NOT EXISTS`` makes a repeat harmless and lets a database that
    # predates this plugin pick the table up in place.
    _create_for(connection)


event.listen(db.Base.metadata, "after_create", _create_on_create_all)

# ``sync_version`` may also be called from tests/scripts that never build the
# app, so the table is created on first use (the same self-healing pattern as
# the ledger, content and checks modules).
_table_lock = threading.Lock()
_table_engine = None


def ensure_table() -> bool:
    """Create the index if it is missing; ``False`` when the dialect is unsupported."""
    global _table_engine
    if not supported():
        return False
    if _table_engine is db.engine:
        return True
    with _table_lock:
        if _table_engine is not db.engine:
            with db.engine.begin() as connection:
                _create_for(connection)
            _table_engine = db.engine
    return True


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #

# Serialises writers in this process.  ``sync_version`` holds it across "read
# the version's state" *and* "write the index", so two notifications for one
# version (``listed`` then ``held``, say) cannot interleave into an index row
# for a version that is no longer listed.  Re-entrant because ``sync_version``
# calls the writers below.  Across processes SQLite's own write lock
# (``BEGIN IMMEDIATE`` below) and PostgreSQL's ``ON CONFLICT`` upsert keep each
# write atomic.
_write_lock = threading.RLock()


def _upsert_sqlite(
    connection: Connection, version_cid: str, title: str, abstract: str, body: str
) -> None:
    """Delete-then-insert one FTS5 row, holding SQLite's write lock."""
    # pysqlite opens no transaction for the DELETE's scan, so take the write
    # lock up front: two processes replacing the same version would otherwise
    # both delete nothing and both insert.
    connection.exec_driver_sql("BEGIN IMMEDIATE")
    try:
        connection.execute(
            text(f"DELETE FROM {TABLE_NAME} WHERE version_cid = :cid"),
            {"cid": version_cid},
        )
        connection.execute(
            text(
                f"INSERT INTO {TABLE_NAME} (version_cid, title, abstract, body) "
                "VALUES (:cid, :title, :abstract, :body)"
            ),
            {"cid": version_cid, "title": title, "abstract": abstract, "body": body},
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _upsert_postgres(
    connection: Connection,
    version_cid: str,
    title: str,
    abstract: str,
    body: str,
    authors: str,
) -> None:
    """Insert-or-update one PostgreSQL row in a single atomic statement."""
    connection.execute(
        text(_POSTGRES_UPSERT),
        {
            "cid": version_cid,
            "title": title,
            "authors": authors,
            "abstract": abstract,
            "body": body,
        },
    )


def upsert_entry(
    version_cid: str,
    title: str,
    abstract: str,
    body: str,
    authors: str = "",
) -> None:
    """Make ``(title, authors, abstract, body)`` the one ``search_fts`` row of ``version_cid``.

    Replaces whatever row the version already had, atomically: a reader sees
    the old row or the new one, never none and never both.  This writes
    unconditionally -- it does not check that the version is listed; that is
    :func:`sync_version`'s job.

    ``authors`` is the version's byline as plain text.  SQLite's FTS5 table has
    no such column and ignores it; PostgreSQL indexes it under weight ``B``.
    """
    if not ensure_table():
        return
    with _write_lock:
        if _is_postgres():
            with db.engine.begin() as connection:
                _upsert_postgres(
                    connection, version_cid, title, abstract, body, authors
                )
        else:
            with db.engine.connect() as connection:
                _upsert_sqlite(connection, version_cid, title, abstract, body)


def remove_entry(version_cid: str) -> bool:
    """Delete the ``search_fts`` row(s) of ``version_cid``; whether there was any."""
    if not ensure_table():
        return False
    with _write_lock, db.engine.begin() as connection:
        result = connection.execute(
            text(f"DELETE FROM {TABLE_NAME} WHERE version_cid = :cid"),
            {"cid": version_cid},
        )
        return result.rowcount > 0


def _body_of(version_cid: str) -> str:
    return BODY_SEPARATOR.join(p.text for p in checks.get_version_text(version_cid))


def _authors_of(version_cid: str) -> str:
    """The version's byline as plain text: its authors' DIDs in byline order.

    Only PostgreSQL indexes it.  The authorship table holds the author DIDs
    (and credit roles); it is the only authorship the node knows, so that is
    what the authors column contains.
    """
    return " ".join(row.author_did for row in authorship_for(version_cid))


def sync_version(version_cid: str) -> bool:
    """Make the index agree with ``paper_versions`` for one version.

    A version whose ``state`` is ``listed`` is written to ``search_fts`` with
    its current title, authors, abstract and text, replacing any earlier row.
    A version in any other state -- not yet listed, ``held``, ``rejected`` --
    or one this node does not hold has no row afterwards, so an unlisted draft
    is never searchable.

    Safe to call at any time and any number of times.  Call it again after a
    listed version's text or byline changes to refresh the row.

    Returns whether the version is in the index afterwards.
    """
    if not isinstance(version_cid, str) or not version_cid:
        return False
    if not ensure_table():
        return False
    with _write_lock:
        version = get_version(version_cid)
        if version is None or version.state != LISTED:
            remove_entry(version_cid)
            return False
        upsert_entry(
            version_cid,
            version.title,
            version.abstract,
            _body_of(version_cid),
            authors=_authors_of(version_cid) if _is_postgres() else "",
        )
        return True


def rebuild_index() -> int:
    """Make the whole index agree with ``paper_versions``; return how many versions it holds.

    Writes a row for every listed version and removes every row whose version
    is not listed (or no longer exists).  It is the repair for a notification
    that was never delivered -- the in-process subscriptions are lost if the
    process dies between committing a transition and notifying -- and the way
    to fill the index for versions listed before this plugin was installed.
    """
    if not ensure_table():
        return 0
    ensure_tables()
    with _write_lock:
        with db.SessionLocal() as session:
            listed = list(
                session.scalars(
                    select(PaperVersion.version_cid).where(PaperVersion.state == LISTED)
                )
            )
        with db.engine.connect() as connection:
            indexed = {
                row[0]
                for row in connection.execute(
                    text(f"SELECT DISTINCT version_cid FROM {TABLE_NAME}")
                )
            }
        for stale in indexed - set(listed):
            remove_entry(stale)
        for version_cid in listed:
            sync_version(version_cid)
    return len(listed)


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def get_entry(version_cid: str) -> Optional[IndexedVersion]:
    """The ``search_fts`` row of ``version_cid``, or ``None`` when it is not indexed."""
    if not isinstance(version_cid, str) or not ensure_table():
        return None
    with db.engine.connect() as connection:
        row = connection.execute(
            text(
                f"SELECT version_cid, title, abstract, body FROM {TABLE_NAME} "
                "WHERE version_cid = :cid LIMIT 1"
            ),
            {"cid": version_cid},
        ).first()
    if row is None:
        return None
    return IndexedVersion(version_cid=row[0], title=row[1], abstract=row[2], body=row[3])


def is_indexed(version_cid: str) -> bool:
    """Whether ``search_fts`` has a row for ``version_cid``."""
    return get_entry(version_cid) is not None
