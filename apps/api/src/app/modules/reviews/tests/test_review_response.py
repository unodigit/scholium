"""Tests for ``POST /v1/reviews/{cid}/response`` (plugin: reviews, feature 114).

The paper and its listed version are put in place through the submissions
plugin's ``save_paper`` / ``save_version`` -- the calls its handlers make --
and appended to the event log, the way the sibling suites do it.  A reviewer
commits a review, then a paper author answers it with a signed
``review.response``; the replies must reach ``review_responses`` and be served
with the review by ``GET /v1/papers/{id}/reviews``.

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
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
)

from app import db
from app.main import app
from app.modules import ledger
from app.modules.identity.models import Account, ensure_account_table
from app.modules.reviews import (
    commitment_digest,
    get_review_response,
    list_review_responses,
)
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

client = TestClient(app)

RESPONSE_URL = "/v1/reviews/{cid}/response"
COMMIT_URL = "/v1/reviews/commit"
REVEAL_URL = "/v1/reviews/reveal"
PAPERS_URL = "/v1/papers"

COMMIT_TYPE = "review.commit"
REVEAL_TYPE = "review.formal"
RESPONSE_TYPE = "review.response"
CATEGORY = "cs.CR"
RUBRIC = (
    "soundness",
    "evidence",
    "reproducibility",
    "novelty",
    "clarity",
    "limitations",
)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_hex(*parts: bytes) -> str:
    return hashlib.sha256(b"|".join(parts)).hexdigest()


def _sign(seed: SigningKey, record_type: str, body: dict) -> dict:
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(seed),
            "created": _timestamp(),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        seed,
    )


class Paper:
    """One listed paper, its signer an author and ``coauthors`` also bylined."""

    def __init__(self, coauthors: Sequence[str] = (), signing_key: Optional[SigningKey] = None) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = signing_key or SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Review response test paper {self.tag}"
        self.abstract = "A paper whose authors answer a formal review."
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
        self.short_id = derive_short_id(genesis["id"])


class Member:
    """A signed-in tier-3 member, optionally a paper author."""

    def __init__(self, seed: Optional[SigningKey] = None, tier: int = 3) -> None:
        self.seed = seed or SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(did=self.did, tier=tier, created_at=_now() - timedelta(days=400))
            )
            session.commit()

        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def response_record(self, review_cid: str, marker: str) -> dict:
        """A signed ``review.response`` with one reply per rubric dimension."""
        items = [
            {"dimension": dimension, "reply": f"{marker} {dimension}"}
            for dimension in RUBRIC
        ]
        return _sign(
            self.seed,
            RESPONSE_TYPE,
            {"review": review_cid, "items": items},
        )

    def post_response(self, review_cid: str, marker: str):
        return client.post(
            RESPONSE_URL.format(cid=review_cid),
            json=self.response_record(review_cid, marker),
            headers=self.headers,
        )


class Reviewer:
    """A tier-3 member with one pseudonymous key and nullifier per paper."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self._secret = secrets.token_bytes(32)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(did=self.did, tier=3, created_at=_now() - timedelta(days=400))
            )
            session.commit()

        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 3)}"}

    def review_key(self, paper: Paper) -> SigningKey:
        return SigningKey(
            hashlib.sha256(
                b"review-key|" + self._secret + b"|" + paper.paper_cid.encode()
            ).digest()
        )

    def nullifier(self, paper: Paper) -> str:
        return _sha256_hex(self._secret, paper.paper_cid.encode())

    def rubric(self, paper: Paper, report: str) -> dict:
        return {
            "target": paper.version_cid,
            "paper": paper.paper_cid,
            "scores": {
                dimension: {
                    "score": 4,
                    "justification": f"Why {dimension} is 4 of 5.",
                }
                for dimension in RUBRIC
            },
            "confidence": 4,
            "recommendation": "minor_revisions",
            "report": report,
            "reviewKey": did_key_from_signing_key(self.review_key(paper)),
            "nullifier": self.nullifier(paper),
        }

    def commit_record(self, paper: Paper, body: dict) -> dict:
        review_key = self.review_key(paper)
        return _sign(
            review_key,
            COMMIT_TYPE,
            {
                "target": paper.version_cid,
                "commitment": commitment_digest(body),
                "reviewKey": did_key_from_signing_key(review_key),
                "nullifier": self.nullifier(paper),
            },
        )

    def post_commit(self, paper: Paper, body: Optional[dict] = None) -> tuple[dict, dict]:
        body = body or self.rubric(paper, f"Review to answer {uuid.uuid4().hex}.")
        record = self.commit_record(paper, body)
        response = client.post(COMMIT_URL, json=record, headers=self.headers)
        assert response.status_code == 201, response.text
        # A first reveal is only accepted once two independent reviews are
        # committed on the version; the setup supplies the second.
        from .test_review_reveal import open_reveal_gate

        open_reveal_gate(paper, paper.version_cid)
        return record, body

    def post_reveal(self, paper: Paper, body: dict):
        revealed = dict(body)
        revealed["commitment"] = commitment_digest(body)
        record = _sign(self.review_key(paper), REVEAL_TYPE, revealed)
        response = client.post(REVEAL_URL, json=record, headers=self.headers)
        assert response.status_code == 201, response.text
        return record


# --------------------------------------------------------------------------- #
# Accepted
# --------------------------------------------------------------------------- #


