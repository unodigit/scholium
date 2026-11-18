"""``python -m app.migrate_backend``: copy a node to new backends and prove the copy.

Every test builds a small but real node -- a SQLite database with a valid
``event_log`` hash chain and rows in a few other tables, and a content
directory of CID-keyed blobs -- and migrates it with the real command line
(``main(argv)``), except two that run the real ``python -m`` process.  Targets
are SQLite files and filesystem directories, or an S3 bucket answered by moto,
so nothing needs a container, a network or credentials.

PostgreSQL itself is not available here, so what only PostgreSQL does (moving
its sequences past copied ids) is tested against a recording connection.
"""

from __future__ import annotations

import hashlib
import io
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws
from sqlalchemy import create_engine, insert, select, text
from sqlalchemy.engine import make_url

from app import db, migrate_backend as mb
from app.modules.ledger.hashing import GENESIS_PREV_HASH, compute_entry_hash
from app.storage import FilesystemObjectStore, StoredObject
from scholium_record_core import compute_file_id

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

BLOBS = {
    "alpha": b"alpha",
    "beta": b"beta" * 5000,
    "empty": b"",
}
#: The tables of the ORCID module, which declares them on a private base.
ORCID_TABLES = ("credentials", "nullifiers")
#: A staged object that is not a CID: copied byte for byte, but with no CID to check.
OPAQUE_KEY = "uploads/Zk3x/00000001"
OPAQUE_BYTES = b"half an upload"


# --------------------------------------------------------------------------- #
# A node to migrate
# --------------------------------------------------------------------------- #


@dataclass
class Node:
    db_path: Path
    content: Path
    entries: list[dict]
    blobs: dict[str, bytes]  # key -> bytes, CID keys and the opaque one

    @property
    def url(self) -> str:
        return f"sqlite:///{self.db_path}"

    @property
    def cids(self) -> list[str]:
        return sorted(self.blobs)


def chain(count: int) -> list[dict]:
    """``count`` event-log rows forming one valid hash chain from seq 1."""
    rows, prev = [], GENESIS_PREV_HASH
    for seq in range(1, count + 1):
        raw = bytes(range(seq, seq + 40)) + b"\x00\xff\x00"  # arbitrary bytes, NULs included
        cid = f"bafyreitest{seq:04d}"
        entry_hash = compute_entry_hash(prev, cid, raw)
        rows.append(
            dict(
                seq=seq,
                record_cid=cid,
                record_type="paper.submitted" if seq % 2 else "review.published",
                author_did=f"did:key:z6Mk{seq}",
                body={"seq": seq, "title": "Δ-ledger", "nested": {"b": 2, "a": 1}},
                raw=raw,
                sig=f"sig-{seq}" if seq % 2 else None,
                prev_hash=prev,
                entry_hash=entry_hash,
                received_at=datetime(2026, 3, 1, 12, 0, seq, 123456),
                origin_node="node.test",
            )
        )
        prev = entry_hash
    return rows


def make_node(
    root: Path, name: str = "src", *, entries: int = 4, opaque: bool = False, with_blobs: bool = True
) -> Node:
    """A SQLite database with a chain and some rows, and a content directory of blobs."""
    root.mkdir(parents=True, exist_ok=True)
    db_path, content = root / f"{name}.db", root / f"{name}-content"
    engine = create_engine(f"sqlite:///{db_path}")
    db.Base.metadata.create_all(bind=engine)
    log = chain(entries)
    tables = db.Base.metadata.tables
    store = FilesystemObjectStore(content)
    blobs: dict[str, bytes] = {}
    content.mkdir(parents=True, exist_ok=True)
    for data in BLOBS.values() if with_blobs else ():
        cid = compute_file_id(data)
        store.put_stream(cid, io.BytesIO(data))
        blobs[cid] = data
    if opaque:
        store.put_stream(OPAQUE_KEY, io.BytesIO(OPAQUE_BYTES))
        blobs[OPAQUE_KEY] = OPAQUE_BYTES
    with engine.begin() as connection:
        if log:
            connection.execute(insert(tables["event_log"]), log)
        connection.execute(
            insert(tables["accounts"]),
            [
                {"did": "did:key:alice", "tier": 2, "created_at": datetime(2026, 1, 2, 3, 4, 5)},
                {"did": "did:key:bob", "tier": 0, "created_at": datetime(2026, 1, 3, 3, 4, 5)},
            ],
        )
        connection.execute(
            insert(tables["blobs"]),
            [{"cid": compute_file_id(BLOBS["alpha"]), "size": 5, "media_type": "text/plain", "scan_status": "passed"}],
        )
        connection.execute(
            insert(tables["rate_limit_hits"]),
            [{"id": 7, "key": "k", "ts": 1.5}, {"id": 9, "key": "k", "ts": 2.25}],
        )
    engine.dispose()
    return Node(db_path, content, log, blobs)


@pytest.fixture
def node(tmp_path) -> Node:
    return make_node(tmp_path)


@pytest.fixture
def dest(tmp_path):
    """Where a migration lands: a database URL and a content directory that do not exist yet."""
    return SimpleNamespace(
        db_path=tmp_path / "dst.db",
        url=f"sqlite:///{tmp_path / 'dst.db'}",
        content=tmp_path / "dst-content",
    )


