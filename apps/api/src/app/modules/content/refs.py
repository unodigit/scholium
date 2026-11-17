"""Which manifests list a file: the content-reference index (plugin: content).

``GET /v1/content/{cid}`` has to know whether a paper version references the
bytes it is asked for (:mod:`app.modules.content.visibility`).  A version
references a file through its ``manifest`` record, whose body -- held in the
ledger -- lists the file cids.  Answering that by reading every ``manifest``
entry on every download made the cost of a request grow with the node.

This module keeps the answer in a table instead::

    content_refs(content_cid TEXT, manifest_cid TEXT,
                 path TEXT, media_type TEXT, role TEXT,
                 PRIMARY KEY (content_cid, manifest_cid))

One row per file a manifest lists, so "which manifests list this cid" is a
primary-key lookup, and the entry's signed `path`, `mediaType` and `role`
travel with it so a download can name the file without reading the manifest
body again.  The index is a pure projection of the ledger's ``manifest``
records -- exactly the set the scan used to read -- which is what keeps
who-may-read-what unchanged.  The second hop, from a manifest to the versions
that name it, stays a read of ``paper_versions`` (the source of truth for
versions, which are saved *before* their ledger entry is appended); it is
made an indexed lookup too, see :func:`ensure_tables`.

Keeping the index complete
--------------------------

Everything funnels through one routine, :func:`sync`, which indexes every
manifest the ledger holds beyond a stored high-water mark::

    content_ref_progress(id INTEGER PRIMARY KEY,   -- always 1
                         last_seq INTEGER)         -- newest manifest seq indexed

* a **ledger subscriber** (:func:`on_manifest_record`, installed by
  :func:`install`) calls it for each ``manifest`` record appended, so a
  download normally finds nothing left to do;
* the **startup backfill** (:func:`backfill`, run by the package's
  ``on_startup`` hook) calls it for the manifests that predate the index --
  on the first start after the index shipped, that is all of them;
* the **download itself** calls it first, which costs two indexed point
  lookups when the index is current.  This is what makes the gate safe: the
  ledger logs and skips a subscriber that raises, the subscriber registry is
  process-global and gets cleared (tests do), and a manifest is visible in
  the ledger a moment before its subscribers run.  An index that trusted the
  notification alone would, in each of those cases, read a file as
  unreferenced and serve pre-listing bytes to anyone.  Catching up is cheap
  and the alternative fails open.

``sync`` is safe to run concurrently, in this process or another: a page of
manifests is indexed in one transaction together with the move of the mark,
and the mark moves only if it still has the value the page was read from, so
exactly one caller indexes a given page and the others re-read the mark.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping, Sequence
from typing import Any, Optional, cast

from sqlalchemy import Column, Integer, Text, inspect, select, text, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import CursorResult, Engine
from sqlalchemy.exc import OperationalError, ProgrammingError, SQLAlchemyError

from app import db

__all__ = [
    "MANIFEST_RECORD_TYPE",
    "VERSION_RECORD_TYPE",
    "PAGE_SIZE",
    "VERSIONS_MANIFEST_INDEX",
    "ContentRef",
    "ContentRefProgress",
    "backfill",
    "ensure_tables",
    "file_cids",
    "file_entries",
    "install",
    "on_manifest_record",
    "sync",
    "uninstall",
]

logger = logging.getLogger(__name__)

#: The ledger record type that lists a version's files.  The submissions plugin
#: owns it (``submissions.MANIFEST_TYPE``); it is spelled out here because that
#: plugin imports this package, so importing it back at load time is circular.
#: A test pins the two together.
MANIFEST_RECORD_TYPE = "manifest"

#: The ledger record type that may carry a version's manifest inline (plugin:
#: submissions).  Such a record is treated as a manifest listing its files.
VERSION_RECORD_TYPE = "paper.version"

#: How many manifests one transaction indexes.  Bounds memory and the time the
#: write lock is held while a long log is backfilled.
PAGE_SIZE = 500

#: Index on ``paper_versions.manifest_cid``: without it "the versions that
#: name this manifest" scans every version.  Named the way SQLAlchemy names
#: ``Column(index=True)``, so the submissions model can declare it later
#: without the two colliding.
VERSIONS_MANIFEST_INDEX = "ix_paper_versions_manifest_cid"

#: The one row of ``content_ref_progress``.
_PROGRESS_ID = 1


class ContentRef(db.Base):
    """One file a ``manifest`` record lists: the file's cid and the manifest's.

    The entry's signed ``path``, ``mediaType`` and ``role`` are copied here
    too, so serving a download can name the file without reading the
    manifest's body from the ledger on every request.
    """

    __tablename__ = "content_refs"

    # The composite primary key is the lookup index: ``content_cid`` leads it.
    content_cid = Column(Text, primary_key=True)
    manifest_cid = Column(Text, primary_key=True)
    #: The signed path inside the paper's bundle.
    path = Column(Text, nullable=True)
    #: The signed bare ``type/subtype``, when the entry names one.
    media_type = Column(Text, nullable=True)
    #: What the file is for: ``manuscript``, ``source``, ``code``, ``data``…
    role = Column(Text, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ContentRef content_cid={self.content_cid!r} "
            f"manifest_cid={self.manifest_cid!r} path={self.path!r}>"
        )


class ContentRefProgress(db.Base):
    """How far through the ledger the index has read (a single row)."""

    __tablename__ = "content_ref_progress"

    id = Column(Integer, primary_key=True, autoincrement=False)
    #: ``seq`` of the newest ``manifest`` entry whose files are in the index;
    #: ``0`` before any is.
    last_seq = Column(Integer, nullable=False, default=0, server_default="0")
    #: ``seq`` of the newest ``paper.version`` entry whose inline manifest has
    #: been indexed; ``0`` before any is.
    last_version_seq = Column(Integer, nullable=False, default=0, server_default="0")


# --------------------------------------------------------------------------- #
# Tables
# --------------------------------------------------------------------------- #

# ``main.create_app`` creates these with every other table, but the index is
# also read by code that never builds the app, and ``on_startup`` runs before
# ``create_all`` -- the same self-healing pattern as the ledger and ``blobs``.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create what the index needs, once per database engine.

    That is the index's own two tables and the tables it reads from (the
    ledger's and the submissions plugin's), plus an index on
    ``paper_versions.manifest_cid``.  The last is the one thing done to a table
    this package does not own: the download's second hop looks versions up by
    manifest, and the table has no index for that, so every download would
    scan every version.  ``CREATE INDEX IF NOT EXISTS`` is idempotent, and
    failing to create it only costs speed, so a failure is logged, not raised.
    """
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        # Imported here, not above: submissions imports this package.
        from app.modules import ledger, submissions

        ledger.ensure_table()
        submissions.ensure_tables()
        for table in (ContentRef.__table__, ContentRefProgress.__table__):
            try:
                table.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table in between.
                if not inspect(db.engine).has_table(table.name):
                    raise
        _ensure_version_progress_column()
        _ensure_ref_metadata_columns()
        _seed_progress()
        _index_versions_by_manifest()
        _table_engine = db.engine


