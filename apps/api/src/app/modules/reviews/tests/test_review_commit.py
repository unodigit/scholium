"""Tests for ``POST /v1/reviews/commit`` (plugin: reviews, feature 107).

The paper is put in place through the submissions plugin's own ``save_paper``
/ ``save_version`` -- the calls its record handlers make -- and appended to the
event log, the way the sibling suites do it.  A reviewer is a fresh key with a
tier-3 ``accounts`` row and a tier-3 access token; the commit is signed by the
reviewer's pseudonymous per-paper key, not by their own DID.

Isolation note: the test database is shared by every test in a worker, so each
test generates its own keys, DIDs and paper cid; nothing is shared.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    did_key_from_signing_key,
    sign_record,
)

from app import db
from app.main import app
from app.modules import ledger
from app.modules.identity.models import Account, ensure_account_table
from app.modules.reviews import get_review, nullifier_bytes
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

client = TestClient(app)

COMMIT_URL = "/v1/reviews/commit"
COMMIT_TYPE = "review.commit"
CATEGORY = "cs.CR"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_hex(*parts: bytes) -> str:
    return hashlib.sha256(b"|".join(parts)).hexdigest()


def _sign(seed: SigningKey, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(seed),
            "created": _timestamp(),
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        seed,
    )


class Paper:
    """One listed paper, bylined with ``coauthors`` as well as its signer."""

    def __init__(self, coauthors: Sequence[str] = ()) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Review commit test paper {self.tag}"
        self.abstract = "A paper that reviewers commit to review."
        self.authors = [self.did, *coauthors]

        manuscript = f"%PDF-1.7 test manuscript {self.tag}".encode()
        genesis = _sign(
            self.seed,
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": self.abstract,
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": list(self.authors),
            },
        )
        manifest = _sign(
            self.seed,
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": compute_file_id(manuscript),
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        byline = [
            {"did": did, "position": position, "creditRoles": ["Conceptualization"]}
            for position, did in enumerate(self.authors, start=1)
        ]
        version = _sign(
            self.seed,
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": self.title,
                "abstract": self.abstract,
                "authors": byline,
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        save_paper(paper_cid=genesis["id"], categories=(CATEGORY,))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=self.title,
            abstract=self.abstract,
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=tuple(
                VersionAuthor(did, position, ("Conceptualization",))
                for position, did in enumerate(self.authors, start=1)
            ),
            state="listed",
        )

        self.version_cid = version["id"]
        self.paper_cid = genesis["id"]


class Reviewer:
    """A tier-3 member with one pseudonymous key and nullifier per paper."""

    def __init__(self, tier: int = 3) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self._secret = secrets.token_bytes(32)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(Account(did=self.did, tier=tier, created_at=_now() - timedelta(days=400)))
            session.commit()

        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def _review_key(self, paper: Paper) -> SigningKey:
        return SigningKey(
            hashlib.sha256(
                b"review-key|" + self._secret + b"|" + paper.paper_cid.encode()
            ).digest()
        )

    def nullifier(self, paper: Paper) -> str:
        return _sha256_hex(self._secret, paper.paper_cid.encode())

    def commit(self, paper: Paper, review_text: Optional[str] = None) -> dict:
        review_key = self._review_key(paper)
        sealed = review_text or f"sealed review {uuid.uuid4().hex}"
        body = {
            "target": paper.version_cid,
            "commitment": _sha256_hex(sealed.encode(), secrets.token_bytes(16)),
            "reviewKey": did_key_from_signing_key(review_key),
            "nullifier": self.nullifier(paper),
        }
        return _sign(review_key, COMMIT_TYPE, body)

    def post_commit(self, paper: Paper, review_text: Optional[str] = None):
        return client.post(COMMIT_URL, json=self.commit(paper, review_text), headers=self.headers)


def test_a_commit_is_saved_to_the_review_projection():
    reviewer = Reviewer()
    paper = Paper()
    record = reviewer.commit(paper)

    response = client.post(COMMIT_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 201, response.text
    assert response.json()["id"] == record["id"]
    assert response.json()["target"] == paper.version_cid
    row = get_review(record["id"])
    assert row is not None
    assert row.version_cid == paper.version_cid
    assert row.review_key == record["body"]["reviewKey"]
    assert row.nullifier == nullifier_bytes(record["body"]["nullifier"])
    assert row.committed_at is not None


def test_second_commit_by_the_same_reviewer_is_a_conflict():
    reviewer = Reviewer()
    paper = Paper()

    assert reviewer.post_commit(paper).status_code == 201
    second = reviewer.post_commit(paper)

    assert second.status_code == 409, second.text


def test_another_reviewer_may_still_commit_on_the_same_paper():
    paper = Paper()
    first, second = Reviewer(), Reviewer()

    assert first.post_commit(paper).status_code == 201
    assert second.post_commit(paper).status_code == 201


def test_a_listed_co_author_may_not_commit():
    coauthor = Reviewer()
    paper = Paper(coauthors=[coauthor.did])

    response = coauthor.post_commit(paper)

    assert response.status_code == 403, response.text


def test_a_caller_below_tier_3_may_not_commit():
    reviewer = Reviewer(tier=2)
    paper = Paper()

    response = reviewer.post_commit(paper)

    assert response.status_code == 403, response.text


def test_an_unauthenticated_caller_may_not_commit():
    reviewer = Reviewer()
    paper = Paper()

    response = client.post(COMMIT_URL, json=reviewer.commit(paper))

    assert response.status_code == 401, response.text


def test_a_wrong_record_type_is_refused():
    reviewer = Reviewer()
    paper = Paper()
    record = reviewer.commit(paper)
    record["type"] = "review.formal"

    response = client.post(COMMIT_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 422, response.text


def test_an_unknown_target_is_refused():
    reviewer = Reviewer()
    paper = Paper()
    record = reviewer.commit(paper)
    record["body"]["target"] = "bafyrei-not-a-version"

    response = client.post(COMMIT_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 422, response.text
