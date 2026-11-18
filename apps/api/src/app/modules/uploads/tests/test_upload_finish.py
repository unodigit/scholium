"""Tests for moving a completed upload into the content store (feature: uploads 47).

The ``PATCH`` that delivers an upload's last byte stores the whole file in the
content store and answers ``204`` with ``Upload-Cid``: the file's raw-codec
CIDv1. Covered here: the CID is the right one (computed independently of the
code under test); the bytes, the ``blobs`` row and the upload row all agree;
earlier ``PATCH`` responses carry no CID; the staged parts are gone; and the
recovery paths — a lost response, a failed move, a dropped connection — all end
with the client able to repeat its final ``PATCH`` and get the CID.
"""

import base64
import io

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import OperationalError

from app.modules import content, uploads
from app.modules.uploads import finalize, store
from scholium_record_core import compute_file_id, parse_file_cid

from .test_upload_patch import (
    create,
    head,
    offset_of,
    part_keys,
    patch,
    run_patch_over_asgi,
    staged_bytes,
    stored_upload,
)


def b64(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def cid_of(response) -> str:
    return response.headers["upload-cid"]


def stored_bytes_at(cid: str) -> bytes:
    with content.open_blob(cid) as blob:
        return blob.read()


def staged_exists(upload_id) -> bool:
    """Whether any part of the upload is still staged in the object store."""
    return bool(part_keys(upload_id))


# --- the final PATCH answers with the CID ---------------------------------------


def test_the_final_patch_returns_the_raw_cid_of_the_whole_file(client):
    data = b"the whole file"
    upload_id = create(client, length=len(data))

    response = patch(client, upload_id, 0, data)

    assert response.status_code == 204
    assert response.content == b""
    assert offset_of(response) == len(data)
    assert cid_of(response) == compute_file_id(data)
    assert cid_of(response).startswith("bafkrei")  # CIDv1, raw codec, sha2-256, base32


def test_the_returned_cid_is_a_canonical_file_id(client):
    upload_id = create(client, length=3)
    cid = cid_of(patch(client, upload_id, 0, b"abc"))
    assert str(parse_file_cid(cid)) == cid


def test_the_cid_covers_every_part_of_a_resumed_upload(client):
    upload_id = create(client, length=10)
    first = patch(client, upload_id, 0, b"01234")
    final = patch(client, upload_id, offset_of(first), b"56789")
    assert cid_of(final) == compute_file_id(b"0123456789")


def test_a_patch_that_does_not_finish_the_upload_has_no_cid(client):
    upload_id = create(client, length=6)
    response = patch(client, upload_id, 0, b"abc")
    assert response.status_code == 204
    assert "upload-cid" not in response.headers
    assert "upload-cid" not in head(client, upload_id).headers
    assert stored_upload(upload_id).cid is None


def test_an_upload_of_unknown_length_never_gets_a_cid_until_its_length_is_reached(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})
    assert "upload-cid" not in patch(client, upload_id, 0, b"abc").headers
    assert stored_upload(upload_id).cid is None


def test_a_deferred_length_upload_is_stored_when_the_length_is_reached(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})
    patch(client, upload_id, 0, b"abc")

    # The client finishes by declaring that three bytes were all there was.
    final = patch(client, upload_id, 3, b"", **{"Upload-Length": "3"})

    assert final.status_code == 204
    assert cid_of(final) == compute_file_id(b"abc")


def test_a_deferred_length_learned_on_the_last_patch_stores_the_upload(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})
    final = patch(client, upload_id, 0, b"abcdef", **{"Upload-Length": "6"})
    assert cid_of(final) == compute_file_id(b"abcdef")


def test_a_large_upload_is_stored_whole(client):
    data = bytes(range(256)) * 12_000  # ~3 MiB, several read chunks of hashing
    upload_id = create(client, length=len(data))
    final = patch(client, upload_id, 0, data)
    assert cid_of(final) == compute_file_id(data)
    assert stored_bytes_at(cid_of(final)) == data


def test_an_empty_upload_is_stored_by_its_empty_patch(client):
    upload_id = create(client, length=0)
    final = patch(client, upload_id, 0, b"")
    assert final.status_code == 204
    assert cid_of(final) == compute_file_id(b"")
    assert content.get_blob(cid_of(final)).size == 0
    assert stored_upload(upload_id).state == "completed"


# --- where the bytes end up -----------------------------------------------------


def test_the_bytes_are_in_the_content_store_under_the_cid(client, content_root):
    upload_id = create(client, length=11)
    cid = cid_of(patch(client, upload_id, 0, b"hello world"))

    assert content.exists(cid)
    assert content.blob_path(cid) == content_root / cid
    assert stored_bytes_at(cid) == b"hello world"


