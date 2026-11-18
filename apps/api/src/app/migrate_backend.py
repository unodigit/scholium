"""Copy an existing node onto new backends: ``python -m app.migrate_backend``.

Moves a running node's data from one database and object store to another --
SQLite to PostgreSQL, the content directory to an S3 bucket, or both at once --
and proves that the copy is the node it was copied from::

    python -m app.migrate_backend \\
        --from-db sqlite:///./scholium.db \\
        --to-db postgresql://scholium:...@db.internal/scholium \\
        --from-storage fs --to-storage s3

Stop the node (and its worker) first.  The database is read in one snapshot
transaction, but the object store is not transactional, so a node that keeps
writing while it is copied can hand the copy a database and a set of blobs
that do not belong together.

What it does, in order
----------------------

1. **Refuses a non-empty target database.**  A table holding any row anywhere
   in the target is an error, and so is a source that is the target.  An empty
   schema -- the tables a freshly started node creates -- is fine.  Nothing has
   been written when this check fails.
2. **Checks the source** without writing anything: every table is one this
   version of the application knows, and the ``event_log`` hash chain is
   intact from seq 1.  A node whose log is already broken is not copied.
3. **Creates the schema** on the target from the application's own models, so
   the append-only triggers on ``event_log`` and the search index are built by
   the same code that builds them at startup, in the target dialect.
4. **Copies every table in dependency order**, in batches, each table in one
   transaction.  ``event_log`` goes in ``seq`` order with ``raw`` (and the
   hashes) exactly as bytes; on PostgreSQL the identity and serial sequences
   are then moved past the copied ids so the next append does not collide.
5. **Copies every blob.**  Each object is read once into a scratch file while
   it is hashed; if its bytes do not hash to the CID it is stored under, the
   run stops naming that CID and nothing is written for it.  What the target
   stored is checked against the same hash.
6. **Re-verifies the target**: row counts of every table; the whole
   ``event_log`` hash chain, row by row against the source, naming the first
   ``seq`` that differs; and every blob, read back and hashed against its CID.

Any failure exits non-zero with ``migrate_backend: error: ...`` on stderr,
naming the first mismatched ``seq`` or CID when that is what went wrong.  Once
step 3 has run the target database and storage may hold a partial copy, which
is the operator's to discard: a migration never resumes into it (step 1 would
refuse it).

``--dry-run`` stops after step 2 and reports counts instead: the tables and
rows, the ``event_log`` head, and how many blobs and bytes would move.  It
writes nothing -- not to the target database (a missing SQLite file is not
created), not to the target storage -- and reads no blob bytes.

Where the backends are configured
---------------------------------

``--from-db`` and ``--to-db`` take database URLs (``sqlite:///path``,
``postgresql://...``); passwords in them are never printed.  ``fs`` storage is
rooted at ``CONTENT_DIR`` and ``s3`` storage at ``S3_BUCKET`` (``S3_*`` settings
-- endpoint, region, credentials, path style), each overridable per side with
``--from-content-dir``/``--to-content-dir`` and
``--from-s3-bucket``/``--to-s3-bucket`` (also ``-s3-endpoint-url`` and
``-s3-region``).  A side's S3 credentials come from
``MIGRATE_FROM_S3_ACCESS_KEY_ID`` / ``MIGRATE_FROM_S3_SECRET_ACCESS_KEY`` (or
``MIGRATE_TO_...``) when set and from ``S3_ACCESS_KEY_ID`` /
``S3_SECRET_ACCESS_KEY`` otherwise, so secrets never travel on a command line.
When both sides name the same storage (moving only the database) no blob is
copied; every blob is still verified in place.

The search index (``search_fts``) is derived data, copied on the columns both
dialects have.  PostgreSQL also indexes author names, which SQLite does not
keep: after SQLite to PostgreSQL run ``app.modules.search.rebuild_index()`` to
fill them.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import pkgutil
import sys
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Optional, TextIO
from urllib.parse import quote

from sqlalchemy import column, func, inspect, select, text
from sqlalchemy import table as sql_table
from sqlalchemy.engine import URL, Connection, Engine, make_url
from sqlalchemy.exc import ArgumentError, SQLAlchemyError
from sqlalchemy.sql.schema import Table

from app import db
from app.db import build_engine, normalise_database_url
from app.modules.ledger.models import EventLog
from app.modules.ledger.triggers import append_only_triggers_installed
from app.modules.ledger.verify import verify_log
from app.modules.search.index import TABLE_NAME as SEARCH_TABLE
from app.settings import settings
from app.storage import FilesystemObjectStore, ObjectNotFoundError, ObjectStore, ObjectStoreError
from scholium_record_core import parse_file_cid

__all__ = [
    "BlobMismatch",
    "ChainMismatch",
    "EXIT_FAILED",
    "EXIT_OK",
    "MigrationConfig",
    "MigrationError",
    "MigrationSummary",
    "StorageSpec",
    "TargetNotEmpty",
    "main",
    "migrate",
    "schema_tables",
]

EXIT_OK = 0
#: Anything that stopped the migration: a refusal, a bad configuration, an
#: I/O failure or a mismatch.  (``argparse`` itself exits 2 on a usage error.)
EXIT_FAILED = 1

#: Rows read from the source and inserted into the target at a time.
BATCH_ROWS = 500
#: A blob up to this size is held in memory while it is hashed; larger ones
#: spill to a scratch file.
SPOOL_BYTES = 8 * 1024 * 1024
#: Bytes read from an object at a time while hashing it.
READ_CHUNK = 1024 * 1024
#: A key no object lives at, used to see whether the target storage answers.
PROBE_KEY = "migrate-backend-probe"

LOG_TABLE = EventLog.__tablename__

#: Columns the database computes itself (the PostgreSQL ``tsvector`` of
#: ``search_fts``); they cannot be inserted and are rebuilt from the others.
_GENERATED_COLUMNS = frozenset({"document"})


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


class MigrationError(Exception):
    """The migration cannot proceed, or what it produced cannot be trusted."""

    #: ``True`` once the target may hold a partial copy (set when a failure
    #: happens after the target was first written), so the operator is told to
    #: discard it before trying again.
    partial = False


class TargetNotEmpty(MigrationError):
    """The target database already holds data."""


class ChainMismatch(MigrationError):
    """The event log is not the same intact chain at ``seq``."""

    def __init__(self, seq: int, message: str) -> None:
        super().__init__(message)
        self.seq = seq


class BlobMismatch(MigrationError):
    """The bytes of the object at ``cid`` are not what its key says they are."""

    def __init__(self, cid: str, message: str) -> None:
        super().__init__(message)
        self.cid = cid


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class StorageSpec:
    """Where one side's objects live.  Secrets are kept out of ``repr``."""

    backend: str
    content_dir: str = ""
    bucket: str = ""
    endpoint_url: str = ""
    region: str = ""
    access_key_id: str = field(default="", repr=False)
    secret_access_key: str = field(default="", repr=False)
    force_path_style: bool = False

    def describe(self) -> str:
        if self.backend == "fs":
            return f"fs ({self.content_dir})"
        where = f"bucket {self.bucket}"
        return f"s3 ({where} at {self.endpoint_url})" if self.endpoint_url else f"s3 ({where})"

    def identity(self) -> tuple:
        """What makes two specs the same place, however they are spelled."""
        if self.backend == "fs":
            return ("fs", os.path.realpath(self.content_dir))
        return ("s3", self.bucket, self.endpoint_url.rstrip("/"))


