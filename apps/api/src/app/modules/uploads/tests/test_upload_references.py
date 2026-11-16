"""Regression tests: who may count an upload as referenced.

The bug: the daily quota and the orphan reaper asked "does *any* manifest in the
record log name this CID?". Any account -- a tier-0 stranger included -- can
post a standalone ``manifest`` record naming any CID, so naming someone else's
upload in one freed the owner's daily quota and kept the upload from the 7-day
cleanup. Separately the reaper only looked at manifests, so it could delete a
file that a discussion post, a notice or a moderation decision still names. And
it kept the *bytes* of any file any record named, so an account could keep
uploads for ever by naming them in standalone manifests that never became a
version.

The contract these tests pin down:

* the daily quota counts every byte a DID uploaded in the rolling day,
  whether or not any record names it;
* an upload is *referenced* (kept by the reaper, row and bytes) only when its
  owner's own records name it: a manifest of a version the owner signed or is
  listed on, or a discussion post, notice or moderation decision the owner
  signed;
* the reaper deletes every other completed upload past the TTL, and its bytes
  too unless a record that uses the file names it: a manifest a version names
  (inline or by CID), or a discussion post, notice or decision, whoever signed
  it. A standalone manifest no version names uses nothing and holds nothing.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record
from sqlalchemy import delete, update

from app.db import SessionLocal
from app.modules import content, ledger
from app.modules.uploads import reaper, references, store
from app.security import issue_access_token

TUS = {"Tus-Resumable": "1.0.0"}
OFFSET_TYPE = "application/offset+octet-stream"
QUOTA_TYPE = "urn:scholium:problem:upload-quota-exceeded"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Actor:
    """A signer whose DID is also the DID its upload bearer token carries."""

    key: SigningKey
    did: str

    @property
    def bearer(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {issue_access_token(self.did, 2)}"}


def actor() -> Actor:
    key = SigningKey.generate()
    return Actor(key=key, did=did_key_from_signing_key(key))


def append(who: Actor, record_type: str, body: dict[str, Any]) -> str:
    """Append ``record_type`` signed by ``who`` straight to the log; return its record cid."""
    unsigned = {
        "v": 1,
        "type": record_type,
        "author": who.did,
        "created": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prev": None,
        "body": body,
        "proofs": [],
    }
    return ledger.append(sign_record(unsigned, who.key)).record_cid


def manifest_body(cid: str, size: int) -> dict[str, Any]:
    return {
        "files": [
            {"path": "paper.pdf", "cid": cid, "size": size, "mediaType": "application/pdf", "role": "manuscript"}
        ]
    }


def post_manifest(who: Actor, cid: str, size: int) -> str:
    """A standalone ``manifest`` record: anyone may post one naming any cid."""
    return append(who, "manifest", manifest_body(cid, size))


def version_body(manifest: Any, authors: list[Any]) -> dict[str, Any]:
    return {
        "paper": f"bafyreipaper{uuid.uuid4().hex}",
        "n": 1,
        "title": "A title",
        "abstract": "An abstract",
        "authors": authors,
        "manifest": manifest,
        "licence": "CC-BY-4.0",
        "changeNote": "first version",
    }


def post_version(signer: Actor, manifest_cid: str, authors: Optional[list[Any]] = None) -> str:
    return append(signer, "paper.version", version_body(manifest_cid, authors or [signer.did]))


def publish(signer: Actor, cid: str, size: int, authors: Optional[list[Any]] = None) -> str:
    """A manifest naming ``cid`` and a version signed by ``signer`` that names the manifest."""
    return post_version(signer, post_manifest(signer, cid, size), authors)


def finish(client, who: Actor, data: bytes) -> tuple[str, str]:
    """Upload ``data`` as ``who`` in one PATCH; return ``(upload id, CID)``."""
    created = client.post("/v1/uploads", headers={**TUS, **who.bearer, "Upload-Length": str(len(data))})
    assert created.status_code == 201, created.text
    upload_id = created.headers["location"].rsplit("/", 1)[1]
    response = client.patch(
        f"/v1/uploads/{upload_id}",
        content=data,
        headers={**TUS, **who.bearer, "Upload-Offset": "0", "Content-Type": OFFSET_TYPE},
    )
    assert response.status_code == 204, response.text
    return upload_id, response.headers["upload-cid"]


def create(client, who: Actor, length: int):
    return client.post("/v1/uploads", headers={**TUS, **who.bearer, "Upload-Length": str(length)})


def row(upload_id: str):
    session = SessionLocal()
    try:
        return store.get_upload(session, upload_id)
    finally:
        session.close()


def age(upload_id: str, days: float) -> None:
    old = (utcnow() - timedelta(days=days)).replace(tzinfo=None)
    session = SessionLocal()
    try:
        session.execute(
            update(store.Upload).where(store.Upload.id == upload_id).values(created_at=old, completed_at=old)
        )
        session.commit()
    finally:
        session.close()


def reap_after_ttl(upload_id: str) -> None:
    """Age ``upload_id`` past the orphan TTL and run the reaper.

    The reaper works on the whole test database, which outlives a test, so
    tests assert on their own upload and file and never on the reaper's totals.
    """
    age(upload_id, 8)
    reaper.reap_abandoned_uploads()


def forget(upload_id: str) -> None:
    """Drop an upload row a test deliberately left behind, so no later reaper run meets it."""
    session = SessionLocal()
    try:
        session.execute(delete(store.Upload).where(store.Upload.id == upload_id))
        session.commit()
    finally:
        session.close()


def bytes_kept(cid: str) -> bool:
    return content.get_blob(cid) is not None and content.blob_path(cid).exists()


# --- the daily quota counts every byte uploaded, referenced or not --------------------


def test_a_strangers_manifest_does_not_free_the_owners_daily_quota(anon_client, monkeypatch):
    """The bug's reproduction: a manifest posted by someone else freed the quota."""
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner, stranger = actor(), actor()
    _, cid = finish(anon_client, owner, b"x" * 600)
    assert create(anon_client, owner, 600).status_code == 413

    post_manifest(stranger, cid, 600)

    over = create(anon_client, owner, 600)
    assert over.status_code == 413
    assert over.json()["type"] == QUOTA_TYPE


