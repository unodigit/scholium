"""Acceptance tests for: API exposes ``POST /v1/reviews/{cid}/response``
accepting a ``review.response`` from a paper author with point-by-point replies
keyed by rubric dimension and saves it to ``review_responses`` (reviews plugin,
feature 114).

Criteria (app_spec.xml, feature 114):

* ``POST /v1/reviews/{cid}/response`` by a non-author returns ``403``.
* ``POST /v1/reviews/{cid}/response`` by an author returns ``201`` and the
  reply appears with the review in ``GET /v1/papers/{id}/reviews``.

The request
-----------

A ``review.response`` is a client-signed record, like every write on this API:
the paper author signs it with their own Ed25519 key, and the body names the
review being answered and carries one reply per rubric dimension::

    POST /v1/reviews/{cid}/response
    Authorization: Bearer <the author's access token>

    {"v": 1, "type": "review.response", "author": "did:key:z6Mk...",
     "created": "2026-11-16T00:00:00Z", "prev": null,
     "body": {"review": "<review cid>",
              "items": [{"dimension": "soundness", "reply": "..."},
                        ... point by point ...]},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

The ``review.response`` schema requires ``items`` (one entry per point) and a
``review``/``reviewCid`` naming the review answered; each item names its rubric
``dimension`` and its ``reply`` text.  The review being answered is the one a
``POST /v1/reviews/commit`` and ``POST /v1/reviews/reveal`` pair put at the
head of ``GET /v1/papers/{id}/reviews``; ``{cid}`` is that review's cid.  The
scene has one committed and revealed review, so the letter the listing labels
it with is ``Reviewer A``.

Because the acceptance criteria do not pin whether the endpoint reads the
signed envelope's ``body`` or a plain JSON payload, the request carries the
same review id and items at both levels, and each item spells its reply under
the schema's three accepted names (``reply``, ``text``, ``body``).  Likewise
the spec calls the review's identity its cid without saying whether that is
the ``review.commit`` cid or the revealed ``review.formal`` cid, so a request
is addressed to the commit cid first and to the formal cid if the node does
not recognise the first.  None of this pins the endpoint's behaviour: the
criteria are read only from the two ``POST`` statuses and the listing.

How the scene is set up
-----------------------

The paper under review belongs to the submissions plugin, whose ``POST
/v1/records`` handlers carry tier, endorsement, consent and scan rules that
have nothing to do with responding to a review.  So the paper is put in the
node the way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` signed by the
  submitting author and appended to the event log, the version's byline naming
  every author;
* the paper and its version indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make --
  with the version listed and each listed author on its ``authorship`` rows.

A reviewer is a fresh key whose ``accounts`` row is tier 3 and whose access
token is tier 3; they commit and reveal a complete rubric so there is a review
to answer.  The author is the paper's submitting author, with an ``accounts``
row and an access token.  The non-author is another signed-in tier-3 member
who is not on the paper's byline.

Reading the listing
-------------------

The criteria fix *that* the reply appears with the review, not the JSON
layout.  So the reply text is looked for anywhere in the ``GET`` document, and
the review is identified by one of the identities the system gives it: the
``review.commit`` cid (the ``review`` table's key), the ``review.formal`` cid,
or its label ``Reviewer A``.  A whole response object is never compared, since
later features may add fields.
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
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

#: The endpoint under test, for one review.
RESPONSE_URL = "/v1/reviews/{cid}/response"

#: The papers the listing hangs off.
PAPERS_URL = "/v1/papers"

#: The endpoints that put a review in the scene (features 107 and 109).
COMMIT_URL = "/v1/reviews/commit"
REVEAL_URL = "/v1/reviews/reveal"

#: The record types those endpoints accept.
COMMIT_TYPE = "review.commit"
REVEAL_TYPE = "review.formal"

#: The record type the endpoint under test accepts.
RESPONSE_TYPE = "review.response"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"

#: Trust tier of a reviewer and of every signed-in member built here.
MEMBER_TIER = 3

#: The six mandatory rubric dimensions (``review.formal`` schema).
RUBRIC = (
    "soundness",
    "evidence",
    "reproducibility",
    "novelty",
    "clarity",
    "limitations",
)

#: The label the listing gives the first committed review.
FIRST_REVIEWER_LABEL = "Reviewer A"


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
    """The sha-256 a reviewer commits to: the sealed review, minus its commitment."""
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


def _all_dicts(value: Any) -> Iterator[dict]:
    """Every dict anywhere inside a JSON value, including ``value`` itself."""
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _all_dicts(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_dicts(item)


def _names_review(item: Any, review_ids: set[str]) -> bool:
    """Whether ``item`` names the review by a cid in a value or as a mapping key.

    Containment is used rather than equality so a layout that spells the review
    as part of a larger string (say its endpoint path) still counts.
    """
    if not isinstance(item, dict):
        return False
    if any(rid in value for value in _all_strings(item) for rid in review_ids):
        return True
    return any(
        isinstance(key, str) and any(rid in key for rid in review_ids)
        for key in item
    )


def _reply_beside_review(body: Any, marker: str, review_ids: set[str]) -> bool:
    """Whether ``marker`` is attached to the review rather than loose in the body.

    The reply may sit inside the review's own object (under any key the
    implementation chooses) or in a neighbouring object that names the review
    by a cid; the document itself is the last, loosest fallback, which still
    means both the review and its reply were served together.
    """
    for item in _all_dicts(body):
        if any(marker in value for value in _all_strings(item)) and _names_review(
            item, review_ids
        ):
            return True
    return False


# --------------------------------------------------------------------------- #
# The scene: a listed paper, its author, a reviewer and an outsider
# --------------------------------------------------------------------------- #


class Paper:
    """One paper with one listed version, signed by its submitting author."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Review response acceptance paper {self.tag}"
        self.abstract = "A paper whose authors answer a formal review."
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


