"""Download metadata for ``GET /v1/content/{cid}`` and its ``/versions`` read.

A signed manifest names each file: its ``path`` is the download name and its
``mediaType`` the response's type.  Without that, a browser saves a paper's
PDF under its bare cid with no extension, and ``/verify`` cannot say which
paper a dropped file belongs to.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app.main import app
from app.modules import content, ledger
from app.modules.submissions import (
    AWAITING_CONSENT,
    save_paper,
    save_version,
    transition_version,
)

_TO_LISTED = ("scanning", "moderation", "listed")


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


class Paper:
    """A paper, its listed version, and the manifest naming its file."""

    def __init__(self, *, path: str = "main.pdf", media_type: Optional[str] = "application/pdf"):
        self.tag = uuid.uuid4().hex
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)

        self.title = f"Download paper {self.tag}"
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": "A paper readers download.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        ledger.append(self.genesis)

        # The blob deliberately has no media type of its own: the response
        # must take the type from the signed manifest, not from the upload.
        self.data = f"%PDF-1.7 download test {self.tag}".encode()
        self.blob = content.store_bytes(self.data, media_type=None)
        content.set_scan_status(self.blob.cid, content.SCAN_PASSED)

        self.manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": path,
                        "cid": self.blob.cid,
                        "size": len(self.data),
                        "mediaType": media_type,
                        "role": "manuscript",
                    }
                ]
            },
        )
        ledger.append(self.manifest)

        self.version = self._sign(
            "paper.version",
            {
                "paper": self.genesis["id"],
                "n": 1,
                "title": self.title,
                "abstract": "A paper readers download.",
                "authors": [self.did],
                "manifest": self.manifest["id"],
                "licence": "CC-BY-4.0",
            },
            prev=self.genesis["id"],
        )
        ledger.append(self.version)

        save_paper(paper_cid=self.genesis["id"], categories=("cs.CR",))
        save_version(
            version_cid=self.version["id"],
            paper_cid=self.genesis["id"],
            n=1,
            title=self.title,
            abstract="A paper readers download.",
            manifest_cid=self.manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=self.genesis["id"],
        )
        from scholium_record_core import derive_short_id

        self.short_id = derive_short_id(self.genesis["id"])

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.key,
        )

    def list(self) -> None:
        for state in _TO_LISTED:
            transition_version(self.version["id"], state)


def content_url(cid: str) -> str:
    return f"/v1/content/{cid}"


def test_manifest_media_type_is_served_inline_with_the_signed_file_name(client):
    paper = Paper()
    paper.list()
    content.set_scan_status(paper.blob.cid, content.SCAN_PASSED)

    response = client.get(content_url(paper.blob.cid))

    assert response.status_code == 200
    assert response.content == paper.data
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.headers["content-disposition"] == 'inline; filename="main.pdf"'


def test_download_query_saves_the_file_as_an_attachment(client):
    paper = Paper()
    paper.list()
    content.set_scan_status(paper.blob.cid, content.SCAN_PASSED)

    response = client.get(content_url(paper.blob.cid), params={"download": "1"})

    assert response.status_code == 200
    assert response.headers["content-disposition"] == 'attachment; filename="main.pdf"'


def test_non_ascii_file_name_carries_filename_and_filename_star(client):
    paper = Paper(path="manuscrit-é.pdf")
    paper.list()
    content.set_scan_status(paper.blob.cid, content.SCAN_PASSED)

    response = client.get(content_url(paper.blob.cid), params={"download": "1"})

    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="manuscrit-_.pdf"')
    assert "filename*=UTF-8''manuscrit-%C3%A9.pdf" in disposition


def test_a_blob_no_manifest_names_serves_without_a_filename(client):
    data = uuid.uuid4().bytes * 4
    blob = content.store_bytes(data, media_type="application/octet-stream")
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

    response = client.get(content_url(blob.cid))

    assert response.status_code == 200
    assert response.content == data
    assert "content-disposition" not in response.headers


def test_versions_lists_the_listed_version_naming_the_blob(client):
    paper = Paper()
    paper.list()
    content.set_scan_status(paper.blob.cid, content.SCAN_PASSED)

    response = client.get(f"{content_url(paper.blob.cid)}/versions")

    assert response.status_code == 200
    body = response.json()
    assert body["cid"] == paper.blob.cid
    assert body["versions"] == [
        {
            "paper": paper.short_id,
            "shortId": paper.short_id,
            "paperCid": paper.genesis["id"],
            "versionCid": paper.version["id"],
            "n": 1,
            "version": 1,
            "title": paper.title,
            "path": "main.pdf",
            "fileName": "main.pdf",
            "file_name": "main.pdf",
            "role": "manuscript",
        }
    ]


def test_versions_never_names_an_unlisted_version(client):
    paper = Paper()  # awaiting consent: not in the public catalog

    response = client.get(f"{content_url(paper.blob.cid)}/versions")

    assert response.status_code == 404


def test_versions_of_an_unknown_cid_is_404(client):
    from scholium_record_core import compute_file_id

    response = client.get(f"/v1/content/{compute_file_id(uuid.uuid4().bytes)}/versions")

    assert response.status_code == 404


def test_versions_of_a_blob_no_paper_names_is_an_empty_list(client):
    blob = content.store_bytes(uuid.uuid4().bytes)
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

    response = client.get(f"{content_url(blob.cid)}/versions")

    assert response.status_code == 200
    assert response.json() == {"cid": blob.cid, "versions": []}
