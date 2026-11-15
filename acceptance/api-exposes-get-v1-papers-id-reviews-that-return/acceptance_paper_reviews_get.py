"""Acceptance tests for: API exposes ``GET /v1/papers/{id}/reviews`` that
returns 200 with report bodies hidden until two reviews are committed on the
version or 21 days pass since the first commit, labelling anonymous reviewers
Reviewer A, Reviewer B per paper (reviews plugin, feature 110).

Criteria (app_spec.xml, feature 110):

* With one committed review, ``GET /v1/papers/{id}/reviews`` as the second
  reviewer returns the review without its report.
* After a second commit, ``GET /v1/papers/{id}/reviews`` returns both reports.

The flow being read back
------------------------

A formal review is a two-step commit-reveal (features 107 and 109).  A tier-3
member seals their review as a ``review.commit`` through ``POST
/v1/reviews/commit``, then opens it as a ``review.formal`` through ``POST
/v1/reviews/reveal``: a complete rubric, a report, and a commitment that
matches.  Once the reveal is accepted the node *holds* the report body -- it
stays in the ``review.formal`` record -- but holding it is not serving it.
Report bodies stay hidden until two reviews are committed on the version, or
21 days pass since the first commit (PRD REV-4: "Reviewer B cannot read A's
report before reveal").  That gate is what these tests observe, at its two
ends:

* **one committed review** -- the review is listed but its report is not
  served, not even to the second reviewer: the tier-3 member standing next in
  line, who has not committed yet.  The first reviewer both commits and
  reveals first, so a withheld report is a report the node holds and refuses
  to serve -- otherwise "without its report" could not be told apart from
  "not yet written";
* **two committed reviews** -- the second commit opens the gate, and both
  report bodies are served.  The second criterion's GET is made by an
  anonymous reader: it names no caller, and a report the endpoint serves at
  all is served to any reader of the public paper page.

Every commit and reveal goes through the real endpoints, so each scene starts
from reviews the node itself accepted.  Each report carries a unique marker
(the scene's tag), so "the report was served" and "the report was withheld"
are one substring check each on the response body, whatever the JSON layout
turns out to be.

How the scene is set up
-----------------------

The paper under review belongs to the submissions plugin, whose ``POST
/v1/records`` handlers carry tier, endorsement, consent and scan rules that
have nothing to do with reading reviews back.  So the paper is put in the node
the way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` signed by the
  submitting author and appended to the event log, the version's byline naming
  every author;
* the paper and its version indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make --
  with the version listed and each listed author on its ``authorship`` rows.

A reviewer is a fresh key whose ``accounts`` row is tier 3 and whose access
token is tier 3.  Their per-paper review key and nullifier are derived the way
feature 107's suite derives them, and the commitment is the digest feature
109's endpoint checks (the sha-256 of the sealed body's canonical JSON).  The
"second reviewer" is simply another such member who has not committed: with
one committed review in the scene, they are exactly the reviewer who comes
second.

Reading the response
--------------------

The criteria fix *that* the review is returned and *that* its report is
withheld (or that both reports are served); they do not fix the JSON layout.
"The review is returned" is read as: the response names the review by one of
the identities the system gives it -- the cid of its ``review.commit`` (the
``review`` table's key, which the reveal's 201 hands back) or of its
``review.formal``, or its per-paper label "Reviewer A" -- anywhere in the
document.  A whole response object is never compared, since later features may
add fields.

The 21-day limb of the gate is deliberately not exercised: every commit here
is dated now, so the gate is closed in the first scene exactly because one
review is committed, and open in the second exactly because two are.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Mapping, Optional

from nacl.signing import SigningKey
from scholium_record_core import (
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
from app.modules.reviews import Review, ensure_tables
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

#: The papers the endpoint under test hangs off.
PAPERS_URL = "/v1/papers"

#: The endpoint that seals a review (feature 107).
COMMIT_URL = "/v1/reviews/commit"

#: The endpoint that opens a sealed review (feature 109).
REVEAL_URL = "/v1/reviews/reveal"

#: The record types those endpoints accept.
COMMIT_TYPE = "review.commit"
REVEAL_TYPE = "review.formal"

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
    """The sha-256 a reviewer commits to: the sealed review, minus its own commitment.

    This is the digest ``POST /v1/reviews/reveal`` checks
    (:func:`app.modules.reviews.reveal.commitment_digest`): the same body is
    committed and then revealed, so the reveal matches its commitment.
    """
    sealed = {key: value for key, value in body.items() if key != "commitment"}
    return hashlib.sha256(_canonical(sealed)).hexdigest()


def _sign(
    seed: SigningKey,
    record_type: str,
    body: dict,
    prev: Optional[str] = None,
) -> dict:
    """A complete signed record by ``seed``; the fixture fails if it is not valid."""
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
    assert validate_envelope(record) == [], validate_envelope(record)
    assert validate_body(record_type, body) == [], validate_body(record_type, body)
    return record


def _all_strings(value: Any) -> Iterator[str]:
    """Every string anywhere inside a JSON value."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _all_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_strings(item)


def _reviews_on(version_cid: str) -> list[Review]:
    """The committed review rows for one version -- the scene's own guard."""
    ensure_tables()
    with db.SessionLocal() as session:
        rows = list(session.query(Review).filter_by(version_cid=version_cid).all())
        for row in rows:
            session.expunge(row)
        return rows