def argv(node: Node, dest, *extra: str, to_storage: str = "fs", from_storage: str = "fs") -> list[str]:
    args = [
        "--from-db", node.url,
        "--to-db", dest.url,
        "--from-storage", from_storage,
        "--to-storage", to_storage,
    ]
    if from_storage == "fs":
        args += ["--from-content-dir", str(node.content)]
    if to_storage == "fs":
        args += ["--to-content-dir", str(dest.content)]
    return [*args, *extra]


def run(capsys, args: list[str]) -> tuple[int, str, str]:
    code = mb.main(args)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def table_rows(url: str, name: str) -> list[dict]:
    table = db.Base.metadata.tables[name]
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            statement = select(table).order_by(*table.primary_key.columns)
            return [dict(row) for row in connection.execute(statement).mappings()]
    finally:
        engine.dispose()


def sql(url: str, statement: str, **params):
    """Run ``statement`` on the database at ``url`` and return its rows (``[]`` for DDL/DML)."""
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            result = connection.execute(text(statement), params)
            return list(result) if result.returns_rows else []
    finally:
        engine.dispose()


def drop_triggers(url: str) -> None:
    """Take the append-only triggers off ``event_log`` so a test can tamper with it."""
    for trigger in ("event_log_reject_update", "event_log_reject_delete", "event_log_reject_replace"):
        sql(url, f"DROP TRIGGER IF EXISTS {trigger}")


def digest_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def store_files(root: Path) -> dict[str, bytes]:
    store = FilesystemObjectStore(root)
    out = {}
    for key in store.list():
        with store.open(key) as body:
            out[key] = body.read()
    return out


# --------------------------------------------------------------------------- #
# A successful migration
# --------------------------------------------------------------------------- #


def test_migrates_the_database_and_every_blob(node, dest, capsys):
    code, out, err = run(capsys, argv(node, dest))

    assert code == 0, err
    assert err == ""
    assert store_files(dest.content) == node.blobs
    for name in ("accounts", "blobs", "rate_limit_hits"):
        assert table_rows(dest.url, name) == table_rows(node.url, name)
    assert "hash chain intact on the target" in out
    assert "3 objects verified against their CIDs" in out


def test_a_node_that_has_linked_an_orcid_id_is_migrated_with_its_orcid_tables(node, dest, capsys):
    """Every running node has the ORCID tables (``nullifiers`` too): none may stop the copy."""
    from app.modules.orcid.models import Credential, Nullifier

    engine = create_engine(node.url)
    try:
        for model in (Credential, Nullifier):
            model.__table__.create(bind=engine, checkfirst=True)
        with engine.begin() as connection:
            connection.execute(Nullifier.__table__.insert(), [{"nullifier": "ab" * 32, "did": "did:key:alice"}])
            connection.execute(
                Credential.__table__.insert(),
                [{"id": "urn:uuid:1", "did": "did:key:alice", "kind": "orcid", "vc": "{}", "status": "active"}],
            )
    finally:
        engine.dispose()

    code, out, err = run(capsys, argv(node, dest))

    assert code == 0, err
    assert sql(dest.url, "SELECT nullifier, did FROM nullifiers") == [("ab" * 32, "did:key:alice")]
    assert sql(dest.url, "SELECT id, did, status FROM credentials") == [("urn:uuid:1", "did:key:alice", "active")]


def test_tables_are_copied_in_the_metadatas_dependency_order(node, dest, capsys, monkeypatch):
    copied, real = [], mb._copy_table

    def spy(source, target, plan):
        copied.append(plan.name)
        return real(source, target, plan)

    monkeypatch.setattr(mb, "_copy_table", spy)

    assert run(capsys, argv(node, dest))[0] == 0

    expected = [t.name for t in mb.schema_tables() if t.name not in ORCID_TABLES]
    assert copied == expected + ["search_fts"]  # the metadata's foreign-key order, then the derived index


def test_event_log_arrives_in_seq_order_with_raw_bytes_unchanged(node, dest, capsys):
    code, _, err = run(capsys, argv(node, dest))

    assert code == 0, err
    copied = table_rows(dest.url, "event_log")
    assert [row["seq"] for row in copied] == [1, 2, 3, 4]
    for row, original in zip(copied, node.entries):
        assert bytes(row["raw"]) == original["raw"]  # NULs and high bytes included
        assert bytes(row["prev_hash"]) == original["prev_hash"]
        assert bytes(row["entry_hash"]) == original["entry_hash"]
        assert row == original


def test_the_copied_chain_still_verifies_with_the_ledger_verifier(node, dest, capsys):
    from app.modules.ledger.verify import verify_log

    assert run(capsys, argv(node, dest))[0] == 0
    assert verify_log(table_rows(dest.url, "event_log")) is None