@dataclass(frozen=True)
class MigrationConfig:
    from_db: str
    to_db: str
    from_storage: StorageSpec
    to_storage: StorageSpec
    dry_run: bool = False


@dataclass
class MigrationSummary:
    """What a run found (``--dry-run``) or did."""

    dry_run: bool
    tables: int = 0
    rows: int = 0
    log_entries: int = 0
    log_head: int = 0
    blobs: int = 0
    blob_bytes: int = 0
    #: ``blobs`` rows whose bytes are not in the source store.
    blobs_without_bytes: int = 0
    notes: list[str] = field(default_factory=list)


def _flag(value: str, default: bool) -> bool:
    raw = (value or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _side_env(side: str, name: str, fallback: str) -> str:
    """``MIGRATE_<SIDE>_S3_<NAME>`` when set, else ``fallback`` (the ``S3_*`` setting)."""
    value = os.environ.get(f"MIGRATE_{side.upper()}_S3_{name}", "").strip()
    return value or (fallback or "").strip()


def resolve_storage(
    side: str,
    backend: str,
    *,
    content_dir: str = "",
    bucket: str = "",
    endpoint_url: str = "",
    region: str = "",
) -> StorageSpec:
    """The :class:`StorageSpec` for ``side`` (``"from"`` or ``"to"``).

    Whatever is not given comes from the application settings (and, for S3
    credentials and path style, the ``MIGRATE_<SIDE>_S3_*`` environment
    variables first).

    Raises:
        MigrationError: the backend is unknown or lacks what it needs.
    """
    backend = (backend or "").strip().lower()
    if backend == "fs":
        root = (content_dir or settings.CONTENT_DIR or "").strip()
        if not root:
            raise MigrationError(
                f"--{side}-storage fs needs a directory: set CONTENT_DIR or pass --{side}-content-dir"
            )
        return StorageSpec("fs", content_dir=root)
    if backend == "s3":
        name = (bucket or settings.S3_BUCKET or "").strip()
        if not name:
            raise MigrationError(
                f"--{side}-storage s3 needs a bucket: set S3_BUCKET or pass --{side}-s3-bucket"
            )
        return StorageSpec(
            "s3",
            bucket=name,
            endpoint_url=(endpoint_url or settings.S3_ENDPOINT_URL or "").strip(),
            region=(region or settings.S3_REGION or "").strip(),
            access_key_id=_side_env(side, "ACCESS_KEY_ID", settings.S3_ACCESS_KEY_ID),
            secret_access_key=_side_env(side, "SECRET_ACCESS_KEY", settings.S3_SECRET_ACCESS_KEY),
            force_path_style=_flag(
                os.environ.get(f"MIGRATE_{side.upper()}_S3_FORCE_PATH_STYLE", ""),
                bool(settings.S3_FORCE_PATH_STYLE),
            ),
        )
    raise MigrationError(f"unknown --{side}-storage {backend!r}; expected fs or s3")


def build_store(spec: StorageSpec) -> ObjectStore:
    """The ObjectStore ``spec`` describes (boto3 is only loaded for ``s3``)."""
    try:
        if spec.backend == "fs":
            return FilesystemObjectStore(spec.content_dir)
        from app.storage.s3 import S3ObjectStore

        return S3ObjectStore(
            spec.bucket,
            endpoint_url=spec.endpoint_url or None,
            region=spec.region or None,
            access_key_id=spec.access_key_id or None,
            secret_access_key=spec.secret_access_key or None,
            force_path_style=spec.force_path_style,
        )
    except ObjectStoreError as exc:
        raise MigrationError(f"cannot use the {spec.backend} storage: {exc}") from exc


# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #


def _register_models() -> None:
    """Import every module that declares a table, without running any startup hook.

    ``module_loader.load_modules`` also calls each module's ``on_startup``,
    and those create tables in the *configured* database.  A migration tool
    must touch only the two databases it was given, so it imports the packages
    and nothing else.
    """
    importlib.import_module("app.jobs")
    importlib.import_module("app.middleware")
    package = importlib.import_module("app.modules")
    for info in pkgutil.iter_modules(package.__path__, package.__name__ + "."):
        importlib.import_module(info.name)


def schema_tables() -> list[Table]:
    """Every table of the application, parents before the tables that reference them.

    The shared metadata in foreign-key dependency order (ties alphabetical,
    so the order is the same on every run), then the tables of the ORCID
    module -- ``credentials`` and ``nullifiers`` -- which live on a private
    base and are not created by ``create_all``.  Every table of that base is
    taken, not just one: a table left out here makes a real node (every node
    has ``nullifiers``) fail the "tables this version does not know" check.
    """
    _register_models()
    from app.modules.orcid.models import Credential

    return [*db.Base.metadata.sorted_tables, *Credential.__table__.metadata.sorted_tables]


def _create_schema(engine: Engine, tables: Sequence[Table]) -> None:
    """Create the application's tables on ``engine``, with their triggers and indexes."""
    db.Base.metadata.create_all(bind=engine)
    for table in tables:
        if table.metadata is not db.Base.metadata:
            table.create(bind=engine, checkfirst=True)
    if not append_only_triggers_installed(engine):
        raise MigrationError(
            f"the append-only triggers on {LOG_TABLE} could not be installed on the target database"
        )


# --------------------------------------------------------------------------- #
# Databases
# --------------------------------------------------------------------------- #


def _parse_url(url: str, what: str) -> URL:
    try:
        return make_url(normalise_database_url(url))
    except ArgumentError:
        # Not echoed: a malformed URL may still carry a password.
        raise MigrationError(f"{what} is not a database URL") from None


def _describe_url(url: URL) -> str:
    return url.render_as_string(hide_password=True)


def _sqlite_file(url: URL) -> Optional[str]:
    """The file a SQLite URL names, or ``None`` for other databases and URI forms."""
    if url.get_backend_name() != "sqlite":
        return None
    path = url.database
    if not path or path == ":memory:" or path.startswith("file:"):
        return None
    return os.path.abspath(path)


def _same_database(first: URL, second: URL) -> bool:
    first_file, second_file = _sqlite_file(first), _sqlite_file(second)
    if first_file or second_file:
        return bool(first_file and second_file and os.path.realpath(first_file) == os.path.realpath(second_file))
    return first.render_as_string(hide_password=False) == second.render_as_string(hide_password=False)


def _source_engine(url: URL) -> Engine:
    """A read-only engine on the source.  SQLite is opened ``mode=ro`` and never created."""
    if url.get_backend_name() == "sqlite":
        if url.database in (None, "", ":memory:"):
            raise MigrationError("an in-memory SQLite database cannot be migrated")
        path = _sqlite_file(url)
        if path is not None:
            if not os.path.isfile(path):
                raise MigrationError(f"the source database {path} does not exist")
            url = URL.create(
                "sqlite",
                database="file:" + quote(path),
                query={"mode": "ro", "uri": "true"},
            )
    return build_engine(url.render_as_string(hide_password=False))


@contextmanager
def _snapshot(engine: Engine) -> Iterator[Connection]:
    """One connection reading one consistent, read-only view of the source."""
    connection = engine.connect()
    try:
        if engine.dialect.name == "postgresql":
            connection = connection.execution_options(
                isolation_level="REPEATABLE READ", postgresql_readonly=True
            )
        yield connection
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def _shadow_tables(connection: Connection) -> set[str]:
    """SQLite's own bookkeeping tables for virtual tables (``search_fts_data``, ...)."""
    if connection.dialect.name != "sqlite":
        return set()
    virtual = [
        row[0]
        for row in connection.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")
        )
    ]
    names = inspect(connection).get_table_names()
    return {name for name in names for owner in virtual if name.startswith(owner + "_")}


