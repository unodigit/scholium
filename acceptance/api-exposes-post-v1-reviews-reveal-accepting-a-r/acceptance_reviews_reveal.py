"""Acceptance tests for: API exposes ``POST /v1/reviews/reveal`` accepting a
``review.formal`` whose commitment matches, requiring scores 1-5 with a
justification for soundness, evidence, reproducibility, novelty, clarity and
limitations plus confidence and recommendation, and returning ``422`` for a
free-text-only review (reviews plugin, feature 109).

Criteria (app_spec.xml, feature 109):

* ``POST /v1/reviews/reveal`` with a report but no rubric scores returns
  ``422``.
* ``POST /v1/reviews/reveal`` whose content does not match the commitment
  returns ``422``.
* ``POST /v1/reviews/reveal`` with all six scores returns ``201``.

The request
-----------

A review is a two-step commit-reveal.  The reviewer first seals a
``review.commit`` through ``POST /v1/reviews/commit`` (feature 107), then
later reveals the rubric as a ``review.formal`` through the endpoint under
test.  Both records are signed by the reviewer's *pseudonymous per-paper
review key*, never by the reviewer's own DID; the access token is what says
who is calling::

    POST /v1/reviews/reveal
    Authorization: Bearer <tier-3 access token>

    {"v": 1, "type": "review.formal", "author": "did:key:z6Mk...",
     "created": "2026-11-16T00:00:00Z", "prev": null,
     "body": {"target": "<version cid>", "paper": "<paper cid>",
              "scores": {"soundness": {"score": 4, "justification": "..."},
                         ... all six dimensions ...},
              "confidence": 4, "recommendation": "minor_revisions",
              "report": "...", "commitment": "<sha-256 hex>",
              "reviewKey": "did:key:z6Mk...", "nullifier": "<sha-256 hex>"},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

``scores`` carries one ``{"score", "justification"}`` entry for each of the
six rubric dimensions, the shape the ``review.formal`` schema and the review
form's ``toReviewBody`` both fix.  ``confidence`` is an integer 1-5 (the
database column is an integer; the schema also allows low/medium/high), and
``recommendation`` is one of the schema's verdicts.

The commitment
--------------

The spec does not pin how the sealed content is hashed, but it does say the
revealed review must carry the commitment from its commit (the
``review.formal`` schema's ``commitment`` field: "Commitment from the matching
review.commit record") and that revealing *different* content is refused.  So
the commitment used here is a sha-256 over the canonical JSON of the review
being sealed -- the sealed content the reviewer decided on before committing.
The same body is committed and then revealed; a test that wants a mismatch
reveals different content, whose own commitment is therefore different.  That
is faithful to both readings of "matches" (the record's commitment field
equalling the commit's, or a digest of the revealed content equalling it)
without asserting anything the criteria do not say.

How the scene is set up
-----------------------

The paper a review is filed against belongs to the submissions plugin, whose
``POST /v1/records`` handlers carry tier, endorsement, consent and scan rules
that have nothing to do with reviewing.  So the paper is put in the node the
way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` signed by the
  submitting author and appended to the event log, the version's byline naming
  every author;
* the paper and its version indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make --
  with the version listed and each listed author on its ``authorship`` rows.

A reviewer is a fresh key whose ``accounts`` row is tier 3 and whose access
token is tier 3.  Their per-paper review key and nullifier are derived the way
feature 107's suite derives them, and the commit is filed through the real
``POST /v1/reviews/commit`` endpoint, so every test starts from a review the
node accepted.

Each criterion is observed through the status of the ``POST
/v1/reviews/reveal`` response alone -- the body of the response is not pinned,
and nothing here compares a whole response object, since later features may
add fields.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional, Sequence

from nacl.signing import SigningKey
from scholium_record_core import (
    canonical_envelope,
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_body,
    validate_envelope,
    verify_record,
)

from app import db
from app.modules import ledger
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

#: The endpoint under test.
REVEAL_URL = "/v1/reviews/reveal"

#: The endpoint that seals the review this one reveals (feature 107).
COMMIT_URL = "/v1/reviews/commit"

#: The record type the reveal endpoint accepts.
REVEAL_TYPE = "review.formal"

#: The record type the commit endpoint accepts.
COMMIT_TYPE = "review.commit"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"

#: Trust tier of a reviewer.
REVIEWER_TIER = 3

#: The six mandatory rubric dimensions (``review.formal`` schema).
RUBRIC = (
    "soundness",
    "evidence",
    "reproducibility",
    "novelty",
    "clarity",
    "limitations",
)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _now() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _timestamp() -> str:
    """Now as the ``created`` field of a record envelope."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_hex(*parts: bytes) -> str:
    return hashlib.sha256(b"|".join(parts)).hexdigest()