def test_target_keeps_the_append_only_guarantee(node, dest, capsys):
    from sqlalchemy.exc import IntegrityError

    assert run(capsys, argv(node, dest))[0] == 0

    with pytest.raises(IntegrityError, match="append-only"):
        sql(dest.url, "UPDATE event_log SET record_type = 'x' WHERE seq = 1")
    with pytest.raises(IntegrityError, match="append-only"):
        sql(dest.url, "DELETE FROM event_log WHERE seq = 1")
    with pytest.raises(IntegrityError, match="append-only"):
        sql(dest.url, "INSERT OR REPLACE INTO event_log (seq, record_cid, record_type, author_did, body, raw,"
                      " prev_hash, entry_hash, received_at, origin_node)"
                      " VALUES (1, 'x', 't', 'd', '{}', x'00', x'00', x'00', '2026-01-01 00:00:00', 'n')")


def test_the_next_append_continues_after_the_copied_seq(node, dest, capsys):
    assert run(capsys, argv(node, dest))[0] == 0

    # SQLite's AUTOINCREMENT counter moved with the explicit seqs: no seq is reused.
    assert sql(dest.url, "SELECT seq FROM sqlite_sequence WHERE name = 'event_log'") == [(4,)]


def test_the_search_index_is_copied_on_the_columns_both_sides_have(node, dest, capsys):
    sql(node.url, "INSERT INTO search_fts (version_cid, title, abstract, body) VALUES ('v1', 'T', 'A', 'B')")

    code, _, err = run(capsys, argv(node, dest))

    assert code == 0, err
    assert sql(dest.url, "SELECT version_cid, title, abstract, body FROM search_fts") == [("v1", "T", "A", "B")]


def test_a_node_with_an_empty_log_and_no_blobs_migrates(tmp_path, dest, capsys):
    empty = make_node(tmp_path / "empty", entries=0, with_blobs=False)

    code, out, err = run(capsys, argv(empty, dest))

    assert code == 0, err
    assert "0 objects verified" in out
    assert table_rows(dest.url, "event_log") == []


def test_objects_that_are_not_cids_are_copied_byte_for_byte(tmp_path, dest, capsys):
    node = make_node(tmp_path, opaque=True)

    code, _, err = run(capsys, argv(node, dest))

    assert code == 0, err
    assert store_files(dest.content) == node.blobs
    assert store_files(dest.content)[OPAQUE_KEY] == OPAQUE_BYTES


def test_a_target_with_the_schema_but_no_rows_counts_as_empty(node, dest, capsys):
    engine = create_engine(dest.url)
    db.Base.metadata.create_all(bind=engine)  # what a freshly started node has (FTS5 bookkeeping rows included)
    engine.dispose()

    code, _, err = run(capsys, argv(node, dest))

    assert code == 0, err
    assert table_rows(dest.url, "event_log") == table_rows(node.url, "event_log")


def test_the_source_is_never_written(node, dest, capsys):
    before = digest_of(node.db_path)
    blobs_before = store_files(node.content)

    assert run(capsys, argv(node, dest))[0] == 0
    assert run(capsys, argv(node, dest, "--dry-run"))[0] != 0  # target now full: refused, still read-only

    assert digest_of(node.db_path) == before
    assert store_files(node.content) == blobs_before
    assert not Path(f"{node.db_path}-journal").exists()


def test_a_database_url_may_be_spelled_with_spaces_and_odd_characters(tmp_path, capsys):
    odd = make_node(tmp_path / "odd dir #1")
    target = SimpleNamespace(
        url=f"sqlite:///{tmp_path / 'out.db'}", content=tmp_path / "out-content", db_path=tmp_path / "out.db"
    )

    code, _, err = run(capsys, argv(odd, target))

    assert code == 0, err
    assert table_rows(target.url, "event_log") == table_rows(odd.url, "event_log")


def test_tables_larger_than_one_batch_are_copied_and_verified_whole(tmp_path, dest, capsys, monkeypatch):
    big = make_node(tmp_path, entries=10)
    monkeypatch.setattr(mb, "BATCH_ROWS", 3)

    code, _, err = run(capsys, argv(big, dest))

    assert code == 0, err
    assert table_rows(dest.url, "event_log") == big.entries


def test_blobs_larger_than_the_in_memory_buffer_spill_and_still_verify(node, dest, capsys, monkeypatch):
    monkeypatch.setattr(mb, "SPOOL_BYTES", 16)
    monkeypatch.setattr(mb, "READ_CHUNK", 7)

    code, _, err = run(capsys, argv(node, dest))

    assert code == 0, err
    assert store_files(dest.content) == node.blobs


# --------------------------------------------------------------------------- #
# S3
# --------------------------------------------------------------------------- #

TARGET_BUCKET = "scholium-target"
SOURCE_BUCKET = "scholium-source"
REGION = "test-region-1"


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        for bucket in (TARGET_BUCKET, SOURCE_BUCKET):
            client.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield client


def bucket_objects(client, bucket: str) -> dict[str, bytes]:
    keys = [item["Key"] for item in client.list_objects_v2(Bucket=bucket).get("Contents", [])]
    return {key: client.get_object(Bucket=bucket, Key=key)["Body"].read() for key in keys}


S3_TARGET = ["--to-s3-bucket", TARGET_BUCKET, "--to-s3-region", REGION]


def test_copies_blobs_from_the_filesystem_to_s3(node, dest, s3, capsys):
    code, out, err = run(capsys, argv(node, dest, *S3_TARGET, to_storage="s3"))

    assert code == 0, err
    assert bucket_objects(s3, TARGET_BUCKET) == node.blobs
    assert table_rows(dest.url, "event_log") == node.entries
    assert f"s3 (bucket {TARGET_BUCKET})" in out


