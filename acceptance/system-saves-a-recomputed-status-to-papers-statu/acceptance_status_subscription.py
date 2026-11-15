"""Acceptance tests for: System saves a recomputed status to ``papers.status``
through a ledger subscription whenever a review, notice or moderation record
for that paper is appended (status plugin, feature 84).

Criteria (app_spec.xml, feature 84):

* A listed paper with two revealed formal reviews recommending minor revisions
  shows status ``reviewed`` in ``GET /v1/papers/{id}``.
* A paper with a retraction record shows status ``retracted`` in
  ``GET /v1/papers/{id}``.

The first two tests below are those criteria, one each.  The rest cover the
feature line itself -- the status is recomputed *whenever* a review, notice or
moderation record is appended, and only for the paper the record is about --
and assert nothing beyond it.

How the scene is set up
-----------------------

The papers and their versions belong to the submissions plugin, whose
``POST /v1/records`` handlers are guarded by tier, endorsement, consent and
moderation rules that have nothing to do with computing a status.  The review
records have no ingest handler at all yet.  So, like the sibling suites, the
scene is put in place below the HTTP layer:

* a ``paper.genesis``, a ``manifest`` and one ``paper.version`` record per
  version, each correctly signed and appended to the event log;
* the paper and its versions indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make;
* a version *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``).

The records the feature reacts to -- ``review.formal``, ``retraction``,
``correction`` and ``moderation.decision`` -- are then appended with
``ledger.append``, which is exactly "a record for that paper is appended" and
notifies the ledger's subscribers.  Each is a correctly signed envelope whose
body validates against the record type's schema.  Nothing here touches
``papers.status`` or calls the status plugin: whatever the paper then shows has
to come from the subscription.

What the tests observe
----------------------

Only the public surface: an anonymous ``GET /v1/papers/{id}`` and the
``status`` it returns.  The expected values follow the precedence table in
:mod:`app.modules.status.compute` (feature 83): a retraction outranks every
other status, a correction outranks review standing, and at least two
reviewers who all recommend minor revisions (or better) make a paper
``reviewed``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, NamedTuple, Optional

import pytest
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

from app.modules import ledger
from app.modules.submissions import (
    AWAITING_CONSENT,
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

PAPERS_URL = "/v1/papers"

#: The states a version walks through on its way to being listed.
_TO_LISTED = ("scanning", "moderation", "listed")

#: The six rubric scores every revealed formal review carries.
_RUBRIC = ("soundness", "evidence", "reproducibility", "novelty", "clarity", "limitations")


# --------------------------------------------------------------------------- #
# Signing and appending records
# --------------------------------------------------------------------------- #


def _sign(key: SigningKey, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
    """A complete record signed by ``key``: ``id`` is the recomputed cid."""
    record = sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(key),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        key,
    )
    # Guard the fixture itself: a failure further on can only be the feature's.
    assert verify_record(record)
    assert validate_envelope(record) == [], validate_envelope(record)
    assert validate_body(record_type, body) == [], validate_body(record_type, body)
    return record


class Version(NamedTuple):
    """One version of a scene paper."""

    n: int
    cid: str


class ScenePaper:
    """A paper started by a ``paper.genesis`` whose versions the test adds one by one.

    A new paper is unlisted (no version).  :meth:`listed` adds versions and lists
    them, which is what makes ``GET /v1/papers/{id}`` answer for it.  The
    ``review``, ``retract``, ``correct`` and ``hold`` methods append the records
    the status feature reacts to and return the appended envelope.
    """

    def __init__(self, *, categories: tuple[str, ...] = ("cs.CR",)) -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.licence = "CC-BY-4.0"
        #: The paper's author: signs genesis, versions and any notice.
        self.key = SigningKey.generate()
        self.author_did = did_key_from_signing_key(self.key)
        self.versions: list[Version] = []

        self.genesis = _sign(
            self.key,
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Acceptance paper {self.tag}",
                "abstract": "A paper whose status the node keeps current.",
                "categories": self.categories,
                "licence": self.licence,
                "authors": [self.author_did],
            },
        )
        ledger.append(self.genesis)
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence=self.licence,
        )
        #: The ``sch:xxxx-xxxx-xxxx`` id of the paper.
        self.short_id = derive_short_id(self.genesis["id"])

    @property
    def paper_cid(self) -> str:
        return self.genesis["id"]

    def short_version_id(self, n: int) -> str:
        """``sch:xxxx-xxxx-xxxx/vN``."""
        return f"{self.short_id}/v{n}"

    # -- versions -------------------------------------------------------- #

    def add_version(self) -> Version:
        """Store the paper's next version, in ``awaiting_consent`` (not yet listed)."""
        n = len(self.versions) + 1
        prev = self.versions[-1].cid if self.versions else self.paper_cid
        title = f"Acceptance paper {self.tag} -- version {n}"
        abstract = f"What changed in version {n} of paper {self.tag}."
        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag} v{n}".encode()

        manifest = _sign(
            self.key,
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
        record = _sign(
            self.key,
            "paper.version",
            {
                "paper": self.paper_cid,
                "n": n,
                "title": title,
                "abstract": abstract,
                "authors": [
                    {"did": self.author_did, "position": 1, "creditRoles": ["Conceptualization"]}
                ],
                "manifest": manifest["id"],
                "licence": self.licence,
                "changeNote": f"Version {n}.",
            },
            prev=prev,
        )
        ledger.append(manifest)
        ledger.append(record)
        save_version(
            version_cid=record["id"],
            paper_cid=self.paper_cid,
            n=n,
            title=title,
            abstract=abstract,
            manifest_cid=manifest["id"],
            licence=self.licence,
            prev_cid=prev,
            change_note=f"Version {n}.",
            authors=(VersionAuthor(self.author_did, 1, ("Conceptualization",)),),
        )
        version = Version(n=n, cid=record["id"])
        self.versions.append(version)
        return version

    def listed(self, versions: int = 1) -> "ScenePaper":
        """Add ``versions`` versions and take each through to ``listed``; return ``self``."""
        for _ in range(versions):
            version = self.add_version()
            for state in _TO_LISTED:
                transition_version(version.cid, state)
        return self

    # -- the records the status feature reacts to ------------------------ #

    def review(
        self,
        recommendation: str = "minor_revisions",
        *,
        reviewer: Optional[SigningKey] = None,
        version: Optional[Version] = None,
    ) -> dict:
        """Append a revealed ``review.formal`` of ``version`` (default: the latest).

        Each call is a new reviewer (a fresh per-paper review key) unless
        ``reviewer`` is given.
        """
        version = version or self.versions[-1]
        record = _sign(
            reviewer or SigningKey.generate(),
            "review.formal",
            {
                "target": version.cid,
                "paper": self.paper_cid,
                "scores": {name: 4 for name in _RUBRIC},
                "confidence": 4,
                "recommendation": recommendation,
                "report": f"Review of paper {self.tag}, version {version.n}.",
            },
        )
        ledger.append(record)
        return record

    def _notice(self, kind: str, target: str) -> dict:
        record = _sign(
            self.key,
            kind,
            {"target": target, "paper": self.paper_cid, "reason": f"A {kind} for paper {self.tag}."},
        )
        ledger.append(record)
        return record

    def retract(self, target: Optional[str] = None) -> dict:
        """Append a ``retraction`` of the paper (or of ``target``, a version cid)."""
        return self._notice("retraction", target or self.paper_cid)

    def correct(self, target: Optional[str] = None) -> dict:
        """Append a ``correction`` of the paper (or of ``target``, a version cid)."""
        return self._notice("correction", target or self.paper_cid)

    def hold(self, version: Version) -> dict:
        """Append a moderator's ``moderation.decision`` holding ``version``."""
        record = _sign(
            SigningKey.generate(),
            "moderation.decision",
            {
                "target": version.cid,
                "action": "hold",
                "clause": "MOD-01",
                "reason": f"Held while paper {self.tag} is looked at.",
            },
        )
        ledger.append(record)
        return record


# --------------------------------------------------------------------------- #
# Reading a response
# --------------------------------------------------------------------------- #


def _status(client, ident: str) -> Any:
    """The ``status`` of ``GET /v1/papers/{ident}`` as an anonymous reader.

    The route must answer 200 -- the paper is listed -- so a failure here is
    never confused with a status that was merely not saved.  ``status`` is read
    at the top of the response, else inside one nested object.
    """
    response = client.get(f"{PAPERS_URL}/{ident}")
    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{ident} -> {response.status_code}: {response.text}"
    )
    body = response.json()
    assert isinstance(body, dict), body
    for scope in [body] + [value for value in body.values() if isinstance(value, dict)]:
        if "status" in scope:
            return scope["status"]
    pytest.fail(f"GET {PAPERS_URL}/{ident} has no 'status': {body}")


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_two_revealed_minor_revision_reviews_make_a_listed_paper_reviewed(client):
    """A listed paper with two revealed formal reviews recommending minor revisions
    shows status reviewed in GET /v1/papers/{id}."""
    paper = ScenePaper().listed()
    assert _status(client, paper.short_id) != "reviewed"  # nothing has been reviewed yet

    paper.review("minor_revisions")
    paper.review("minor_revisions")

    assert _status(client, paper.short_id) == "reviewed"


