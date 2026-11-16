"""Journey: two reviewers review a paper, the author answers, and it is *reviewed*.

The story, told only through ``/v1``:

1. an author publishes and a moderator lists version 1 of a paper;
2. a first reviewer commits a sealed review.  The reviews listing shows it
   without its report: the report gate stays shut while only one review has
   been committed, and a reveal is refused until the gate opens;
3. a second reviewer commits -- against the same version but with a
   ``major_concerns`` verdict -- which opens the report gate;
4. both reviewers reveal, so the paper is *under review*: two reviews exist,
   but they do not agree;
5. the author answers both reviews point by point;
6. the author posts version 2, and a moderator lists it;
7. the concerned reviewer revises their review against version 2 to
   ``minor_revisions`` (a ``review.formal`` whose ``prev`` names their earlier
   one), so every current review is supportive and the paper becomes
   *reviewed*.

The reports and the replies are read back through the public reviews listing,
and the status through the public catalog -- what a reader sees.
"""

from __future__ import annotations

import hashlib
import io
import json
import secrets
from typing import Any, Mapping, Optional

from nacl.signing import SigningKey
from pypdf import PdfWriter
from scholium_record_core import did_key_from_signing_key, sign_record

from app import jobs
from app.modules.admin.cli import main as admin_cli
from app.modules.submissions import get_version

from .helpers import Actor, now, verification_link_for

ORCID_ID = "0000-0002-1825-0097"
PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}

#: The states a version passes through on the way to the catalog.
MODERATION = "moderation"
LISTED = "listed"

#: The paper statuses this journey passes through.
UNDER_REVIEW = "under_review"
REVIEWED = "reviewed"

COMMIT_URL = "/v1/reviews/commit"
REVEAL_URL = "/v1/reviews/reveal"

#: The six mandatory rubric dimensions (``review.formal`` schema).
RUBRIC = (
    "soundness",
    "evidence",
    "reproducibility",
    "novelty",
    "clarity",
    "limitations",
)


def upload_pdf(client, data: bytes, *, headers: dict[str, str] | None = None) -> str:
    """Upload ``data`` as a manuscript over tus and return its content id.

    ``headers`` carries the uploading account's ``Authorization``: an upload
    belongs to the DID that creates it, so the same caller must also append.
    """
    auth = dict(headers or {})
    created = client.post(
        "/v1/uploads",
        headers={**auth, "Tus-Resumable": "1.0.0", "Upload-Length": str(len(data))},
    )
    assert created.status_code == 201, created.text
    upload_id = created.headers["Location"].rsplit("/", 1)[-1]
    patched = client.patch(
        f"/v1/uploads/{upload_id}",
        content=data,
        headers={
            **auth,
            "Tus-Resumable": "1.0.0",
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": "0",
        },
    )
    assert patched.status_code == 204, patched.text
    cid = patched.headers.get("Upload-Cid")
    assert cid, patched.headers
    return cid


def blank_pdf() -> bytes:
    """A minimal, valid one-page PDF."""
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def make_author(client, reviewer) -> Actor:
    """A verified, ORCID-linked author endorsed in ``cs.AI`` (tier 2)."""
    author = Actor(client)
    author.sign_in()
    saved = client.put(f"/v1/profiles/{author.did}", json=PROFILE, headers=author.headers)
    assert saved.status_code == 200, saved.text
    client.post(verification_link_for(author.did))
    author.link_orcid(ORCID_ID)
    author.refresh()
    endorsement = reviewer.record(
        "endorsement", {"endorsee": author.did, "category": "cs.AI", "statement": "ok"}
    )
    accepted = reviewer.submit(endorsement)
    assert accepted.status_code == 201, accepted.text
    author.refresh()
    assert author.tier == 2
    return author


def make_moderator(client) -> Actor:
    """A signed-in tier-4 moderator, appointed the way the node operator does it."""
    moderator = Actor(client)
    moderator.sign_in()
    assert admin_cli(["set-tier", moderator.did, "moderator"]) == 0
    moderator.refresh()
    assert moderator.tier == 4
    return moderator


def _sealed_digest(body: Mapping[str, Any]) -> str:
    """The sha-256 a reviewer commits to: the sealed review, minus its commitment."""
    sealed = {key: value for key, value in body.items() if key != "commitment"}
    canonical = json.dumps(
        sealed, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _sign(
    seed: SigningKey, record_type: str, body: dict, prev: Optional[str] = None
) -> dict:
    """A complete signed record by ``seed``."""
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(seed),
            "created": now(),
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        seed,
    )