def test_copies_blobs_from_s3_to_the_filesystem(node, dest, s3, capsys):
    for key, data in node.blobs.items():
        s3.put_object(Bucket=SOURCE_BUCKET, Key=key, Body=data)
    args = argv(node, dest, "--from-s3-bucket", SOURCE_BUCKET, "--from-s3-region", REGION, from_storage="s3")

    code, _, err = run(capsys, args)

    assert code == 0, err
    assert store_files(dest.content) == node.blobs


def test_s3_credentials_come_from_the_migrate_environment_and_stay_out_of_the_output(
    node, dest, s3, capsys, monkeypatch
):
    monkeypatch.setenv("MIGRATE_TO_S3_ACCESS_KEY_ID", "AKIA-migrate-to")
    monkeypatch.setenv("MIGRATE_TO_S3_SECRET_ACCESS_KEY", "super-secret-migrate-to")

    code, out, err = run(capsys, argv(node, dest, *S3_TARGET, to_storage="s3"))

    assert code == 0, err
    assert "super-secret-migrate-to" not in out + err
    assert "AKIA-migrate-to" not in out + err


def test_the_command_exactly_as_documented_takes_storage_from_the_settings(node, dest, s3, capsys, monkeypatch):
    """``--from-storage fs --to-storage s3`` and nothing else: CONTENT_DIR and S3_* say where."""
    monkeypatch.setattr(mb.settings, "CONTENT_DIR", str(node.content))
    monkeypatch.setattr(mb.settings, "S3_BUCKET", TARGET_BUCKET)
    monkeypatch.setattr(mb.settings, "S3_REGION", REGION)
    monkeypatch.setattr(mb.settings, "S3_ENDPOINT_URL", "")

    code, _, err = run(
        capsys,
        ["--from-db", node.url, "--to-db", dest.url, "--from-storage", "fs", "--to-storage", "s3"],
    )

    assert code == 0, err
    assert bucket_objects(s3, TARGET_BUCKET) == node.blobs
    assert table_rows(dest.url, "event_log") == node.entries


def test_dry_run_to_s3_writes_nothing(node, dest, s3, capsys):
    code, out, err = run(capsys, argv(node, dest, *S3_TARGET, "--dry-run", to_storage="s3"))

    assert code == 0, err
    assert bucket_objects(s3, TARGET_BUCKET) == {}
    assert not dest.db_path.exists()
    assert "dry run" in out


# --------------------------------------------------------------------------- #
# Refusals
# --------------------------------------------------------------------------- #


def test_refuses_a_target_database_with_data_and_writes_nothing(tmp_path, node, dest, capsys):
    other = make_node(tmp_path / "other", name="busy", entries=2)
    dest = SimpleNamespace(url=other.url, db_path=other.db_path, content=tmp_path / "fresh-content")
    before = digest_of(other.db_path)

    code, out, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "target database is not empty" in err
    assert "event_log holds 2 rows" in err or "holds" in err
    assert digest_of(other.db_path) == before
    assert not dest.content.exists()
    assert "partial copy" not in err  # nothing was written, so there is nothing to discard


def test_a_migration_cannot_be_run_twice_into_the_same_target(node, dest, capsys):
    assert run(capsys, argv(node, dest))[0] == 0

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "target database is not empty" in err


def test_a_dry_run_is_refused_by_a_non_empty_target_too(node, dest, capsys):
    assert run(capsys, argv(node, dest))[0] == 0

    code, _, err = run(capsys, argv(node, dest, "--dry-run"))

    assert code == mb.EXIT_FAILED
    assert "target database is not empty" in err


def test_refuses_to_copy_a_database_onto_itself(node, tmp_path, capsys):
    same = SimpleNamespace(url=node.url, db_path=node.db_path, content=tmp_path / "elsewhere")

    code, _, err = run(capsys, argv(node, same))

    assert code == mb.EXIT_FAILED
    assert "same database" in err


def test_a_missing_source_database_is_an_error_and_is_not_created(tmp_path, dest, capsys):
    missing = tmp_path / "nope.db"
    args = ["--from-db", f"sqlite:///{missing}", "--to-db", dest.url, "--from-storage", "fs", "--to-storage", "fs",
            "--from-content-dir", str(tmp_path), "--to-content-dir", str(dest.content)]

    code, _, err = run(capsys, args)

    assert code == mb.EXIT_FAILED
    assert "does not exist" in err
    assert not missing.exists()
    assert not dest.db_path.exists()


def test_a_missing_source_content_directory_is_an_error(node, dest, tmp_path, capsys):
    args = argv(node, dest)
    args[args.index("--from-content-dir") + 1] = str(tmp_path / "no-such-dir")

    code, _, err = run(capsys, args)

    assert code == mb.EXIT_FAILED
    assert "content directory" in err and "does not exist" in err
    assert not dest.db_path.exists()


def test_refuses_a_source_table_this_version_does_not_know(node, dest, capsys):
    sql(node.url, "CREATE TABLE stray_notes (id INTEGER PRIMARY KEY)")

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "stray_notes" in err
    assert not dest.db_path.exists()


