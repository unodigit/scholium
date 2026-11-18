"""Tests for the content store (feature 43).

Covers: bytes stored under their raw-codec CIDv1 in the object store, the
``blobs`` row (cid, size, media_type, scan_status), idempotent re-stores,
streaming, media-type validation, the cid-keying's safety, and the write
guarantees (no partial objects, no row without bytes).  The blob API
(``write_bytes``/``write_stream``/``open_blob``/``exists`` plus
``delete_blob``/``blob_size``/``local_copy``) is exercised against the
default filesystem backend -- including data written by the layout the
previous, path-based store used -- and against the S3 driver served by moto
in-process, so the same guarantees hold on both.  The download route's
streaming and its ``Range`` answers are here too: ``206`` with the
headers an unranged ``GET`` carries, ``416`` past the end, everything else
served in full.

Isolation note: xdist workers get their own database file but tests in a worker
share the ``blobs`` table, so every test stores unique random bytes and asserts
on its own cid rather than on table totals.  ``CONTENT_DIR`` is fresh per test
(see ``conftest.py``).
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path

import boto3
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws
from scholium_record_core import compute_file_id, compute_record_id
from scholium_record_core import manifest as record_manifest
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app import db, module_loader
from app.modules import content
from app.modules.content import service, store
from app.storage.s3 import S3ObjectStore


AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"

#: A real dag-cbor *record* id: a valid CID, but not a file id.
RECORD_ID = compute_record_id(
    {
        "v": 1,
        "type": "test.content",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {},
        "proofs": [],
    }
)


def unique_bytes(n: int = 64) -> bytes:
    return os.urandom(n)


def blob_rows(cid: str) -> list[tuple]:
    with db.SessionLocal() as session:
        return list(
            session.execute(
                text("SELECT cid, size, media_type, scan_status FROM blobs WHERE cid = :cid"),
                {"cid": cid},
            )
        )


def blob_files(root: Path) -> list[str]:
    """Names of the finished blobs in ``root`` (the ``.tmp`` directory excluded)."""
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if p.name != store.TMP_DIRNAME)


def tmp_files(root: Path) -> list[str]:
    tmp = root / store.TMP_DIRNAME
    return sorted(p.name for p in tmp.iterdir()) if tmp.exists() else []


# --------------------------------------------------------------------------- #
# storing bytes: the file and the blobs row
# --------------------------------------------------------------------------- #


def test_store_bytes_writes_file_named_by_raw_cid(content_root):
    data = unique_bytes()
    blob = content.store_bytes(data, media_type="application/pdf")

    assert blob.cid == compute_file_id(data)
    assert blob.cid.startswith("bafkrei")
    assert (content_root / blob.cid).read_bytes() == data
    assert content.blob_path(blob.cid) == content_root / blob.cid
    assert content.exists(blob.cid)


def test_store_bytes_records_cid_size_media_type_and_scan_status():
    data = unique_bytes(1234)
    blob = content.store_bytes(data, media_type="application/pdf")

    assert (blob.cid, blob.size, blob.media_type, blob.scan_status) == (
        compute_file_id(data),
        1234,
        "application/pdf",
        content.SCAN_SCANNING,
    )
    # ...and the same values are what the table holds.
    assert blob_rows(blob.cid) == [(blob.cid, 1234, "application/pdf", "scanning")]


def test_media_type_is_optional_and_stored_as_null():
    blob = content.store_bytes(unique_bytes())

    assert blob.media_type is None
    assert blob_rows(blob.cid)[0][2] is None


def test_empty_file_is_stored_with_size_zero(content_root):
    blob = content.store_bytes(b"")

    assert blob.cid == compute_file_id(b"")
    assert blob.size == 0
    assert (content_root / blob.cid).read_bytes() == b""
    assert blob_rows(blob.cid) == [(blob.cid, 0, None, "scanning")]


@pytest.mark.parametrize("wrap", [bytes, bytearray, memoryview])
def test_store_bytes_accepts_any_bytes_like(wrap):
    data = unique_bytes()

    assert content.store_bytes(wrap(data)).cid == compute_file_id(data)


@pytest.mark.parametrize("bad", ["text", 12, None, ["a"]])
def test_store_bytes_rejects_non_bytes(bad, content_root):
    with pytest.raises(TypeError):
        content.store_bytes(bad)
    assert blob_files(content_root) == []


def test_blobs_table_has_the_specified_columns():
    content.ensure_table()
    columns = {c["name"]: c for c in inspect(db.engine).get_columns("blobs")}

    assert set(columns) == {"cid", "size", "media_type", "scan_status"}
    assert not columns["size"]["nullable"]
    assert not columns["scan_status"]["nullable"]
    assert columns["media_type"]["nullable"]
    assert inspect(db.engine).get_pk_constraint("blobs")["constrained_columns"] == ["cid"]


def test_size_beyond_32_bits_round_trips():
    # A bundle may be 5 GiB: ``size`` must not be a 32-bit column.
    five_gib = 5 * 1024**3
    with db.SessionLocal() as session:
        cid = compute_file_id(unique_bytes())
        content.ensure_table()
        session.add(content.Blob(cid=cid, size=five_gib, scan_status="scanning"))
        session.commit()
    assert content.get_blob(cid).size == five_gib


# --------------------------------------------------------------------------- #
# streaming
# --------------------------------------------------------------------------- #


def test_store_stream_matches_store_bytes():
    data = unique_bytes(5000)

    from_stream = content.store_stream(io.BytesIO(data), media_type="text/plain")

    assert from_stream.cid == compute_file_id(data)
    assert from_stream.size == 5000
    assert from_stream.media_type == "text/plain"


def test_store_stream_spans_multiple_chunks(monkeypatch, content_root):
    monkeypatch.setattr(store, "CHUNK_SIZE", 7)
    data = unique_bytes(100)  # 14+ chunks, the last one short

    blob = content.store_stream(io.BytesIO(data))
    assert blob.cid == compute_file_id(data)
    assert (content_root / blob.cid).read_bytes() == data

    # store_bytes slices into the same chunks and must agree.
    assert content.store_bytes(data).cid == blob.cid


def test_store_stream_handles_short_reads():
    class Dribble:
        """A raw stream that returns at most 3 bytes per read."""

        def __init__(self, data: bytes) -> None:
            self._buf = io.BytesIO(data)

        def read(self, size: int = -1) -> bytes:
            return self._buf.read(min(3, size) if size > 0 else 3)

    data = unique_bytes(100)

    assert content.store_stream(Dribble(data)).cid == compute_file_id(data)


def test_store_stream_of_real_file(tmp_path):
    source = tmp_path / "paper.pdf"
    data = unique_bytes(2 * store.CHUNK_SIZE + 123)  # crosses the real chunk size
    source.write_bytes(data)

    with source.open("rb") as handle:
        blob = content.store_stream(handle, media_type="application/pdf")

    assert blob.cid == compute_file_id(data)
    assert blob.size == len(data)
    with content.open_blob(blob.cid) as stored:
        assert stored.read() == data


def test_text_mode_stream_is_rejected_and_stores_nothing(content_root):
    with pytest.raises(TypeError, match="binary"):
        content.store_stream(io.StringIO("not bytes"))

    assert blob_files(content_root) == []
    assert tmp_files(content_root) == []


def test_failing_stream_leaves_no_partial_file(content_root):
    class Breaks:
        def __init__(self) -> None:
            self.calls = 0

        def read(self, size: int = -1) -> bytes:
            self.calls += 1
            if self.calls == 1:
                return b"first half"
            raise OSError("connection reset")

    with pytest.raises(OSError, match="connection reset"):
        content.store_stream(Breaks())

    assert blob_files(content_root) == []
    assert tmp_files(content_root) == []


def test_cid_from_digest_agrees_with_record_core():
    import hashlib

    for data in (b"", b"a", unique_bytes(1), unique_bytes(10_000)):
        assert store.cid_from_digest(hashlib.sha256(data).digest()) == compute_file_id(data)


# --------------------------------------------------------------------------- #
# idempotence
# --------------------------------------------------------------------------- #


def test_storing_the_same_bytes_twice_gives_one_file_and_one_row(content_root):
    data = unique_bytes()

    first = content.store_bytes(data, media_type="application/pdf")
    second = content.store_bytes(data, media_type="application/pdf")

    assert first.cid == second.cid
    assert blob_files(content_root) == [first.cid]
    assert len(blob_rows(first.cid)) == 1
    assert tmp_files(content_root) == []


def test_restoring_never_resets_a_scan_verdict():
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    content.set_scan_status(cid, content.SCAN_PASSED)

    again = content.store_bytes(data)

    assert again.scan_status == content.SCAN_PASSED
    assert blob_rows(cid)[0][3] == "passed"


def test_restoring_a_failed_blob_keeps_it_failed():
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    content.set_scan_status(cid, content.SCAN_FAILED)

    assert content.store_bytes(data).scan_status == content.SCAN_FAILED


def test_restoring_fills_in_a_missing_media_type_but_never_replaces_one():
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    assert content.get_blob(cid).media_type is None

    assert content.store_bytes(data, media_type="application/zip").media_type == "application/zip"
    assert content.store_bytes(data, media_type="text/plain").media_type == "application/zip"
    assert content.store_bytes(data).media_type == "application/zip"
    assert blob_rows(cid)[0][2] == "application/zip"


def test_file_without_a_row_is_adopted_by_the_next_store(content_root):
    """A crash after the file landed but before the row committed is recoverable."""
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    with db.SessionLocal() as session:
        session.execute(text("DELETE FROM blobs WHERE cid = :cid"), {"cid": cid})
        session.commit()
    assert blob_rows(cid) == []

    blob = content.store_bytes(data, media_type="text/plain")

    assert blob.cid == cid
    assert blob_rows(cid) == [(cid, len(data), "text/plain", "scanning")]
    assert (content_root / cid).read_bytes() == data


def test_row_without_a_file_is_repaired_by_the_next_store(content_root):
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    (content_root / cid).unlink()
    assert not content.exists(cid)

    content.store_bytes(data)

    assert (content_root / cid).read_bytes() == data
    assert len(blob_rows(cid)) == 1


def test_wrong_sized_file_at_a_cid_path_is_replaced(content_root):
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    (content_root / cid).write_bytes(data[:-1])  # simulated truncation

    content.store_bytes(data)

    assert (content_root / cid).read_bytes() == data


def test_a_row_disagreeing_on_size_is_a_conflict_not_silently_trusted():
    data = unique_bytes()
    cid = content.store_bytes(data).cid
    with db.SessionLocal() as session:
        session.execute(
            text("UPDATE blobs SET size = size + 1 WHERE cid = :cid"), {"cid": cid}
        )
        session.commit()

    with pytest.raises(content.BlobConflict):
        content.store_bytes(data)


def test_concurrent_stores_of_the_same_bytes_all_succeed(content_root):
    data = unique_bytes(4096)
    workers = 8
    barrier = threading.Barrier(workers)
    results: list = []
    errors: list = []

    def run() -> None:
        try:
            barrier.wait()
            results.append(content.store_bytes(data, media_type="application/pdf"))
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    cid = compute_file_id(data)
    assert {b.cid for b in results} == {cid}
    assert len(blob_rows(cid)) == 1
    assert blob_files(content_root) == [cid]
    assert tmp_files(content_root) == []


def test_losing_the_insert_race_adopts_the_winners_row(monkeypatch):
    """Both stores saw no row; the loser's INSERT hits the primary key and recovers."""
    data = unique_bytes()
    cid = content.store_bytes(data, media_type="application/pdf").cid
    real_get = Session.get
    calls = {"n": 0}

    def get_once_missing(self, *args, **kwargs):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_get(self, *args, **kwargs)

    monkeypatch.setattr(Session, "get", get_once_missing)

    blob = content.store_bytes(data)

    assert (blob.cid, blob.media_type) == (cid, "application/pdf")
    assert len(blob_rows(cid)) == 1