def _canonical(value: Any) -> bytes:
    """The repository's canonical JSON form: sorted keys, no spaces, UTF-8."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _sealed_digest(body: Mapping[str, Any]) -> str:
    """The sha-256 a reviewer commits to: the sealed review, minus its own commitment."""
    sealed = {key: value for key, value in body.items() if key != "commitment"}
    return hashlib.sha256(_canonical(sealed)).hexdigest()


def _sign(
    seed: SigningKey,
    record_type: str,
    body: dict,
    prev: Optional[str] = None,
    *,
    check_body: bool = True,
) -> dict:
    """A complete signed record by ``seed``; the fixture fails if it is not valid.

    ``check_body=False`` is for a record whose *body* is the thing under test --
    a free-text-only ``review.formal`` is deliberately schema-invalid and must
    still be signed and sent so the endpoint can refuse it.
    """
    record = sign_record(
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
    # Guard the fixture itself: a failure further on can only be the feature's.
    assert verify_record(record)
    # ``validate_envelope`` also validates the body; see ``check_body``.
    assert canonical_envelope(record)
    if check_body:
        assert validate_envelope(record) == [], validate_envelope(record)
        assert validate_body(record_type, body) == [], validate_body(record_type, body)
    return record


# --------------------------------------------------------------------------- #
# The scene: a listed paper and a tier-3 reviewer
# --------------------------------------------------------------------------- #


class Paper:
    """One paper with one listed version."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Review reveal acceptance paper {self.tag}"
        self.abstract = "A paper whose review is committed and then revealed."
        self.authors: list[str] = [self.did]

        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag}".encode()

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

        # Index the paper and its version the way the submissions handlers do,
        # with the version listed and every listed author on its byline.
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

        #: cid of the version a review commits to and is revealed against.
        self.version_cid: str = version["id"]
        #: cid of the paper's ``paper.genesis`` record.
        self.paper_cid: str = genesis["id"]
        #: The ``sch:xxxx-xxxx-xxxx`` id the paper is addressed by.
        self.short_id: str = derive_short_id(genesis["id"])