def _existing_tables(connection: Connection) -> set[str]:
    return set(inspect(connection).get_table_names()) - _shadow_tables(connection)


def _check_target_empty(engine: Engine) -> None:
    """Raise :class:`TargetNotEmpty` unless every table of the target is empty."""
    with engine.connect() as connection:
        for name in sorted(_existing_tables(connection)):
            if connection.execute(select(1).select_from(sql_table(name)).limit(1)).first() is None:
                continue
            rows = connection.execute(select(func.count()).select_from(sql_table(name))).scalar_one()
            raise TargetNotEmpty(
                f"the target database is not empty: table {name} holds {rows} row{'s' if rows != 1 else ''}; "
                "migrate into a freshly created database with no data in it"
            )


# --------------------------------------------------------------------------- #
# Reading and copying tables
# --------------------------------------------------------------------------- #


@dataclass
class TablePlan:
    """One table to copy: what to read, in which order, and how many rows it has."""

    table: Any
    columns: list[Any]
    order_by: list[Any]
    rows: int
    #: Derived data whose columns need not match between dialects.
    derived: bool = False

    @property
    def name(self) -> str:
        return self.table.name


def _plan_tables(connection: Connection, tables: Sequence[Table]) -> list[TablePlan]:
    """What to copy from the source, in dependency order.

    Raises:
        MigrationError: the source has a table, or a column, that this
            version of the schema does not define -- copying around it would
            silently drop data.
    """
    inspector = inspect(connection)
    present = _existing_tables(connection)
    known = {table.name for table in tables} | {SEARCH_TABLE}
    unknown = sorted(present - known)
    if unknown:
        raise MigrationError(
            "the source database has tables this version does not know and would not copy: "
            + ", ".join(unknown)
        )
    plans: list[TablePlan] = []
    for table in tables:
        if table.name not in present:
            continue
        have = {entry["name"] for entry in inspector.get_columns(table.name)}
        extra = sorted(have - {col.name for col in table.columns})
        if extra:
            raise MigrationError(
                f"the source table {table.name} has columns this version does not define: {', '.join(extra)}"
            )
        columns = [col for col in table.columns if col.name in have]
        order_by = [col for col in table.primary_key.columns if col.name in have]
        plans.append(TablePlan(table, columns, order_by, _count(connection, table)))
    if SEARCH_TABLE in present:
        names = [entry["name"] for entry in inspector.get_columns(SEARCH_TABLE)]
        names = [name for name in names if name not in _GENERATED_COLUMNS]
        index = sql_table(SEARCH_TABLE, *(column(name) for name in names))
        key = [index.c.version_cid] if "version_cid" in names else []
        plans.append(TablePlan(index, list(index.c), key, _count(connection, index), derived=True))
    return plans