# --------------------------------------------------------------------------- #
# media types
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("declared", "stored"),
    [
        ("application/pdf", "application/pdf"),
        ("Application/PDF", "application/pdf"),
        ("text/plain; charset=utf-8", "text/plain"),
        ("  image/svg+xml  ", "image/svg+xml"),
        ("application/vnd.api+json;version=1", "application/vnd.api+json"),
        ("", None),
        (None, None),
    ],
)
def test_media_type_is_normalised_to_the_bare_form(declared, stored):
    assert content.normalize_media_type(declared) == stored
    assert content.store_bytes(unique_bytes(), media_type=declared).media_type == stored


@pytest.mark.parametrize(
    "bad",
    [
        "pdf",
        "*/*",
        "application/",
        "/pdf",
        "application/pdf/extra",
        "text/plain\r\nSet-Cookie: x=1",
        "text/pla in",
        "a/b\x00",
        "ünï/code",
        ";charset=utf-8",
        "a" * 200 + "/b",
        42,
    ],
)
def test_malformed_media_type_is_rejected_before_anything_is_written(bad, content_root):
    with pytest.raises(content.InvalidMediaType):
        content.store_bytes(unique_bytes(), media_type=bad)
    with pytest.raises(content.InvalidMediaType):
        content.store_stream(io.BytesIO(b"x"), media_type=bad)

    assert not content_root.exists()


