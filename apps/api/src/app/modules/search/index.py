"""The ``search_fts`` FTS5 table and the operations on it (plugin: search).

Table shape (``app_spec.xml``, ``database_schema/search_fts``)::

    search_fts(version_cid UNINDEXED, title, abstract, body)   -- FTS5

One row per *listed* version.  ``title`` and ``abstract`` are the signed
metadata from ``paper_versions`` and ``body`` is the version's extracted text
-- its ``version_texts`` paragraphs (the ``checks`` plugin) in reading order,
separated by a blank line.  ``version_cid`` is stored but not tokenised: it is
the key a search result is mapped back to a version with.

The index is a *projection* of ``paper_versions``, never a second source of
truth: :func:`sync_version` looks at the version's current state and makes the
index agree with it -- a ``listed`` version is (re)written, anything else is
removed.  Because every write goes through that one function it is idempotent,
and a late, repeated or out-of-order notification cannot leave the index
disagreeing with the database.  :func:`rebuild_index` does the same for every
version, which repairs the one gap an in-process subscription has: a process
that dies between committing a transition and delivering its notification.

FTS5 gives no uniqueness guarantee, so "replace" is a DELETE followed by an
INSERT in one transaction.  ``version_cid`` is UNINDEXED, so that DELETE scans
the table; at the sizes this node is built for (hundreds of papers) that is
cheaper than keeping a second lookup structure in step.

Only SQLite has FTS5.  On any other dialect every operation here is a no-op
(reads report "not indexed"), the same way the ledger's append-only triggers
are.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import event, select, text
from sqlalchemy.engine import Connection

from app import db
from app.modules import checks
from app.modules.submissions import LISTED, PaperVersion, ensure_tables, get_version

__all__ = [
    "BODY_SEPARATOR",
    "IndexedVersion",
    "TABLE_NAME",
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

_CREATE_TABLE = f"""
    CREATE VIRTUAL TABLE IF NOT EXISTS {TABLE_NAME} USING fts5(
        version_cid UNINDEXED,
        title,
        abstract,
        body
    )
"""


@dataclass(frozen=True)
class IndexedVersion:
    """One row of ``search_fts``."""

    version_cid: str
    title: str
    abstract: str
    body: str


def supported() -> bool:
    """Whether the configured database can hold the index (SQLite only)."""
    return db.engine.dialect.name == "sqlite"


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #


def _create_on_create_all(target, connection: Connection, **kwargs) -> None:
    # ``main.create_app`` runs ``Base.metadata.create_all`` after the modules
    # load.  FTS5 virtual tables are not SQLAlchemy models, so create ours
    # alongside them; ``IF NOT EXISTS`` makes a repeat harmless and lets a
    # database that predates this plugin pick the table up in place.
    if connection.dialect.name == "sqlite":
        connection.execute(text(_CREATE_TABLE))


event.listen(db.Base.metadata, "after_create", _create_on_create_all)

# ``sync_version`` may also be called from tests/scripts that never build the
# app, so the table is created on first use (the same self-healing pattern as
# the ledger, content and checks modules).
_table_lock = threading.Lock()
_table_engine = None


def ensure_table() -> bool:
    """Create ``search_fts`` if it is missing; ``False`` when the dialect has no FTS5."""
    global _table_engine
    if not supported():
        return False
    if _table_engine is db.engine:
        return True
    with _table_lock:
        if _table_engine is not db.engine:
            with db.engine.begin() as connection:
                connection.execute(text(_CREATE_TABLE))
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
# (``BEGIN IMMEDIATE`` below) keeps each write atomic.
_write_lock = threading.RLock()


def upsert_entry(version_cid: str, title: str, abstract: str, body: str) -> None:
    """Make ``(title, abstract, body)`` the one ``search_fts`` row of ``version_cid``.

    Replaces whatever row the version already had, atomically: a reader sees
    the old row or the new one, never none and never both.  This writes
    unconditionally -- it does not check that the version is listed; that is
    :func:`sync_version`'s job.
    """
    if not ensure_table():
        return
    with _write_lock, db.engine.connect() as connection:
        # pysqlite opens no transaction for the DELETE's scan, so take the
        # write lock up front: two processes replacing the same version would
        # otherwise both delete nothing and both insert.
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


def sync_version(version_cid: str) -> bool:
    """Make the index agree with ``paper_versions`` for one version.

    A version whose ``state`` is ``listed`` is written to ``search_fts`` with
    its current title, abstract and text, replacing any earlier row.  A version
    in any other state -- not yet listed, ``held``, ``rejected`` -- or one this
    node does not hold has no row afterwards, so an unlisted draft is never
    searchable.

    Safe to call at any time and any number of times.  Call it again after a
    listed version's text changes to refresh the ``body``.

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
        upsert_entry(version_cid, version.title, version.abstract, _body_of(version_cid))
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