def _count(connection: Connection, table: Any) -> int:
    return connection.execute(select(func.count()).select_from(table)).scalar_one()


def _batches(connection: Connection, plan: TablePlan) -> Iterator[list[dict[str, Any]]]:
    """The rows of ``plan`` in primary-key order, :data:`BATCH_ROWS` at a time."""
    statement = (
        select(*plan.columns)
        .order_by(*plan.order_by)
        .execution_options(stream_results=True, yield_per=BATCH_ROWS)
    )
    result = connection.execute(statement)
    try:
        for batch in result.mappings().partitions():
            yield [dict(row) for row in batch]
    finally:
        result.close()


def _rows(connection: Connection, plan: TablePlan) -> Iterator[dict[str, Any]]:
    for batch in _batches(connection, plan):
        yield from batch


def _copy_table(source: Connection, target: Engine, plan: TablePlan) -> int:
    """Copy ``plan``'s rows into the target in one transaction; return how many."""
    columns = plan.columns
    if plan.derived:
        # Only what both dialects keep: the target may lack (or generate) columns.
        have = {entry["name"] for entry in inspect(target).get_columns(plan.name)}
        columns = [col for col in columns if col.name in have]
    copied = 0
    with target.begin() as connection:
        for batch in _batches(source, plan):
            rows = [{col.key: row[col.key] for col in columns} for row in batch]
            connection.execute(plan.table.insert(), rows)
            copied += len(rows)
    return copied