def test_invalid_media_type_is_also_a_value_error():
    with pytest.raises(ValueError):
        content.store_bytes(b"x", media_type="nope")


@pytest.mark.parametrize(
    "value", ["application/pdf", "image/svg+xml", "application/vnd.api+json", "text/x-c++src"]
)
def test_accepted_media_types_satisfy_the_manifest_rule(value):
    """Guards ``service._MEDIA_TYPE_PATTERN`` against drifting from the manifest's."""
    assert record_manifest._MEDIA_TYPE_PATTERN.fullmatch(content.normalize_media_type(value))
    assert service._MEDIA_TYPE_PATTERN.pattern == record_manifest._MEDIA_TYPE_PATTERN.pattern


# --------------------------------------------------------------------------- #
# scan status and lookups
# --------------------------------------------------------------------------- #


def test_scan_status_vocabulary():
    assert content.SCAN_STATUSES == ("scanning", "passed", "failed")
    assert (content.SCAN_SCANNING, content.SCAN_PASSED, content.SCAN_FAILED) == content.SCAN_STATUSES


def test_set_scan_status_updates_the_row_and_returns_it():
    cid = content.store_bytes(unique_bytes()).cid

    updated = content.set_scan_status(cid, content.SCAN_PASSED)

    assert updated.scan_status == "passed"
    assert blob_rows(cid)[0][3] == "passed"
    assert content.get_blob(cid).scan_status == "passed"