def _ensure_version_progress_column() -> None:
    """Add ``last_version_seq`` to an older ``content_ref_progress`` table."""
    if not inspect(db.engine).has_table(ContentRefProgress.__tablename__):
        return
    columns = {column["name"] for column in inspect(db.engine).get_columns(ContentRefProgress.__tablename__)}
    if "last_version_seq" in columns:
        return
    try:
        with db.engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE content_ref_progress "
                    "ADD COLUMN last_version_seq INTEGER NOT NULL DEFAULT 0"
                )
            )
    except (OperationalError, ProgrammingError):
        if "last_version_seq" not in {
            column["name"] for column in inspect(db.engine).get_columns(ContentRefProgress.__tablename__)
        }:
            raise


def _ensure_ref_metadata_columns() -> None:
    """Add ``path``/``media_type``/``role`` to an older ``content_refs`` table.

    The columns let a download name the file without reading the manifest's
    body.  Adding them to a table built before they existed starts the index
    over (the progress marks go back to zero), which re-reads every manifest
    and fills the new columns in; without that, old rows would never gain
    them.  The re-read happens once, on the first start after the upgrade.
    """
    if not inspect(db.engine).has_table(ContentRef.__tablename__):
        return
    columns = {column["name"] for column in inspect(db.engine).get_columns(ContentRef.__tablename__)}
    added = False
    for name in ("path", "media_type", "role"):
        if name in columns:
            continue
        try:
            with db.engine.begin() as connection:
                connection.execute(
                    text(f"ALTER TABLE {ContentRef.__tablename__} ADD COLUMN {name} TEXT")
                )
            added = True
        except (OperationalError, ProgrammingError):
            # Another process added it between the check and the DDL.
            if name not in {
                column["name"]
                for column in inspect(db.engine).get_columns(ContentRef.__tablename__)
            }:
                raise
    if not added:
        return
    with db.engine.begin() as connection:
        connection.execute(
            text(
                f"UPDATE {ContentRefProgress.__tablename__} "
                "SET last_seq = 0, last_version_seq = 0"
            )
        )


def _seed_progress() -> None:
    """Make sure the single ``content_ref_progress`` row exists."""
    with db.SessionLocal() as session:
        if session.get(ContentRefProgress, _PROGRESS_ID) is not None:
            return
        session.add(ContentRefProgress(id=_PROGRESS_ID, last_seq=0))
        try:
            session.commit()
        except SQLAlchemyError:
            # Another process seeded it first: that is what was wanted.
            session.rollback()
            if session.get(ContentRefProgress, _PROGRESS_ID) is None:
                raise