def _reset_sequences(connection: Connection, tables: Sequence[Table]) -> None:
    """Move PostgreSQL's identity and serial sequences past the ids that were copied in.

    Rows inserted with explicit ids do not advance a sequence, so without this
    the next ordinary insert -- the next ``event_log`` append above all --
    would try to reuse seq 1.  SQLite needs nothing: an explicit rowid moves
    its own counter.
    """
    if connection.dialect.name != "postgresql":
        return
    for table in tables:
        key = table.autoincrement_column
        if key is None:
            continue
        top = connection.execute(select(func.max(key))).scalar()
        if top is None:
            continue
        connection.execute(
            text("SELECT setval(pg_get_serial_sequence(:table, :column), :value)"),
            {"table": connection.dialect.identifier_preparer.quote(table.name), "column": key.name, "value": top},
        )


# --------------------------------------------------------------------------- #
# The event log
# --------------------------------------------------------------------------- #


def _comparable(row: Mapping[str, Any]) -> dict[str, Any]:
    """``row`` with every value in a form two dialects agree on."""
    out: dict[str, Any] = {}
    for name, value in row.items():
        if isinstance(value, (bytes, bytearray, memoryview)):
            value = bytes(value)
        elif isinstance(value, (dict, list)):
            value = json.dumps(value, sort_keys=True, separators=(",", ":"))
        out[name] = value
    return out


def _check_source_chain(connection: Connection, plan: TablePlan) -> None:
    """Raise :class:`ChainMismatch` unless the source log is one intact chain from seq 1."""
    broken = verify_log(_rows(connection, plan))
    if broken is not None:
        raise ChainMismatch(
            broken, f"the source event_log hash chain is broken at seq {broken}; it was not copied"
        )


def _verify_log_copy(source: Connection, target: Connection, plan: TablePlan) -> None:
    """Check the target's log is the source's, and an intact chain, naming the first seq that is not.

    Walks both logs in ``seq`` order together.  Each target row must equal
    its source row in every column (so ``raw`` is byte for byte, and ``sig``,
    ``body`` and the rest are not quietly altered either), and the target is
    then run through :func:`~app.modules.ledger.verify.verify_log`, which
    recomputes every hash and link from seq 1.  A target that stops early or
    runs on is reported at the first seq that is missing or extra.
    """
    source_rows = _rows(source, plan)
    last_seq = 0

    def compared() -> Iterator[dict[str, Any]]:
        nonlocal last_seq
        for row in _rows(target, plan):
            seq = row["seq"]
            expected = next(source_rows, None)
            if expected is None:
                raise ChainMismatch(seq, f"seq {seq} is on the target but not in the source event_log")
            if seq < expected["seq"]:
                raise ChainMismatch(seq, f"seq {seq} is on the target but not in the source event_log")
            if seq > expected["seq"]:
                raise ChainMismatch(
                    expected["seq"], f"seq {expected['seq']} is missing from the target event_log"
                )
            left, right = _comparable(expected), _comparable(row)
            if left != right:
                differing = next(name for name in left if left[name] != right.get(name))
                raise ChainMismatch(
                    seq, f"seq {seq} differs between source and target event_log (column {differing})"
                )
            last_seq = seq
            yield row

    broken = verify_log(compared())
    if broken is not None:
        raise ChainMismatch(broken, f"the target event_log hash chain is broken at seq {broken}")
    leftover = next(source_rows, None)
    if leftover is not None:
        raise ChainMismatch(
            leftover["seq"], f"seq {leftover['seq']} is missing from the target event_log"
        )