@pytest.mark.parametrize("bad", ["", "clean", "PASSED", None, 1])
def test_set_scan_status_rejects_unknown_statuses(bad):
    cid = content.store_bytes(unique_bytes()).cid

    with pytest.raises(content.InvalidScanStatus):
        content.set_scan_status(cid, bad)
    assert content.get_blob(cid).scan_status == "scanning"


def test_set_scan_status_for_unknown_cid_raises():
    with pytest.raises(content.BlobNotFound):
        content.set_scan_status(compute_file_id(unique_bytes()), content.SCAN_PASSED)


def test_get_blob_returns_a_loaded_detached_row():
    data = unique_bytes()
    stored = content.store_bytes(data, media_type="text/plain")

    found = content.get_blob(stored.cid)

    # Attribute access after the session closed must not raise DetachedInstanceError.
    assert (found.cid, found.size, found.media_type, found.scan_status) == (
        stored.cid,
        len(data),
        "text/plain",
        "scanning",
    )


def test_get_blob_for_unknown_or_malformed_cid_is_none():
    assert content.get_blob(compute_file_id(unique_bytes())) is None
    assert content.get_blob("not-a-cid") is None
    assert content.get_blob(None) is None


# --------------------------------------------------------------------------- #
# cid -> path safety, configuration
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "../etc/passwd",
        "..",
        "/etc/passwd",
        "bafkreiabc/../../x",
        "sub/dir",
        RECORD_ID,  # a dag-cbor record id, not a file id
        compute_file_id(b"x").upper(),  # non-canonical spelling of a real file id
        None,
        42,
    ],
)
def test_blob_path_only_accepts_canonical_file_ids(bad):
    with pytest.raises(ValueError):
        content.blob_path(bad)
    assert content.exists(bad) is False