def test_an_author_response_is_saved_and_served_with_the_review():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    author = Member(seed=paper.seed)
    marker = f"Author reply {uuid.uuid4().hex}"

    response = author.post_response(commit["id"], marker)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["review_cid"] == commit["id"]
    assert body["replies"]["soundness"] == f"{marker} soundness"

    saved = get_review_response(response.json()["id"])
    assert saved is not None
    assert saved.review_cid == commit["id"]
    assert saved.replies["soundness"] == f"{marker} soundness"
    listed = list_review_responses(commit["id"])
    assert [row.response_cid for row in listed] == [saved.response_cid]

    listing = client.get(f"{PAPERS_URL}/{paper.short_id}/reviews")
    assert listing.status_code == 200, listing.text
    assert f"{marker} soundness" in listing.text
    assert commit["id"] in listing.text


def test_a_response_may_be_addressed_by_the_revealed_review_cid():
    paper = Paper()
    reviewer = Reviewer()
    commit, review_body = reviewer.post_commit(paper)
    reveal = reviewer.post_reveal(paper, review_body)
    author = Member(seed=paper.seed)
    marker = f"Author reply {uuid.uuid4().hex}"

    response = author.post_response(reveal["id"], marker)

    assert response.status_code == 201, response.text
    assert response.json()["review_cid"] == commit["id"]


def test_a_listed_co_author_may_answer():
    coauthor = Member()
    paper = Paper(coauthors=[coauthor.did])
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)

    response = coauthor.post_response(commit["id"], f"Co-author reply {uuid.uuid4().hex}")

    assert response.status_code == 201, response.text


def test_a_response_may_spell_its_replies_as_text_or_body():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    author = Member(seed=paper.seed)
    marker = f"Author reply {uuid.uuid4().hex}"
    record = _sign(
        paper.seed,
        RESPONSE_TYPE,
        {
            "review": commit["id"],
            "items": [
                {"dimension": "clarity", "text": marker},
                {"dimension": "novelty", "body": f"{marker} again"},
            ],
        },
    )

    response = client.post(
        RESPONSE_URL.format(cid=commit["id"]), json=record, headers=author.headers
    )

    assert response.status_code == 201, response.text
    saved = get_review_response(record["id"])
    assert saved.replies == {"clarity": marker, "novelty": f"{marker} again"}


# --------------------------------------------------------------------------- #
# Refused
# --------------------------------------------------------------------------- #


def test_a_member_who_is_not_on_the_byline_is_refused():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    outsider = Member()

    response = outsider.post_response(commit["id"], f"Outsider reply {uuid.uuid4().hex}")

    assert response.status_code == 403, response.text


def test_the_reviewer_may_not_answer_their_own_review():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    marker = f"Reviewer reply {uuid.uuid4().hex}"

    record = _sign(
        reviewer.seed,
        RESPONSE_TYPE,
        {"review": commit["id"], "items": [{"dimension": "soundness", "reply": marker}]},
    )
    response = client.post(
        RESPONSE_URL.format(cid=commit["id"]), json=record, headers=reviewer.headers
    )

    assert response.status_code == 403, response.text


def test_a_response_signed_by_someone_other_than_the_caller_is_refused():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    author = Member(seed=paper.seed)
    stranger = Member()
    record = stranger.response_record(commit["id"], f"Wrong signer {uuid.uuid4().hex}")

    response = client.post(
        RESPONSE_URL.format(cid=commit["id"]), json=record, headers=author.headers
    )

    assert response.status_code == 403, response.text


def test_an_unauthenticated_caller_is_refused():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    author = Member(seed=paper.seed)

    response = client.post(
        RESPONSE_URL.format(cid=commit["id"]),
        json=author.response_record(commit["id"], "Anonymous reply"),
    )

    assert response.status_code == 401, response.text


def test_a_wrong_record_type_is_refused():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    author = Member(seed=paper.seed)
    record = author.response_record(commit["id"], "Reply")
    record["type"] = "review.formal"

    response = client.post(
        RESPONSE_URL.format(cid=commit["id"]), json=record, headers=author.headers
    )

    assert response.status_code == 422, response.text


def test_an_unknown_review_is_a_404():
    paper = Paper()
    author = Member(seed=paper.seed)

    response = author.post_response("bafyrei-not-a-review", "Reply")

    assert response.status_code == 404, response.text


def test_a_response_for_a_different_review_is_refused():
    paper = Paper()
    reviewer = Reviewer()
    first, _ = reviewer.post_commit(paper)
    other_paper = Paper()
    other_reviewer = Reviewer()
    second, _ = other_reviewer.post_commit(other_paper)
    author = Member(seed=paper.seed)

    # Addressed to the first review, but the body answers the second.
    record = author.response_record(second["id"], "Wrong review")
    response = client.post(
        RESPONSE_URL.format(cid=first["id"]), json=record, headers=author.headers
    )

    assert response.status_code == 422, response.text


def test_a_response_with_no_items_is_refused():
    paper = Paper()
    reviewer = Reviewer()
    commit, _ = reviewer.post_commit(paper)
    author = Member(seed=paper.seed)
    record = _sign(
        paper.seed, RESPONSE_TYPE, {"review": commit["id"], "items": []}
    )

    response = client.post(
        RESPONSE_URL.format(cid=commit["id"]), json=record, headers=author.headers
    )

    assert response.status_code == 422, response.text
