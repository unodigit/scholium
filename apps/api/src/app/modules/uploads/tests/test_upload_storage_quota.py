"""Regression tests: upload size and storage are bounded per DID and per day.

The bug: a brand-new tier-2 account could declare a 5 GiB upload and get a
``201``; completed uploads were never counted against any quota, so filling the
content store with never-referenced files was free; and a completed upload that
no manifest ever named was kept for ever.

Covered here:

* a young account's daily allowance (2 GiB by default) rejects a 5 GiB
  ``Upload-Length`` -- the 5 GiB bundle cap still applies only to accounts
  that are allowed it (established accounts, 20 GiB/day by default);
* completed uploads count against the daily allowance, and counting them makes
  further uploads ``413`` problem details;
* naming an upload's CID in a manifest does not stop it counting: anyone can
  post a manifest naming any CID (``test_upload_references`` covers who may);
* the periodic job deletes completed uploads that their owner's records do not
  reference once they are older than ``UPLOAD_ORPHAN_TTL`` (7 days by
  default), bytes and ``blobs`` row included, while a referenced upload is kept.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record
from sqlalchemy import update

from app.db import SessionLocal
from app.modules import content, ledger
from app.modules.identity.models import Account
from app.modules.uploads import limits, reaper, store
from app.security import issue_access_token

TUS = {"Tus-Resumable": "1.0.0"}
OFFSET_TYPE = "application/offset+octet-stream"
QUOTA_TYPE = "urn:scholium:problem:upload-quota-exceeded"

GIB = 1024**3


def did(label: str) -> str:
    return f"did:key:z6Mk{label}{uuid.uuid4().hex}"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def bearer_for(owner: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(owner, 2)}"}


def establish(owner: str, days: int = 100) -> None:
    """Give ``owner`` an account ``days`` old (100: established; 0: brand new)."""
    created = (utcnow() - timedelta(days=days)).replace(tzinfo=None)
    session = SessionLocal()
    try:
        session.add(Account(did=owner, tier=2, created_at=created))
        session.commit()
    finally:
        session.close()


def post(client, length, who, metadata=None):
    headers = {**TUS, **who, "Upload-Length": str(length)}
    if metadata is not None:
        headers["Upload-Metadata"] = metadata
    return client.post("/v1/uploads", headers=headers)


def new_upload(client, who, length) -> str:
    response = post(client, length, who)
    assert response.status_code == 201, response.text
    return response.headers["location"].rsplit("/", 1)[1]


def patch(client, upload_id, offset, data, who):
    headers = {**TUS, "Upload-Offset": str(offset), "Content-Type": OFFSET_TYPE, **who}
    return client.patch(f"/v1/uploads/{upload_id}", content=data, headers=headers)


def new_deferred(client, who) -> str:
    response = client.post("/v1/uploads", headers={**TUS, **who, "Upload-Defer-Length": "1"})
    assert response.status_code == 201, response.text
    return response.headers["location"].rsplit("/", 1)[1]


def finish(client, who, data: bytes) -> tuple[str, str]:
    """Upload ``data`` in one PATCH; return ``(upload id, CID)``."""
    upload_id = new_upload(client, who, len(data))
    response = patch(client, upload_id, 0, data, who)
    assert response.status_code == 204, response.text
    return upload_id, response.headers["upload-cid"]


def row(upload_id):
    session = SessionLocal()
    try:
        return store.get_upload(session, upload_id)
    finally:
        session.close()


def age(upload_id: str, days: float) -> None:
    """Make a completed upload look ``days`` old (the table keeps naive UTC)."""
    old = (utcnow() - timedelta(days=days)).replace(tzinfo=None)
    session = SessionLocal()
    try:
        session.execute(
            update(store.Upload)
            .where(store.Upload.id == upload_id)
            .values(created_at=old, completed_at=old)
        )
        session.commit()
    finally:
        session.close()


def reference_manifest(cid: str, size: int) -> str:
    """Append a signed ``manifest`` record naming ``cid``; return its record cid."""
    key = SigningKey.generate()
    unsigned = {
        "v": 1,
        "type": "manifest",
        "author": did_key_from_signing_key(key),
        "created": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prev": None,
        "body": {
            "files": [
                {
                    "path": "paper.pdf",
                    "cid": cid,
                    "size": size,
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
        "proofs": [],
    }
    entry = ledger.append(sign_record(unsigned, key))
    return entry.record_cid


def publish_version(key: SigningKey, cid: str, size: int) -> None:
    """Sign a manifest naming ``cid`` and a ``paper.version`` naming that manifest, both as ``key``."""
    author = did_key_from_signing_key(key)

    def append(record_type: str, body: dict) -> str:
        unsigned = {
            "v": 1,
            "type": record_type,
            "author": author,
            "created": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": body,
            "proofs": [],
        }
        return ledger.append(sign_record(unsigned, key)).record_cid

    files = [{"path": "paper.pdf", "cid": cid, "size": size, "mediaType": "application/pdf", "role": "manuscript"}]
    manifest = append("manifest", {"files": files})
    append(
        "paper.version",
        {
            "paper": f"bafyreipaper{uuid.uuid4().hex}",
            "n": 1,
            "title": "A title",
            "abstract": "An abstract",
            "authors": [author],
            "manifest": manifest,
            "licence": "CC-BY-4.0",
            "changeNote": "first version",
        },
    )


# --- daily size quota, by account age ------------------------------------------------


def test_the_default_allowances_are_sized_for_phase_one():
    from app.modules.uploads import config

    assert config.daily_quota_bytes(None) == 2 * GIB
    assert config.daily_quota_bytes(utcnow() - timedelta(days=91)) == 20 * GIB
    assert config.orphan_ttl() == timedelta(days=7)


def test_a_new_account_cannot_declare_a_five_gib_upload(anon_client):
    """The bug's reproduction: a brand-new tier-2 account got a 201."""
    who = bearer_for(did("Newcomer"))

    response = post(
        anon_client,
        limits.BUNDLE_MAX_BYTES,
        who,
        metadata="filename YXJjaGl2ZS56aXA=",  # archive.zip (a bundle)
    )

    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["type"] == QUOTA_TYPE
    assert body["quota_bytes"] == 2 * GIB
    assert "location" not in response.headers


