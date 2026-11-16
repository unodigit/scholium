"""A co-author can read the PDF they are asked to approve (bug).

A version that lists a co-author waits in ``awaiting_consent`` until every
co-author has consented.  The consent page fetches the manuscript with the
co-author's token, but the blob scan used to start only when the version left
``awaiting_consent`` -- so the route answered ``423`` (still being scanned) for
the one file the co-author had to look at before consenting.

Files are scanned as soon as a manifest naming them is recorded (an upload
that completes is scanned even earlier, see the uploads tests), independent of
consent.  The version's own state machine is untouched.
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from pypdf import PdfWriter
from scholium_record_core import did_key_from_signing_key, sign_record, verify_record

from app.main import app
from app.modules import content, ledger, sanitizer, submissions
from app.modules.submissions import VersionAuthor, save_paper, save_version, transition_version
from app.security import issue_access_token


@pytest.fixture
def client():
    # Other suites clear the process-wide ledger subscribers; ``on_startup``
    # restores them for a real node, so do the same here.
    sanitizer.ensure_subscribed()
    with TestClient(app) as c:
        yield c


def _pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_metadata({"/Title": f"consent-{uuid.uuid4().hex}"})
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _bearer(did: str, tier: int = 2) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


class SubmittedVersion:
    """A first version, just submitted, that lists a co-author.

    The manuscript is in the content store exactly as an upload leaves it, and
    the records are signed and appended the way the submissions handlers
    leave them.  The version waits in ``awaiting_consent``.
    """

    def __init__(self, pdf: Optional[bytes] = None) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.coauthor_did = did_key_from_signing_key(SigningKey.generate())

        self.pdf = pdf if pdf is not None else _pdf()
        blob = content.store_bytes(self.pdf, media_type="application/pdf")
        self.file_cid = blob.cid

        title = f"Awaiting consent {self.tag}"
        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": title,
                "abstract": "Every co-author must approve this.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did, self.coauthor_did],
            },
        )
        manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": self.file_cid,
                        "size": len(self.pdf),
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
                "abstract": "Every co-author must approve this.",
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
            abstract="Every co-author must approve this.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=(
                VersionAuthor(self.did, 1, ("Conceptualization",)),
                VersionAuthor(self.coauthor_did, 2, ()),
            ),
            state=submissions.AWAITING_CONSENT,
        )
        self.version_cid: str = version["id"]

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        assert verify_record(record)
        return record

    @property
    def state(self) -> str:
        row = submissions.get_version(self.version_cid)
        assert row is not None
        return row.state


def test_a_coauthor_can_read_the_pdf_before_consenting(client):
    submitted = SubmittedVersion()
    assert submitted.state == submissions.AWAITING_CONSENT

    response = client.get(f"/v1/content/{submitted.file_cid}", headers=_bearer(submitted.coauthor_did))

    assert response.status_code == 200
    assert response.content == submitted.pdf


def test_the_scan_does_not_move_a_version_that_still_awaits_consent(client):
    submitted = SubmittedVersion()

    assert content.get_blob(submitted.file_cid).scan_status == content.SCAN_PASSED
    assert submitted.state == submissions.AWAITING_CONSENT


def test_the_pdf_is_still_hidden_from_everyone_else_before_listing(client):
    submitted = SubmittedVersion()
    stranger = did_key_from_signing_key(SigningKey.generate())

    assert client.get(f"/v1/content/{submitted.file_cid}").status_code == 404
    assert client.get(f"/v1/content/{submitted.file_cid}", headers=_bearer(stranger)).status_code == 404


def test_after_consent_a_version_whose_files_already_passed_moves_on_at_once(client):
    submitted = SubmittedVersion()

    transition_version(submitted.version_cid, submissions.SCANNING, reason="all authors consented")

    assert submitted.state == submissions.MODERATION


def test_a_failing_file_is_refused_to_the_coauthor_and_still_holds_the_version(client):
    from pypdf.generic import DictionaryObject, NameObject, TextStringObject

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_metadata({"/Title": f"evil-{uuid.uuid4().hex}"})
    writer._root_object[NameObject("/OpenAction")] = DictionaryObject(
        {
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('pwned')"),
        }
    )
    buffer = io.BytesIO()
    writer.write(buffer)
    submitted = SubmittedVersion(buffer.getvalue())

    # Scanned early, and refused: a bad file is never served, consent or not.
    assert content.get_blob(submitted.file_cid).scan_status == content.SCAN_FAILED
    response = client.get(f"/v1/content/{submitted.file_cid}", headers=_bearer(submitted.coauthor_did))
    assert response.status_code != 200
    assert submitted.pdf not in response.content
    assert submitted.state == submissions.AWAITING_CONSENT

    # The version scan after consent reaches the same verdict.
    transition_version(submitted.version_cid, submissions.SCANNING, reason="all authors consented")
    assert submitted.state == submissions.HELD