class Reviewer:
    """A signed-in tier-3 member who seals a review and later reveals it."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        #: The reviewer's private secret: the review key and nullifier derive from it.
        self._secret = secrets.token_bytes(32)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(
                    did=self.did,
                    tier=REVIEWER_TIER,
                    created_at=_now() - timedelta(days=400),
                )
            )
            session.commit()

        #: The reviewer's credentials: a tier-3 access token.
        self.headers = {
            "Authorization": f"Bearer {issue_access_token(self.did, REVIEWER_TIER)}"
        }

    def _review_key(self, paper: Paper) -> SigningKey:
        """The reviewer's pseudonymous key for ``paper``: never their own DID's key."""
        return SigningKey(
            hashlib.sha256(
                b"review-key|" + self._secret + b"|" + paper.paper_cid.encode()
            ).digest()
        )

    def nullifier(self, paper: Paper) -> str:
        """``H(secret || paperId)``: the same for this person and paper, every time."""
        return _sha256_hex(self._secret, paper.paper_cid.encode())

    def rubric(self, paper: Paper, *,
               score: int = 4,
               report: Optional[str] = None) -> dict:
        """The body of a revealed review, with all six scored dimensions.

        Each dimension is ``{"score": 1-5, "justification": "..."}``, the shape
        the ``review.formal`` schema and the review form both use.  The paper's
        own cid, the review key and the nullifier ride along as hints the node
        may use to find the sealed review; the schema allows extra properties.
        """
        review_key = self._review_key(paper)
        return {
            "target": paper.version_cid,
            "paper": paper.paper_cid,
            "scores": {
                dimension: {
                    "score": score,
                    "justification": f"Why {dimension} is {score} of 5.",
                }
                for dimension in RUBRIC
            },
            "confidence": 4,
            "recommendation": "minor_revisions",
            "report": report
            or f"A report on {paper.title}: the method, evidence and claims were assessed.",
            "reviewKey": did_key_from_signing_key(review_key),
            "nullifier": self.nullifier(paper),
        }

    def report_only(self, paper: Paper, *, report: Optional[str] = None) -> dict:
        """The body of a free-text-only review: a report and no rubric scores."""
        body = self.rubric(paper, report=report)
        del body["scores"]
        return body

    def commit(self, paper: Paper, body: Mapping[str, Any]) -> dict:
        """A signed ``review.commit`` sealing ``body``'s content."""
        review_key = self._review_key(paper)
        commit_body = {
            "target": paper.version_cid,
            "commitment": _sealed_digest(body),
            "reviewKey": did_key_from_signing_key(review_key),
            "nullifier": self.nullifier(paper),
        }
        record = _sign(review_key, COMMIT_TYPE, commit_body)
        # The commit is signed by the pseudonymous key, not the caller's own.
        assert record["author"] != self.did
        return record

    def reveal_record(
        self, paper: Paper, body: Mapping[str, Any], *, check_body: bool = True
    ) -> dict:
        """A signed ``review.formal`` revealing ``body``, with its commitment."""
        review_key = self._review_key(paper)
        revealed_body = dict(body)
        revealed_body["commitment"] = _sealed_digest(body)
        record = _sign(review_key, REVEAL_TYPE, revealed_body, check_body=check_body)
        assert record["author"] != self.did
        return record

    def post_commit(self, client, paper: Paper, body: Mapping[str, Any]):
        """Seal ``body`` as this reviewer; the setup fails if the node refuses it."""
        response = client.post(
            COMMIT_URL,
            json=self.commit(paper, body),
            headers=self.headers,
        )
        assert response.status_code == 201, (
            f"the review should be sealed before it can be revealed; "
            f"commit got {response.status_code}: {response.text}"
        )
        return response

    def post_reveal(
        self, client, paper: Paper, body: Mapping[str, Any], *, check_body: bool = True
    ):
        """Sign a fresh ``review.formal`` for ``body`` and ``POST`` it."""
        return client.post(
            REVEAL_URL,
            json=self.reveal_record(paper, body, check_body=check_body),
            headers=self.headers,
        )


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_reveal_with_a_report_but_no_rubric_scores_returns_422(client):
    """Free text alone is not a formal review: the six rubric scores are required."""
    reviewer = Reviewer()
    paper = Paper()
    body = reviewer.report_only(paper)
    reviewer.post_commit(client, paper, body)

    assert "scores" not in body
    # The body is deliberately schema-invalid: that is what the endpoint must refuse.
    response = reviewer.post_reveal(client, paper, body, check_body=False)

    assert response.status_code == 422, (
        f"revealing a report with no rubric scores should be refused with 422; "
        f"got {response.status_code}: {response.text}"
    )


def test_reveal_whose_content_does_not_match_the_commitment_returns_422(client):
    """A review revealed against a commitment for other content does not match."""
    reviewer = Reviewer()
    paper = Paper()

    sealed = reviewer.rubric(paper, score=4, report="The sealed report on this paper.")
    reviewer.post_commit(client, paper, sealed)

    # The revealed review is a different review: other scores, other report --
    # and therefore a different commitment from the one that was sealed.
    different = reviewer.rubric(paper, score=2, report="A different report entirely.")
    assert _sealed_digest(different) != _sealed_digest(sealed)

    response = reviewer.post_reveal(client, paper, different)

    assert response.status_code == 422, (
        f"revealing content that does not match the sealed commitment should be "
        f"refused with 422; got {response.status_code}: {response.text}"
    )


def test_reveal_with_all_six_scores_returns_201(client):
    """A complete rubric revealed against its own commitment is accepted."""
    reviewer = Reviewer()
    paper = Paper()
    body = reviewer.rubric(paper)
    assert set(body["scores"]) == set(RUBRIC)
    assert all(1 <= entry["score"] <= 5 for entry in body["scores"].values())
    reviewer.post_commit(client, paper, body)

    response = reviewer.post_reveal(client, paper, body)

    assert response.status_code == 201, (
        f"revealing all six rubric scores against the matching commitment should "
        f"be accepted with 201; got {response.status_code}: {response.text}"
    )
