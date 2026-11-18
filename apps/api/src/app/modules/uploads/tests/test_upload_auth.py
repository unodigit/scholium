"""Regression tests: uploads need an authenticated owner, a quota, and a garbage collector.

The bug: ``POST /v1/uploads`` + ``PATCH`` answered 201/204 and a CID to anyone,
with no token; ``HEAD``/``PATCH`` never compared the upload's owner; and an
upload nobody finished kept its staged bytes for ever.

Covered here:

* creating, inspecting (``HEAD``) and resuming/completing (``PATCH``) an upload
  need a tier-1+ access token: 401 without a usable one, 403 below tier 1;
* only the owner may touch an upload; anyone else (any tier) gets the same 404
  as for an id that does not exist, and an unowned legacy row belongs to nobody;
* a per-DID quota caps the bytes an account may have in flight;
* a periodic job deletes incomplete uploads older than a configurable TTL
  (default 24 h), their staged parts, and staged bytes with no upload at all.

Every test uses DIDs of its own: the test database outlives a test, and the
quota counts what an account already has in flight.
"""

import io
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, func, select, update

from app import jobs
from app.db import SessionLocal
from app.modules import content, uploads
from app.modules.identity.models import Account
from app.modules.uploads import limits, store
from app.security import issue_access_token
from app.settings import settings

from .conftest import bearer
from .test_upload_patch import part_keys, staged_bytes

TUS = {"Tus-Resumable": "1.0.0"}
OFFSET_TYPE = "application/offset+octet-stream"

QUOTA_TYPE = "urn:scholium:problem:upload-quota-exceeded"


def did(label: str) -> str:
    return f"did:key:z6Mk{label}{uuid.uuid4().hex}"


def establish(owner: str, days: int = 100) -> None:
    """Give ``owner`` an account old enough for the established-account allowances."""
    created = (utcnow() - timedelta(days=days)).replace(tzinfo=None)
    session = SessionLocal()
    try:
        session.add(Account(did=owner, tier=2, created_at=created))
        session.commit()
    finally:
        session.close()


@pytest.fixture
def alice() -> dict[str, str]:
    return bearer(did("Alice"), 2)


@pytest.fixture
def bob() -> dict[str, str]:
    return bearer(did("Bob"), 2)


# --- helpers ---------------------------------------------------------------------


def post(client, length=100, who=None, **extra):
    """POST a creation request; ``length=None`` asks for a deferred length."""
    headers = {**TUS, **(who or {}), **extra}
    if length is None:
        headers["Upload-Defer-Length"] = "1"
    else:
        headers["Upload-Length"] = str(length)
    return client.post("/v1/uploads", headers=headers)


def new_upload(client, who, length=100) -> str:
    response = post(client, length, who)
    assert response.status_code == 201, response.text
    return response.headers["location"].rsplit("/", 1)[1]


def patch(client, upload_id, offset, data=b"", who=None):
    headers = {**TUS, "Upload-Offset": str(offset), "Content-Type": OFFSET_TYPE, **(who or {})}
    return client.patch(f"/v1/uploads/{upload_id}", content=data, headers=headers)


def head(client, upload_id, who=None):
    return client.head(f"/v1/uploads/{upload_id}", headers={**TUS, **(who or {})})


def row(upload_id):
    session = SessionLocal()
    try:
        return store.get_upload(session, upload_id)
    finally:
        session.close()


def make_row(owner, length=100, **kwargs) -> str:
    """An upload row created behind the API's back (a legacy or foreign one)."""
    session = SessionLocal()
    try:
        return store.create_upload(session, upload_length=length, owner_did=owner, **kwargs).id
    finally:
        session.close()


def count_uploads() -> int:
    session = SessionLocal()
    try:
        return session.scalar(select(func.count()).select_from(store.Upload))
    finally:
        session.close()


def finish(client, who, data=b"hello") -> tuple[str, str]:
    """Upload ``data`` in one PATCH; return ``(upload id, CID)``."""
    upload_id = new_upload(client, who, len(data))
    response = patch(client, upload_id, 0, data, who)
    assert response.status_code == 204, response.text
    return upload_id, response.headers["upload-cid"]