def test_a_source_column_this_version_does_not_define_is_not_silently_dropped(node, dest, capsys):
    sql(node.url, "ALTER TABLE accounts ADD COLUMN nickname TEXT")

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "accounts" in err and "nickname" in err


def test_an_in_memory_database_cannot_be_the_target(node, dest, capsys):
    args = argv(node, dest)
    args[args.index("--to-db") + 1] = "sqlite://"

    code, _, err = run(capsys, args)

    assert code == mb.EXIT_FAILED
    assert "in-memory" in err


def test_a_target_in_a_directory_that_does_not_exist_fails_with_a_message(node, tmp_path, capsys):
    target = SimpleNamespace(
        url=f"sqlite:///{tmp_path / 'no-such-dir' / 'dst.db'}",
        db_path=tmp_path / "no-such-dir" / "dst.db",
        content=tmp_path / "dst-content",
    )

    code, _, err = run(capsys, argv(node, target))

    assert code == mb.EXIT_FAILED
    assert "migrate_backend: error:" in err
    assert "Traceback" not in err


def test_a_url_that_is_not_a_database_url_is_refused_without_echoing_it(node, dest, capsys):
    args = argv(node, dest)
    args[args.index("--to-db") + 1] = "not a url but hunter2"

    code, out, err = run(capsys, args)

    assert code == mb.EXIT_FAILED
    assert "hunter2" not in out + err


def test_an_unreachable_postgres_target_fails_cleanly_and_never_prints_the_password(node, tmp_path, capsys):
    target = SimpleNamespace(
        url="postgresql://scholium:hunter2-secret@127.0.0.1:1/scholium",
        db_path=tmp_path / "unused.db",
        content=tmp_path / "unused-content",
    )

    code, out, err = run(capsys, argv(node, target))

    assert code == mb.EXIT_FAILED
    assert "cannot read the target database" in err
    assert "hunter2-secret" not in out + err
    assert not target.content.exists()


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["--from-db", "x", "--to-db", "y", "--from-storage", "fs"],
        ["--from-db", "x", "--to-db", "y", "--from-storage", "ftp", "--to-storage", "fs"],
    ],
)
def test_usage_errors_exit_non_zero(args, capsys):
    with pytest.raises(SystemExit) as exit_info:
        mb.main(args)

    assert exit_info.value.code != 0
    assert "usage" in capsys.readouterr().err.lower()


def test_s3_without_a_bucket_says_which_option_to_set(node, dest, capsys, monkeypatch):
    monkeypatch.setattr(mb.settings, "S3_BUCKET", "")

    code, _, err = run(capsys, argv(node, dest, to_storage="s3"))

    assert code == mb.EXIT_FAILED
    assert "--to-s3-bucket" in err and "S3_BUCKET" in err


# --------------------------------------------------------------------------- #
# A bad source: nothing is written
# --------------------------------------------------------------------------- #


def corrupt_chain(node: Node, seq: int) -> None:
    drop_triggers(node.url)
    sql(node.url, "UPDATE event_log SET raw = x'deadbeef' WHERE seq = :seq", seq=seq)


def test_a_broken_source_chain_stops_the_run_naming_the_first_bad_seq(node, dest, capsys):
    corrupt_chain(node, 3)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 3" in err
    assert not dest.db_path.exists()
    assert not dest.content.exists()


def test_a_dry_run_also_reports_a_broken_source_chain(node, dest, capsys):
    corrupt_chain(node, 2)

    code, out, err = run(capsys, argv(node, dest, "--dry-run"))

    assert code == mb.EXIT_FAILED
    assert "seq 2" in err
    assert "intact" not in out


def test_a_removed_source_row_is_a_break_at_the_missing_seq(node, dest, capsys):
    drop_triggers(node.url)
    sql(node.url, "DELETE FROM event_log WHERE seq = 2")

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 2" in err


def test_a_blob_whose_bytes_do_not_hash_to_its_cid_is_never_stored(node, dest, capsys):
    bad = node.cids[1]
    (node.content / bad).write_bytes(b"not what the cid says")

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert bad in err
    assert "does not hash to its CID" in err
    # Nothing was stored under the CID that vouches for the wrong bytes.
    assert bad not in store_files(dest.content)
    assert "partial copy" in err  # the database had already been written


def test_the_first_corrupt_blob_is_the_one_named(node, dest, capsys):
    first, _, last = node.cids
    (node.content / first).write_bytes(b"corrupt one")
    (node.content / last).write_bytes(b"corrupt two")

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert first in err
    assert last not in err


def test_a_target_store_that_misreports_what_it_kept_is_caught_and_cleaned_up(node, dest, capsys, monkeypatch):
    class Lying:
        def __init__(self, inner):
            self.inner = inner

        def put_stream(self, key, stream):
            stored = self.inner.put_stream(key, stream)
            return StoredObject(key=key, size=stored.size, sha256=b"\x00" * 32)

        def __getattr__(self, name):
            return getattr(self.inner, name)

    real_build = mb.build_store
    monkeypatch.setattr(
        mb, "build_store", lambda spec: Lying(real_build(spec)) if spec.content_dir == str(dest.content) else real_build(spec)
    )

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert node.cids[0] in err
    assert node.cids[0] not in store_files(dest.content)