class Member:
    """A signed-in tier-3 member, optionally the paper's own author."""

    def __init__(self, seed: Optional[SigningKey] = None) -> None:
        self.seed = seed or SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(
                    did=self.did,
                    tier=MEMBER_TIER,
                    created_at=_now() - timedelta(days=400),
                )
            )
            session.commit()

        #: The member's credentials: a tier-3 access token.
        self.headers = {
            "Authorization": f"Bearer {issue_access_token(self.did, MEMBER_TIER)}"
        }

    def response_record(self, review_cid: str, marker: str) -> dict:
        """A signed ``review.response`` answering ``review_cid`` point by point.

        Each rubric dimension gets one item with a unique reply (``marker`` plus
        the dimension), which is what the listing must show.  The same values
        are also carried at the top level of the request, and each item spells
        its reply as ``reply``, ``text`` and ``body``, so an endpoint that reads
        a plain payload or the signed envelope's ``body`` both see them.
        """
        items = [
            {
                "dimension": dimension,
                "reply": f"{marker} {dimension}",
                "text": f"{marker} {dimension}",
                "body": f"{marker} {dimension}",
            }
            for dimension in RUBRIC
        ]
        replies = {dimension: f"{marker} {dimension}" for dimension in RUBRIC}
        body = {
            "review": review_cid,
            "reviewCid": review_cid,
            "items": items,
            "replies": replies,
            "text": marker,
        }
        record = dict(_sign(self.seed, RESPONSE_TYPE, body))
        # A plain-JSON implementation may read these from the payload's top
        # level instead of the envelope's ``body``; the extra keys do not take
        # part in the record id or signature.
        record["review"] = review_cid
        record["reviewCid"] = review_cid
        record["items"] = items
        record["replies"] = replies
        assert verify_record(record)
        return record

    def post_response(self, client, review_cids: list[str], marker: str):
        """POST the response, addressing the first review cid the node recognises.

        The spec names the review's cid without fixing which record's cid it
        is, so the commit cid is tried first and the formal cid second.  A
        ``404`` or ``422`` means the path cid was not recognised; anything else
        -- a ``201`` or the ``403`` an author check produces -- is the answer.
        Returns ``(response, attempts)`` where ``attempts`` lists every cid and
        status tried, for failure messages.
        """
        attempts: list[tuple[str, Any]] = []
        response = None
        seen: set[str] = set()
        for cid in review_cids:
            if cid in seen:
                continue
            seen.add(cid)
            response = client.post(
                RESPONSE_URL.format(cid=cid),
                json=self.response_record(cid, marker),
                headers=self.headers,
            )
            attempts.append((cid, response))
            if response.status_code not in (404, 422):
                break
        assert response is not None
        return response, attempts