def test_a_brand_new_tier_two_account_row_gets_the_young_allowance(anon_client):
    """The spec's case: a tier-2 account created just now, not an unknown DID."""
    owner = did("BrandNew")
    establish(owner, days=0)

    response = post(
        anon_client,
        limits.BUNDLE_MAX_BYTES,
        bearer_for(owner),
        metadata="filename YXJjaGl2ZS56aXA=",
    )

    assert response.status_code == 413
    assert response.json()["type"] == QUOTA_TYPE


def test_an_established_account_may_still_declare_a_five_gib_bundle(anon_client):
    """The 5 GiB bundle cap stays for accounts that have earned it."""
    owner = did("Established")
    establish(owner)

    response = post(
        anon_client,
        limits.BUNDLE_MAX_BYTES,
        bearer_for(owner),
        metadata="filename YXJjaGl2ZS56aXA=",
    )

    assert response.status_code == 201
    assert "location" in response.headers


def test_completed_uploads_use_up_the_daily_quota(anon_client, monkeypatch):
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner = did("Daily")
    who = bearer_for(owner)

    finish(anon_client, who, b"x" * 600)

    over = post(anon_client, 600, who)

    assert over.status_code == 413
    assert over.json()["type"] == QUOTA_TYPE


def test_a_manifest_reference_does_not_stop_an_upload_counting(anon_client, monkeypatch):
    """The allowance counts what was uploaded, not what later gets named.

    This used to assert the opposite -- a manifest freed the quota -- but any
    account can post a manifest naming any CID, so that let a second account
    free the first's allowance.
    """
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner = did("Referenced")
    who = bearer_for(owner)

    _, cid = finish(anon_client, who, b"x" * 600)
    assert post(anon_client, 600, who).status_code == 413

    reference_manifest(cid, 600)

    assert post(anon_client, 600, who).status_code == 413