def staged_exists(upload_id) -> bool:
    """Whether any part of the upload is staged in the object store."""
    return bool(part_keys(upload_id))


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def age(upload_id, hours: float) -> None:
    """Make an upload look ``hours`` old (the table keeps naive UTC)."""
    created = (utcnow() - timedelta(hours=hours)).replace(tzinfo=None)
    session = SessionLocal()
    try:
        session.execute(update(store.Upload).where(store.Upload.id == upload_id).values(created_at=created))
        session.commit()
    finally:
        session.close()


# --- authentication: nothing is writable anonymously ----------------------------------


def test_anonymous_creation_is_401_and_stores_nothing(anon_client):
    before = count_uploads()

    response = post(anon_client)

    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert "location" not in response.headers
    assert count_uploads() == before


def test_anonymous_patch_is_401_and_writes_nothing(anon_client, alice):
    upload_id = new_upload(anon_client, alice)

    response = patch(anon_client, upload_id, 0, b"anonymous bytes")

    assert response.status_code == 401
    assert not staged_exists(upload_id)
    assert row(upload_id).upload_offset == 0


def test_anonymous_head_is_401(anon_client, alice):
    upload_id = new_upload(anon_client, alice)

    response = head(anon_client, upload_id)

    assert response.status_code == 401
    assert "upload-offset" not in response.headers


def test_an_anonymous_caller_cannot_get_a_file_into_the_content_dir(anon_client, content_root):
    created = post(anon_client, 5)
    assert created.status_code == 401

    upload_id = "A" * 24  # even a guessed id gets nowhere
    assert patch(anon_client, upload_id, 0, b"hello").status_code == 401
    # Nothing was staged: not as parts in the object store, and not where earlier releases staged.
    assert not (content_root / "uploads").exists()
    assert not (content_root / store.STAGING_DIRNAME).exists()


@pytest.mark.parametrize("authorization", ["Bearer not-a-jwt", "Basic Zm9vOmJhcg==", "Bearer "])
def test_unusable_credentials_are_401(anon_client, authorization):
    before = count_uploads()

    response = post(anon_client, who={"Authorization": authorization})

    assert response.status_code == 401
    assert count_uploads() == before