def test_the_owners_own_publication_does_not_free_the_daily_quota_either(anon_client, monkeypatch):
    """The allowance counts bytes uploaded in the day, whatever later names them."""
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner = actor()
    _, cid = finish(anon_client, owner, b"x" * 600)

    publish(owner, cid, 600)

    assert create(anon_client, owner, 600).status_code == 413


def test_a_deferred_length_upload_is_bounded_by_bytes_the_owner_published(anon_client, monkeypatch):
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner = actor()
    _, cid = finish(anon_client, owner, b"x" * 600)
    publish(owner, cid, 600)
    created = anon_client.post("/v1/uploads", headers={**TUS, **owner.bearer, "Upload-Defer-Length": "1"})
    assert created.status_code == 201
    upload_id = created.headers["location"].rsplit("/", 1)[1]

    over = anon_client.patch(
        f"/v1/uploads/{upload_id}",
        content=b"y" * 600,
        headers={**TUS, **owner.bearer, "Upload-Offset": "0", "Content-Type": OFFSET_TYPE},
    )

    assert over.status_code == 413


def test_the_reported_reproduction_over_http_with_a_tier_zero_stranger(anon_client, monkeypatch):
    """Upload as X; as tier-0 Y post a manifest naming its cid through the real ingest endpoint.

    The manifest handler accepts any tier and any file that exists in the
    content store, so this is how the bug was reached. Afterwards X's quota is
    still spent and the reaper removes X's upload and its bytes after the TTL:
    a standalone manifest no version names uses nothing.
    """
    monkeypatch.setenv("UPLOAD_DAILY_QUOTA_BYTES", "1000")
    owner, stranger = actor(), actor()
    # Unique bytes: the test database outlives a test, and another upload naming
    # the same CID would keep the shared blob alive on its own.
    data = (b"x" + uuid.uuid4().hex.encode()) * 20
    data = data[:600]
    upload_id, cid = finish(anon_client, owner, data)
    record = sign_record(
        {
            "v": 1,
            "type": "manifest",
            "author": stranger.did,
            "created": utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": manifest_body(cid, len(data)),
            "proofs": [],
        },
        stranger.key,
    )

    posted = anon_client.post(
        "/v1/records",
        json=record,
        headers={"Authorization": f"Bearer {issue_access_token(stranger.did, 0)}"},
    )
    assert posted.status_code == 201, posted.text

    assert create(anon_client, owner, 600).status_code == 413
    reap_after_ttl(upload_id)
    assert row(upload_id) is None
    assert not bytes_kept(cid)  # a standalone manifest no version names holds nothing


