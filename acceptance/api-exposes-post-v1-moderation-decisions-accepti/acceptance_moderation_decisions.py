"""Acceptance tests for: API exposes ``POST /v1/moderation/decisions`` accepting
a signed ``moderation.decision`` (list, hold, reclassify, reject, delist) that
requires a known policy clause and a reason, saves it to the
``moderation_decisions`` table and sets the version state (moderation plugin,
feature 71).

Criteria (app_spec.xml, feature 71):

* ``POST /v1/moderation/decisions`` without a clause returns ``422`` problem
  details.
* ``POST /v1/moderation/decisions`` with action ``list`` returns ``201`` and
  the paper becomes resolvable by its ``sch:`` id.
* ``GET /v1/records/{cid}`` returns the decision record publicly.

The request
-----------

Every write on this API is a client-signed record envelope, and this endpoint
takes a signed ``moderation.decision`` the same way ``POST /v1/records`` takes
any record::

    POST /v1/moderation/decisions
    Authorization: Bearer <tier-4 access token>

    {"v": 1, "type": "moderation.decision", "author": "did:key:z6Mk...",
     "created": "2026-11-14T05:33:00Z", "prev": null,
     "body": {"target": "<version cid>", "action": "list",
              "clause": "MOD-01", "reason": "..."},
     "proofs": [], "id": "bafyrei...", "sig": "..."}

The moderator signs the record with their own key, so ``id`` is the recomputed
cid and ``sig`` a real Ed25519 signature by ``author``: whatever order the
pipeline checks things in, the only thing wrong with a refused record is the
thing the test breaks.  ``body.target`` is the cid of the version being
decided on, ``body.clause`` is the id of a clause served by
``GET /v1/moderation/policies``, and ``body.reason`` is the reason shown to the
author.

How the scene is set up
-----------------------

The paper and its version belong to the submissions plugin, whose
``POST /v1/records`` handlers are guarded by tier, endorsement, consent and scan
rules that have nothing to do with deciding on a version.  So a version that
is waiting for a moderator is put in place the way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` record signed by
  the author and appended to the event log;
* the paper and its version indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make --
  with the version in state ``moderation``, which is where a version sits
  when it is in the moderation queue;
* the moderator: a fresh key whose ``accounts`` row is tier 4 and whose access
  token is tier 4.  Both are put in place because a node may read the
  moderator's tier from either one.

Everything the criteria are about goes through the public surface: ``POST
/v1/moderation/decisions`` as the moderator, then ``GET /v1/papers/{sch: id}``
and ``GET /v1/records/{cid}`` as an anonymous reader.

The response of ``POST /v1/moderation/decisions`` is not pinned beyond its
status, and neither is the layout of ``GET /v1/papers/{id}``: the tests identify
the paper by values only that scene's version has (its cid, its ``sch:`` id or
its unique title) wherever they sit in the response, and they never compare a
whole response object, since later features may add fields.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Optional

import pytest
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
DECISIONS_URL = "/v1/moderation/decisions"

#: Public endpoints the criteria are observed through.
POLICIES_URL = "/v1/moderation/policies"
PAPERS_URL = "/v1/papers"
RECORDS_URL = "/v1/records"

#: RFC 9457 media type every API error on this app is served as.
PROBLEM_JSON = "application/problem+json"

#: The record type of a decision.
DECISION_TYPE = "moderation.decision"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _now() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _timestamp() -> str:
    """Now as the ``created`` field of a record envelope."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def _assert_problem_details(response, status: int) -> dict:
    """The response is RFC 9457 problem details with ``status``; return its body."""
    assert response.status_code == status, (
        f"expected {status}, got {response.status_code}: {response.text}"
    )
    assert response.headers["content-type"].startswith(PROBLEM_JSON), (
        response.headers["content-type"]
    )
    body = response.json()
    assert body["status"] == status, body
    return body


# --------------------------------------------------------------------------- #
# The scene: a version waiting in the moderation queue, and a moderator
# --------------------------------------------------------------------------- #