def test_open_blob_missing_bytes(content_root):
    with pytest.raises(FileNotFoundError):
        content.open_blob(compute_file_id(unique_bytes()))


@pytest.mark.parametrize("configured", ["", "   "])
def test_unconfigured_content_dir_refuses_to_write(configured, monkeypatch, tmp_path):
    monkeypatch.setattr("app.settings.settings.CONTENT_DIR", configured)
    monkeypatch.chdir(tmp_path)

    with pytest.raises(content.ContentError, match="CONTENT_DIR"):
        content.store_bytes(unique_bytes())
    assert list(tmp_path.iterdir()) == []  # nothing was scattered into the cwd


def test_content_dir_is_created_on_first_write_only(content_root):
    assert not content_root.exists()

    content.store_bytes(unique_bytes())

    assert content_root.is_dir()


def test_content_dir_follows_settings_changes(monkeypatch, tmp_path):
    other = tmp_path / "elsewhere"
    monkeypatch.setattr("app.settings.settings.CONTENT_DIR", str(other))

    blob = content.store_bytes(unique_bytes())

    assert (other / blob.cid).is_file()


# --------------------------------------------------------------------------- #
# plugin registration
# --------------------------------------------------------------------------- #


def test_module_is_discovered_and_registers_blobs_and_the_content_route():
    app = FastAPI()

    loaded = module_loader.load_modules(app)

    assert content in loaded
    assert "blobs" in db.Base.metadata.tables
    # Feature 44 adds the byte-serving route; the loader mounts it under /v1.
    assert content.router is not None
    assert "/v1/content/{cid}" in app.openapi()["paths"]


def test_create_app_creates_the_blobs_table():
    from app.main import create_app

    create_app()

    assert inspect(db.engine).has_table("blobs")


# --------------------------------------------------------------------------- #
# the object-store surface: delete_blob, blob_size, open_range, local_copy
# --------------------------------------------------------------------------- #


def test_blob_size_reports_the_stored_size():
    data = unique_bytes(1000)
    blob = content.store_bytes(data)

    assert content.blob_size(blob.cid) == 1000


def test_blob_size_of_missing_bytes():
    with pytest.raises(FileNotFoundError):
        content.blob_size(compute_file_id(unique_bytes()))


@pytest.mark.parametrize("bad", ["", "../etc/passwd", "sub/dir", RECORD_ID, None, 42])
def test_blob_size_and_delete_blob_reject_non_canonical_ids(bad):
    with pytest.raises(ValueError):
        content.blob_size(bad)
    with pytest.raises(ValueError):
        content.delete_blob(bad)


def test_delete_blob_removes_the_bytes_and_leaves_the_row_alone(content_root):
    data = unique_bytes()
    blob = content.store_bytes(data, media_type="application/pdf")

    content.delete_blob(blob.cid)

    assert not content.exists(blob.cid)
    assert blob_files(content_root) == []
    with pytest.raises(FileNotFoundError):
        content.open_blob(blob.cid)
    with pytest.raises(FileNotFoundError):
        content.blob_size(blob.cid)
    # The row is the caller's business (moderation's, in practice).
    assert blob_rows(blob.cid) == [(blob.cid, len(data), "application/pdf", "scanning")]


def test_delete_blob_of_bytes_that_are_not_there_is_a_no_op():
    content.delete_blob(compute_file_id(unique_bytes()))


def test_delete_blob_then_store_again_recreates_the_bytes(content_root):
    data = unique_bytes()
    blob = content.store_bytes(data)

    content.delete_blob(blob.cid)
    again = store.write_bytes(data)

    assert again.created is True
    assert (content_root / blob.cid).read_bytes() == data