# --- the reaper keeps an upload only when its owner's records name it -----------------


def test_a_strangers_manifest_does_not_keep_an_upload_from_the_reaper(anon_client):
    """The bug's reproduction: the upload survived the reaper."""
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"named by a stranger")
    post_manifest(stranger, cid, len(b"named by a stranger"))

    reap_after_ttl(upload_id)

    assert row(upload_id) is None


def test_a_strangers_standalone_manifest_does_not_keep_the_bytes_either(anon_client):
    """A manifest no version names uses nothing, whoever signed it: the bytes go too."""
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"named by a stranger")
    post_manifest(stranger, cid, len(b"named by a stranger"))

    reap_after_ttl(upload_id)

    assert row(upload_id) is None
    assert not bytes_kept(cid)


def test_a_strangers_version_listing_nobody_else_does_not_keep_the_upload(anon_client):
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"in a strangers version")
    publish(stranger, cid, len(b"in a strangers version"))

    reap_after_ttl(upload_id)

    assert row(upload_id) is None
    assert bytes_kept(cid)


def test_a_manifest_of_a_version_the_owner_signed_keeps_the_upload(anon_client):
    owner = actor()
    upload_id, cid = finish(anon_client, owner, b"my paper")
    publish(owner, cid, len(b"my paper"))

    reap_after_ttl(upload_id)

    assert row(upload_id) is not None and row(upload_id).cid == cid
    assert bytes_kept(cid)


def test_a_manifest_of_a_version_the_owner_is_a_listed_coauthor_of_keeps_the_upload(anon_client):
    owner, lead = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"our paper")
    publish(lead, cid, len(b"our paper"), authors=[lead.did, {"did": owner.did, "name": "Co Author"}])

    reap_after_ttl(upload_id)

    assert row(upload_id) is not None
    assert bytes_kept(cid)


def test_a_version_that_carries_its_manifest_inline_keeps_the_upload(anon_client):
    owner = actor()
    upload_id, cid = finish(anon_client, owner, b"inline manifest")
    append(owner, "paper.version", version_body(manifest_body(cid, 15), [owner.did]))

    reap_after_ttl(upload_id)

    assert row(upload_id) is not None
    assert bytes_kept(cid)


def test_a_manifest_the_owner_signed_but_no_version_names_does_not_keep_the_upload(anon_client):
    """A manifest alone is not paper: only a version's manifest makes an upload referenced."""
    owner = actor()
    upload_id, cid = finish(anon_client, owner, b"loose manifest")
    post_manifest(owner, cid, len(b"loose manifest"))

    reap_after_ttl(upload_id)

    assert row(upload_id) is None


def test_bytes_named_only_by_the_owners_standalone_manifest_are_reaped(anon_client):
    """The bug's reproduction: the upload row went, but its bytes were kept for ever.

    A standalone manifest that no ``paper.version`` names is not a record that
    uses the file, so it must not hold the bytes past the orphan TTL.
    """
    owner = actor()
    upload_id, cid = finish(anon_client, owner, b"loose bytes")
    post_manifest(owner, cid, len(b"loose bytes"))

    reap_after_ttl(upload_id)

    assert row(upload_id) is None
    assert content.get_blob(cid) is None
    assert not content.blob_path(cid).exists()