def _index_versions_by_manifest() -> None:
    from app.modules.submissions.models import PaperVersion

    statement = (
        f"CREATE INDEX IF NOT EXISTS {VERSIONS_MANIFEST_INDEX} "
        f"ON {PaperVersion.__tablename__} (manifest_cid)"
    )
    try:
        with db.engine.begin() as connection:
            connection.execute(text(statement))
    except (OperationalError, ProgrammingError):
        logger.warning(
            "could not index %s.manifest_cid; content downloads will scan versions",
            PaperVersion.__tablename__,
            exc_info=True,
        )


# --------------------------------------------------------------------------- #
# Reading a manifest
# --------------------------------------------------------------------------- #


def _inline_manifest_body(body: Any) -> Any:
    """Unwrap an inline manifest carried by a ``paper.version`` body, if any."""
    if not isinstance(body, Mapping):
        return body
    manifest = body.get("manifest")
    if manifest is None:
        manifest = body.get("manifest_cid", body.get("manifestCid"))
    if isinstance(manifest, Mapping) or (
        isinstance(manifest, Sequence)
        and not isinstance(manifest, (str, bytes, bytearray))
    ):
        return manifest
    return body


def file_cids(body: Any) -> list[str]:
    """The distinct file cids a ``manifest`` (or inline manifest) body lists.

    A body that carries its manifest inline (a ``paper.version`` record whose
    ``manifest`` is an object or file list rather than a record cid) is
    unwrapped first, so inline and separate manifests are treated the same.
    Anything that is not a well-formed entry -- a body that is not an object,
    ``files`` that is not a list, an entry that is not an object or whose
    ``cid`` is not a non-empty string -- names no file, which is what the scan
    this index replaces made of it.  A file listed twice (two paths, one
    content) is one reference.
    """
    return [entry["content_cid"] for entry in file_entries(body)]


def _optional_text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() != "" else None


def file_entries(body: Any) -> list[dict[str, Any]]:
    """The distinct file entries a manifest body lists, with what names them.

    One dict per distinct ``cid`` (the first occurrence wins, as the scan this
    index replaces did), carrying the signed ``path``, ``mediaType`` and
    ``role`` alongside the cid.  A malformed field is no value rather than an
    error: the entry still names its file, and the download falls back to the
    blob's own media type.
    """
    body = _inline_manifest_body(body)
    if isinstance(body, Mapping):
        files = body.get("files")
    elif isinstance(body, Sequence) and not isinstance(body, (str, bytes, bytearray)):
        files = body
    else:
        return []
    if not isinstance(files, list):
        return []

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in files:
        if not isinstance(item, Mapping):
            continue
        cid = item.get("cid")
        if not isinstance(cid, str) or not cid or cid in seen:
            continue
        seen.add(cid)
        entries.append(
            {
                "content_cid": cid,
                "path": _optional_text(item.get("path")),
                "media_type": _optional_text(
                    item.get("mediaType", item.get("media_type"))
                ),
                "role": _optional_text(item.get("role")),
            }
        )
    return entries


# --------------------------------------------------------------------------- #
# Keeping the index complete
# --------------------------------------------------------------------------- #


def sync() -> int:
    """Index every ``manifest`` entry in the ledger the index has not read yet.

    Returns how many manifests it indexed (``0`` when the index was current,
    which costs two indexed point lookups and no writes).  See the module
    docstring for why every download calls this and for how concurrent callers
    cooperate.  An error propagates: a caller that cannot tell whether the
    index is complete must not guess that a file is unreferenced.
    """
    ensure_tables()
    from app.modules.ledger.models import EventLog

    indexed = 0
    while True:
        with db.SessionLocal() as session:
            mark = session.execute(
                select(ContentRefProgress.last_seq).where(ContentRefProgress.id == _PROGRESS_ID)
            ).scalar_one_or_none()
            if mark is None:
                # The row was removed (an operator resetting the index): put
                # it back, at the start, and index everything again.
                _seed_progress()
                continue

            # The common case ends here, without reading any entry's body.
            newest = session.execute(
                select(EventLog.seq)
                .where(EventLog.record_type == MANIFEST_RECORD_TYPE)
                .order_by(EventLog.seq.desc())
                .limit(1)
            ).scalar_one_or_none()
            if newest is None or newest <= mark:
                break

            page = session.execute(
                select(EventLog.seq, EventLog.record_cid, EventLog.body)
                .where(EventLog.record_type == MANIFEST_RECORD_TYPE, EventLog.seq > mark)
                .order_by(EventLog.seq)
                .limit(PAGE_SIZE)
            ).all()
            if not page:
                break

            # Move the mark first, and only from the value this page was read
            # for: if another caller moved it meanwhile it has indexed (or is
            # indexing) these manifests and this transaction does nothing.
            # An UPDATE's result is a ``CursorResult``; the session's stub says ``Result``.
            claimed = cast(
                "CursorResult[Any]",
                session.execute(
                    update(ContentRefProgress)
                    .where(
                        ContentRefProgress.id == _PROGRESS_ID,
                        ContentRefProgress.last_seq == mark,
                    )
                    .values(last_seq=page[-1].seq)
                ),
            )
            if claimed.rowcount != 1:
                session.rollback()
                continue

            references = [
                {**entry, "manifest_cid": row.record_cid}
                for row in page
                for entry in file_entries(row.body)
            ]
            if references:
                session.execute(_insert_references(session), references)
            session.commit()
            indexed += len(page)

    indexed += _sync_inline_versions()
    return indexed