class Submission:
    """One paper with one version in state ``moderation``, waiting for a decision."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Moderation decision acceptance paper {self.tag}"
        self.abstract = "A paper waiting for a moderator's decision."

        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag}".encode()

        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": self.abstract,
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        manifest = self._sign(
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
        version = self._sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": self.title,
                "abstract": self.abstract,
                "authors": [
                    {"did": self.did, "position": 1, "creditRoles": ["Conceptualization"]}
                ],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        # Index the paper and its version the way the submissions handlers do,
        # with the version where the moderation queue finds it.
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
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
            state="moderation",
        )

        #: cid of the version a decision targets.
        self.version_cid: str = version["id"]
        #: cid of the paper's ``paper.genesis`` record.
        self.paper_cid: str = genesis["id"]
        #: The ``sch:xxxx-xxxx-xxxx`` id the paper is resolved by.
        self.short_id: str = derive_short_id(genesis["id"])

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        """A complete signed record; the fixture fails if it is not valid."""
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
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    def is_described_by(self, payload: Any) -> bool:
        """Whether ``payload`` is about this submission, wherever it says so."""
        strings = set(_all_strings(payload))
        return any(
            needle in strings for needle in (self.version_cid, self.short_id, self.title)
        )


class Moderator:
    """A tier-4 member who signs moderation decisions."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(did=self.did, tier=4, created_at=_now() - timedelta(days=400))
            )
            session.commit()

        #: The moderator's credentials: a tier-4 access token.
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 4)}"}

    def decide(
        self,
        submission: Submission,
        action: str,
        *,
        clause: Optional[str],
        reason: Optional[str] = None,
    ) -> dict:
        """A signed ``moderation.decision`` on ``submission``'s version.

        ``clause=None`` leaves the clause out of the body altogether; every other
        field is exactly what a complete decision carries.  The reason is unique
        to the decision.
        """
        body: dict[str, Any] = {
            "target": submission.version_cid,
            "action": action,
            "reason": reason or f"Acceptance decision {uuid.uuid4().hex}",
        }
        if clause is not None:
            body["clause"] = clause
        record = sign_record(
            {
                "v": 1,
                "type": DECISION_TYPE,
                "author": self.did,
                "created": _timestamp(),
                "prev": None,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        # The record is signed and well formed either way; a decision with a
        # clause is valid outright, and one without is valid except for the clause.
        assert verify_record(record)
        canonical_envelope(record)
        if clause is not None:
            assert validate_envelope(record) == [], validate_envelope(record)
            assert validate_body(DECISION_TYPE, body) == [], validate_body(DECISION_TYPE, body)
        else:
            assert "clause" not in record["body"]
            assert validate_body(DECISION_TYPE, body) != []
            assert validate_body(DECISION_TYPE, {**body, "clause": "MOD-01"}) == []
        return record


@pytest.fixture
def moderator() -> Moderator:
    """A fresh tier-4 moderator."""
    return Moderator()


@pytest.fixture
def clause(client) -> str:
    """The id of a policy clause this node knows, as ``GET /v1/moderation/policies`` lists it."""
    response = client.get(POLICIES_URL)
    assert response.status_code == 200, response.text
    clauses = response.json()
    assert clauses, "the node serves no policy clauses"
    return clauses[0]["id"]


def _post(client, moderator: Moderator, decision: dict):
    """``POST /v1/moderation/decisions`` as ``moderator``."""
    return client.post(DECISIONS_URL, json=decision, headers=moderator.headers)


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_decision_without_a_clause_returns_422_problem_details(client, moderator, clause):
    """A decision that cites no policy clause is refused with 422 problem details."""
    accepted = Submission()
    refused = Submission()

    # Control: the same moderator, the same action and the same kind of request,
    # but with a clause, is accepted.  The only difference below is the clause.
    control = _post(client, moderator, moderator.decide(accepted, "list", clause=clause))
    assert control.status_code == 201, (
        f"a decision citing clause {clause!r} should be accepted: "
        f"{control.status_code} {control.text}"
    )

    clauseless = moderator.decide(refused, "list", clause=None)
    response = _post(client, moderator, clauseless)

    _assert_problem_details(response, 422)

    # A refused decision is not recorded and does not act on the version.
    assert client.get(f"{RECORDS_URL}/{clauseless['id']}").status_code == 404
    assert client.get(f"{PAPERS_URL}/{refused.short_id}").status_code == 404


def test_list_decision_returns_201_and_the_paper_becomes_resolvable_by_its_sch_id(
    client, moderator, clause
):
    """Listing a version answers 201 and the paper then resolves by its sch: id."""
    submission = Submission()

    # A version waiting in moderation is not in the public catalog yet.
    before = client.get(f"{PAPERS_URL}/{submission.short_id}")
    assert before.status_code == 404, (
        f"GET {PAPERS_URL}/{submission.short_id} -> {before.status_code}: {before.text}"
    )

    response = _post(client, moderator, moderator.decide(submission, "list", clause=clause))

    assert response.status_code == 201, response.text

    after = client.get(f"{PAPERS_URL}/{submission.short_id}")
    assert after.status_code == 200, (
        f"GET {PAPERS_URL}/{submission.short_id} -> {after.status_code}: {after.text}"
    )
    assert submission.is_described_by(after.json()), after.json()


def test_get_records_cid_returns_the_decision_record_publicly(client, moderator, clause):
    """The signed decision can be read back by its cid with no credentials at all."""
    submission = Submission()
    decision = moderator.decide(submission, "list", clause=clause)
    cid = decision["id"]

    # The node holds no such record until the moderator submits it.
    assert client.get(f"{RECORDS_URL}/{cid}").status_code == 404

    response = _post(client, moderator, decision)
    assert response.status_code == 201, response.text

    # Anonymous: no Authorization header.
    read = client.get(f"{RECORDS_URL}/{cid}")

    assert read.status_code == 200, read.text
    record = read.json()
    assert record["id"] == cid
    assert record["type"] == DECISION_TYPE
    assert record["author"] == moderator.did
    body = record["body"]
    assert body["target"] == submission.version_cid
    assert body["action"] == "list"
    assert body["clause"] == clause
    assert body["reason"] == decision["body"]["reason"]