def test_an_expired_token_is_401(anon_client):
    token = issue_access_token(did("Late"), 2, now=utcnow() - timedelta(hours=1))

    response = post(anon_client, who={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401


def test_a_reader_cannot_create_an_upload(anon_client):
    before = count_uploads()

    response = post(anon_client, who=bearer(did("Reader"), 0))

    assert response.status_code == 403
    body = response.json()
    assert body["required_tier"] == 1
    assert body["caller_tier"] == 0
    assert count_uploads() == before


def test_a_member_may_upload_and_owns_the_upload(anon_client):
    member = did("Member")

    upload_id = new_upload(anon_client, bearer(member, 1))

    assert row(upload_id).owner_did == member


@pytest.mark.parametrize("method", ["head", "patch"])
def test_a_reader_cannot_inspect_or_resume_even_an_upload_held_in_their_name(anon_client, method):
    reader = did("Reader")
    upload_id = make_row(reader)
    who = bearer(reader, 0)

    response = head(anon_client, upload_id, who) if method == "head" else patch(anon_client, upload_id, 0, b"x", who)

    assert response.status_code == 403
    assert not staged_exists(upload_id)


# --- ownership: someone else's upload does not exist ------------------------------------


def test_head_of_another_callers_upload_is_404(anon_client, alice, bob):
    upload_id = new_upload(anon_client, alice)

    response = head(anon_client, upload_id, bob)

    assert response.status_code == 404
    assert "upload-offset" not in response.headers
    # No oracle: it looks exactly like an upload that was never created.
    assert response.status_code == head(anon_client, "no-such-upload", bob).status_code


def test_patch_to_another_callers_upload_is_404_and_writes_nothing(anon_client, alice, bob):
    upload_id = new_upload(anon_client, alice, length=10)
    assert patch(anon_client, upload_id, 0, b"hello", alice).status_code == 204

    response = patch(anon_client, upload_id, 5, b"WORLD", bob)

    assert response.status_code == 404
    assert response.json()["detail"] == patch(anon_client, "no-such-upload", 5, b"WORLD", bob).json()["detail"]
    assert row(upload_id).upload_offset == 5
    assert staged_bytes(upload_id) == b"hello"
    # The owner carries on, unaffected.
    done = patch(anon_client, upload_id, 5, b"world", alice)
    assert done.status_code == 204
    assert done.headers["upload-cid"]


def test_a_stranger_does_not_even_touch_the_staged_parts_of_an_upload(anon_client, alice, bob):
    upload_id = new_upload(anon_client, alice)

    assert patch(anon_client, upload_id, 0, b"x", bob).status_code == 404

    assert not staged_exists(upload_id)


def test_only_the_owner_learns_the_cid_of_a_finished_upload(anon_client, alice, bob):
    upload_id, cid = finish(anon_client, alice)

    stranger = patch(anon_client, upload_id, 5, b"", bob)
    owner = patch(anon_client, upload_id, 5, b"", alice)

    assert stranger.status_code == 404
    assert "upload-cid" not in stranger.headers
    assert owner.status_code == 204
    assert owner.headers["upload-cid"] == cid


def test_a_higher_tier_is_not_a_way_around_ownership(anon_client, alice):
    upload_id = new_upload(anon_client, alice)
    moderator = bearer(did("Moderator"), 4)

    assert head(anon_client, upload_id, moderator).status_code == 404
    assert patch(anon_client, upload_id, 0, b"x", moderator).status_code == 404


def test_an_unowned_legacy_upload_belongs_to_nobody(anon_client, alice):
    upload_id = make_row(None)
    moderator = bearer(did("Moderator"), 4)

    for who in (alice, moderator):
        assert head(anon_client, upload_id, who).status_code == 404
        assert patch(anon_client, upload_id, 0, b"x", who).status_code == 404
    assert not staged_exists(upload_id)


# --- quota: bytes in flight per DID ----------------------------------------------------


def test_bytes_in_flight_are_capped_per_did(anon_client, alice, bob, monkeypatch):
    monkeypatch.setenv("UPLOAD_QUOTA_BYTES", "1000")
    assert post(anon_client, 600, alice).status_code == 201
    before = count_uploads()

    over = post(anon_client, 600, alice)

    assert over.status_code == 413
    assert over.headers["content-type"].startswith("application/problem+json")
    body = over.json()
    assert body["type"] == QUOTA_TYPE
    assert body["quota_bytes"] == 1000
    assert "location" not in over.headers
    assert count_uploads() == before
    # The quota is per DID, and a caller may fill it exactly.
    assert post(anon_client, 600, bob).status_code == 201
    assert post(anon_client, 400, alice).status_code == 201
    assert post(anon_client, 1, alice).status_code == 413


def test_a_finished_upload_stops_counting_against_the_quota(anon_client, alice, monkeypatch):
    monkeypatch.setenv("UPLOAD_QUOTA_BYTES", "1000")
    upload_id = new_upload(anon_client, alice, 600)
    assert post(anon_client, 600, alice).status_code == 413

    assert patch(anon_client, upload_id, 0, b"x" * 600, alice).status_code == 204

    assert post(anon_client, 600, alice).status_code == 201


def test_a_deferred_length_upload_reserves_the_size_limit_of_its_kind(anon_client, alice, monkeypatch):
    monkeypatch.setenv("UPLOAD_QUOTA_BYTES", "1000")

    assert post(anon_client, None, alice).status_code == 413


def test_the_default_quota_fits_two_maximum_bundles_and_no_third(anon_client, monkeypatch):
    """The 5 GiB bundle cap survives for an account old enough to be allowed it."""
    monkeypatch.delenv("UPLOAD_QUOTA_BYTES", raising=False)
    owner = did("EstablishedBundles")
    establish(owner)
    who = bearer(owner)
    bundle = {"Upload-Metadata": "filename YXJjaGl2ZS56aXA="}  # archive.zip

    assert post(anon_client, limits.BUNDLE_MAX_BYTES, who, **bundle).status_code == 201
    assert post(anon_client, limits.BUNDLE_MAX_BYTES, who, **bundle).status_code == 201
    assert post(anon_client, 1, who).status_code == 413


@pytest.mark.parametrize("configured", ["banana", "0", "-5"])
def test_an_unusable_quota_setting_falls_back_to_the_default(anon_client, monkeypatch, configured):
    monkeypatch.setenv("UPLOAD_QUOTA_BYTES", configured)
    owner = did("EstablishedFallback")
    establish(owner)

    assert post(anon_client, limits.BUNDLE_MAX_BYTES, bearer(owner)).status_code == 201


def test_the_size_limits_still_apply_to_an_authenticated_caller(anon_client, alice):
    pdf = {"Upload-Metadata": "filetype YXBwbGljYXRpb24vcGRm"}  # application/pdf

    assert post(anon_client, limits.PDF_MAX_BYTES + 1, alice, **pdf).status_code == 413
    assert post(anon_client, limits.BUNDLE_MAX_BYTES + 1, alice).status_code == 413
    assert post(anon_client, limits.PDF_MAX_BYTES, alice, **pdf).status_code == 201


# --- garbage collection ----------------------------------------------------------------


@pytest.fixture
def reaper():
    from app.modules.uploads import reaper as module

    return module


@pytest.fixture
def reaper_jobs(reaper):
    """No ``uploads.reap`` jobs queued before or after the test."""

    def purge():
        jobs._ensure_table()
        session = SessionLocal()
        try:
            session.execute(delete(jobs.Job).where(jobs.Job.kind == reaper.JOB_KIND))
            session.commit()
        finally:
            session.close()

    purge()
    yield
    purge()


def reaper_jobs_queued(reaper) -> list:
    session = SessionLocal()
    try:
        return list(
            session.scalars(
                select(jobs.Job).where(jobs.Job.kind == reaper.JOB_KIND, jobs.Job.status == jobs.STATUS_QUEUED)
            )
        )
    finally:
        session.close()


def started_upload(client, who, data=b"abc", length=100) -> str:
    """An upload that got some bytes and then was abandoned."""
    upload_id = new_upload(client, who, length)
    assert patch(client, upload_id, 0, data, who).status_code == 204
    return upload_id


def test_the_default_ttl_is_24_hours():
    from app.modules.uploads import config

    assert config.upload_ttl() == timedelta(hours=24)


def test_an_abandoned_upload_is_deleted_once_older_than_the_ttl(anon_client, alice, reaper):
    upload_id = started_upload(anon_client, alice)
    assert staged_exists(upload_id)

    kept = reaper.reap_abandoned_uploads(now=utcnow() + timedelta(hours=23))
    assert kept.uploads == 0
    assert row(upload_id) is not None and staged_exists(upload_id)

    reaped = reaper.reap_abandoned_uploads(now=utcnow() + timedelta(hours=25))

    assert reaped.uploads >= 1
    assert row(upload_id) is None
    assert not staged_exists(upload_id)
    assert head(anon_client, upload_id, alice).status_code == 404


def test_an_upload_that_never_received_a_byte_is_reaped_too(anon_client, alice, reaper):
    upload_id = new_upload(anon_client, alice)

    reaper.reap_abandoned_uploads(now=utcnow() + timedelta(hours=25))

    assert row(upload_id) is None


def test_young_uploads_survive_while_old_ones_go(anon_client, alice, reaper):
    old = started_upload(anon_client, alice)
    age(old, 25)
    young = started_upload(anon_client, alice)

    reaper.reap_abandoned_uploads()

    assert row(old) is None and not staged_exists(old)
    assert row(young) is not None and staged_exists(young)


def test_the_ttl_is_configurable(anon_client, alice, reaper, monkeypatch):
    monkeypatch.setenv("UPLOAD_TTL_SECONDS", "60")
    upload_id = started_upload(anon_client, alice)

    assert reaper.reap_abandoned_uploads(now=utcnow() + timedelta(seconds=30)).uploads == 0
    assert row(upload_id) is not None

    assert reaper.reap_abandoned_uploads(now=utcnow() + timedelta(seconds=120)).uploads >= 1
    assert row(upload_id) is None


def test_a_finished_upload_is_not_reaped_before_the_orphan_ttl(anon_client, alice, reaper):
    """The incomplete-upload TTL (24 h) does not touch a finished upload.

    Once it is older than the orphan TTL (7 days) and no manifest names it, the
    orphan sweep does delete it -- see ``test_upload_storage_quota``.
    """
    upload_id, cid = finish(anon_client, alice)

    reaper.reap_abandoned_uploads(now=utcnow() + timedelta(days=6))

    assert row(upload_id).cid == cid
    with content.open_blob(cid) as blob:
        assert blob.read() == b"hello"
    again = patch(anon_client, upload_id, 5, b"", alice)
    assert again.status_code == 204 and again.headers["upload-cid"] == cid


def test_a_complete_upload_that_was_never_moved_is_reaped(anon_client, reaper):
    owner = did("Stranded")
    upload_id = make_row(owner, length=3)
    store.write_part(upload_id, 0, io.BytesIO(b"abc"))
    session = SessionLocal()
    try:
        assert store.advance_offset(session, upload_id, expected_offset=0, new_offset=3)
    finally:
        session.close()
    assert row(upload_id).state == store.STATE_COMPLETED and row(upload_id).cid is None

    reaper.reap_abandoned_uploads(now=utcnow() + timedelta(hours=25))

    assert row(upload_id) is None
    assert not staged_exists(upload_id)


def test_an_upload_being_written_right_now_is_left_alone(anon_client, alice, reaper):
    upload_id = started_upload(anon_client, alice)
    later = utcnow() + timedelta(hours=25)

    held = store.acquire_lock(upload_id)  # a PATCH is appending to it
    try:
        assert reaper.reap_abandoned_uploads(now=later).uploads == 0
        assert row(upload_id) is not None
        assert staged_exists(upload_id)
    finally:
        held.release()

    assert reaper.reap_abandoned_uploads(now=later).uploads >= 1
    assert row(upload_id) is None


def test_reaping_frees_the_quota(anon_client, alice, reaper, monkeypatch):
    monkeypatch.setenv("UPLOAD_QUOTA_BYTES", "1000")
    upload_id = new_upload(anon_client, alice, 600)
    assert post(anon_client, 600, alice).status_code == 413

    age(upload_id, 25)
    reaper.reap_abandoned_uploads()

    assert post(anon_client, 600, alice).status_code == 201


def test_files_an_earlier_release_staged_with_no_upload_are_swept_once_stale(reaper, content_root):
    staging = content_root / store.STAGING_DIRNAME
    staging.mkdir(parents=True)
    stale, fresh = staging / "orphan-stale", staging / "orphan-fresh"
    stale.write_bytes(b"left behind")
    fresh.write_bytes(b"just arrived")
    long_ago = (utcnow() - timedelta(hours=48)).timestamp()
    os.utime(stale, (long_ago, long_ago))

    result = reaper.reap_abandoned_uploads()

    assert result.orphans == 1
    assert not stale.exists()
    assert fresh.exists()


def test_the_reaper_is_a_job_that_runs_and_queues_its_next_run(anon_client, alice, reaper, reaper_jobs):
    upload_id = started_upload(anon_client, alice)
    age(upload_id, 25)

    jobs.enqueue(reaper.JOB_KIND)  # eager: runs inline

    assert row(upload_id) is None
    (next_run,) = reaper_jobs_queued(reaper)
    assert next_run.run_after is not None
    assert next_run.run_after > utcnow().replace(tzinfo=None)


def test_scheduling_the_reaper_twice_queues_one_job(reaper, reaper_jobs):
    assert reaper.schedule_reaper() is not None
    assert reaper.schedule_reaper() is None
    assert len(reaper_jobs_queued(reaper)) == 1


def test_startup_queues_the_reaper_when_jobs_run_on_the_worker(reaper, reaper_jobs, monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 0)

    uploads.on_startup(None)
    uploads.on_startup(None)

    assert len(reaper_jobs_queued(reaper)) == 1


def test_startup_queues_nothing_in_eager_mode(reaper, reaper_jobs, monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 1)

    uploads.on_startup(None)

    assert reaper_jobs_queued(reaper) == []