# --------------------------------------------------------------------------- #
# The scene: a listed paper and two tier-3 reviewers
# --------------------------------------------------------------------------- #


class Paper:
    """One paper with one listed version."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Paper reviews listing acceptance paper {self.tag}"
        self.abstract = "A paper whose reviews are committed, revealed and read back."
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
    """A signed-in tier-3 member who seals a review of a paper and opens it."""

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

    def rubric(self, paper: Paper, report: str) -> dict:
        """The body of a revealed review: all six scored dimensions and ``report``."""
        review_key = self._review_key(paper)
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
            "reviewKey": did_key_from_signing_key(review_key),
            "nullifier": self.nullifier(paper),
        }

    def commit_record(self, paper: Paper, body: Mapping[str, Any]) -> dict:
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

    def reveal_record(self, paper: Paper, body: Mapping[str, Any]) -> dict:
        """A signed ``review.formal`` revealing ``body``, with its commitment."""
        review_key = self._review_key(paper)
        revealed_body = dict(body)
        revealed_body["commitment"] = _sealed_digest(body)
        record = _sign(review_key, REVEAL_TYPE, revealed_body)
        assert record["author"] != self.did
        return record

    def file_review(self, client, paper: Paper, report: str) -> tuple[str, str]:
        """Commit and then reveal a full review carrying ``report``.

        Returns the cids of the two records, and fails here -- not in the
        criterion -- if the node refuses either step, since every test needs a
        review the node has accepted before there is anything to read back.
        """
        body = self.rubric(paper, report)

        # Each record is signed once and posted as signed: its cid -- what the
        # test later looks for in the listing -- is the cid the node accepted.
        commit = self.commit_record(paper, body)
        committed = client.post(COMMIT_URL, json=commit, headers=self.headers)
        assert committed.status_code == 201, (
            f"the review should be sealed before it can be revealed; "
            f"commit got {committed.status_code}: {committed.text}"
        )

        reveal = self.reveal_record(paper, body)
        revealed = client.post(REVEAL_URL, json=reveal, headers=self.headers)
        assert revealed.status_code == 201, (
            f"the report should be revealed, and so held by the node, before it "
            f"can be hidden or served; reveal got {revealed.status_code}: "
            f"{revealed.text}"
        )

        return commit["id"], reveal["id"]


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_with_one_committed_review_get_as_the_second_reviewer_returns_the_review_without_its_report(
    client,
):
    """One committed review: the second reviewer is served the review, not its report."""
    first = Reviewer()
    second = Reviewer()
    paper = Paper()
    report = (
        f"First reviewer's sealed report {paper.tag}: the claims, the evidence "
        f"and the limitations were each weighed."
    )

    commit_cid, reveal_cid = first.file_review(client, paper, report)
    # The scene holds exactly one committed review on the version, and that
    # review has been revealed: the node holds the report the response must
    # withhold -- withholding a report nobody wrote would prove nothing.
    rows = _reviews_on(paper.version_cid)
    assert len(rows) == 1, (
        f"the scene should hold exactly one committed review, found {len(rows)}"
    )
    assert rows[0].committed_at is not None, "the committed review carries no date"
    assert rows[0].revealed_at is not None, "the committed review was never revealed"

    # The second reviewer reads: a tier-3 member who has not committed, which
    # is exactly who the gate must keep the first report from.
    response = client.get(f"{PAPERS_URL}/{paper.short_id}/reviews", headers=second.headers)

    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{paper.short_id}/reviews as the second reviewer -> "
        f"{response.status_code}: {response.text}"
    )
    # The review is returned: named by one of its records' cids or its label.
    payload = response.json()
    named = {commit_cid, reveal_cid, "Reviewer A"} & set(_all_strings(payload))
    assert named, (
        f"the listing should return the committed review, naming it by its "
        f"review.commit cid {commit_cid!r}, its review.formal cid {reveal_cid!r} "
        f"or its label 'Reviewer A': {payload}"
    )
    # Its report is not: the body never reaches the reader.
    assert report not in response.text, (
        f"with one committed review the report body must stay hidden, but the "
        f"second reviewer was served it: {response.text}"
    )


def test_after_a_second_commit_get_returns_both_reports(client):
    """A second commit opens the gate: both report bodies are served."""
    first = Reviewer()
    second = Reviewer()
    paper = Paper()
    report_a = (
        f"First reviewer's sealed report {paper.tag}: the method was checked."
    )
    report_b = (
        f"Second reviewer's sealed report {paper.tag}: the evidence was checked."
    )

    first.file_review(client, paper, report_a)
    assert len(_reviews_on(paper.version_cid)) == 1, (
        "the scene should start with exactly one committed review"
    )

    # The second commit: another tier-3 member seals and opens their own review.
    second.file_review(client, paper, report_b)
    rows = _reviews_on(paper.version_cid)
    assert len(rows) == 2, (
        f"the scene should hold two committed reviews, found {len(rows)}"
    )
    assert all(row.revealed_at is not None for row in rows), (
        "both committed reviews should have been revealed"
    )

    response = client.get(f"{PAPERS_URL}/{paper.short_id}/reviews")

    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{paper.short_id}/reviews -> "
        f"{response.status_code}: {response.text}"
    )
    assert report_a in response.text, (
        f"after the second commit the first report should be served: "
        f"{response.text}"
    )
    assert report_b in response.text, (
        f"after the second commit the second report should be served: "
        f"{response.text}"
    )