def test_open_range_reads_a_slice_a_suffix_and_a_tail():
    data = unique_bytes(100)
    blob = content.store_bytes(data)

    with content.open_range(blob.cid, offset=10, length=5) as handle:
        assert handle.read() == data[10:15]
    with content.open_range(blob.cid, offset=90) as handle:
        assert handle.read() == data[90:]
    with content.open_range(blob.cid) as handle:  # the defaults are open_blob
        assert handle.read() == data


def test_open_range_of_missing_bytes():
    with pytest.raises(FileNotFoundError):
        content.open_range(compute_file_id(unique_bytes()), offset=0, length=1)


def test_local_copy_hands_out_a_real_file_then_removes_it():
    data = unique_bytes(500)
    blob = content.store_bytes(data)

    seen = []
    with content.local_copy(blob.cid) as path:
        assert isinstance(path, Path)
        assert path.read_bytes() == data
        # A real file, not a handle: openable by name, seekable.
        with open(path, "rb") as handle:
            handle.seek(5)
            assert handle.read(3) == data[5:8]
        seen.append(path)

    assert not seen[0].exists()


def test_local_copy_is_a_snapshot_the_stored_bytes_live_on():
    data = unique_bytes()
    blob = content.store_bytes(data)

    with content.local_copy(blob.cid) as path:
        path.write_bytes(b"scribbled on the copy")

    with content.open_blob(blob.cid) as handle:
        assert handle.read() == data


def test_local_copy_of_missing_bytes():
    with pytest.raises(FileNotFoundError):
        with content.local_copy(compute_file_id(unique_bytes())):
            raise AssertionError("the copy should not have been made")


def test_local_copy_rejects_a_non_canonical_id():
    with pytest.raises(ValueError):
        with content.local_copy("../etc/passwd"):
            raise AssertionError("not a file id")


# --------------------------------------------------------------------------- #
# STORAGE_BACKEND=fs: the previous layout's data is read as it stands
# --------------------------------------------------------------------------- #


def test_bytes_written_by_the_path_based_store_are_read_byte_for_byte(content_root):
    """An existing CONTENT_DIR keeps working: no migration, no rewrite."""
    data = unique_bytes(300)
    cid = compute_file_id(data)
    content_root.mkdir(parents=True)  # the old layout: plain files, no .tmp
    (content_root / cid).write_bytes(data)

    assert content.exists(cid)
    assert content.blob_size(cid) == len(data)
    assert content.blob_path(cid) == content_root / cid
    with content.open_blob(cid) as handle:
        assert handle.read() == data
    with content.local_copy(cid) as path:
        assert path.read_bytes() == data
    # Re-storing them changes nothing: they are already there.
    assert store.write_bytes(data).created is False
    assert (content_root / cid).read_bytes() == data


# --------------------------------------------------------------------------- #
# the same store behind the S3 driver (moto, in process)
# --------------------------------------------------------------------------- #

S3_BUCKET = "scholium-content-test"


@pytest.fixture
def s3_backend(monkeypatch):
    """Serve the content store from moto's S3: a real S3 driver, no network."""
    with mock_aws():
        client = boto3.client(
            "s3",
            region_name="us-east-1",
            aws_access_key_id="test-access-key-id",
            aws_secret_access_key="test-SECRET-access-key",
        )
        client.create_bucket(Bucket=S3_BUCKET)
        remote = S3ObjectStore(
            S3_BUCKET,
            region="us-east-1",
            access_key_id="test-access-key-id",
            secret_access_key="test-SECRET-access-key",
        )
        monkeypatch.setattr(store, "get_object_store", lambda: remote)
        yield remote


def test_the_blob_api_works_the_same_on_the_s3_backend(s3_backend, content_root):
    data = unique_bytes(400)
    blob = content.store_bytes(data, media_type="application/pdf")

    # The bytes are in the bucket, keyed by their cid...
    assert s3_backend.exists(blob.cid)
    assert s3_backend.size(blob.cid) == 400
    # ...and nowhere on the local filesystem.
    assert not content_root.exists()

    assert content.exists(blob.cid)
    assert content.blob_size(blob.cid) == 400
    with content.open_blob(blob.cid) as handle:
        assert handle.read() == data
    with content.open_range(blob.cid, offset=390, length=5) as handle:
        assert handle.read() == data[390:395]
    with content.local_copy(blob.cid) as path:
        assert path.read_bytes() == data
    # Idempotence holds there too: the same bytes again change nothing.
    assert store.write_bytes(data).created is False

    content.delete_blob(blob.cid)
    assert not content.exists(blob.cid)
    assert not s3_backend.exists(blob.cid)