def test_a_blobs_row_records_the_cid_and_size_and_starts_scanning(client):
    upload_id = create(client, length=11)
    cid = cid_of(patch(client, upload_id, 0, b"hello world"))

    blob = content.get_blob(cid)
    assert blob is not None
    assert blob.size == 11
    assert blob.scan_status == content.SCAN_SCANNING


def test_the_stored_upload_is_not_served_until_it_is_scanned(client):
    upload_id = create(client, length=3)
    cid = cid_of(patch(client, upload_id, 0, b"abc"))
    assert client.get(f"/v1/content/{cid}").status_code == 423


def test_the_upload_row_remembers_the_cid(client):
    upload_id = create(client, length=3)
    cid = cid_of(patch(client, upload_id, 0, b"abc"))

    upload = stored_upload(upload_id)
    assert upload.cid == cid
    assert upload.state == "completed"
    assert upload.upload_offset == 3


def test_the_staged_parts_are_gone_once_the_upload_is_moved(client):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    assert staged_exists(upload_id)  # still in flight

    patch(client, upload_id, 3, b"def")

    assert not staged_exists(upload_id)


def test_nothing_but_the_blob_is_left_beside_the_content_stores_entries(client, content_root):
    """The parts' own directories go with the parts: only the finished file stays."""
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    assert (content_root / "uploads").is_dir()  # in flight: staged in the object store
    cid = cid_of(patch(client, upload_id, 3, b"def"))
    assert sorted(p.name for p in content_root.iterdir() if not p.name.startswith(".")) == [cid]


def test_the_same_bytes_uploaded_twice_share_one_cid_and_blob(client, content_root):
    first = cid_of(patch(client, create(client, length=4), 0, b"same"))
    second = cid_of(patch(client, create(client, length=4), 0, b"same"))

    assert first == second
    assert [p.name for p in content_root.iterdir() if not p.name.startswith(".")] == [first]


def test_storing_the_same_bytes_again_keeps_an_earlier_scan_verdict(client):
    first = cid_of(patch(client, create(client, length=4), 0, b"same"))
    content.set_scan_status(first, content.SCAN_PASSED)

    second = cid_of(patch(client, create(client, length=4), 0, b"same"))

    assert second == first
    assert content.get_blob(first).scan_status == content.SCAN_PASSED


# --- the declared media type ----------------------------------------------------


def test_the_declared_filetype_becomes_the_blobs_media_type(client):
    upload_id = create(client, length=4, **{"Upload-Metadata": f"filetype {b64('application/pdf')}"})
    cid = cid_of(patch(client, upload_id, 0, b"%PDF"))
    assert content.get_blob(cid).media_type == "application/pdf"


def test_an_upload_without_a_declared_media_type_is_stored_without_one(client):
    cid = cid_of(patch(client, create(client, length=3), 0, b"abc"))
    assert content.get_blob(cid).media_type is None


def test_a_malformed_media_type_does_not_fail_the_upload(client):
    upload_id = create(client, length=3, **{"Upload-Metadata": f"filetype {b64('not a media type')}"})
    final = patch(client, upload_id, 0, b"abc")
    assert final.status_code == 204
    assert content.get_blob(cid_of(final)).media_type is None


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        ("", None),
        (f"filetype {b64('application/pdf')}", "application/pdf"),
        (f"filetype {b64('Application/PDF; charset=binary')}", "application/pdf"),
        (f"filename {b64('paper.pdf')}", None),  # a file name is not a declaration
        (f"kind {b64('pdf')}", None),  # a size class is not a media type
        (f"filetype {b64('nope')},mimetype {b64('application/zip')}", "application/zip"),
        (f"filetype {b64('application/pdf')},mimetype {b64('application/zip')}", "application/pdf"),
        ("filetype", None),
    ],
)
def test_declared_media_type(metadata, expected):
    assert finalize.declared_media_type(metadata) == expected


# --- repeating the final PATCH --------------------------------------------------


def test_repeating_the_final_patch_returns_the_same_cid(client):
    """The client lost the response: it asks again and is told, not refused."""
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    final = patch(client, upload_id, 3, b"def")

    again = patch(client, upload_id, 6, b"")

    assert again.status_code == 204
    assert offset_of(again) == 6
    assert cid_of(again) == cid_of(final)


def test_repeating_it_with_a_streamed_empty_body_works_too(client):
    upload_id = create(client, length=3)
    final = patch(client, upload_id, 0, b"abc")

    again = patch(client, upload_id, 3, iter([b""]))

    assert again.status_code == 204
    assert cid_of(again) == cid_of(final)