# --------------------------------------------------------------------------- #
# Re-verification of the target
# --------------------------------------------------------------------------- #


def tamper_log_after_copy(monkeypatch, tamper) -> None:
    """Run ``tamper(target_url)`` right after ``event_log`` has been copied."""
    real = mb._copy_table

    def copy_then_tamper(source, target, plan):
        copied = real(source, target, plan)
        if plan.name == "event_log":
            tamper(target.url.render_as_string(hide_password=False))
        return copied

    monkeypatch.setattr(mb, "_copy_table", copy_then_tamper)


def test_a_target_row_that_differs_from_the_source_names_its_seq(node, dest, capsys, monkeypatch):
    def tamper(url):
        drop_triggers(url)
        sql(url, "UPDATE event_log SET raw = x'00ff' WHERE seq = 3")

    tamper_log_after_copy(monkeypatch, tamper)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 3" in err
    assert "partial copy" in err


def test_a_column_the_chain_does_not_cover_is_compared_too(node, dest, capsys, monkeypatch):
    def tamper(url):
        drop_triggers(url)
        sql(url, "UPDATE event_log SET sig = 'forged' WHERE seq = 1")

    tamper_log_after_copy(monkeypatch, tamper)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 1" in err and "sig" in err


def test_a_forged_but_self_consistent_target_chain_is_still_a_mismatch(node, dest, capsys, monkeypatch):
    """Recomputing the hashes after editing a row makes the chain verify -- but it is not the source's."""

    def tamper(url):
        drop_triggers(url)
        forged = chain(4)
        raw = b"forged record"
        prev = bytes(forged[2]["entry_hash"])
        sql(url, "UPDATE event_log SET raw = :raw, entry_hash = :h WHERE seq = 4",
            raw=raw, h=compute_entry_hash(prev, forged[3]["record_cid"], raw))

    tamper_log_after_copy(monkeypatch, tamper)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 4" in err


def test_a_row_missing_from_the_middle_of_the_target_log_names_its_seq(node, dest, capsys, monkeypatch):
    def tamper(url):
        drop_triggers(url)
        sql(url, "DELETE FROM event_log WHERE seq = 2")

    tamper_log_after_copy(monkeypatch, tamper)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 2 is missing" in err


def test_a_truncated_target_log_names_the_first_missing_seq(node, dest, capsys, monkeypatch):
    def tamper(url):
        drop_triggers(url)
        sql(url, "DELETE FROM event_log WHERE seq > 2")

    tamper_log_after_copy(monkeypatch, tamper)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 3 is missing" in err


def test_an_extra_target_entry_is_named_by_seq(node, dest, capsys, monkeypatch):
    def tamper(url):
        extra = chain(5)[4]
        sql(url, "INSERT INTO event_log (seq, record_cid, record_type, author_did, body, raw, prev_hash,"
                 " entry_hash, received_at, origin_node)"
                 " VALUES (5, :cid, 't', 'd', '{}', :raw, :prev, :hash, '2026-03-01 12:00:05', 'n')",
            cid=extra["record_cid"], raw=extra["raw"], prev=extra["prev_hash"], hash=extra["entry_hash"])

    tamper_log_after_copy(monkeypatch, tamper)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "seq 5 is on the target" in err


def test_a_blob_altered_on_the_target_after_copying_is_named_by_cid(node, dest, capsys, monkeypatch):
    victim = node.cids[1]
    real = mb._copy_blob

    def copy_then_corrupt(source, target, key):
        record = real(source, target, key)
        if key == victim:
            target.put_stream(key, io.BytesIO(b"bit rot"))
        return record

    monkeypatch.setattr(mb, "_copy_blob", copy_then_corrupt)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert victim in err
    assert "target does not hash to its CID" in err


def test_a_blob_missing_from_the_target_after_copying_is_named_by_cid(node, dest, capsys, monkeypatch):
    victim = node.cids[2]
    real = mb._copy_blob

    def copy_then_lose(source, target, key):
        record = real(source, target, key)
        if key == victim:
            target.delete(key)
        return record

    monkeypatch.setattr(mb, "_copy_blob", copy_then_lose)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert victim in err
    assert "missing from the target storage" in err


def test_a_table_whose_row_count_differs_is_reported(node, dest, capsys, monkeypatch):
    real = mb._copy_table

    def copy_then_drop(source, target, plan):
        copied = real(source, target, plan)
        if plan.name == "accounts":
            sql(target.url.render_as_string(hide_password=False), "DELETE FROM accounts WHERE did = 'did:key:bob'")
        return copied

    monkeypatch.setattr(mb, "_copy_table", copy_then_drop)

    code, _, err = run(capsys, argv(node, dest))

    assert code == mb.EXIT_FAILED
    assert "accounts has 1 rows on the target but 2 on the source" in err


# --------------------------------------------------------------------------- #
# Moving only the database
# --------------------------------------------------------------------------- #