def _sync_inline_versions() -> int:
    """Index inline manifests carried by ``paper.version`` records."""
    ensure_tables()
    from app.modules.ledger.models import EventLog

    indexed = 0
    while True:
        with db.SessionLocal() as session:
            mark = session.execute(
                select(ContentRefProgress.last_version_seq).where(
                    ContentRefProgress.id == _PROGRESS_ID
                )
            ).scalar_one_or_none()
            if mark is None:
                _seed_progress()
                continue

            newest = session.execute(
                select(EventLog.seq)
                .where(EventLog.record_type == VERSION_RECORD_TYPE)
                .order_by(EventLog.seq.desc())
                .limit(1)
            ).scalar_one_or_none()
            if newest is None or newest <= mark:
                return indexed

            page = session.execute(
                select(EventLog.seq, EventLog.record_cid, EventLog.body)
                .where(EventLog.record_type == VERSION_RECORD_TYPE, EventLog.seq > mark)
                .order_by(EventLog.seq)
                .limit(PAGE_SIZE)
            ).all()
            if not page:
                return indexed

            claimed = cast(
                "CursorResult[Any]",
                session.execute(
                    update(ContentRefProgress)
                    .where(
                        ContentRefProgress.id == _PROGRESS_ID,
                        ContentRefProgress.last_version_seq == mark,
                    )
                    .values(last_version_seq=page[-1].seq)
                ),
            )
            if claimed.rowcount != 1:
                session.rollback()
                continue

            references = [
                {**entry, "manifest_cid": row.record_cid}
                for row in page
                for entry in file_entries(row.body)
            ]
            if references:
                session.execute(_insert_references(session), references)
            session.commit()
            indexed += sum(1 for row in page if file_cids(row.body))


def _insert_references(session: Any) -> Any:
    """An INSERT into ``content_refs`` that fills in an existing row's metadata.

    Rows can pre-exist when someone reset the progress row without emptying
    the table, and the ``path``/``media_type``/``role`` columns arrived after
    the first rows did; upserting is what lets a rebuild complete and fill
    those in instead of failing or leaving them missing.  SQLite is the
    project's database (see :mod:`app.modules.ledger.triggers`); elsewhere a
    plain INSERT is used.
    """
    if session.get_bind().dialect.name == "sqlite":
        statement = sqlite_insert(ContentRef.__table__)
        return statement.on_conflict_do_update(
            index_elements=[ContentRef.content_cid, ContentRef.manifest_cid],
            set_={
                "path": statement.excluded.path,
                "media_type": statement.excluded.media_type,
                "role": statement.excluded.role,
            },
        )
    return ContentRef.__table__.insert()


def backfill() -> int:
    """Index the manifests that predate the index (run at startup); returns the count."""
    indexed = sync()
    if indexed:
        logger.info("content-reference index: indexed %d manifest record(s)", indexed)
    return indexed


def on_manifest_record(entry: Any) -> None:
    """Ledger subscriber: index the ``manifest`` record just appended.

    The entry itself is not consulted: :func:`sync` indexes everything the
    ledger holds past the mark, this record and any that an earlier missed
    notification left behind.
    """
    sync()


def install() -> None:
    """Subscribe :func:`on_manifest_record` to the ledger (idempotent)."""
    from app.modules import ledger

    ledger.subscribe(MANIFEST_RECORD_TYPE, on_manifest_record)
    ledger.subscribe(VERSION_RECORD_TYPE, on_manifest_record)


def uninstall() -> None:
    """Remove the subscription.  Intended for tests."""
    from app.modules import ledger

    ledger.unsubscribe(MANIFEST_RECORD_TYPE, on_manifest_record)
    try:
        ledger.unsubscribe(VERSION_RECORD_TYPE, on_manifest_record)
    except Exception:  # pragma: no cover - defensive
        pass