class Reviewer:
    """A signed-in tier-3 member who commits and reveals a review of a paper."""

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
                    tier=MEMBER_TIER,
                    created_at=_now() - timedelta(days=400),
                )
            )
            session.commit()

        #: The reviewer's credentials: a tier-3 access token.
        self.headers = {
            "Authorization": f"Bearer {issue_access_token(self.did, MEMBER_TIER)}"
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
        review the node has accepted before there is anything to answer.
        """
        body = self.rubric(paper, report)

        commit = self.commit_record(paper, body)
        committed = client.post(COMMIT_URL, json=commit, headers=self.headers)
        assert committed.status_code == 201, (
            f"the review should be sealed before it can be answered; "
            f"commit got {committed.status_code}: {committed.text}"
        )

        reveal = self.reveal_record(paper, body)
        revealed = client.post(REVEAL_URL, json=reveal, headers=self.headers)
        assert revealed.status_code == 201, (
            f"the review should be revealed before it can be answered; "
            f"reveal got {revealed.status_code}: {revealed.text}"
        )

        return commit["id"], reveal["id"]


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_response_by_a_non_author_returns_403(client):
    """A member who is not on the paper's byline may not answer its review."""
    paper = Paper()
    reviewer = Reviewer()
    commit_cid, reveal_cid = reviewer.file_review(
        client, paper, f"Review to be answered {paper.tag}."
    )

    outsider = Member()
    assert outsider.did not in paper.authors

    response, attempts = outsider.post_response(
        client,
        [commit_cid, reveal_cid],
        f"Reply by a non-author {uuid.uuid4().hex}",
    )

    tried = ", ".join(f"{cid} -> {r.status_code}" for cid, r in attempts)
    assert response.status_code == 403, (
        f"a non-author answering review {commit_cid!r} should be refused with "
        f"403; got {response.status_code}: {response.text} (tried {tried})"
    )


def test_response_by_an_author_returns_201_and_the_reply_appears_with_the_review(
    client,
):
    """The paper's author answers point by point; the listing shows the reply."""
    paper = Paper()
    reviewer = Reviewer()
    commit_cid, reveal_cid = reviewer.file_review(
        client, paper, f"Review to be answered {paper.tag}."
    )

    author = Member(seed=paper.seed)
    assert author.did == paper.did
    assert author.did in paper.authors
    marker = f"Author reply {uuid.uuid4().hex}"
    soundness_reply = f"{marker} soundness"

    response, attempts = author.post_response(
        client, [commit_cid, reveal_cid], marker
    )
    tried = ", ".join(f"{cid} -> {r.status_code}" for cid, r in attempts)
    assert response.status_code == 201, (
        f"a paper author answering review {commit_cid!r} should be accepted "
        f"with 201; got {response.status_code}: {response.text} (tried {tried})"
    )

    # Read the listing as the author: the endpoint is public, and an author is
    # a reader it cannot legitimately keep their own reply from.
    listing = client.get(
        f"{PAPERS_URL}/{paper.short_id}/reviews", headers=author.headers
    )
    assert listing.status_code == 200, (
        f"GET {PAPERS_URL}/{paper.short_id}/reviews -> "
        f"{listing.status_code}: {listing.text}"
    )

    payload = listing.json()
    # The review the author answered is returned ...
    review_ids = {commit_cid, reveal_cid, FIRST_REVIEWER_LABEL}
    assert any(rid in listing.text for rid in review_ids), (
        f"the listing should return the answered review, naming it by its "
        f"review.commit cid {commit_cid!r}, its review.formal cid {reveal_cid!r} "
        f"or its label {FIRST_REVIEWER_LABEL!r}: {payload}"
    )
    # ... and the author's point-by-point reply appears with it.
    assert soundness_reply in listing.text, (
        f"the author's reply should appear in the listing after the 201; "
        f"looked for {soundness_reply!r}: {payload}"
    )
    assert _reply_beside_review(payload, soundness_reply, review_ids), (
        f"the author's reply should appear with the review it answers, not "
        f"detached from any review named by {sorted(review_ids)!r}: {payload}"
    )
