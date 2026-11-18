"""Journey: sealed reviews, the report gate and the reveal, over HTTP on both deployments.

A listed paper gets two reviews.  The first reviewer commits a sealed review; the
reviews listing shows that a review exists but not its report, and a reveal is
refused (409) while only one review is committed.  The second commit opens the
gate; neither report is public until its author reveals it; after both reveal,
the listing carries the reports.  The author then answers a review point by
point, and the paper's status follows the reviews.

This is the review escrow's contract -- it must hold whichever database and
object store sit under the node.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from typing import Any, Mapping

import httpx
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from e2e_harness import Actor, Published, assert_problem, json_of, now

RUBRIC = ("soundness", "evidence", "reproducibility", "novelty", "clarity", "limitations")


def _sealed_digest(body: Mapping[str, Any]) -> str:
    """The sha-256 a reviewer commits to: the sealed review, minus its commitment."""
    sealed = {key: value for key, value in body.items() if key != "commitment"}
    canonical = json.dumps(sealed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _sign(seed: SigningKey, record_type: str, body: dict) -> dict:
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(seed),
            "created": now(),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        seed,
    )


class Reviewer:
    """A tier-3 member with a pseudonymous per-paper review key (never their own DID's key)."""

    def __init__(self, node, client: httpx.Client) -> None:
        self.client = client
        self.actor = Actor(node, client).sign_in().promote("reviewer")
        assert self.actor.tier == 3
        self._secret = secrets.token_bytes(32)

    def key(self, paper_cid: str) -> SigningKey:
        return SigningKey(hashlib.sha256(b"review-key|" + self._secret + b"|" + paper_cid.encode()).digest())

    def nullifier(self, paper_cid: str) -> str:
        return hashlib.sha256(self._secret + paper_cid.encode()).hexdigest()

    def body(self, paper_cid: str, target: str, *, score: int, recommendation: str, report: str) -> dict:
        return {
            "target": target,
            "paper": paper_cid,
            "scores": {d: {"score": score, "justification": f"On {d}: {score} of 5."} for d in RUBRIC},
            "confidence": 4,
            "recommendation": recommendation,
            "report": report,
            "reviewKey": did_key_from_signing_key(self.key(paper_cid)),
            "nullifier": self.nullifier(paper_cid),
        }

    def commit(self, paper_cid: str, target: str, body: dict) -> httpx.Response:
        key = self.key(paper_cid)
        record = _sign(
            key,
            "review.commit",
            {
                "target": target,
                "commitment": _sealed_digest(body),
                "reviewKey": did_key_from_signing_key(key),
                "nullifier": self.nullifier(paper_cid),
            },
        )
        assert record["author"] != self.actor.did, "the commit must not be signed by the reviewer's own key"
        return self.client.post("/v1/reviews/commit", json=record, headers=self.actor.headers)

    def reveal(self, paper_cid: str, body: dict) -> httpx.Response:
        revealed = dict(body)
        revealed["commitment"] = _sealed_digest(body)
        record = _sign(self.key(paper_cid), "review.formal", revealed)
        return self.client.post("/v1/reviews/reveal", json=record, headers=self.actor.headers)


def listing(http: httpx.Client, paper: Published) -> dict:
    return json_of(http.get(f"/v1/papers/{paper.short_id}/reviews"))


def test_reviews_are_sealed_until_the_gate_opens_then_revealed(node, http, paper):
    first = Reviewer(node, http)
    second = Reviewer(node, http)

    first_body = first.body(paper.paper_cid, paper.version_cid, score=4, recommendation="minor_revisions",
                            report="First report: sound and worth publishing.")
    committed = first.commit(paper.paper_cid, paper.version_cid, first_body)
    assert committed.status_code == 201, committed.text
    first_commit = committed.json()["id"]

    # One commit: the gate is shut, the review is listed without its report, and an
    # early reveal is refused so no report reaches the public log ahead of the others.
    sealed = listing(http, paper)
    assert sealed["gate_open"] is False, sealed
    [only] = sealed["reviews"]
    assert only["review_cid"] == first_commit and "report" not in only, only
    assert first_body["report"] not in json.dumps(sealed)
    early = first.reveal(paper.paper_cid, first_body)
    assert assert_problem(early, 409)["type"] == "urn:scholium:problem:reveal-gate-closed", early.text

    # The second commit opens the gate; still nothing is public until a reveal.
    second_body = second.body(paper.paper_cid, paper.version_cid, score=2, recommendation="major_concerns",
                              report="Second report: the evidence is not yet there.")
    second_commit = second.commit(paper.paper_cid, paper.version_cid, second_body)
    assert second_commit.status_code == 201, second_commit.text
    opened = listing(http, paper)
    assert opened["gate_open"] is True, opened
    assert second_body["report"] not in json.dumps(opened)

    # A reveal that does not match its commitment is refused.
    forged = dict(first_body, report="A different report than the one committed to.")
    refused = first.reveal(paper.paper_cid, forged)
    assert assert_problem(refused, 422)["type"] == "urn:scholium:problem:review-commitment-mismatch", refused.text
    assert forged["report"] not in json.dumps(listing(http, paper))

    # Both reveal; the reports are now in the public listing.
    assert first.reveal(paper.paper_cid, first_body).status_code == 201
    assert second.reveal(paper.paper_cid, second_body).status_code == 201
    revealed = {item["review_cid"]: item for item in listing(http, paper)["reviews"]}
    assert revealed[first_commit]["report"] == first_body["report"]
    assert revealed[second_commit.json()["id"]]["recommendation"] == "major_concerns"

    # The reviews disagree, so the paper is under review.
    assert json_of(http.get(f"/v1/papers/{paper.short_id}"))["status"] == "under_review"

    # The author answers the first review point by point.
    reply = paper.author.record(
        "review.response",
        {"review": first_commit, "items": [{"dimension": d, "reply": f"Thank you on {d}."} for d in RUBRIC]},
    )
    answered = http.post(f"/v1/reviews/{first_commit}/response", json=reply, headers=paper.author.headers)
    assert answered.status_code == 201, answered.text
    [answer] = {i["review_cid"]: i for i in listing(http, paper)["reviews"]}[first_commit]["responses"]
    assert answer["replies"]["soundness"] == "Thank you on soundness."


def test_one_reviewer_cannot_commit_twice_on_a_paper(node, http, paper):
    """The nullifier is the same for the same person and paper: a second review is refused."""
    reviewer = Reviewer(node, http)
    body = reviewer.body(paper.paper_cid, paper.version_cid, score=3, recommendation="minor_revisions",
                         report="Only once.")
    assert reviewer.commit(paper.paper_cid, paper.version_cid, body).status_code == 201
    again = reviewer.commit(paper.paper_cid, paper.version_cid, body)
    assert assert_problem(again, 409)["type"] == "urn:scholium:problem:review-already-committed", again.text