class Reviewer:
    """A tier-3 member with a pseudonymous per-paper review key.

    The key, the nullifier and the commitment are derived the way the reviews
    plugin documents them: the record itself never names the reviewer; the
    access token is what says who is calling.
    """

    def __init__(self, client) -> None:
        self.client = client
        self.actor = Actor(client)
        self.actor.sign_in()
        assert admin_cli(["set-tier", self.actor.did, "reviewer"]) == 0
        self.actor.refresh()
        assert self.actor.tier == 3
        #: The reviewer's private secret: the review key and nullifier derive from it.
        self._secret = secrets.token_bytes(32)

    @property
    def headers(self) -> dict[str, str]:
        return self.actor.headers

    def review_key(self, paper_cid: str) -> SigningKey:
        """The reviewer's pseudonymous key for one paper, never their own DID's key."""
        return SigningKey(
            hashlib.sha256(
                b"review-key|" + self._secret + b"|" + paper_cid.encode()
            ).digest()
        )

    def nullifier(self, paper_cid: str) -> str:
        """``H(secret || paperId)``: the same for this person and paper, every time."""
        return hashlib.sha256(self._secret + paper_cid.encode()).hexdigest()

    def review_body(
        self,
        paper_cid: str,
        target: str,
        *,
        score: int,
        recommendation: str,
        report: str,
    ) -> dict:
        """A complete review of ``target``; the review key and nullifier ride along."""
        key = self.review_key(paper_cid)
        return {
            "target": target,
            "paper": paper_cid,
            "scores": {
                dimension: {
                    "score": score,
                    "justification": f"On {dimension}: {score} of 5.",
                }
                for dimension in RUBRIC
            },
            "confidence": 4,
            "recommendation": recommendation,
            "report": report,
            "reviewKey": did_key_from_signing_key(key),
            "nullifier": self.nullifier(paper_cid),
        }

    def commit(self, paper_cid: str, target: str, body: Mapping[str, Any]):
        """Seal ``body`` as a ``review.commit`` and POST it as this reviewer."""
        key = self.review_key(paper_cid)
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
        # The commit is signed by the pseudonymous key, not the caller's own.
        assert record["author"] != self.actor.did
        return self.client.post(COMMIT_URL, json=record, headers=self.headers)

    def reveal(self, paper_cid: str, body: Mapping[str, Any]):
        """Reveal ``body`` as a ``review.formal`` carrying its commitment."""
        key = self.review_key(paper_cid)
        revealed = dict(body)
        revealed["commitment"] = _sealed_digest(body)
        record = _sign(key, "review.formal", revealed)
        assert record["author"] != self.actor.did
        return self.client.post(REVEAL_URL, json=record, headers=self.headers)

    def update(
        self,
        paper_cid: str,
        target: str,
        prev: str,
        *,
        score: int,
        recommendation: str,
        report: str,
    ):
        """Revise an earlier review against ``target``; ``prev`` names the earlier one."""
        key = self.review_key(paper_cid)
        body = self.review_body(
            paper_cid,
            target,
            score=score,
            recommendation=recommendation,
            report=report,
        )
        # An update opens nothing, so it carries no commitment.
        record = _sign(key, "review.formal", body, prev=prev)
        return self.client.post(REVEAL_URL, json=record, headers=self.headers)


def publish_version(
    client,
    author: Actor,
    moderator: Actor,
    *,
    paper_cid: str,
    manifest_cid: str,
    n: int,
    prev: str,
    title: str,
) -> str:
    """Submit, consent to, scan and list version ``n``; return its version cid."""
    version = author.record(
        "paper.version",
        {
            "paper": paper_cid,
            "n": n,
            "title": title,
            "abstract": f"Abstract for {title}.",
            "authors": [
                {"did": author.did, "position": 1, "creditRoles": ["Conceptualization"]}
            ],
            "manifest": manifest_cid,
            "licence": "CC-BY-4.0",
            "changeNote": f"Version {n}.",
        },
        prev=prev,
    )
    submitted = author.submit(version)
    assert submitted.status_code == 201, submitted.text
    version_cid = version["id"]

    consent = author.record(
        "coauthor.consent",
        {"version": version_cid, "role": "Conceptualization", "decision": "accept"},
    )
    consented = author.submit(consent)
    assert consented.status_code == 201, consented.text

    # The only author has accepted, so the version scans; a clean scan moves it
    # to the moderator's queue.
    jobs.run_pending()
    row = get_version(version_cid)
    assert row is not None and row.state == MODERATION, row.state

    policies = client.get("/v1/moderation/policies")
    assert policies.status_code == 200, policies.text
    clause_id = policies.json()[0]["id"]

    decision = moderator.record(
        "moderation.decision",
        {
            "target": version_cid,
            "action": "list",
            "clause": clause_id,
            "reason": "In scope and the checks passed.",
        },
    )
    listed = moderator.submit(decision)
    assert listed.status_code == 201, listed.text
    assert listed.json()["state"] == LISTED, listed.text

    row = get_version(version_cid)
    assert row is not None and row.state == LISTED, row.state
    return version_cid


