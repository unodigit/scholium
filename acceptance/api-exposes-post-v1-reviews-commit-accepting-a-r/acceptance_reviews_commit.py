"""Acceptance tests for: API exposes ``POST /v1/reviews/commit`` accepting a
``review.commit`` (target version, commitment hash, per-paper review key,
nullifier) from a tier-3 member, that returns ``409`` for a second review by
the same person and ``403`` for a co-author (reviews plugin, feature 107).

Criteria (app_spec.xml, feature 107):

* A second ``POST /v1/reviews/commit`` by the same reviewer on the same paper
  returns ``409``.
* ``POST /v1/reviews/commit`` by a listed co-author returns ``403``.
* ``POST /v1/reviews/commit`` by a tier-3 non-author returns ``201``.

The request
-----------

Like every write on this API, the endpoint takes a client-signed record
envelope.  A ``review.commit`` is signed by the *review key*, the pseudonymous
per-paper key a reviewer derives for one paper, and not by the reviewer's own
DID: that separation is what lets the node keep the reviewer's identity out of
the public record.  The caller is whoever the access token says they are::

    POST /v1/reviews/commit
    Authorization: Bearer <tier-3 access token>

    {"v": 1, "type": "review.commit", "author": "did:key:z6Mk...",
     "created": "2026-11-16T00:00:00Z", "prev": null,
     "body": {"target": "<version cid>", "commitment": "<sha-256 hex>",
              "reviewKey": "did:key:z6Mk...", "nullifier": "<sha-256 hex>"},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

``author`` and ``reviewKey`` are the same per-paper review key; ``id`` is the
recomputed cid and ``sig`` a real Ed25519 signature by that key, so the only
thing wrong with a refused commit is the thing the test is about.

The ``nullifier`` is ``H(secret || paperId)``: the reviewer's own secret hashed
with the paper's id.  It is deterministic, so the same person reviewing the
same paper again produces the same nullifier -- and the same review key, which
is derived from the same secret -- while another person, or the same person on
another paper, produces another.  :class:`Reviewer` derives all three that way.
The commitment is a hash over the sealed review text, so a second review
carries a different commitment: the second request is a new record, not a
replay of the first.

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
token is tier 3: both are put in place because a node may read a member's tier
from either one.  A co-author is such a reviewer who is also listed on the
paper's byline; they did not sign anything the paper is made of, so the only
thing that marks them out is that they are listed.

Each criterion is observed through the ``POST`` response status alone -- the
body of the response is not pinned, and nothing here compares a whole response
object, since later features may add fields.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

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
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

#: The endpoint under test.
COMMIT_URL = "/v1/reviews/commit"

#: The record type this endpoint accepts.
COMMIT_TYPE = "review.commit"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"

#: Trust tier of a reviewer.
REVIEWER_TIER = 3


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


def _sign(seed: SigningKey, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
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


# --------------------------------------------------------------------------- #
# The scene: a listed paper, its authors, and tier-3 reviewers
# --------------------------------------------------------------------------- #


class Paper:
    """One paper with one listed version, bylined with ``coauthors`` as well."""

    def __init__(self, coauthors: Sequence[str] = ()) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Review commit acceptance paper {self.tag}"
        self.abstract = "A paper that reviewers commit to review."
        #: Every DID on the byline, the submitting author first.
        self.authors: list[str] = [self.did, *coauthors]

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

        #: cid of the version a review commits to.
        self.version_cid: str = version["id"]
        #: cid of the paper's ``paper.genesis`` record.
        self.paper_cid: str = genesis["id"]
        #: The ``sch:xxxx-xxxx-xxxx`` id the paper is addressed by.
        self.short_id: str = derive_short_id(genesis["id"])


class Reviewer:
    """A signed-in tier-3 member who can seal a review of a paper."""

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

    def commit(self, paper: Paper, review_text: Optional[str] = None) -> dict:
        """A signed ``review.commit`` to review ``paper``'s version.

        The commitment seals ``review_text`` (unique per call unless given); the
        review key and nullifier are the reviewer's own for this paper.
        """
        review_key = self._review_key(paper)
        sealed = review_text or f"sealed review {uuid.uuid4().hex}"
        body = {
            "target": paper.version_cid,
            "commitment": _sha256_hex(sealed.encode(), secrets.token_bytes(16)),
            "reviewKey": did_key_from_signing_key(review_key),
            "nullifier": self.nullifier(paper),
        }
        record = _sign(review_key, COMMIT_TYPE, body)
        # The commit is signed by the pseudonymous key, not the caller's own.
        assert record["author"] != self.did
        return record

    def post_commit(self, client, paper: Paper, review_text: Optional[str] = None):
        """Sign a fresh ``review.commit`` and ``POST`` it as this reviewer."""
        return client.post(
            COMMIT_URL,
            json=self.commit(paper, review_text),
            headers=self.headers,
        )


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_second_commit_by_the_same_reviewer_on_the_same_paper_returns_409(client):
    """A reviewer seals one review per paper: committing again is a conflict."""
    reviewer = Reviewer()
    paper = Paper()

    first = reviewer.post_commit(client, paper)
    assert first.status_code == 201, (
        f"the reviewer's first commit on the paper should be accepted with 201; "
        f"got {first.status_code}: {first.text}"
    )

    second = reviewer.post_commit(client, paper)
    assert second.status_code == 409, (
        f"a second commit by the same reviewer on the same paper should be "
        f"refused with 409; got {second.status_code}: {second.text}"
    )


def test_commit_by_a_listed_co_author_returns_403(client):
    """A tier-3 member listed on the paper's byline may not review their own paper."""
    coauthor = Reviewer()
    paper = Paper(coauthors=[coauthor.did])
    assert coauthor.did in paper.authors
    assert coauthor.did != paper.did  # a co-author, not the submitting signer

    response = coauthor.post_commit(client, paper)

    assert response.status_code == 403, (
        f"a listed co-author committing a review of their own paper should be "
        f"refused with 403; got {response.status_code}: {response.text}"
    )


def test_commit_by_a_tier_3_non_author_returns_201(client):
    """A tier-3 member who is not an author seals a review: the commit is accepted."""
    reviewer = Reviewer()
    paper = Paper()
    assert reviewer.did not in paper.authors

    response = reviewer.post_commit(client, paper)

    assert response.status_code == 201, (
        f"a tier-3 non-author committing a review should be accepted with 201; "
        f"got {response.status_code}: {response.text}"
    )
