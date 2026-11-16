"""Pre-listing visibility of stored content (plugin: content).

A paper's bytes become public only when a version that references them is
``listed``.  While a version sits in ``moderation`` (or any other unlisted
state) its files may be read only by that version's authors and by moderators
(tier 4); everyone else -- anonymous callers included -- gets ``404``, the
same answer as for a cid nothing is stored for, so the response never reveals
that unlisted content exists.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    did_key_from_signing_key,
    sign_record,
    verify_record,
)

from app import db
from app.main import app
from app.modules import content, ledger, submissions
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.modules.submissions.models import PaperVersion
from app.security import issue_access_token


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _timestamp(offset: timedelta = timedelta(0)) -> str:
    return (datetime.now(timezone.utc) + offset).strftime("%Y-%m-%dT%H:%M:%SZ")


class UnlistedPaper:
    """One paper whose single version's manuscript is really in the blob store.

    The records are signed and appended exactly the way the submissions
    handlers leave them, the paper and version are indexed through
    ``save_paper`` / ``save_version``, and the version is then put directly in
    the state the test needs (the way the moderation tests place a scene).
    """

    def __init__(self, state: str = "moderation") -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        coauthor_seed = SigningKey.generate()
        self.coauthor_did = did_key_from_signing_key(coauthor_seed)

        self.manuscript = f"%PDF-1.7 listing gate test {self.tag}".encode()
        blob = content.store_bytes(self.manuscript, media_type="application/pdf")
        content.set_scan_status(blob.cid, content.SCAN_PASSED)
        assert blob.cid == compute_file_id(self.manuscript)
        self.file_cid: str = blob.cid

        title = f"Listing gate paper {self.tag}"
        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": title,
                "abstract": "Waiting for a moderator.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": self.file_cid,
                        "size": len(self.manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = self._sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": title,
                "abstract": "Waiting for a moderator.",
                "authors": [
                    {"did": self.did, "position": 1, "creditRoles": ["Conceptualization"]},
                    {"did": self.coauthor_did, "position": 2, "creditRoles": []},
                ],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        save_paper(paper_cid=genesis["id"], categories=("cs.CR",))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=title,
            abstract="Waiting for a moderator.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=(
                VersionAuthor(self.did, 1, ("Conceptualization",)),
                VersionAuthor(self.coauthor_did, 2, ()),
            ),
        )
        self.version_cid: str = version["id"]
        self.manifest_cid: str = manifest["id"]
        self.state: str = state
        self._force_state(state)

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": _timestamp(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        assert verify_record(record)
        return record

    def _force_state(self, state: str) -> None:
        """Put the version row exactly where the test needs it, bypassing jobs."""
        with db.SessionLocal() as session:
            row = session.get(PaperVersion, self.version_cid)
            assert row is not None
            row.state = state
            if state == submissions.LISTED:
                row.listed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session.commit()

    def list_it(self) -> None:
        """Move the version to ``listed`` (the paper's bytes become public)."""
        self._force_state(submissions.LISTED)


def _bearer(did: str, tier: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


# --------------------------------------------------------------------------- #
# The bug: bytes of a version still in moderation are public
# --------------------------------------------------------------------------- #


def test_file_of_a_version_in_moderation_is_not_public(client):
    paper = UnlistedPaper(state="moderation")

    response = client.get(f"/v1/content/{paper.file_cid}")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_the_manifest_records_own_cid_is_never_content(client):
    # The manifest is a ledger record under a DAG-CBOR record id, not a raw
    # file id: the route answers 404 for it whether the version is listed or
    # not (records are served by GET /v1/records/{cid}).
    paper = UnlistedPaper(state="moderation")

    response = client.get(f"/v1/content/{paper.manifest_cid}")

    assert response.status_code == 404


def test_scanning_file_of_an_unlisted_version_is_not_public_either(client):
    paper = UnlistedPaper(state="awaiting_consent")
    content.set_scan_status(paper.file_cid, content.SCAN_SCANNING)

    response = client.get(f"/v1/content/{paper.file_cid}")

    # The gate answers before the scan gate, so an anonymous caller cannot
    # even learn that unlisted bytes exist (a 423 would leak that).
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Who may still read unlisted bytes
# --------------------------------------------------------------------------- #


def test_the_versions_authors_may_read_unlisted_bytes(client):
    paper = UnlistedPaper(state="moderation")

    for did in (paper.did, paper.coauthor_did):
        response = client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(did, 2))
        assert response.status_code == 200
        assert response.content == paper.manuscript


def test_a_moderator_may_read_unlisted_bytes(client):
    paper = UnlistedPaper(state="moderation")
    moderator = did_key_from_signing_key(SigningKey.generate())

    response = client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(moderator, 4))

    assert response.status_code == 200
    assert response.content == paper.manuscript


def test_everyone_else_gets_404_even_when_authenticated(client):
    paper = UnlistedPaper(state="moderation")
    stranger = did_key_from_signing_key(SigningKey.generate())

    for tier in (0, 1, 2, 3):
        response = client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(stranger, tier))
        assert response.status_code == 404, f"tier {tier}"


def test_being_an_author_elsewhere_grants_nothing(client):
    paper = UnlistedPaper(state="moderation")
    other = UnlistedPaper(state="listed")

    # `other` is listed, so its bytes are public for everyone ...
    assert client.get(f"/v1/content/{other.file_cid}").status_code == 200
    # ... including for `paper`'s author; but authorship of one paper grants
    # nothing on another paper's unlisted bytes, even for a tier-2 author.
    response = client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(other.did, 2))

    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Listing makes the bytes public
# --------------------------------------------------------------------------- #


def test_file_becomes_public_when_a_referencing_version_is_listed(client):
    paper = UnlistedPaper(state="moderation")
    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 404

    paper.list_it()

    response = client.get(f"/v1/content/{paper.file_cid}")
    assert response.status_code == 200
    assert response.content == paper.manuscript
    assert "sandbox" in response.headers["content-security-policy"].lower()


def test_a_delisted_versions_file_is_no_longer_public(client):
    # Delisting (a `reject`/`delist` decision) is not a tombstone: the bytes
    # stay and the cid is not denylisted -- but the version is unlisted, so
    # the paper vanishes from public view, its files included.
    paper = UnlistedPaper(state="listed")
    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 200

    paper._force_state(submissions.REJECTED)

    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 404


def test_an_unusable_token_is_read_as_anonymous(client):
    paper = UnlistedPaper(state="moderation")

    response = client.get(
        f"/v1/content/{paper.file_cid}",
        headers={"Authorization": "Bearer not-a-token"},
    )

    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Content no version references keeps the old, public behaviour
# --------------------------------------------------------------------------- #


def test_unreferenced_blob_stays_public(client):
    data = f"loose bytes {uuid.uuid4().hex}".encode()
    blob = content.store_bytes(data, media_type="text/plain")
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 200
    assert response.content == data