def test_retraction_record_makes_a_paper_retracted(client):
    """A paper with a retraction record shows status retracted in GET /v1/papers/{id}."""
    paper = ScenePaper().listed()
    assert _status(client, paper.short_id) != "retracted"  # nothing has been retracted yet

    paper.retract()

    assert _status(client, paper.short_id) == "retracted"


# --------------------------------------------------------------------------- #
# The rest of the feature line
# --------------------------------------------------------------------------- #


def test_status_is_recomputed_each_time_a_review_or_notice_is_appended(client):
    """The status is recomputed whenever a record is appended, not just the first time."""
    paper = ScenePaper().listed()

    paper.review("minor_revisions")
    assert _status(client, paper.short_id) != "reviewed"  # one reviewer is not enough

    paper.review("minor_revisions")
    assert _status(client, paper.short_id) == "reviewed"

    paper.correct()  # a correction notice outranks review standing
    assert _status(client, paper.short_id) == "corrected"

    paper.retract()  # a retraction outranks everything
    assert _status(client, paper.short_id) == "retracted"


def test_correction_notice_makes_a_paper_corrected(client):
    """A notice other than a retraction is saved too: a correction shows as corrected."""
    paper = ScenePaper().listed()
    assert _status(client, paper.short_id) != "corrected"

    paper.correct()

    assert _status(client, paper.short_id) == "corrected"


