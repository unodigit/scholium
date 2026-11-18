"""Tests for staging in-flight uploads in the ObjectStore (feature: object storage).

An upload in flight no longer keeps its bytes in ``CONTENT_DIR/.uploads``. Each
``PATCH`` persists the bytes it delivered as one part object under
``uploads/{id}/{start offset}`` *before* ``Upload-Offset`` advances; finishing
streams the parts in order into the content store (computing the CID as they
pass) and deletes them; the reaper deletes every part of an abandoned upload.
tus clients see the same ``204`` responses, offsets and quota errors as before.

Covered here: what a ``PATCH`` leaves in the store and when; finishing from
parts, and what happens when the parts do not add up; the lease that keeps two
requests (and the reaper) from writing one upload at once; garbage collection of
parts; the uploads an earlier release staged in ``CONTENT_DIR/.uploads``, which
the new code still finds; and that all of it behaves the same on the S3
backend (moto, in process).
"""

import io
import os
import threading
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from moto import mock_aws
from sqlalchemy import update
from sqlalchemy.exc import OperationalError

from app.db import SessionLocal
from app.modules import content
from app.modules.uploads import finalize, reaper, store
from app.settings import settings
from app.storage import ObjectStoreError, _s3_store, get_object_store
from scholium_record_core import compute_file_id

from .test_upload_patch import (
    create,
    head,
    leave_part,
    offset_of,
    part_keys,
    patch,
    run_patch_over_asgi,
    staged_bytes,
    stored_upload,
)

BUCKET = "scholium-uploads-test"
REGION = "us-east-1"
ACCESS_KEY_ID = "test-access-key-id"
SECRET = "test-SECRET-access-key-0123456789"


def key(upload_id, start) -> str:
    return store.part_key(upload_id, start)


def read_part(upload_id, start) -> bytes:
    with get_object_store().open(key(upload_id, start)) as part:
        return part.read()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def age(upload_id, hours: float) -> None:
    created = (utcnow() - timedelta(hours=hours)).replace(tzinfo=None)
    with SessionLocal() as session:
        session.execute(update(store.Upload).where(store.Upload.id == upload_id).values(created_at=created))
        session.commit()


def lease_row(upload_id):
    with SessionLocal() as session:
        return session.get(store.UploadLease, upload_id)


@pytest.fixture(params=["fs", "s3"])
def backend(request, monkeypatch):
    """Run the test once with the filesystem backend and once with S3 on moto."""
    if request.param == "fs":
        yield "fs"
        return
    with mock_aws():
        boto3.client(
            "s3", region_name=REGION, aws_access_key_id=ACCESS_KEY_ID, aws_secret_access_key=SECRET
        ).create_bucket(Bucket=BUCKET)
        monkeypatch.setattr(settings, "STORAGE_BACKEND", "s3")
        monkeypatch.setattr(settings, "S3_BUCKET", BUCKET)
        monkeypatch.setattr(settings, "S3_REGION", REGION)
        monkeypatch.setattr(settings, "S3_ACCESS_KEY_ID", ACCESS_KEY_ID)
        monkeypatch.setattr(settings, "S3_SECRET_ACCESS_KEY", SECRET)
        monkeypatch.setattr(settings, "S3_ENDPOINT_URL", "")
        monkeypatch.setattr(settings, "S3_FORCE_PATH_STYLE", 0)
        _s3_store.cache_clear()
        yield "s3"
        _s3_store.cache_clear()


# --- what a PATCH leaves in the store ---------------------------------------------------


def test_each_patch_persists_its_own_part_object(client, backend):
    upload_id = create(client, length=12)

    patch(client, upload_id, 0, b"aaaa")
    patch(client, upload_id, 4, b"bbb")

    assert part_keys(upload_id) == [key(upload_id, 0), key(upload_id, 4)]
    assert read_part(upload_id, 0) == b"aaaa"
    assert read_part(upload_id, 4) == b"bbb"
    assert offset_of(head(client, upload_id)) == 7