# --------------------------------------------------------------------------- #
# Blobs
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class BlobRecord:
    """An object the migration moved, and the hash of the bytes that moved."""

    key: str
    size: int
    #: The sha2-256 of the bytes -- for a CID key, the digest the CID names.
    #: ``None`` only when storage is shared and the key is not a CID.
    digest: Optional[bytes]


def _expected_digest(key: str) -> Optional[bytes]:
    """The sha2-256 digest ``key`` promises, or ``None`` if it is not a file CID."""
    try:
        return parse_file_cid(key).raw_digest
    except ValueError:
        return None


def _cid_of(digest: bytes) -> str:
    from app.modules.content.store import cid_from_digest

    return cid_from_digest(digest)


def _hash_object(store: ObjectStore, key: str, sink: Optional[Any] = None) -> tuple[bytes, int]:
    """Read the object at ``key`` through, returning its sha2-256 and size."""
    digest = hashlib.sha256()
    size = 0
    with store.open(key) as body:
        while True:
            chunk = body.read(READ_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            if sink is not None:
                sink.write(chunk)
    return digest.digest(), size


def _list_keys(store: ObjectStore) -> list[str]:
    try:
        return list(store.list())
    except ObjectStoreError as exc:
        raise MigrationError(f"cannot list the source storage: {exc}") from exc


def _copy_blob(source: ObjectStore, target: ObjectStore, key: str) -> BlobRecord:
    """Copy one object, after checking its bytes hash to ``key``.

    The bytes are hashed while being read into a scratch buffer, and only a
    match is handed to the target, so a corrupt blob is never stored under
    the CID that vouches for it.  What the target reports storing is checked
    against the same hash; a disagreement removes the object again.
    """
    expected = _expected_digest(key)
    with tempfile.SpooledTemporaryFile(max_size=SPOOL_BYTES) as spool:
        try:
            actual, size = _hash_object(source, key, spool)
        except ObjectNotFoundError as exc:
            raise MigrationError(f"object {key} disappeared from the source storage") from exc
        except (ObjectStoreError, OSError) as exc:
            raise MigrationError(f"cannot read object {key} from the source storage: {exc}") from exc
        if expected is not None and actual != expected:
            raise BlobMismatch(
                key, f"blob {key} does not hash to its CID: its bytes hash to {_cid_of(actual)}"
            )
        spool.seek(0)
        try:
            stored = target.put_stream(key, spool)
        except (ObjectStoreError, OSError) as exc:
            raise MigrationError(f"cannot write object {key} to the target storage: {exc}") from exc
    if stored.size != size or stored.sha256 != actual:
        target.delete(key)
        raise BlobMismatch(key, f"blob {key}: the target storage did not keep the bytes it was given")
    return BlobRecord(key, size, actual)


def _verify_blob(store: ObjectStore, record: BlobRecord) -> None:
    """Read ``record``'s object back from the target and hash it against its CID."""
    key = record.key
    try:
        if record.digest is None:
            if not store.exists(key):
                raise BlobMismatch(key, f"blob {key} is missing from the target storage")
            return
        actual, size = _hash_object(store, key)
    except ObjectNotFoundError as exc:
        raise BlobMismatch(key, f"blob {key} is missing from the target storage") from exc
    except (ObjectStoreError, OSError) as exc:
        raise MigrationError(f"cannot read object {key} from the target storage: {exc}") from exc
    if actual != record.digest:
        if _expected_digest(key) is not None:
            raise BlobMismatch(
                key,
                f"blob {key} on the target does not hash to its CID: its bytes hash to {_cid_of(actual)}",
            )
        raise BlobMismatch(key, f"object {key} on the target differs from the source ({size} bytes read back)")


# --------------------------------------------------------------------------- #
# The migration
# --------------------------------------------------------------------------- #


def _say(out: TextIO, line: str = "") -> None:
    print(line, file=out, flush=True)


def _blobs_without_bytes(connection: Connection, plans: Sequence[TablePlan], keys: set[str]) -> int:
    """How many ``blobs`` rows name bytes that the source store does not hold.

    Not an error -- a takedown deletes the bytes and keeps the row -- but a
    source storage pointed at the wrong place shows up here as every row.
    """
    plan = next((plan for plan in plans if plan.name == "blobs"), None)
    if plan is None:
        return 0
    rows = connection.execute(select(plan.table.c.cid))
    return sum(1 for (cid,) in rows if cid not in keys)


def migrate(config: MigrationConfig, out: Optional[TextIO] = None) -> MigrationSummary:
    """Run the migration ``config`` describes.

    Raises:
        MigrationError: the migration was refused, could not run, or its
            result failed verification (:class:`TargetNotEmpty`,
            :class:`ChainMismatch` and :class:`BlobMismatch` name which seq
            or CID).
    """
    out = out if out is not None else sys.stdout
    source_url = _parse_url(config.from_db, "--from-db")
    target_url = _parse_url(config.to_db, "--to-db")
    if _same_database(source_url, target_url):
        raise MigrationError("--from-db and --to-db are the same database")
    shared = config.from_storage.identity() == config.to_storage.identity()

    source_store = build_store(config.from_storage)
    target_store = build_store(config.to_storage)
    if config.from_storage.backend == "fs" and not os.path.isdir(config.from_storage.content_dir):
        raise MigrationError(
            f"the source content directory {config.from_storage.content_dir} does not exist"
        )

    tables = schema_tables()
    summary = MigrationSummary(dry_run=config.dry_run)
    target_file = _sqlite_file(target_url)
    # A SQLite target that does not exist yet is empty, and connecting to it
    # would create it: a dry run must not.
    target_missing = target_file is not None and not os.path.exists(target_file)

    if target_url.get_backend_name() == "sqlite" and target_url.database in (None, "", ":memory:"):
        raise MigrationError("an in-memory SQLite database cannot be a migration target: it would vanish at exit")

    source_engine = target_engine = None
    try:
        source_engine = _source_engine(source_url)
        target_engine = build_engine(target_url.render_as_string(hide_password=False))
        if not target_missing:
            try:
                _check_target_empty(target_engine)
            except SQLAlchemyError as exc:
                raise MigrationError(f"cannot read the target database: {_brief(exc)}") from exc
        with _snapshot(source_engine) as source:
            plans = _plan_tables(source, tables)
            log_plan = next((plan for plan in plans if plan.name == LOG_TABLE), None)
            if log_plan is not None:
                _check_source_chain(source, log_plan)
                summary.log_entries = log_plan.rows
                summary.log_head = (
                    source.execute(select(func.max(log_plan.table.c.seq))).scalar() or 0
                )
            keys = _list_keys(source_store)
            summary.tables = len(plans)
            summary.rows = sum(plan.rows for plan in plans)
            summary.blobs = len(keys)
            summary.blobs_without_bytes = _blobs_without_bytes(source, plans, set(keys))

            _say(out, f"source database: {_describe_url(source_url)}")
            _say(out, f"target database: {_describe_url(target_url)} (empty)")
            _say(out, f"source storage: {config.from_storage.describe()}")
            _say(out, f"target storage: {config.to_storage.describe()}"
                      + (" (the same: blobs are verified in place, not copied)" if shared else ""))

            if config.dry_run:
                return _dry_run_report(config, summary, plans, source_store, keys, out)

            try:
                target_store.exists(PROBE_KEY)
            except ObjectStoreError as exc:
                raise MigrationError(f"cannot reach the target storage: {exc}") from exc

            try:
                return _run(
                    config, summary, plans, tables, source, target_engine,
                    source_store, target_store, keys, shared, out,
                )
            except MigrationError as exc:
                exc.partial = True
                raise
            except SQLAlchemyError as exc:
                failure = MigrationError(f"database error: {_brief(exc)}")
                failure.partial = True
                raise failure from exc
    except SQLAlchemyError as exc:
        raise MigrationError(f"database error: {_brief(exc)}") from exc
    finally:
        for engine in (source_engine, target_engine):
            if engine is not None:
                engine.dispose()


def _dry_run_report(
    config: MigrationConfig,
    summary: MigrationSummary,
    plans: list[TablePlan],
    store: ObjectStore,
    keys: list[str],
    out: TextIO,
) -> MigrationSummary:
    try:
        summary.blob_bytes = sum(store.size(key) for key in keys)
    except ObjectStoreError as exc:
        raise MigrationError(f"cannot read the source storage: {exc}") from exc
    _say(out, "dry run: nothing is written")
    _say(out, f"tables: {summary.tables} with {summary.rows} rows")
    for plan in plans:
        if plan.rows:
            _say(out, f"  {plan.name}: {plan.rows}")
    _say(out, f"event_log: {summary.log_entries} entries, head seq {summary.log_head}, hash chain intact")
    _say(out, f"blobs: {summary.blobs} objects, {summary.blob_bytes} bytes")
    if summary.blobs_without_bytes:
        _say(out, f"blob rows without stored bytes: {summary.blobs_without_bytes}")
    return summary


def _run(
    config: MigrationConfig,
    summary: MigrationSummary,
    plans: list[TablePlan],
    tables: Sequence[Table],
    source: Connection,
    target_engine: Engine,
    source_store: ObjectStore,
    target_store: ObjectStore,
    keys: list[str],
    shared: bool,
    out: TextIO,
) -> MigrationSummary:
    _create_schema(target_engine, tables)
    _say(out, "target schema created")

    for plan in plans:
        try:
            copied = _copy_table(source, target_engine, plan)
        except SQLAlchemyError as exc:
            raise MigrationError(f"copying table {plan.name} failed: {_brief(exc)}") from exc
        if copied:
            _say(out, f"copied {plan.name}: {copied} rows")
    with target_engine.begin() as connection:
        _reset_sequences(connection, tables)

    records: list[BlobRecord] = []
    for key in keys:
        if shared:
            records.append(BlobRecord(key, 0, _expected_digest(key)))
            continue
        record = _copy_blob(source_store, target_store, key)
        summary.blob_bytes += record.size
        records.append(record)
    _say(out, f"copied {len(records)} blobs" if not shared else f"found {len(records)} blobs in place")

    _say(out, "verifying the target")
    with target_engine.connect() as target:
        # The log first: it can name the seq that differs, which a bare count cannot.
        log_plan = next((plan for plan in plans if plan.name == LOG_TABLE), None)
        if log_plan is not None:
            _verify_log_copy(source, target, log_plan)
        for plan in plans:
            have = _count(target, plan.table)
            if have != plan.rows:
                raise MigrationError(
                    f"table {plan.name} has {have} rows on the target but {plan.rows} on the source"
                )
    for record in records:
        _verify_blob(target_store, record)

    _say(out, f"event_log: {summary.log_entries} entries, head seq {summary.log_head}, hash chain intact on the target")
    _say(out, f"blobs: {len(records)} objects verified against their CIDs on the target")
    _say(out, f"migrated {summary.tables} tables ({summary.rows} rows)")
    return summary


def _brief(exc: BaseException) -> str:
    """The driver's own message, without the SQL statement and its parameters."""
    inner = getattr(exc, "orig", None) or exc
    lines = str(inner).strip().splitlines()
    return lines[0] if lines else type(inner).__name__


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.migrate_backend",
        description=(
            "Copy an existing node to new backends and verify the copy: refuses a non-empty "
            "target database, copies every table and blob, then re-verifies the event_log hash "
            "chain and every blob on the target."
        ),
    )
    parser.add_argument("--from-db", required=True, metavar="URL", help="database URL of the node to copy")
    parser.add_argument("--to-db", required=True, metavar="URL", help="database URL to copy into; must be empty")
    parser.add_argument("--from-storage", required=True, choices=("fs", "s3"), help="object store of the node to copy")
    parser.add_argument("--to-storage", required=True, choices=("fs", "s3"), help="object store to copy into")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report row, entry and blob counts without writing anything (reads no blob bytes)",
    )
    for side in ("from", "to"):
        group = parser.add_argument_group(f"{side} storage (defaults: the CONTENT_DIR / S3_* settings)")
        group.add_argument(f"--{side}-content-dir", default="", metavar="DIR", help="root of fs storage")
        group.add_argument(f"--{side}-s3-bucket", default="", metavar="NAME", help="s3 bucket")
        group.add_argument(f"--{side}-s3-endpoint-url", default="", metavar="URL", help="s3 endpoint")
        group.add_argument(f"--{side}-s3-region", default="", metavar="REGION", help="s3 region")
    return parser