def test_retraction_naming_a_version_makes_the_paper_retracted(client):
    """A notice that names one version is still a notice for the paper."""
    paper = ScenePaper().listed(versions=2)
    v1, v2 = paper.versions

    paper.retract(target=v2.cid)

    # Status belongs to the paper: it reads the same through every version id.
    assert _status(client, paper.short_id) == "retracted"
    assert _status(client, paper.short_version_id(v1.n)) == "retracted"


def test_moderation_hold_record_makes_a_paper_contested(client):
    """A moderation record for the paper is a trigger too: a hold shows as contested."""
    paper = ScenePaper().listed(versions=2)
    v1, v2 = paper.versions
    # Read through version 1: holding version 2 may take that version off the
    # public catalog, and the paper's status must still be readable.
    assert _status(client, paper.short_version_id(v1.n)) != "contested"

    paper.hold(v2)

    assert _status(client, paper.short_version_id(v1.n)) == "contested"


def test_records_for_one_paper_change_only_that_papers_status(client):
    """The status saved is the one of the paper the appended record is about."""
    retracted = ScenePaper().listed()
    reviewed = ScenePaper().listed()
    untouched = ScenePaper().listed()
    untouched_before = _status(client, untouched.short_id)

    retracted.retract()
    assert _status(client, retracted.short_id) == "retracted"
    assert _status(client, reviewed.short_id) != "retracted"

    reviewed.review("minor_revisions")
    reviewed.review("minor_revisions")

    assert _status(client, reviewed.short_id) == "reviewed"
    assert _status(client, retracted.short_id) == "retracted"
    assert _status(client, untouched.short_id) == untouched_before