def test_parts_are_keyed_by_the_offset_they_start_at_under_the_upload_id(client, backend):
    upload_id = create(client, length=8)
    patch(client, upload_id, 0, b"abc")
    patch(client, upload_id, 3, b"de")

    assert part_keys(upload_id) == [f"uploads/{upload_id}/{0:019d}", f"uploads/{upload_id}/{3:019d}"]


def test_a_patch_without_bytes_stores_no_part(client, backend):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abc")

    assert patch(client, upload_id, 3, b"").status_code == 204

    assert part_keys(upload_id) == [key(upload_id, 0)]


def test_a_part_is_stored_before_the_offset_advances(client, monkeypatch):
    upload_id = create(client)
    seen = []
    real = store.advance_offset

    def spy(session, uploaded, **kwargs):
        # What the object store holds at the moment the database is asked to move the offset.
        seen.append((kwargs["new_offset"], [read_part(uploaded, 0)]))
        return real(session, uploaded, **kwargs)

    monkeypatch.setattr(store, "advance_offset", spy)

    assert patch(client, upload_id, 0, b"abcde").status_code == 204

    assert seen == [(5, [b"abcde"])]


def test_a_part_the_database_never_recorded_is_replaced_by_the_retry(client, monkeypatch):
    """The offset could not be moved: the part is unacknowledged, and the client's retry overwrites it."""
    upload_id = create(client)

    def database_down(*args, **kwargs):
        raise OperationalError("UPDATE uploads", {}, Exception("database is locked"))

    monkeypatch.setattr(store, "advance_offset", database_down)
    assert patch(client, upload_id, 0, b"first try").status_code == 503
    monkeypatch.undo()

    assert offset_of(head(client, upload_id)) == 0
    retry = patch(client, upload_id, 0, b"retry")
    assert retry.status_code == 204
    assert part_keys(upload_id) == [key(upload_id, 0)]
    assert staged_bytes(upload_id) == b"retry"


def test_a_body_past_the_declared_length_stores_no_part(client, backend):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")

    def body():
        yield b"de"
        yield b"fgh"  # 8 bytes of 6

    assert patch(client, upload_id, 3, body()).status_code == 413

    assert part_keys(upload_id) == [key(upload_id, 0)]
    assert offset_of(head(client, upload_id)) == 3


def test_the_bytes_of_a_dropped_connection_become_a_part(client):
    upload_id = create(client)
    patch(client, upload_id, 0, b"head-")

    run_patch_over_asgi(
        upload_id,
        5,
        [
            {"type": "http.request", "body": b"half ", "more_body": True},
            {"type": "http.request", "body": b"sent", "more_body": True},
            {"type": "http.disconnect"},
        ],
    )

    assert part_keys(upload_id) == [key(upload_id, 0), key(upload_id, 5)]
    assert read_part(upload_id, 5) == b"half sent"
    assert offset_of(head(client, upload_id)) == 14


def test_a_large_body_is_one_part(client, backend):
    data = bytes(range(256)) * 40_000  # 10 MiB: more than the in-memory spool holds
    upload_id = create(client, length=len(data) + 1)

    assert patch(client, upload_id, 0, data).status_code == 204

    assert part_keys(upload_id) == [key(upload_id, 0)]
    assert read_part(upload_id, 0) == data


def test_nothing_is_staged_on_the_local_disk_beside_the_content_dir(client, content_root, backend):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    assert part_keys(upload_id) == [key(upload_id, 0)]

    assert not (content_root / ".uploads").exists()
    if backend == "s3":
        # The bytes are in the bucket and nowhere on the local filesystem.
        assert not content_root.exists()
        patch(client, upload_id, 3, b"def")
        assert not content_root.exists()


# --- finishing from parts ---------------------------------------------------------------