def test_blob_path_has_no_answer_on_the_s3_backend(s3_backend):
    blob = content.store_bytes(unique_bytes())

    with pytest.raises(content.ContentError, match="local_copy"):
        content.blob_path(blob.cid)


def test_the_download_route_streams_and_ranges_the_s3_backend(s3_backend, content_root):
    from app.main import app

    data = unique_bytes(600)
    blob = content.store_bytes(data, media_type="text/plain")
    content.set_scan_status(blob.cid, content.SCAN_PASSED)
    with TestClient(app) as client:
        full = client.get(f"/v1/content/{blob.cid}")

        assert full.status_code == 200
        assert full.content == data
        assert full.headers["content-length"] == "600"

        part = client.get(f"/v1/content/{blob.cid}", headers={"Range": "bytes=100-109"})

        assert part.status_code == 206
        assert part.content == data[100:110]
        assert part.headers["content-range"] == "bytes 100-109/600"

    assert not content_root.exists()  # nothing was staged on disk


# --------------------------------------------------------------------------- #
# the download route: streaming and Range
# --------------------------------------------------------------------------- #


@pytest.fixture
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


def served(data: bytes, media_type: str = "application/octet-stream"):
    """A blob whose row exists, bytes are stored and scan has passed."""
    blob = content.store_bytes(data, media_type=media_type)
    content.set_scan_status(blob.cid, content.SCAN_PASSED)
    return blob


def test_a_served_file_carries_length_range_and_etag_headers(client):
    data = unique_bytes(1000)
    blob = served(data, "text/plain")

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-length"] == "1000"
    assert response.headers["accept-ranges"] == "bytes"
    # Content addressing: the file id *is* the entity tag.
    assert response.headers["etag"] == f'"{blob.cid}"'
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["content-security-policy"] == "sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("bytes=0-9", (0, 10)),
        ("bytes=10-19", (10, 20)),
        ("bytes=990-", (990, 1000)),
        ("bytes=-7", (993, 1000)),
        ("bytes=-5000", (0, 1000)),  # more than there is: all of it
        ("bytes=0-5000", (0, 1000)),  # the end is clamped to the last byte
        ("bytes=999-999", (999, 1000)),
    ],
)
def test_a_single_range_is_answered_206_with_unchanged_headers(client, header, expected):
    data = unique_bytes(1000)
    blob = served(data, "text/plain")
    start, end = expected

    response = client.get(f"/v1/content/{blob.cid}", headers={"Range": header})

    assert response.status_code == 206
    assert response.content == data[start:end]
    assert response.headers["content-range"] == f"bytes {start}-{end - 1}/1000"
    assert response.headers["content-length"] == str(end - start)
    # Everything an unranged GET carries is unchanged.
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["content-security-policy"] == "sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["etag"] == f'"{blob.cid}"'


def test_a_ranged_manifest_download_keeps_the_manifest_headers(client):
    from .test_content_download import Paper

    paper = Paper()
    paper.list()
    content.set_scan_status(paper.blob.cid, content.SCAN_PASSED)

    response = client.get(f"/v1/content/{paper.blob.cid}", headers={"Range": "bytes=0-3"})

    assert response.status_code == 206
    assert response.content == paper.data[:4]
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.headers["content-disposition"] == 'inline; filename="main.pdf"'
    assert response.headers["content-security-policy"] == "sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize(
    "header",
    [
        "bytes=1000-",  # the first byte asked for is past the end
        "bytes=1000-1001",
        "bytes=999999-",
        "bytes=-0",  # the last zero bytes: nothing can be sent
    ],
)
def test_a_range_past_the_end_is_a_416_naming_the_size(client, header):
    blob = served(unique_bytes(1000))

    response = client.get(f"/v1/content/{blob.cid}", headers={"Range": header})

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */1000"