def _config(args: argparse.Namespace) -> MigrationConfig:
    def spec(side: str) -> StorageSpec:
        return resolve_storage(
            side,
            getattr(args, f"{side}_storage"),
            content_dir=getattr(args, f"{side}_content_dir"),
            bucket=getattr(args, f"{side}_s3_bucket"),
            endpoint_url=getattr(args, f"{side}_s3_endpoint_url"),
            region=getattr(args, f"{side}_s3_region"),
        )

    return MigrationConfig(
        from_db=args.from_db,
        to_db=args.to_db,
        from_storage=spec("from"),
        to_storage=spec("to"),
        dry_run=args.dry_run,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the command line; the exit status is 0 on success and non-zero otherwise."""
    args = _parser().parse_args(list(argv) if argv is not None else None)
    try:
        migrate(_config(args))
    except MigrationError as exc:
        print(f"migrate_backend: error: {exc}", file=sys.stderr, flush=True)
        if exc.partial:
            print(
                "migrate_backend: the target may hold a partial copy; discard it before trying again",
                file=sys.stderr,
                flush=True,
            )
        return EXIT_FAILED
    except Exception as exc:  # a CLI reports, it does not dump a traceback
        print(f"migrate_backend: error: unexpected {type(exc).__name__}: {_brief(exc)}", file=sys.stderr, flush=True)
        return EXIT_FAILED
    return EXIT_OK



if __name__ == "__main__":
    sys.exit(main())