def test_repeating_the_final_patch_leaves_no_staged_file(client):
    upload_id = create(client, length=3)
    patch(client, upload_id, 0, b"abc")
    patch(client, upload_id, 3, b"")
    assert not staged_exists(upload_id)


def test_head_of_a_stored_upload_still_reports_its_offset(client):
    upload_id = create(client, length=3)
    patch(client, upload_id, 0, b"abc")
    response = head(client, upload_id)
    assert response.status_code == 200
    assert offset_of(response) == 3
    assert response.headers["upload-length"] == "3"


def test_a_stored_upload_refuses_more_bytes(client):
    upload_id = create(client, length=3)
    final = patch(client, upload_id, 0, b"abc")

    response = patch(client, upload_id, 3, b"d")

    assert response.status_code == 413
    assert response.json()["type"] == "urn:scholium:problem:upload-too-large"
    assert "upload-cid" not in response.headers
    assert stored_bytes_at(cid_of(final)) == b"abc"
    assert not staged_exists(upload_id)


def test_a_stored_upload_refuses_a_streamed_body_with_bytes(client):
    upload_id = create(client, length=3)
    final = patch(client, upload_id, 0, b"abc")

    response = patch(client, upload_id, 3, iter([b"d"]))

    assert response.status_code == 413
    assert stored_upload(upload_id).cid == cid_of(final)
    assert not staged_exists(upload_id)


def test_a_stored_upload_still_answers_409_to_the_wrong_offset(client):
    upload_id = create(client, length=3)
    patch(client, upload_id, 0, b"abc")

    response = patch(client, upload_id, 1, b"")

    assert response.status_code == 409
    assert offset_of(response) == 3
    assert "upload-cid" not in response.headers
    assert not staged_exists(upload_id)


def test_a_stored_upload_cannot_have_its_length_changed(client):
    upload_id = create(client, length=3)
    patch(client, upload_id, 0, b"abc")
    response = patch(client, upload_id, 3, b"", **{"Upload-Length": "4"})
    assert response.status_code == 400
    assert "upload-cid" not in response.headers
    assert not staged_exists(upload_id)


def test_a_stored_upload_whose_move_died_before_deleting_its_parts_is_answered_and_cleaned(client):
    """The move recorded the CID and died before deleting the parts: the repeat finishes the cleaning."""
    upload_id = create(client, length=3)
    cid = cid_of(patch(client, upload_id, 0, b"abc"))
    store.write_part(upload_id, 0, io.BytesIO(b"abc"))  # what the move failed to delete
    assert staged_exists(upload_id)

    again = patch(client, upload_id, 3, b"")

    assert cid_of(again) == cid
    assert not staged_exists(upload_id)


# --- failures and recovery ------------------------------------------------------