def test_when_both_sides_share_one_storage_no_blob_is_rewritten_but_all_are_verified(node, dest, capsys):
    stamps = {path: path.stat().st_mtime_ns for path in node.content.iterdir()}
    args = argv(node, dest)
    args[args.index("--to-content-dir") + 1] = str(node.content)

    code, out, err = run(capsys, args)

    assert code == 0, err
    assert "verified in place" in out
    assert {path: path.stat().st_mtime_ns for path in node.content.iterdir()} == stamps
    assert table_rows(dest.url, "event_log") == node.entries


def test_shared_storage_still_catches_a_corrupt_blob(node, dest, capsys):
    bad = node.cids[0]
    (node.content / bad).write_bytes(b"rotted in place")
    args = argv(node, dest)
    args[args.index("--to-content-dir") + 1] = str(node.content)

    code, _, err = run(capsys, args)

    assert code == mb.EXIT_FAILED
    assert bad in err


# --------------------------------------------------------------------------- #
# --dry-run
# --------------------------------------------------------------------------- #


def test_dry_run_reports_counts_and_writes_nothing(node, dest, capsys):
    source_digest = digest_of(node.db_path)

    code, out, err = run(capsys, argv(node, dest, "--dry-run"))

    assert code == 0, err
    assert "dry run" in out
    assert "  event_log: 4" in out
    assert "  accounts: 2" in out
    assert "event_log: 4 entries, head seq 4" in out
    assert f"blobs: 3 objects, {sum(len(data) for data in node.blobs.values())} bytes" in out
    assert not dest.db_path.exists()
    assert not dest.content.exists()
    assert digest_of(node.db_path) == source_digest


def test_dry_run_counts_objects_that_are_not_cids_as_blobs(tmp_path, dest, capsys):
    node = make_node(tmp_path, opaque=True)

    code, out, _ = run(capsys, argv(node, dest, "--dry-run"))

    assert code == 0
    assert "blobs: 4 objects" in out


def test_dry_run_does_not_read_blob_bytes(node, dest, capsys):
    (node.content / node.cids[0]).write_bytes(b"corrupt, but a dry run only counts")

    code, out, err = run(capsys, argv(node, dest, "--dry-run"))

    assert code == 0, err
    assert "blobs: 3 objects" in out


def test_dry_run_into_an_existing_empty_target_leaves_it_empty(node, dest, capsys):
    engine = create_engine(dest.url)
    engine.dispose()
    sql(dest.url, "CREATE TABLE marker (x INTEGER)")

    code, _, err = run(capsys, argv(node, dest, "--dry-run"))

    assert code == 0, err
    assert sql(dest.url, "SELECT name FROM sqlite_master WHERE type = 'table'") == [("marker",)]


def test_dry_run_flags_blob_rows_whose_bytes_are_not_in_the_source_storage(node, dest, capsys):
    (node.content / compute_file_id(BLOBS["alpha"])).unlink()  # a takedown removed the bytes

    code, out, _ = run(capsys, argv(node, dest, "--dry-run"))

    assert code == 0
    assert "blob rows without stored bytes: 1" in out


# --------------------------------------------------------------------------- #
# Pieces
# --------------------------------------------------------------------------- #


def test_tables_are_listed_in_foreign_key_order():
    from sqlalchemy import Column, ForeignKey, Integer, MetaData, Table

    metadata = MetaData()
    Table("child", metadata, Column("id", Integer, primary_key=True), Column("parent_id", ForeignKey("parent.id")))
    Table("parent", metadata, Column("id", Integer, primary_key=True))

    assert [table.name for table in metadata.sorted_tables] == ["parent", "child"]
    names = [table.name for table in mb.schema_tables()]
    assert names == [table.name for table in db.Base.metadata.sorted_tables] + list(ORCID_TABLES)
    assert "event_log" in names and len(names) == len(set(names))


def test_describe_url_hides_the_password():
    shown = mb._describe_url(make_url("postgresql://scholium:hunter2@db.internal/scholium"))

    assert "hunter2" not in shown
    assert "db.internal" in shown and "scholium" in shown


def test_storage_credentials_are_kept_out_of_repr(monkeypatch):
    monkeypatch.setenv("MIGRATE_FROM_S3_SECRET_ACCESS_KEY", "do-not-print")

    spec = mb.resolve_storage("from", "s3", bucket="b")

    assert spec.secret_access_key == "do-not-print"
    assert "do-not-print" not in repr(spec) and "do-not-print" not in spec.describe()


def test_side_specific_credentials_beat_the_settings(monkeypatch):
    monkeypatch.setattr(mb.settings, "S3_ACCESS_KEY_ID", "from-settings")
    monkeypatch.setattr(mb.settings, "S3_SECRET_ACCESS_KEY", "settings-secret")
    monkeypatch.setenv("MIGRATE_TO_S3_ACCESS_KEY_ID", "to-env")
    monkeypatch.delenv("MIGRATE_FROM_S3_ACCESS_KEY_ID", raising=False)

    assert mb.resolve_storage("to", "s3", bucket="b").access_key_id == "to-env"
    assert mb.resolve_storage("from", "s3", bucket="b").access_key_id == "from-settings"
    assert mb.resolve_storage("from", "s3", bucket="b").secret_access_key == "settings-secret"