def listed_reviews(client, short_id: str) -> dict:
    """The public reviews listing of the paper's latest listed version."""
    response = client.get(f"/v1/papers/{short_id}/reviews")
    assert response.status_code == 200, response.text
    return response.json()


def by_review_cid(listing: Mapping[str, Any]) -> dict[str, dict]:
    """The listing's reviews, keyed by the cid of the review they stand for."""
    return {item["review_cid"]: item for item in listing["reviews"]}


def respond(client, author: Actor, review_cid: str, marker: str) -> dict:
    """The author answers ``review_cid`` point by point; return the signed record."""
    record = author.record(
        "review.response",
        {
            "review": review_cid,
            "items": [
                {"dimension": dimension, "reply": f"{marker} {dimension}"}
                for dimension in RUBRIC
            ],
        },
    )
    response = client.post(
        f"/v1/reviews/{review_cid}/response", json=record, headers=author.headers
    )
    assert response.status_code == 201, response.text
    assert response.json()["review_cid"] == review_cid, response.text
    return record


def test_review_journey(client, node, reviewer):
    moderator = make_moderator(client)
    author = make_author(client, reviewer)

    # --- 1. version 1 is published and listed -------------------------------
    pdf_bytes = blank_pdf()
    file_cid = upload_pdf(client, pdf_bytes, headers=author.headers)
    manifest = author.record(
        "manifest",
        {
            "files": [
                {
                    "path": "main.pdf",
                    "cid": file_cid,
                    "size": len(pdf_bytes),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
    )
    submitted = author.submit(manifest)
    assert submitted.status_code == 201, submitted.text
    manifest_cid = manifest["id"]

    genesis = author.record(
        "paper.genesis",
        {
            "title": "A paper two reviewers read",
            "abstract": "A paper that is reviewed, answered and revised.",
            "categories": ["cs.AI"],
            "licence": "CC-BY-4.0",
            "authors": [author.did],
        },
    )
    started = author.submit(genesis)
    assert started.status_code == 201, started.text
    paper_cid = genesis["id"]
    short_id = started.json().get("shortId") or started.json().get("short_id")
    assert short_id and short_id.startswith("sch:"), started.text

    v1 = publish_version(
        client,
        author,
        moderator,
        paper_cid=paper_cid,
        manifest_cid=manifest_cid,
        n=1,
        prev=paper_cid,
        title="A paper two reviewers read v1",
    )

    first = Reviewer(client)
    second = Reviewer(client)

    # --- 2. the first reviewer seals a supportive review --------------------
    first_body = first.review_body(
        paper_cid,
        v1,
        score=4,
        recommendation="minor_revisions",
        report="The first reviewer's report: sound and worth publishing.",
    )
    committed = first.commit(paper_cid, v1, first_body)
    assert committed.status_code == 201, committed.text
    first_commit_cid = committed.json()["id"]
    assert committed.json()["target"] == v1, committed.text

    # One review is committed on the version: the report gate is still shut,
    # and a reveal now would put a report in the public log before anyone else
    # has committed, so it is refused.
    listing = listed_reviews(client, short_id)
    assert listing["gate_open"] is False, listing
    assert len(listing["reviews"]) == 1, listing
    [only] = listing["reviews"]
    assert only["review_cid"] == first_commit_cid, only
    assert "report" not in only, only
    assert first_body["report"] not in json.dumps(listing), listing
    early = first.reveal(paper_cid, first_body)
    assert early.status_code == 409, early.text
    assert early.json()["type"] == "urn:scholium:problem:reveal-gate-closed", early.text

    # --- 3. the second commit opens the report gate -------------------------
    second_body = second.review_body(
        paper_cid,
        v1,
        score=2,
        recommendation="major_concerns",
        report="The second reviewer's report: the evidence is not yet there.",
    )
    committed = second.commit(paper_cid, v1, second_body)
    assert committed.status_code == 201, committed.text
    second_commit_cid = committed.json()["id"]

    # The gate opens on the second commit.  Neither report is public yet --
    # neither reviewer has revealed -- and no early reveal reached the log.
    listing = listed_reviews(client, short_id)
    assert listing["gate_open"] is True, listing
    reviews = by_review_cid(listing)
    assert set(reviews) == {first_commit_cid, second_commit_cid}, reviews
    assert "report" not in reviews[first_commit_cid], reviews[first_commit_cid]
    assert second_body["report"] not in json.dumps(listing), listing

    # --- 4. both reviewers reveal their reviews ----------------------------
    revealed = first.reveal(paper_cid, first_body)
    assert revealed.status_code == 201, revealed.text
    assert revealed.json()["review"] == first_commit_cid, revealed.text

    revealed = second.reveal(paper_cid, second_body)
    assert revealed.status_code == 201, revealed.text
    second_formal_cid = revealed.json()["id"]
    assert revealed.json()["review"] == second_commit_cid, revealed.text

    listing = listed_reviews(client, short_id)
    reviews = by_review_cid(listing)
    assert reviews[first_commit_cid]["report"] == first_body["report"], reviews
    assert reviews[second_commit_cid]["report"] == second_body["report"], reviews
    assert reviews[first_commit_cid]["recommendation"] == "minor_revisions", reviews
    assert reviews[second_commit_cid]["recommendation"] == "major_concerns", reviews

    # The reviews do not agree, so the paper is under review, not reviewed.
    paper = client.get(f"/v1/papers/{short_id}")
    assert paper.status_code == 200, paper.text
    assert paper.json()["status"] == UNDER_REVIEW, paper.text

    # --- 5. the author answers both reviews point by point -----------------
    first_marker = "Author reply to the first review"
    second_marker = "Author reply to the second review"
    respond(client, author, first_commit_cid, first_marker)
    respond(client, author, second_commit_cid, second_marker)

    listing = listed_reviews(client, short_id)
    reviews = by_review_cid(listing)
    assert reviews[first_commit_cid]["replies"]["soundness"] == f"{first_marker} soundness", reviews
    assert reviews[second_commit_cid]["replies"]["evidence"] == f"{second_marker} evidence", reviews

    # --- 6. the author posts version 2 --------------------------------------
    v2 = publish_version(
        client,
        author,
        moderator,
        paper_cid=paper_cid,
        manifest_cid=manifest_cid,
        n=2,
        prev=v1,
        title="A paper two reviewers read v2",
    )
    paper = client.get(f"/v1/papers/{short_id}")
    assert paper.status_code == 200, paper.text
    assert paper.json()["versionCid"] == v2, paper.text
    assert paper.json()["n"] == 2, paper.text
    # The reviews still do not agree, so the status has not changed.
    assert paper.json()["status"] == UNDER_REVIEW, paper.text

    # --- 7. the concerned reviewer revises their review against v2 ---------
    revised = second.update(
        paper_cid,
        v2,
        second_formal_cid,
        score=4,
        recommendation="minor_revisions",
        report="The second reviewer's revised report: the evidence now holds.",
    )
    assert revised.status_code == 201, revised.text
    assert revised.json()["review"] == second_commit_cid, revised.text
    assert revised.json()["prev"] == second_formal_cid, revised.text

    # Both current reviews are now supportive: the paper is reviewed.
    paper = client.get(f"/v1/papers/{short_id}")
    assert paper.status_code == 200, paper.text
    assert paper.json()["status"] == REVIEWED, paper.text
    assert paper.json()["n"] == 2, paper.text

    # The updating reviewer is one entry with both reviews in its history, and
    # the newest review is the one it stands on.
    listing = listed_reviews(client, short_id)
    [entry] = listing["reviews"]
    assert entry["review_cid"] == second_commit_cid, entry
    assert [revision["n"] for revision in entry["history"]] == [1, 2], entry
    assert [revision["id"] for revision in entry["history"]] == [
        second_formal_cid,
        revised.json()["id"],
    ], entry
    assert entry["history"][-1]["prev"] == second_formal_cid, entry
    assert entry["recommendation"] == "minor_revisions", entry
    assert entry["version_cid"] == v2, entry