def test_a_failed_move_is_503_and_changes_nothing(client, monkeypatch):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")

    def disk_full(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(content, "store_stream", disk_full)
    response = patch(client, upload_id, 3, b"def")

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "upload-cid" not in response.headers
    assert stored_upload(upload_id).cid is None
    assert staged_bytes(upload_id) == b"abcdef"
    assert offset_of(head(client, upload_id)) == 6


def test_the_final_patch_can_be_repeated_after_a_failed_move(client, monkeypatch):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    real_store_stream = content.store_stream

    def disk_full(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(content, "store_stream", disk_full)
    assert patch(client, upload_id, 3, b"def").status_code == 503
    monkeypatch.setattr(content, "store_stream", real_store_stream)

    retry = patch(client, upload_id, 6, b"")

    assert retry.status_code == 204
    assert cid_of(retry) == compute_file_id(b"abcdef")
    assert stored_bytes_at(cid_of(retry)) == b"abcdef"
    assert stored_upload(upload_id).cid == cid_of(retry)
    assert not staged_exists(upload_id)


def test_bytes_stored_but_not_recorded_are_adopted_by_the_repeat(client, monkeypatch):
    """The move died after the content store had the bytes, before the upload row knew."""
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    real_record_cid = store.record_cid

    def database_down(*args, **kwargs):
        raise OperationalError("UPDATE uploads", {}, Exception("database is locked"))

    monkeypatch.setattr(store, "record_cid", database_down)
    assert patch(client, upload_id, 3, b"def").status_code == 503
    monkeypatch.setattr(store, "record_cid", real_record_cid)
    assert stored_upload(upload_id).cid is None
    assert staged_exists(upload_id)

    retry = patch(client, upload_id, 6, b"")

    assert retry.status_code == 204
    assert cid_of(retry) == compute_file_id(b"abcdef")
    assert stored_upload(upload_id).cid == cid_of(retry)
    assert not staged_exists(upload_id)


def test_the_final_patch_waits_for_another_writer_to_let_go(client):
    upload_id = create(client, length=3)
    patch(client, upload_id, 0, b"ab")
    held = store.acquire_lock(upload_id)
    try:
        assert patch(client, upload_id, 2, b"c").status_code == 423
    finally:
        held.release()

    final = patch(client, upload_id, 2, b"c")

    assert cid_of(final) == compute_file_id(b"abc")


def test_a_connection_dropped_right_after_the_last_byte_still_stores_the_upload(client):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")

    run_patch_over_asgi(
        upload_id,
        3,
        [
            {"type": "http.request", "body": b"def", "more_body": True},
            {"type": "http.disconnect"},
        ],
    )

    assert stored_upload(upload_id).cid == compute_file_id(b"abcdef")
    assert not staged_exists(upload_id)
    again = patch(client, upload_id, 6, b"")
    assert cid_of(again) == compute_file_id(b"abcdef")


def test_a_dropped_connection_short_of_the_end_stores_nothing(client):
    upload_id = create(client, length=9)
    run_patch_over_asgi(
        upload_id,
        0,
        [
            {"type": "http.request", "body": b"abc", "more_body": True},
            {"type": "http.disconnect"},
        ],
    )
    assert stored_upload(upload_id).cid is None
    assert staged_bytes(upload_id) == b"abc"


# --- upgrading a database from before the cid column ----------------------------

_OLD_UPLOADS_TABLE = """
CREATE TABLE uploads (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    upload_length BIGINT,
    defer_length BOOLEAN NOT NULL,
    upload_offset BIGINT NOT NULL,
    upload_metadata TEXT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    state VARCHAR(16) NOT NULL,
    owner_did VARCHAR(256),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""


@pytest.fixture
def old_database(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as connection:
        connection.execute(text(_OLD_UPLOADS_TABLE))
        connection.execute(
            text(
                "INSERT INTO uploads (id, upload_length, defer_length, upload_offset, upload_metadata, kind, state) "
                "VALUES ('old', 5, 0, 2, '', 'other', 'pending')"
            )
        )
    yield engine
    engine.dispose()


def column_names(engine) -> set[str]:
    return {column["name"] for column in inspect(engine).get_columns("uploads")}


def test_ensure_columns_adds_cid_and_completed_at_to_an_old_uploads_table(old_database):
    assert "cid" not in column_names(old_database)
    assert "completed_at" not in column_names(old_database)

    assert store.ensure_columns(old_database) == ["cid", "completed_at"]

    assert "cid" in column_names(old_database)
    assert "completed_at" in column_names(old_database)
    with old_database.connect() as connection:
        row = connection.execute(text("SELECT upload_offset, cid, completed_at FROM uploads WHERE id = 'old'")).one()
    assert tuple(row) == (2, None, None)  # existing uploads survive, unstored


def test_ensure_columns_is_idempotent(old_database):
    store.ensure_columns(old_database)
    assert store.ensure_columns(old_database) == []


def test_ensure_columns_restores_a_dropped_column_on_the_live_database(client):
    """The ALTER must be valid for the database that is running, not only for SQLite."""
    from app import db

    # A pool of its own: SQLite checks an ALTER against the schema each
    # *connection* has cached, and the shared pool's connections still hold the
    # one from before the DROP below.
    engine = db.build_engine(db.engine.url.render_as_string(hide_password=False))
    try:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE uploads DROP COLUMN completed_at"))
        try:
            assert store.ensure_columns(engine) == ["completed_at"]
        finally:
            store.ensure_columns(engine)

        column = next(c for c in inspect(engine).get_columns("uploads") if c["name"] == "completed_at")
        assert column["nullable"] is True
        if engine.dialect.name == "postgresql":
            assert column["type"].timezone is True  # the model's DateTime(timezone=True)
    finally:
        engine.dispose()


def test_ensure_columns_leaves_a_missing_table_to_create_all(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'empty.db'}")
    try:
        assert store.ensure_columns(engine) == []
        assert not inspect(engine).has_table("uploads")
    finally:
        engine.dispose()


def test_ensure_columns_has_nothing_to_do_for_a_current_table(client):
    from app.db import engine

    assert store.ensure_columns(engine) == []


def test_the_startup_hook_upgrades_the_database_it_is_pointed_at(old_database, monkeypatch):
    monkeypatch.setattr(uploads, "engine", old_database)

    uploads.on_startup(None)

    assert "cid" in column_names(old_database)


def test_the_module_loader_can_call_the_startup_hook(old_database, monkeypatch):
    from fastapi import FastAPI

    from app import module_loader

    monkeypatch.setattr(uploads, "engine", old_database)

    module_loader._call_hook(uploads.on_startup, FastAPI())

    assert "cid" in column_names(old_database)
