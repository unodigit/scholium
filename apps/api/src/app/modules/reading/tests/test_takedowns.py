"""Takedowns reach the reading routes (NET-5).

``GET /v1/content/{cid}`` answers ``451`` for a cid moderation tombstoned, but
a version's extracted text is a copy of what its manuscript PDF says.  Once
that PDF is taken down, ``GET /v1/papers/{id}/v/{n}/text`` and
``GET /v1/papers/{id}/compare`` must stop serving the text too -- with the same
``451`` problem, not ``200``.

A takedown that names the *file* leaves the version ``listed`` (see
``moderation.tests.test_tombstones``), so the version's state cannot be what
the routes look at: the denylist entry for the manuscript PDF is.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    verify_record,
)

from app import db
from app.main import app
from app.modules import checks, content, ledger
from app.modules.moderation import tombstone_cid, tombstone_target
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.modules.submissions.models import PaperVersion

PROBLEM_JSON = "application/problem+json"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Paper:
    """A paper with listed versions whose manuscripts are stored and whose text is extracted."""

    def __init__(self, texts_by_version: list[list[str]]) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Reading takedown paper {self.tag}"

        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": "Read by everyone.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        ledger.append(genesis)
        save_paper(paper_cid=genesis["id"], categories=("cs.CR",))
        self.paper_cid: str = genesis["id"]
        self.short_id: str = derive_short_id(genesis["id"])

        #: ``version_cid`` / manuscript ``pdf_cid`` / ``figure_cid``, by version number.
        self.version_cids: dict[int, str] = {}
        self.pdf_cids: dict[int, str] = {}
        self.figure_cids: dict[int, str] = {}

        prev = genesis["id"]
        for n, texts in enumerate(texts_by_version, start=1):
            prev = self._add_version(n, texts, prev)

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

    def _stored(self, data: bytes, media_type: str) -> str:
        blob = content.store_bytes(data, media_type=media_type)
        content.set_scan_status(blob.cid, content.SCAN_PASSED)
        assert blob.cid == compute_file_id(data)
        return blob.cid

    def _add_version(self, n: int, texts: list[str], prev: str) -> str:
        pdf = f"%PDF-1.7 reading test {self.tag} v{n}".encode()
        figure = f"<svg>{self.tag} v{n}</svg>".encode()
        pdf_cid = self._stored(pdf, "application/pdf")
        figure_cid = self._stored(figure, "image/svg+xml")
        manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": pdf_cid,
                        "size": len(pdf),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    },
                    {
                        "path": "fig1.svg",
                        "cid": figure_cid,
                        "size": len(figure),
                        "mediaType": "image/svg+xml",
                        "role": "figure",
                    },
                ]
            },
        )
        version = self._sign(
            "paper.version",
            {
                "paper": self.paper_cid,
                "n": n,
                "title": self.title,
                "abstract": "Read by everyone.",
                "authors": [{"did": self.did, "position": 1, "creditRoles": ["Conceptualization"]}],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": f"Version {n}.",
            },
            prev=prev,
        )
        ledger.append(manifest)
        ledger.append(version)
        save_version(
            version_cid=version["id"],
            paper_cid=self.paper_cid,
            n=n,
            title=self.title,
            abstract="Read by everyone.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=prev,
            change_note=f"Version {n}.",
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
            state="awaiting_consent",
        )
        # Set the state on the row: ``transition_version`` would publish
        # ``version.state_changed`` and, with JOBS_EAGER, run the scan job inline.
        with db.SessionLocal() as session:
            row = session.get(PaperVersion, version["id"])
            row.state = "listed"
            session.commit()
        checks.save_paragraphs(version["id"], texts)

        self.version_cids[n] = version["id"]
        self.pdf_cids[n] = pdf_cid
        self.figure_cids[n] = figure_cid
        return version["id"]

    def text_url(self, n: int) -> str:
        return f"/v1/papers/{self.short_id}/v/{n}/text"

    def compare_url(self, from_n: int, to_n: int) -> str:
        return f"/v1/papers/{self.short_id}/compare?from={from_n}&to={to_n}"


@pytest.fixture
def paper() -> Paper:
    return Paper(
        [
            ["Alpha opens the paper.", "Beta is shared by both versions."],
            ["Alpha opens the paper.", "Beta is shared by both versions.", "Gamma is new."],
        ]
    )


def _assert_takedown_problem(response) -> None:
    assert response.status_code == 451, response.text[:300]
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    body = response.json()
    assert body["status"] == 451
    assert body["title"] == "Unavailable For Legal Reasons"
    assert "moderation" in body["detail"]


# --------------------------------------------------------------------------- #
# Before any takedown the routes serve the text (guards the scene itself)
# --------------------------------------------------------------------------- #


def test_untouched_versions_serve_their_text(client, paper):
    text = client.get(paper.text_url(1))
    assert text.status_code == 200, text.text
    assert [p["text"] for p in text.json()["paragraphs"]] == [
        "Alpha opens the paper.",
        "Beta is shared by both versions.",
    ]

    compare = client.get(paper.compare_url(1, 2))
    assert compare.status_code == 200, compare.text
    assert [p["text"] for p in compare.json()["added"]] == ["Gamma is new."]


def test_the_content_route_already_refuses_a_tombstoned_pdf(client, paper):
    """The reference behaviour the reading routes must match."""
    tombstone_cid(paper.pdf_cids[1], "decision-1")

    response = client.get(f"/v1/content/{paper.pdf_cids[1]}")

    assert response.status_code == 451


# --------------------------------------------------------------------------- #
# GET /v1/papers/{id}/v/{n}/text
# --------------------------------------------------------------------------- #


def test_text_of_a_tombstoned_pdf_is_451(client, paper):
    tombstone_cid(paper.pdf_cids[1], "decision-1")

    response = client.get(paper.text_url(1))

    _assert_takedown_problem(response)
    assert "Alpha opens the paper." not in response.text


def test_text_of_a_version_taken_down_as_a_version_is_451(client, paper):
    """A version target tombstones every file *and* moves the version to ``rejected``."""
    tombstone_target(paper.version_cids[1], "decision-1", actor="did:key:zMod")

    response = client.get(paper.text_url(1))

    _assert_takedown_problem(response)


def test_text_of_a_paper_taken_down_as_a_paper_is_451_for_every_version(client, paper):
    tombstone_target(paper.paper_cid, "decision-1", actor="did:key:zMod")

    for n in (1, 2):
        _assert_takedown_problem(client.get(paper.text_url(n)))


def test_a_takedown_of_one_version_leaves_the_others_readable(client, paper):
    tombstone_cid(paper.pdf_cids[1], "decision-1")

    response = client.get(paper.text_url(2))

    assert response.status_code == 200, response.text
    assert response.json()["count"] == 3


def test_a_missing_version_is_still_404_not_451(client, paper):
    tombstone_cid(paper.pdf_cids[1], "decision-1")

    assert client.get(paper.text_url(9)).status_code == 404


# --------------------------------------------------------------------------- #
# GET /v1/papers/{id}/compare
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("taken_down", [1, 2], ids=["from-side", "to-side"])
def test_compare_with_a_tombstoned_side_is_451(client, paper, taken_down):
    tombstone_cid(paper.pdf_cids[taken_down], "decision-1")

    response = client.get(paper.compare_url(1, 2))

    _assert_takedown_problem(response)
    assert "Gamma is new." not in response.text
    assert "Alpha opens the paper." not in response.text


def test_compare_of_a_version_taken_down_as_a_version_is_451(client, paper):
    tombstone_target(paper.version_cids[2], "decision-1", actor="did:key:zMod")

    _assert_takedown_problem(client.get(paper.compare_url(1, 2)))


def test_compare_with_a_missing_version_is_still_404_not_451(client, paper):
    tombstone_cid(paper.pdf_cids[1], "decision-1")

    assert client.get(paper.compare_url(1, 9)).status_code == 404
