"""Pre-listing visibility of a version's text and checks (plugin: reading).

The checks pipeline extracts a version's paragraphs when it enters
``moderation`` -- before any moderator has approved it -- so ``GET /text``,
``GET /compare`` and ``GET /checks`` would hand the full text and the advisory
report of an unlisted version (``moderation``, ``held``, ``rejected``, ...)
to anyone.  They must instead answer with the unknown-version ``404`` to
anonymous callers and to anyone who is neither one of the version's authors
nor a tier-4 moderator -- the same rule ``GET /v1/content/{cid}`` applies to
the unlisted bytes themselves (``content.visibility.may_read``).  Authors and
moderators still get the content: moderators need it to review.

Listed versions keep the old, public behaviour.
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
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.modules.submissions.models import PaperVersion
from app.security import issue_access_token

PROBLEM_JSON = "application/problem+json"

V1_TEXT = ["Alpha opens the paper.", "Beta is shared by both versions."]
V2_TEXT = [
    "Alpha opens the paper.",
    "Beta is shared by both versions.",
    "Gamma is new and still in moderation.",
]


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Paper:
    """A paper whose version 1 is ``listed`` (by A) and version 2 sits in
    ``moderation`` (by B), both with extracted text and a checks row."""

    def __init__(self, v2_state: str = "moderation") -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)  # version 1's author
        b_seed = SigningKey.generate()
        self.author_b = did_key_from_signing_key(b_seed)  # version 2's author
        self.title = f"Reading visibility paper {self.tag}"

        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": "Read by everyone once listed.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        ledger.append(genesis)
        save_paper(paper_cid=genesis["id"], categories=("cs.CR",))
        self.paper_cid: str = genesis["id"]
        self.short_id: str = derive_short_id(genesis["id"])

        #: version ``n``'s record cid and manuscript pdf cid.
        self.version_cids: dict[int, str] = {}
        self.pdf_cids: dict[int, str] = {}

        prev = genesis["id"]
        prev = self._add_version(
            1,
            V1_TEXT,
            author=self.did,
            state="listed",
            prev=prev,
        )
        self._add_version(
            2,
            V2_TEXT,
            author=self.author_b,
            state=v2_state,
            prev=prev,
        )

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

    def _add_version(
        self,
        n: int,
        texts: list[str],
        *,
        author: str,
        state: str,
        prev: str,
    ) -> str:
        pdf = f"%PDF-1.7 visibility test {self.tag} v{n}".encode()
        blob = content.store_bytes(pdf, media_type="application/pdf")
        content.set_scan_status(blob.cid, content.SCAN_PASSED)
        assert blob.cid == compute_file_id(pdf)
        manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": blob.cid,
                        "size": len(pdf),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = self._sign(
            "paper.version",
            {
                "paper": self.paper_cid,
                "n": n,
                "title": self.title,
                "abstract": "Read by everyone once listed.",
                "authors": [{"did": author, "position": 1, "creditRoles": ["Conceptualization"]}],
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
            abstract="Read by everyone once listed.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=prev,
            change_note=f"Version {n}.",
            authors=(VersionAuthor(author, 1, ("Conceptualization",)),),
            state="awaiting_consent",
        )
        # Place the row exactly where the test needs it, bypassing jobs.
        with db.SessionLocal() as session:
            row = session.get(PaperVersion, version["id"])
            row.state = state
            session.commit()
        # The pipeline's extraction and checks, as they run for a version in
        # moderation, minus the jobs.
        checks.save_paragraphs(version["id"], texts)
        checks.save_check_result(version["id"], similarity_pct=10 + n)

        self.version_cids[n] = version["id"]
        self.pdf_cids[n] = blob.cid
        return version["id"]

    # -- the three routes under test -------------------------------------- #

    def text_url(self, n: int) -> str:
        return f"/v1/papers/{self.short_id}/v/{n}/text"

    def compare_url(self, from_n: int, to_n: int) -> str:
        return f"/v1/papers/{self.short_id}/compare?from={from_n}&to={to_n}"

    def checks_url(self, n: int) -> str:
        return f"/v1/papers/{self.short_id}/v/{n}/checks"


@pytest.fixture
def paper() -> Paper:
    return Paper()


def _bearer(did: str, tier: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _assert_not_found(response) -> None:
    """The unknown-version 404: a problem document that hides the version."""
    assert response.status_code == 404, response.text[:300]
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    body = response.json()
    assert body["status"] == 404
    assert body["title"] == "Not Found"


# --------------------------------------------------------------------------- #
# The bug: text and checks of a version still in moderation are public
# --------------------------------------------------------------------------- #


def test_text_of_a_version_in_moderation_is_not_public(client, paper):
    response = client.get(paper.text_url(2))

    _assert_not_found(response)
    assert "Gamma is new and still in moderation." not in response.text


def test_compare_with_an_unlisted_side_is_not_public(client, paper):
    response = client.get(paper.compare_url(1, 2))

    _assert_not_found(response)
    assert "Gamma is new and still in moderation." not in response.text


def test_checks_of_a_version_in_moderation_are_not_public(client, paper):
    # The checks row exists (saved above), so only the visibility gate can
    # turn this into the unknown-version 404 rather than the report.
    response = client.get(paper.checks_url(2))

    _assert_not_found(response)


@pytest.mark.parametrize(
    "state", ["awaiting_consent", "scanning", "moderation", "held", "rejected"]
)
def test_every_unlisted_state_hides_the_text(client, state):
    scene = Paper(v2_state=state)

    response = client.get(scene.text_url(2))

    _assert_not_found(response)


# --------------------------------------------------------------------------- #
# Who may still read an unlisted version
# --------------------------------------------------------------------------- #


def test_the_unlisted_versions_author_still_reads_text_compare_and_checks(client, paper):
    headers = _bearer(paper.author_b, 2)

    assert client.get(paper.text_url(2), headers=headers).status_code == 200
    compare = client.get(paper.compare_url(1, 2), headers=headers)
    assert compare.status_code == 200, compare.text
    assert [p["text"] for p in compare.json()["added"]] == [
        "Gamma is new and still in moderation."
    ]
    checks_response = client.get(paper.checks_url(2), headers=headers)
    assert checks_response.status_code == 200, checks_response.text
    assert checks_response.json()["similarityPct"] == 12


def test_a_tier4_moderator_still_reads_text_compare_and_checks(client, paper):
    # A moderator who is not an author at all: the queue needs the text.
    moderator = did_key_from_signing_key(SigningKey.generate())
    headers = _bearer(moderator, 4)

    assert client.get(paper.text_url(2), headers=headers).status_code == 200
    assert client.get(paper.compare_url(1, 2), headers=headers).status_code == 200
    assert client.get(paper.checks_url(2), headers=headers).status_code == 200


def test_everyone_else_gets_404_even_when_authenticated(client, paper):
    stranger = did_key_from_signing_key(SigningKey.generate())

    for tier in (0, 1, 2, 3):
        headers = _bearer(stranger, tier)
        assert client.get(paper.text_url(2), headers=headers).status_code == 404, (
            f"tier {tier}"
        )
        assert client.get(paper.checks_url(2), headers=headers).status_code == 404, (
            f"tier {tier}"
        )


def test_an_author_of_only_the_listed_side_cannot_compare(client, paper):
    # ``paper.did`` authored version 1 (listed) but not version 2: the diff
    # would quote version 2's pre-listing text, so it stays 404.  Version 1's
    # own text and checks remain theirs to read.
    headers = _bearer(paper.did, 2)

    assert client.get(paper.compare_url(1, 2), headers=headers).status_code == 404
    assert client.get(paper.text_url(1), headers=headers).status_code == 200


def test_an_unusable_token_is_read_as_anonymous(client, paper):
    response = client.get(
        paper.text_url(2),
        headers={"Authorization": "Bearer not-a-token"},
    )

    _assert_not_found(response)


# --------------------------------------------------------------------------- #
# Listed versions are unchanged, and so is the takedown answer
# --------------------------------------------------------------------------- #


def test_listed_versions_stay_public(client, paper):
    text = client.get(paper.text_url(1))
    assert text.status_code == 200, text.text
    assert [p["text"] for p in text.json()["paragraphs"]] == V1_TEXT

    assert client.get(paper.checks_url(1)).status_code == 200

    compare = client.get(paper.compare_url(1, 1))
    assert compare.status_code == 200, compare.text


def test_a_delisted_version_is_no_longer_public(client, paper):
    assert client.get(paper.text_url(1)).status_code == 200

    with db.SessionLocal() as session:
        row = session.get(PaperVersion, paper.version_cids[1])
        row.state = "rejected"
        session.commit()

    _assert_not_found(client.get(paper.text_url(1)))


def test_a_taken_down_version_still_answers_451_not_404(client, paper):
    # The takedown answer (NET-5) comes first, exactly as ``/v1/content``
    # orders its tombstone before the listing gate -- including for callers
    # the gate would refuse anyway.
    from app.modules.moderation import tombstone_cid

    tombstone_cid(paper.pdf_cids[2], "decision-1")

    response = client.get(paper.text_url(2))

    assert response.status_code == 451, response.text[:300]
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