def test_a_range_of_an_empty_file_is_a_416(client):
    blob = served(b"")

    response = client.get(f"/v1/content/{blob.cid}", headers={"Range": "bytes=0-0"})

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */0"


@pytest.mark.parametrize(
    "header",
    [
        "bytes=5-2",  # end before start: names no bytes
        "bytes=0-4,10-14",  # several ranges: the whole object is never a wrong byte
        "items=0-9",  # another unit
        "bytes=a-b",
        "bytes=-",
        "bytes=",
        "not a range at all",
    ],
)
def test_a_range_we_do_not_serve_is_ignored_and_answered_in_full(client, header):
    data = unique_bytes(100)
    blob = served(data)

    response = client.get(f"/v1/content/{blob.cid}", headers={"Range": header})

    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-length"] == "100"
    assert "content-range" not in response.headers


def test_if_range_with_the_current_etag_still_gets_the_range(client):
    data = unique_bytes(100)
    blob = served(data)

    response = client.get(
        f"/v1/content/{blob.cid}",
        headers={"Range": "bytes=10-19", "If-Range": f'"{blob.cid}"'},
    )

    assert response.status_code == 206
    assert response.content == data[10:20]
    assert response.headers["content-range"] == "bytes 10-19/100"


@pytest.mark.parametrize(
    "validator",
    [
        '"0123456789abcdef0123456789abcdef"',  # a stale tag: the old mtime-derived kind
        "Wed, 21 Oct 2015 07:28:00 GMT",  # a date: this route sends no Last-Modified
    ],
)
def test_if_range_that_does_not_match_gets_the_whole_object(client, validator):
    """RFC 9110 13.1.5: the client's partial copy may not line up, so send it all."""
    data = unique_bytes(100)
    blob = served(data)

    response = client.get(
        f"/v1/content/{blob.cid}",
        headers={"Range": "bytes=10-19", "If-Range": validator},
    )

    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-length"] == "100"
    assert "content-range" not in response.headers


def test_if_range_with_a_weak_tag_never_matches(client):
    blob = served(unique_bytes(100))

    response = client.get(
        f"/v1/content/{blob.cid}",
        headers={"Range": "bytes=10-19", "If-Range": f'W/"{blob.cid}"'},
    )

    assert response.status_code == 200
    assert "content-range" not in response.headers


def test_bytes_removed_after_the_size_check_are_a_451_not_a_broken_200(client, monkeypatch):
    """A takedown racing a download answers cleanly, before any 200 has gone out."""
    import importlib

    # ``content.router`` is the exported APIRouter, which shadows the submodule.
    content_router = importlib.import_module("app.modules.content.router")

    blob = served(unique_bytes(100))
    real_size = content_router.blob_size

    def size_then_takedown(cid):
        size = real_size(cid)
        content.delete_blob(cid)  # moderation removes the bytes right after we looked
        return size

    monkeypatch.setattr(content_router, "blob_size", size_then_takedown)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 451
    assert "removed" in response.json()["detail"]


def test_head_is_not_served_by_the_byte_route(client):
    """The route answers GET only, as it always has (a HEAD is a 405)."""
    blob = served(unique_bytes(50))

    response = client.head(f"/v1/content/{blob.cid}")

    assert response.status_code == 405


def test_bytes_that_predate_the_object_store_are_served_byte_for_byte(client, content_root):
    """A passed blob whose file was written by the old path-based store serves."""
    data = unique_bytes(200)
    cid = compute_file_id(data)
    content_root.mkdir(parents=True)
    (content_root / cid).write_bytes(data)
    content.ensure_table()
    with db.SessionLocal() as session:
        session.execute(
            text(
                "INSERT INTO blobs (cid, size, media_type, scan_status) "
                "VALUES (:cid, :size, NULL, 'passed')"
            ),
            {"cid": cid, "size": len(data)},
        )
        session.commit()

    whole = client.get(f"/v1/content/{cid}")
    part = client.get(f"/v1/content/{cid}", headers={"Range": "bytes=10-19"})

    assert whole.status_code == 200
    assert whole.content == data
    assert part.status_code == 206
    assert part.content == data[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(data)}"