def test_the_active_window_is_a_rolling_day(anon_client, monkeypatch):
    """Bytes completed more than a day ago no longer spend today's allowance."""
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner = did("Yesterday")
    who = bearer_for(owner)

    upload_id, _ = finish(anon_client, who, b"x" * 600)
    age(upload_id, 1.5)

    assert post(anon_client, 600, who).status_code == 201


def test_a_deferred_length_upload_cannot_stream_past_the_daily_allowance(anon_client, monkeypatch):
    """Deferred length must not be a way around the daily allowance."""
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    who = bearer_for(did("DeferredStream"))
    upload_id = new_deferred(anon_client, who)

    assert patch(anon_client, upload_id, 0, b"x" * 600, who).status_code == 204

    over = patch(anon_client, upload_id, 600, b"x" * 600, who)
    assert over.status_code == 413


def test_a_deferred_length_cannot_be_declared_above_the_daily_allowance(anon_client, monkeypatch):
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    who = bearer_for(did("DeferredDeclare"))
    upload_id = new_deferred(anon_client, who)
    headers = {**TUS, "Upload-Offset": "0", "Content-Type": OFFSET_TYPE, "Upload-Length": "2000", **who}

    response = anon_client.patch(f"/v1/uploads/{upload_id}", content=b"", headers=headers)

    assert response.status_code == 413
    assert response.json()["type"] == QUOTA_TYPE


# --- orphaned completed uploads -------------------------------------------------------


def test_an_unreferenced_completed_upload_is_deleted_after_the_orphan_ttl(anon_client):
    owner = did("Orphan")
    upload_id, cid = finish(anon_client, bearer_for(owner), b"orphaned bytes")
    previous_cid = row(upload_id).cid
    assert previous_cid == cid
    assert content.get_blob(cid) is not None

    age(upload_id, 6)
    reaper.reap_abandoned_uploads()
    assert row(upload_id) is not None
    assert content.get_blob(cid) is not None

    age(upload_id, 8)
    reaper.reap_abandoned_uploads()

    assert row(upload_id) is None
    assert content.get_blob(cid) is None
    assert not content.blob_path(cid).exists()


def test_a_completed_upload_its_owners_version_references_is_kept(anon_client):
    key = SigningKey.generate()
    owner = did_key_from_signing_key(key)
    upload_id, cid = finish(anon_client, bearer_for(owner), b"kept bytes")
    publish_version(key, cid, len(b"kept bytes"))
    age(upload_id, 30)

    reaper.reap_abandoned_uploads()

    assert row(upload_id) is not None
    assert row(upload_id).cid == cid
    assert content.get_blob(cid) is not None
    assert content.blob_path(cid).exists()


def test_the_orphan_ttl_is_configurable(anon_client, monkeypatch):
    monkeypatch.setenv("UPLOAD_ORPHAN_TTL_SECONDS", "60")
    owner = did("ShortLived")
    upload_id, _ = finish(anon_client, bearer_for(owner), b"short lived")

    reaper.reap_abandoned_uploads(now=utcnow() + timedelta(seconds=30))
    assert row(upload_id) is not None

    reaper.reap_abandoned_uploads(now=utcnow() + timedelta(seconds=120))
    assert row(upload_id) is None


def test_a_referenced_blob_survives_while_an_unreferenced_duplicate_goes(anon_client):
    """Deduplicated bytes are only deleted once nothing references them."""
    owner = did("Shared")
    who = bearer_for(owner)
    data = b"same bytes"
    first = new_upload(anon_client, who, len(data))
    second = new_upload(anon_client, who, len(data))
    assert patch(anon_client, first, 0, data, who).status_code == 204
    assert patch(anon_client, second, 0, data, who).status_code == 204
    cid = row(first).cid
    assert row(second).cid == cid
    age(first, 8)
    age(second, 8)

    reaper.reap_abandoned_uploads()

    assert row(first) is None and row(second) is None
    assert content.get_blob(cid) is None
    assert not content.blob_path(cid).exists()