@pytest.mark.parametrize(
    ("record_type", "field"),
    [
        ("discussion.post", "textCid"),
        ("correction", "reasonCid"),
        ("retraction", "reasonCid"),
        ("withdrawal", "reasonCid"),
        ("moderation.decision", "reasonCid"),
    ],
)
def test_a_record_the_owner_signed_that_names_the_file_keeps_the_upload(anon_client, record_type, field):
    owner = actor()
    upload_id, cid = finish(anon_client, owner, b"words in a file " + record_type.encode())
    append(owner, record_type, {"target": f"bafyreitarget{uuid.uuid4().hex}", field: cid})

    reap_after_ttl(upload_id)

    assert row(upload_id) is not None
    assert bytes_kept(cid)


@pytest.mark.parametrize(
    ("record_type", "field"),
    [
        ("discussion.post", "textCid"),
        ("correction", "reasonCid"),
        ("retraction", "reasonCid"),
        ("withdrawal", "reasonCid"),
        ("moderation.decision", "reasonCid"),
    ],
)
def test_a_record_a_stranger_signed_does_not_keep_the_upload_but_keeps_the_file(anon_client, record_type, field):
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"someone elses words " + record_type.encode())
    append(stranger, record_type, {"target": f"bafyreitarget{uuid.uuid4().hex}", field: cid})

    reap_after_ttl(upload_id)

    assert row(upload_id) is None
    assert bytes_kept(cid)


def test_a_file_no_record_names_is_deleted_with_its_upload(anon_client):
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"nobody names me")
    post_manifest(stranger, "bafkreisomethingelseentirely", 1)

    reap_after_ttl(upload_id)

    assert row(upload_id) is None
    assert content.get_blob(cid) is None
    assert not content.blob_path(cid).exists()


def test_a_file_two_owners_uploaded_stays_while_one_of_them_publishes_it(anon_client):
    """Identical bytes share one blob; the publisher's upload keeps it, the other upload goes."""
    publisher, other = actor(), actor()
    mine, cid = finish(anon_client, publisher, b"shared bytes")
    theirs, same = finish(anon_client, other, b"shared bytes")
    assert same == cid
    publish(publisher, cid, len(b"shared bytes"))
    age(mine, 8)
    age(theirs, 8)

    reaper.reap_abandoned_uploads()

    assert row(mine) is not None
    assert row(theirs) is None
    assert bytes_kept(cid)


def test_the_reaper_deletes_nothing_when_the_record_log_cannot_be_read(anon_client, monkeypatch):
    owner = actor()
    upload_id, cid = finish(anon_client, owner, b"cannot tell")
    monkeypatch.setattr(reaper.references, "scan", lambda candidates: None)

    try:
        reap_after_ttl(upload_id)

        assert row(upload_id) is not None
        assert bytes_kept(cid)
    finally:
        forget(upload_id)  # aged and unreferenced: any later reaper run would take it


def test_the_scan_reads_the_whole_log_not_just_its_first_batch(anon_client, monkeypatch):
    monkeypatch.setattr(references, "_BATCH", 2)
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"deep in the log")
    for n in range(5):
        post_manifest(stranger, f"bafkreiunrelatedbefore{n}", n)
    publish(owner, cid, len(b"deep in the log"))
    for n in range(5):
        post_manifest(stranger, f"bafkreiunrelatedafter{n}", n)

    reap_after_ttl(upload_id)

    assert row(upload_id) is not None
    assert bytes_kept(cid)


def test_an_erasure_request_does_not_hold_a_file_back(anon_client):
    """A record that asks for bytes to go is not a record that uses them."""
    owner, stranger = actor(), actor()
    upload_id, cid = finish(anon_client, owner, b"to be erased")
    append(stranger, "erasure.request", {"cids": [cid]})

    reap_after_ttl(upload_id)

    assert row(upload_id) is None
    assert content.get_blob(cid) is None
    assert not content.blob_path(cid).exists()