def test_finishing_streams_the_parts_in_order_into_the_content_store(client, backend):
    chunks = [b"alpha-", b"bravo-", b"charlie"]
    data = b"".join(chunks)
    upload_id = create(client, length=len(data))
    offset = 0
    for chunk in chunks[:-1]:
        offset = offset_of(patch(client, upload_id, offset, chunk))

    final = patch(client, upload_id, offset, chunks[-1])

    assert final.status_code == 204
    cid = final.headers["upload-cid"]
    assert cid == compute_file_id(data)
    with content.open_blob(cid) as blob:
        assert blob.read() == data
    assert part_keys(upload_id) == []  # every part is gone once the bytes are stored
    assert stored_upload(upload_id).cid == cid


def test_the_content_store_is_fed_one_ordered_stream_and_hashes_what_passes(client, monkeypatch):
    upload_id = create(client, length=9)
    patch(client, upload_id, 0, b"123")
    patch(client, upload_id, 3, b"456")
    seen = []
    real = content.store_stream

    def spy(stream, **kwargs):
        seen.append(type(stream).__name__)
        return real(stream, **kwargs)

    monkeypatch.setattr(content, "store_stream", spy)

    final = patch(client, upload_id, 6, b"789")

    assert seen == ["PartsReader"]
    assert final.headers["upload-cid"] == compute_file_id(b"123456789")


def test_finishing_an_upload_of_many_parts(client, backend):
    pieces = [bytes([65 + i]) * (i + 1) for i in range(10)]
    data = b"".join(pieces)
    upload_id = create(client, length=len(data))
    offset = 0
    for piece in pieces:
        response = patch(client, upload_id, offset, piece)
        offset = offset_of(response)

    assert response.headers["upload-cid"] == compute_file_id(data)
    assert part_keys(upload_id) == []


def test_a_missing_middle_part_fails_finishing_with_410_and_stores_nothing(client):
    """Appending only checks that the last part ends at the offset; finishing reads every part."""
    upload_id = create(client, length=12)
    patch(client, upload_id, 0, b"aaa")
    patch(client, upload_id, 3, b"bbb")
    patch(client, upload_id, 6, b"ccc")
    get_object_store().delete(key(upload_id, 3))

    response = patch(client, upload_id, 9, b"ddd")

    assert response.status_code == 410
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "upload-cid" not in response.headers
    assert stored_upload(upload_id).cid is None
    assert patch(client, upload_id, 12, b"").status_code == 410  # and it stays so: the client starts over


def test_a_failed_read_of_the_parts_is_503_and_the_final_patch_can_be_repeated(client, monkeypatch):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    real = store.PartsReader.read

    def unreachable(self, size=-1, /):
        raise ObjectStoreError("the bucket is unreachable")

    monkeypatch.setattr(store.PartsReader, "read", unreachable)
    response = patch(client, upload_id, 3, b"def")
    monkeypatch.setattr(store.PartsReader, "read", real)

    assert response.status_code == 503
    assert stored_upload(upload_id).cid is None
    assert staged_bytes(upload_id) == b"abcdef"
    retry = patch(client, upload_id, 6, b"")
    assert retry.headers["upload-cid"] == compute_file_id(b"abcdef")


def test_an_unreachable_object_store_is_503_and_the_offset_does_not_move(client, monkeypatch):
    upload_id = create(client)

    def unreachable(*args, **kwargs):
        raise ObjectStoreError("the bucket is unreachable")

    monkeypatch.setattr(store, "write_part", unreachable)
    response = patch(client, upload_id, 0, b"abc")
    monkeypatch.undo()

    assert response.status_code == 503
    assert offset_of(head(client, upload_id)) == 0
    assert patch(client, upload_id, 0, b"abc").status_code == 204