def test_fs_storage_defaults_to_content_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(mb.settings, "CONTENT_DIR", str(tmp_path / "configured"))

    assert mb.resolve_storage("from", "fs").content_dir == str(tmp_path / "configured")
    assert mb.resolve_storage("from", "fs", content_dir="/elsewhere").content_dir == "/elsewhere"


def test_two_spellings_of_one_directory_are_the_same_storage(tmp_path):
    (tmp_path / "content").mkdir()
    first = mb.StorageSpec("fs", content_dir=str(tmp_path / "content"))
    second = mb.StorageSpec("fs", content_dir=str(tmp_path / "content" / ".." / "content"))

    assert first.identity() == second.identity()
    assert first.identity() != mb.StorageSpec("fs", content_dir=str(tmp_path / "other")).identity()
    assert mb.StorageSpec("s3", bucket="b", endpoint_url="http://x/").identity() == mb.StorageSpec(
        "s3", bucket="b", endpoint_url="http://x"
    ).identity()


def test_the_source_database_is_opened_read_only(node):
    from sqlalchemy.exc import OperationalError

    engine = mb._source_engine(make_url(node.url))
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM event_log")).scalar() == 4
            with pytest.raises(OperationalError, match="readonly"):
                connection.execute(text("DELETE FROM accounts"))
    finally:
        engine.dispose()


def test_a_run_moves_the_target_sequences_once_after_the_tables_are_copied(node, dest, capsys, monkeypatch):
    calls = []
    real = mb._reset_sequences

    def spy(connection, tables):
        calls.append(([table.name for table in tables], connection.dialect.name))
        return real(connection, tables)

    monkeypatch.setattr(mb, "_reset_sequences", spy)

    assert run(capsys, argv(node, dest))[0] == 0

    assert len(calls) == 1
    names, dialect = calls[0]
    assert dialect == "sqlite" and "event_log" in names


class RecordingConnection:
    """A stand-in for a PostgreSQL connection that records what it is asked to run."""

    def __init__(self, dialect: str, top=41):
        self.dialect = SimpleNamespace(name=dialect, identifier_preparer=SimpleNamespace(quote=lambda name: name))
        self.top = top
        self.calls: list[tuple[str, dict | None]] = []

    def execute(self, statement, params=None):
        self.calls.append((str(statement), params))
        return SimpleNamespace(scalar=lambda: self.top)


def test_postgres_sequences_are_moved_past_the_copied_ids():
    tables = {table.name: table for table in mb.schema_tables()}
    connection = RecordingConnection("postgresql")

    mb._reset_sequences(connection, [tables["event_log"], tables["blobs"], tables["rate_limit_hits"]])

    setvals = [(sql_text, params) for sql_text, params in connection.calls if "setval" in sql_text]
    assert [params for _, params in setvals] == [
        {"table": "event_log", "column": "seq", "value": 41},
        {"table": "rate_limit_hits", "column": "id", "value": 41},
    ]  # blobs has a text primary key: no sequence
    assert all("pg_get_serial_sequence(:table, :column)" in sql_text for sql_text, _ in setvals)


def test_an_empty_postgres_table_leaves_its_sequence_alone():
    tables = {table.name: table for table in mb.schema_tables()}
    connection = RecordingConnection("postgresql", top=None)

    mb._reset_sequences(connection, [tables["event_log"]])

    assert not any("setval" in sql_text for sql_text, _ in connection.calls)


def test_sqlite_needs_no_sequence_reset():
    connection = RecordingConnection("sqlite")

    mb._reset_sequences(connection, mb.schema_tables())

    assert connection.calls == []


# --------------------------------------------------------------------------- #
# The real process
# --------------------------------------------------------------------------- #


def run_module(*args: str, cwd: Path, configured_db: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(SRC), "DATABASE_URL": f"sqlite:///{configured_db}"}
    env.pop("SCHOLIUM_ENV", None)
    return subprocess.run(
        [sys.executable, "-m", "app.migrate_backend", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_python_dash_m_migrates_and_exits_zero_without_touching_the_configured_database(node, dest, tmp_path):
    configured = tmp_path / "configured.db"

    done = run_module(*argv(node, dest), cwd=tmp_path, configured_db=configured)

    assert done.returncode == 0, done.stderr
    assert table_rows(dest.url, "event_log") == node.entries
    assert store_files(dest.content) == node.blobs
    # The tool touches the two databases it was given, never the one DATABASE_URL names.
    assert not configured.exists()
    assert not (tmp_path / "scholium.db").exists()


def test_python_dash_m_exits_non_zero_naming_the_cid(node, dest, tmp_path):
    bad = node.cids[0]
    (node.content / bad).write_bytes(b"corrupt")

    done = run_module(*argv(node, dest), cwd=tmp_path, configured_db=tmp_path / "configured.db")

    assert done.returncode != 0
    assert bad in done.stderr
    assert done.stderr.startswith("migrate_backend: error:") or "migrate_backend: error:" in done.stderr
    assert "Traceback" not in done.stderr


def test_python_dash_m_help_documents_the_flags(tmp_path):
    done = run_module("--help", cwd=tmp_path, configured_db=tmp_path / "configured.db")

    assert done.returncode == 0
    for flag in ("--from-db", "--to-db", "--from-storage", "--to-storage", "--dry-run"):
        assert flag in done.stdout
