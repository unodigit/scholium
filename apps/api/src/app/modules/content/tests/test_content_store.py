"""Tests for the content store (feature 43).

Covers: bytes stored under their raw-codec CIDv1 in ``CONTENT_DIR``, the
``blobs`` row (cid, size, media_type, scan_status), idempotent re-stores,
streaming, media-type validation, the cid-to-path mapping's safety, and the
write guarantees (no partial files, no row without bytes).

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

import pytest
from fastapi import FastAPI
from scholium_record_core import compute_file_id, compute_record_id
from scholium_record_core import manifest as record_manifest
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app import db, module_loader
from app.modules import content
from app.modules.content import service, store


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