def test_a_full_disk_is_503_and_the_offset_does_not_move(client, monkeypatch):
    upload_id = create(client)

    def disk_full(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(store, "write_part", disk_full)
    response = patch(client, upload_id, 0, b"abc")
    monkeypatch.undo()

    assert response.status_code == 503
    assert offset_of(head(client, upload_id)) == 0


@pytest.mark.parametrize("read_size", [1, 2, 5, 1000, -1])
def test_parts_reader_returns_the_parts_as_one_stream(client, read_size):
    upload_id = create(client, length=100)
    for start, data in [(0, b"abc"), (3, b"defgh"), (8, b"ij")]:
        leave_part(upload_id, start, data)

    with store.PartsReader(upload_id, 10) as reader:
        if read_size < 0:
            assert reader.read() == b"abcdefghij"
        else:
            out = b""
            while chunk := reader.read(read_size):
                out += chunk
            assert out == b"abcdefghij"
        assert reader.read(10) == b""  # and stays at the end


def test_parts_reader_ignores_parts_that_were_never_acknowledged(client):
    upload_id = create(client, length=100)
    leave_part(upload_id, 0, b"abc")
    leave_part(upload_id, 3, b"JUNK")

    with store.PartsReader(upload_id, 3) as reader:
        assert reader.read() == b"abc"


def test_parts_reader_of_an_empty_upload_is_empty(client):
    upload_id = create(client, length=0)
    with store.PartsReader(upload_id, 0) as reader:
        assert reader.read(10) == b""


@pytest.mark.parametrize(
    ("parts", "size"),
    [
        ([(0, b"abc"), (5, b"fgh")], 8),  # a gap between parts
        ([(0, b"abcde"), (3, b"def")], 6),  # parts overlap
        ([(0, b"abc")], 5),  # fewer bytes than acknowledged
        ([(0, b"abcdef")], 3),  # the last part runs past what was acknowledged
        ([(3, b"def")], 6),  # the first part is missing
        ([], 3),  # no parts at all
    ],
)
def test_parts_reader_refuses_parts_that_do_not_add_up(client, parts, size):
    upload_id = create(client, length=100)
    for start, data in parts:
        leave_part(upload_id, start, data)

    with store.PartsReader(upload_id, size) as reader:
        with pytest.raises(store.UploadBytesMissing):
            while reader.read(2):
                pass


def test_parts_reader_keeps_the_lease_alive_as_it_reads(client):
    upload_id = create(client, length=100)
    leave_part(upload_id, 0, b"abcdef")
    ticks = []

    with store.PartsReader(upload_id, 6, keepalive=lambda: ticks.append(1)) as reader:
        while reader.read(2):
            pass

    assert len(ticks) >= 3


def test_finalize_refuses_to_store_parts_that_do_not_add_up(client):
    upload_id = create(client, length=6)
    leave_part(upload_id, 0, b"abc")

    with pytest.raises(store.UploadBytesMissing):
        finalize.move_into_content_store(upload_id, "", 6)

    assert stored_upload(upload_id).cid is None
    assert part_keys(upload_id) == [key(upload_id, 0)]


# --- the lease --------------------------------------------------------------------------


def test_the_lease_is_exclusive_until_released(client):
    upload_id = create(client)

    first = store.acquire_lock(upload_id)
    with pytest.raises(store.UploadBusy):
        store.acquire_lock(upload_id)
    first.release()

    store.acquire_lock(upload_id).release()
    assert lease_row(upload_id) is None


def test_a_lease_is_per_upload(client):
    one, two = create(client), create(client)
    with store.acquire_lock(one):
        store.acquire_lock(two).release()


def test_leases_work_as_context_managers(client):
    upload_id = create(client)
    with store.acquire_lock(upload_id):
        with pytest.raises(store.UploadBusy):
            store.acquire_lock(upload_id)
    store.acquire_lock(upload_id).release()


def test_acquiring_the_lease_of_an_id_that_is_not_ours_is_refused(client):
    with pytest.raises(ValueError):
        store.acquire_lock("../escape")


def test_an_expired_lease_is_taken_over_and_the_old_holder_finds_out(client):
    upload_id = create(client)
    old = store.acquire_lock(upload_id)
    with SessionLocal() as session:
        session.execute(
            update(store.UploadLease)
            .where(store.UploadLease.upload_id == upload_id)
            .values(expires_at=(utcnow() - timedelta(seconds=1)).replace(tzinfo=None))
        )
        session.commit()

    new = store.acquire_lock(upload_id)

    with pytest.raises(store.LockLost):
        old.renew()
    old.release()  # the old holder's release must not free the new holder's lease
    with pytest.raises(store.UploadBusy):
        store.acquire_lock(upload_id)
    new.renew()
    new.release()


def test_renewing_extends_the_lease(client):
    upload_id = create(client)
    with store.acquire_lock(upload_id) as lock:
        with SessionLocal() as session:
            session.execute(
                update(store.UploadLease)
                .where(store.UploadLease.upload_id == upload_id)
                .values(expires_at=(utcnow() + timedelta(seconds=1)).replace(tzinfo=None))
            )
            session.commit()
        soon = lease_row(upload_id).expires_at

        lock.renew()

        assert lease_row(upload_id).expires_at > soon


def test_touch_renews_only_when_a_while_has_passed(client, monkeypatch):
    upload_id = create(client)
    with store.acquire_lock(upload_id) as lock:
        renewals = []
        monkeypatch.setattr(lock, "renew", lambda: renewals.append(1))

        lock.touch()
        assert renewals == []

        monkeypatch.setattr(store, "_RENEW_AFTER", 0.0)
        lock.touch()
        assert renewals == [1]


def test_only_one_of_many_concurrent_callers_gets_the_lease(client):
    upload_id = create(client)
    start = threading.Barrier(8)
    winners, losers = [], []

    def contend():
        start.wait()
        try:
            winners.append(store.acquire_lock(upload_id))
        except store.UploadBusy:
            losers.append(1)

    threads = [threading.Thread(target=contend) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(winners) == 1 and len(losers) == 7
    winners[0].release()


def test_the_lease_is_released_when_the_request_ends(client):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    assert lease_row(upload_id) is None

    assert patch(client, upload_id, 0, b"XXX").status_code == 409  # a refused request lets go too
    assert lease_row(upload_id) is None

    patch(client, upload_id, 3, b"def")  # and one that finishes the upload
    assert lease_row(upload_id) is None


def test_a_request_that_loses_its_lease_mid_flight_is_told_to_retry_and_stores_nothing(client, monkeypatch):
    upload_id = create(client)

    def lost(self):
        raise store.LockLost(self.upload_id)

    monkeypatch.setattr(store.UploadLock, "renew", lost)
    response = patch(client, upload_id, 0, b"abc")
    monkeypatch.undo()

    assert response.status_code == 423
    assert response.json()["type"] == "urn:scholium:problem:upload-locked"
    assert part_keys(upload_id) == []
    assert offset_of(head(client, upload_id)) == 0


def test_a_request_that_loses_its_lease_while_the_body_arrives_stops_at_once(client, monkeypatch):
    upload_id = create(client)
    monkeypatch.setattr(store.UploadLock, "due", lambda self: True)

    def lost(self):
        raise store.LockLost(self.upload_id)

    monkeypatch.setattr(store.UploadLock, "renew", lost)

    assert patch(client, upload_id, 0, b"abc").status_code == 423
    assert part_keys(upload_id) == []


def test_a_lease_that_cannot_be_released_does_not_fail_the_request(client, monkeypatch):
    upload_id = create(client)

    def database_down(self):
        raise OperationalError("DELETE FROM upload_leases", {}, Exception("database is locked"))

    monkeypatch.setattr(store.UploadLock, "release", database_down)

    assert patch(client, upload_id, 0, b"abc").status_code == 204


# --- discarding and listing parts -------------------------------------------------------


def test_discard_parts_deletes_every_part_and_only_that_uploads(client, backend):
    one, other, longer = create(client), create(client), create(client)
    for start, data in [(0, b"a"), (1, b"b"), (2, b"c")]:
        leave_part(one, start, data)
    leave_part(other, 0, b"kept")
    # An id that merely starts like ``one`` is another upload's.
    sibling = one + "x"
    get_object_store().put_stream(key(sibling, 0), io.BytesIO(b"kept too"))
    # Whatever sits under the upload's prefix goes, whatever its name.
    get_object_store().put_stream(f"uploads/{one}/stray", io.BytesIO(b"stray"))

    assert store.discard_parts(one) == 4

    assert part_keys(one) == []
    assert part_keys(other) == [key(other, 0)]
    assert part_keys(sibling) == [key(sibling, 0)]
    assert store.discard_parts(one) == 0  # idempotent
    assert part_keys(longer) == []


def test_discard_parts_is_best_effort_unless_told_otherwise(client, monkeypatch):
    upload_id = create(client)
    leave_part(upload_id, 0, b"abc")

    def unreachable(self, key):
        raise ObjectStoreError("the bucket is unreachable")

    monkeypatch.setattr(type(get_object_store()), "delete", unreachable)

    assert store.discard_parts(upload_id) == 0  # logged, not raised
    with pytest.raises(ObjectStoreError):
        store.discard_parts(upload_id, best_effort=False)


def test_staged_upload_ids_lists_each_upload_once_and_only_ours(client, backend):
    one, two = create(client), create(client)
    leave_part(one, 0, b"a")
    leave_part(one, 1, b"b")
    leave_part(two, 0, b"c")
    objects = get_object_store()
    objects.put_stream("uploads/loose-object", io.BytesIO(b"not a part of any upload"))
    objects.put_stream("uploads/not an id/0000000000000000000", io.BytesIO(b"nor this"))

    assert sorted(store.staged_upload_ids()) == sorted([one, two])


# --- garbage collection -----------------------------------------------------------------


def started(client, data=b"abc", length=100) -> str:
    upload_id = create(client, length=length)
    assert patch(client, upload_id, 0, data).status_code == 204
    return upload_id


def test_the_reaper_deletes_every_part_of_an_abandoned_upload(client, backend):
    upload_id = create(client, length=100)
    offset = 0
    for piece in (b"one", b"two", b"three"):
        offset = offset_of(patch(client, upload_id, offset, piece))
    leave_part(upload_id, offset, b"unacknowledged")
    assert len(part_keys(upload_id)) == 4

    result = reaper.reap_abandoned_uploads(now=utcnow() + timedelta(hours=25))

    assert result.uploads >= 1
    assert stored_upload(upload_id) is None
    assert part_keys(upload_id) == []
    assert lease_row(upload_id) is None


def test_the_reaper_leaves_a_young_uploads_parts_alone(client, backend):
    old, young = started(client), started(client)
    age(old, 25)

    reaper.reap_abandoned_uploads()

    assert stored_upload(old) is None and part_keys(old) == []
    assert stored_upload(young) is not None and part_keys(young) == [key(young, 0)]


def test_the_reaper_skips_an_upload_a_request_holds_and_reaps_it_later(client, backend):
    upload_id = started(client)
    later = utcnow() + timedelta(hours=25)

    with store.acquire_lock(upload_id):
        assert reaper.reap_abandoned_uploads(now=later).uploads == 0
        assert part_keys(upload_id) == [key(upload_id, 0)]

    assert reaper.reap_abandoned_uploads(now=later).uploads >= 1
    assert part_keys(upload_id) == []


def test_a_store_that_cannot_delete_the_parts_keeps_the_row_for_the_next_pass(client, monkeypatch):
    upload_id = started(client)
    later = utcnow() + timedelta(hours=25)
    objects_type = type(get_object_store())
    real_delete = objects_type.delete

    def unreachable(self, key):
        raise ObjectStoreError("the bucket is unreachable")

    monkeypatch.setattr(objects_type, "delete", unreachable)
    failed = reaper.reap_abandoned_uploads(now=later)
    monkeypatch.setattr(objects_type, "delete", real_delete)

    assert failed.uploads == 0
    assert stored_upload(upload_id) is not None  # still there to be found again
    assert part_keys(upload_id) == [key(upload_id, 0)]
    assert lease_row(upload_id) is None  # and not left locked

    assert reaper.reap_abandoned_uploads(now=later).uploads >= 1
    assert stored_upload(upload_id) is None and part_keys(upload_id) == []


def test_parts_whose_upload_has_no_row_are_swept(client, backend):
    gone = started(client)
    with SessionLocal() as session:  # the row is deleted, the parts survive: a crash between the two steps
        session.execute(store.Upload.__table__.delete().where(store.Upload.id == gone))
        session.commit()
    kept = started(client)

    result = reaper.reap_abandoned_uploads()

    assert result.orphans == 1
    assert part_keys(gone) == []
    assert part_keys(kept) == [key(kept, 0)]


def test_parts_left_behind_by_a_finished_upload_are_swept(client, backend):
    upload_id = create(client, length=3)
    cid = patch(client, upload_id, 0, b"abc").headers["upload-cid"]
    leave_part(upload_id, 0, b"abc")  # the move recorded the CID and died before deleting them

    result = reaper.reap_abandoned_uploads()

    assert result.orphans == 1
    assert part_keys(upload_id) == []
    assert stored_upload(upload_id).cid == cid


def test_a_pass_with_nothing_staged_sweeps_nothing(client, backend):
    assert reaper.reap_abandoned_uploads().orphans == 0


def test_an_unreachable_object_store_does_not_stop_the_pass(client, monkeypatch):
    upload_id = create(client)

    def unreachable(self, prefix=""):
        raise ObjectStoreError("the bucket is unreachable")

    monkeypatch.setattr(type(get_object_store()), "list", unreachable)

    result = reaper.reap_abandoned_uploads(now=utcnow() + timedelta(hours=25))

    assert result.orphans == 0
    assert result.uploads == 0
    assert stored_upload(upload_id) is not None


def test_an_orphaned_completed_upload_has_its_blob_deleted_through_the_object_store(client, backend):
    """The blob lives wherever the content store keeps it: the reaper must not assume a local path."""
    upload_id = create(client, length=11)
    cid = patch(client, upload_id, 0, b"hello world").headers["upload-cid"]
    assert content.exists(cid)
    old = (utcnow() - timedelta(days=8)).replace(tzinfo=None)
    with SessionLocal() as session:
        session.execute(
            update(store.Upload).where(store.Upload.id == upload_id).values(completed_at=old, created_at=old)
        )
        session.commit()

    result = reaper.reap_abandoned_uploads()

    assert result.completed >= 1 and result.blobs >= 1
    assert stored_upload(upload_id) is None
    assert content.get_blob(cid) is None
    assert not content.exists(cid)


# --- uploads an earlier release staged in CONTENT_DIR/.uploads --------------------------


def stage_the_old_way(content_root, upload_id, data: bytes):
    """Leave ``data`` where an earlier release kept the bytes of an upload in flight."""
    staging = content_root / ".uploads"
    staging.mkdir(parents=True, exist_ok=True)
    (staging / upload_id).write_bytes(data)
    return staging / upload_id


def stage_legacy_upload(client, content_root, *, length, received: bytes, on_disk: bytes = None):
    """An upload whose first ``len(received)`` bytes were staged the old way, as after an upgrade."""
    upload_id = create(client, length=length)
    if received:
        patch(client, upload_id, 0, received)
        for key_ in part_keys(upload_id):
            get_object_store().delete(key_)
    path = stage_the_old_way(content_root, upload_id, received if on_disk is None else on_disk)
    return upload_id, path


def test_an_upload_staged_by_an_earlier_release_continues_and_finishes(client, content_root):
    upload_id, legacy = stage_legacy_upload(client, content_root, length=6, received=b"abc")
    assert offset_of(head(client, upload_id)) == 3

    final = patch(client, upload_id, 3, b"def")

    assert final.status_code == 204
    assert final.headers["upload-cid"] == compute_file_id(b"abcdef")
    assert not legacy.exists()
    assert part_keys(upload_id) == []


def test_the_first_append_adopts_the_old_file_as_the_first_part(client, content_root):
    upload_id, legacy = stage_legacy_upload(client, content_root, length=10, received=b"abc")

    assert patch(client, upload_id, 3, b"def").status_code == 204

    assert part_keys(upload_id) == [key(upload_id, 0), key(upload_id, 3)]
    assert read_part(upload_id, 0) == b"abc"
    assert not legacy.exists()


def test_bytes_the_old_file_holds_past_the_acknowledged_offset_are_dropped(client, content_root):
    upload_id, legacy = stage_legacy_upload(
        client, content_root, length=6, received=b"abc", on_disk=b"abcJUNK"
    )

    final = patch(client, upload_id, 3, b"def")

    assert final.headers["upload-cid"] == compute_file_id(b"abcdef")


def test_a_complete_upload_still_staged_the_old_way_is_finished_by_an_empty_patch(client, content_root):
    upload_id = create(client, length=6)
    stage_the_old_way(content_root, upload_id, b"abcdef")
    with SessionLocal() as session:
        assert store.advance_offset(session, upload_id, expected_offset=0, new_offset=6)

    final = patch(client, upload_id, 6, b"")

    assert final.status_code == 204
    assert final.headers["upload-cid"] == compute_file_id(b"abcdef")
    assert not (content_root / ".uploads" / upload_id).exists()


def test_an_old_file_with_fewer_bytes_than_were_acknowledged_is_410(client, content_root):
    upload_id, legacy = stage_legacy_upload(
        client, content_root, length=6, received=b"abc", on_disk=b"ab"
    )

    response = patch(client, upload_id, 3, b"def")

    assert response.status_code == 410
    assert offset_of(head(client, upload_id)) == 3


def test_an_old_file_is_not_adopted_by_an_upload_that_has_parts(client, content_root):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    stage_the_old_way(content_root, upload_id, b"XXX")  # e.g. left by a crash after adopting

    final = patch(client, upload_id, 3, b"def")

    assert final.headers["upload-cid"] == compute_file_id(b"abcdef")


def test_finishing_an_upload_removes_a_leftover_old_file(client, content_root):
    upload_id = create(client, length=3)
    legacy = stage_the_old_way(content_root, upload_id, b"abc")

    final = patch(client, upload_id, 0, b"abc")  # the offset is 0: the old file was never acknowledged

    assert final.headers["upload-cid"] == compute_file_id(b"abc")
    assert not legacy.exists()


def test_the_reaper_removes_the_old_file_of_an_abandoned_upload(client, content_root):
    upload_id, legacy = stage_legacy_upload(client, content_root, length=100, received=b"abc")
    age(upload_id, 25)

    reaper.reap_abandoned_uploads()

    assert stored_upload(upload_id) is None
    assert not legacy.exists()


def test_the_reaper_keeps_the_old_file_of_an_upload_that_is_still_young(client, content_root):
    upload_id, legacy = stage_legacy_upload(client, content_root, length=100, received=b"abc")
    long_ago = (utcnow() - timedelta(hours=48)).timestamp()
    os.utime(legacy, (long_ago, long_ago))

    reaper.reap_abandoned_uploads()

    assert stored_upload(upload_id) is not None
    assert legacy.exists()


def test_head_of_an_upload_staged_the_old_way_reports_its_offset(client, content_root):
    upload_id, _ = stage_legacy_upload(client, content_root, length=6, received=b"abc")

    response = head(client, upload_id)

    assert response.status_code == 200
    assert offset_of(response) == 3
    assert response.headers["upload-length"] == "6"


# --- no schema change to uploads --------------------------------------------------------


def test_the_lease_lives_in_its_own_table_and_leaves_uploads_alone(client):
    from sqlalchemy import inspect

    from app.db import engine

    inspector = inspect(engine)
    assert inspector.has_table("upload_leases")
    assert {column["name"] for column in inspector.get_columns("uploads")} == {
        "id",
        "upload_length",
        "defer_length",
        "upload_offset",
        "upload_metadata",
        "kind",
        "state",
        "owner_did",
        "created_at",
        "cid",
        "completed_at",
    }


def test_discard_staged_is_the_old_name_for_deleting_every_part(client, backend):
    upload_id = create(client)
    leave_part(upload_id, 0, b"abc")
    leave_part(upload_id, 3, b"def")

    assert store.discard_staged(upload_id) is None

    assert part_keys(upload_id) == []
    store.discard_staged(upload_id)  # and a no-op when there is nothing
