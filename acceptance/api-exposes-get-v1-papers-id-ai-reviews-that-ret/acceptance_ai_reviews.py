"""Acceptance tests for: API exposes ``GET /v1/papers/{id}/ai-reviews`` that
returns reports labelled advisory with findings grouped by agent (ai_review
plugin, feature 122).

Criteria (app_spec.xml, feature 122):

* With the fake provider, ``GET /v1/papers/{id}/ai-reviews`` for a listed paper
  returns ``200`` with ``advisory`` true and four agents.
* Every finding in ``GET /v1/papers/{id}/ai-reviews`` has an evidence object.
* The paper status in ``GET /v1/papers/{id}`` is unchanged after the AI review
  is appended.

The first three tests below are those criteria, one each.

How the scene is set up
-----------------------

The paper, its version and its AI review belong to other parts of the
``ai_review`` plugin, whose submission handlers are guarded by tier,
endorsement, consent and moderation rules that have nothing to do with reading
a review back.  The scene is therefore put in place the way the sibling
suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` record, each
  correctly signed and appended to the event log;
* the paper and version indexed through the submissions plugin's own exported
  ``save_paper`` / ``save_version`` -- the calls its handlers make;
* the version *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``), which is what a moderator's
  decision ends up calling;
* the review appended by the ``ai_review`` plugin's exported ``run_ai_review``
  -- the call its background job makes after a version is listed (feature
  121) -- with ``AI_PROVIDER=fake``, the provider the first criterion names.

Everything the criteria are about then goes through the public surface: an
anonymous ``GET /v1/papers/{id}/ai-reviews`` and ``GET /v1/papers/{id}``.

Reading the response
--------------------

The criteria fix *that* the report is advisory, *that* four agents appear and
*that* findings carry evidence; they do not fix the JSON layout.  The helpers
below find those values anywhere a reasonable layout puts them -- a top-level
``advisory`` flag, a list of per-agent reports, findings grouped under an
agent's name or collected in one list -- and never compare a whole response
object, so later features may add fields without breaking these tests.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, NamedTuple, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_envelope,
    verify_record,
)

from app import db, jobs
from app.modules import ledger
from app.modules.ai_review import (
    AGENT_NAMES,
    AIReview,
    ensure_ai_reviews_table,
    run_ai_review,
)
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

PAPERS_URL = "/v1/papers"

#: The states a version walks through on its way to being listed.
_TO_LISTED = ("scanning", "moderation", "listed")

#: The four specialist agents whose reports the endpoint groups findings by.
_EXPECTED_AGENTS = frozenset(AGENT_NAMES)


# --------------------------------------------------------------------------- #
# The scene: one listed paper whose AI review has been appended
# --------------------------------------------------------------------------- #


class Version(NamedTuple):
    """One version of a scene paper."""

    n: int
    cid: str
    title: str


class ScenePaper:
    """A paper started by a ``paper.genesis`` and its first ``paper.version``."""

    def __init__(self, *, categories: tuple[str, ...] = ("cs.CR",)) -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.licence = "CC-BY-4.0"
        self._keys = [SigningKey.generate() for _ in range(2)]
        #: The listed authors' DIDs, in byline order.
        self.author_dids = [did_key_from_signing_key(key) for key in self._keys]

        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Acceptance paper {self.tag}",
                "abstract": "A paper whose AI pre-review readers can fetch.",
                "categories": self.categories,
                "licence": self.licence,
                "authors": self.author_dids,
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

    # -- signing --------------------------------------------------------- #

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        """A complete record signed by the lead author: ``id`` is the recomputed cid."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.author_dids[0],
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self._keys[0],
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    # -- the version ----------------------------------------------------- #

    def add_version(self) -> Version:
        """Store the paper's first version in ``awaiting_consent``."""
        n = 1
        title = f"Acceptance paper {self.tag} -- version {n}"
        abstract = f"What the paper {self.tag} says."
        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag} v{n}".encode()

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
        record = self._sign(
            "paper.version",
            {
                "paper": self.genesis["id"],
                "n": n,
                "title": title,
                "abstract": abstract,
                "authors": [
                    {
                        "did": did,
                        "position": index + 1,
                        "creditRoles": ["Conceptualization"],
                    }
                    for index, did in enumerate(self.author_dids)
                ],
                "manifest": manifest["id"],
                "licence": self.licence,
                "changeNote": f"Version {n}.",
            },
            prev=self.genesis["id"],
        )
        ledger.append(manifest)
        ledger.append(record)
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=abstract,
            manifest_cid=manifest["id"],
            licence=self.licence,
            prev_cid=self.genesis["id"],
            change_note=f"Version {n}.",
            authors=tuple(
                VersionAuthor(did, index + 1, ("Conceptualization",))
                for index, did in enumerate(self.author_dids)
            ),
        )
        return Version(n=n, cid=record["id"], title=title)

    def list_version(self, version: Version) -> None:
        """Take ``version`` through scanning and moderation to ``listed``."""
        for state in _TO_LISTED:
            transition_version(version.cid, state)

    # -- the review ------------------------------------------------------ #

    def append_review(self, version: Version) -> str:
        """Append the advisory AI review for ``version``; return its cid."""
        return run_ai_review(version.cid, paper_cid=self.genesis["id"])


@pytest.fixture
def listed_paper_with_review():
    """A listed paper whose version has had its advisory AI review appended."""
    paper = ScenePaper()
    version = paper.add_version()
    paper.list_version(version)
    review_cid = paper.append_review(version)
    assert review_cid, "run_ai_review returned no review cid"
    assert _review_row(version.cid) is not None, "the AI review was not appended"
    return paper, version


# --------------------------------------------------------------------------- #
# Reading the response
# --------------------------------------------------------------------------- #


def _walk(value: Any) -> Iterator[dict]:
    """Every dict anywhere inside a JSON value, including ``value`` itself."""
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _walk(item)


def _strings(value: Any) -> Iterator[str]:
    """Every string anywhere inside a JSON value, dict keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            if isinstance(key, str):
                yield key
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def _field(body: Any, name: str) -> Any:
    """``name`` at the top of the response, else inside one nested object."""
    if not isinstance(body, dict):
        return None
    if name in body:
        return body[name]
    for value in body.values():
        if isinstance(value, dict) and name in value:
            return value[name]
    return None


def _advisory_flags(body: Any) -> list[Any]:
    """Every ``advisory`` label anywhere in the response."""
    return [item["advisory"] for item in _walk(body) if "advisory" in item]


def _agent_names(body: Any) -> set[str]:
    """The specialist agent names the response names anywhere (key or value)."""
    return {text for text in _strings(body) if text in _EXPECTED_AGENTS}


def _findings(body: Any) -> list[dict]:
    """Every finding object anywhere in the response.

    A finding is the object the plugin's reports carry: the one naming a
    ``claim`` and its ``evidence``.  The endpoint may group them by agent,
    collect them in one list, or both.
    """
    return [
        item for item in _walk(body) if "claim" in item or "evidence" in item
    ]


def _reviews(client, ident: str):
    """``GET /v1/papers/{ident}/ai-reviews`` as an anonymous reader."""
    return client.get(f"{PAPERS_URL}/{ident}/ai-reviews")


def _reviews_ok(client, ident: str) -> Any:
    """``GET /v1/papers/{ident}/ai-reviews`` -- must answer 200; return its JSON."""
    response = _reviews(client, ident)
    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{ident}/ai-reviews -> {response.status_code}: "
        f"{response.text}"
    )
    return response.json()


def _paper_status(client, ident: str) -> Any:
    """The ``status`` of ``GET /v1/papers/{ident}``."""
    response = client.get(f"{PAPERS_URL}/{ident}")
    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{ident} -> {response.status_code}: {response.text}"
    )
    status = _field(response.json(), "status")
    assert isinstance(status, str) and status, response.text
    return status


def _review_row(version_cid: str) -> Optional[AIReview]:
    """The persisted ``ai_reviews`` row for ``version_cid``, if any."""
    ensure_ai_reviews_table()
    with db.SessionLocal() as session:
        row = session.query(AIReview).filter_by(version_cid=version_cid).first()
        if row is not None:
            session.expunge(row)
        return row


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_with_fake_provider_a_listed_paper_returns_200_with_advisory_true_and_four_agents(
    client, listed_paper_with_review
):
    """With the fake provider, GET .../ai-reviews for a listed paper returns 200, advisory true, four agents."""
    paper, _version = listed_paper_with_review

    body = _reviews_ok(client, paper.short_id)

    flags = _advisory_flags(body)
    assert flags, f"the report carries no advisory label: {body}"
    assert all(flag is True for flag in flags), (
        f"every advisory label must be true, got {flags!r}: {body}"
    )

    agents = _agent_names(body)
    assert agents == _EXPECTED_AGENTS, (
        f"expected the four agents {sorted(_EXPECTED_AGENTS)}, got {sorted(agents)}: "
        f"{body}"
    )
    assert len(agents) == 4, agents


def test_every_finding_has_an_evidence_object(client, listed_paper_with_review):
    """Every finding in GET .../ai-reviews has an evidence object."""
    paper, _version = listed_paper_with_review

    body = _reviews_ok(client, paper.short_id)

    findings = _findings(body)
    for number, finding in enumerate(findings, start=1):
        assert "evidence" in finding, (
            f"finding {number} has no evidence object: {finding}"
        )
        evidence = finding["evidence"]
        assert isinstance(evidence, dict), (
            f"finding {number}'s evidence is not an object: {evidence!r}"
        )
        assert evidence, f"finding {number}'s evidence object is empty: {finding}"


def test_paper_status_is_unchanged_after_the_ai_review_is_appended(
    client, monkeypatch
):
    """The paper status in GET /v1/papers/{id} is unchanged after the AI review is appended."""
    paper = ScenePaper()
    version = paper.add_version()

    # Listing normally enqueues the AI review job (feature 121).  Suppress that
    # one trigger so the status is read while no review exists yet, then append
    # the review deliberately and read the status again: the two readings
    # differ only by the appended advisory review.
    with monkeypatch.context() as patch:
        patch.setattr(jobs, "enqueue", lambda *args, **kwargs: None)
        paper.list_version(version)

    status_before = _paper_status(client, paper.short_id)
    assert _review_row(version.cid) is None, "the trigger was not suppressed"

    paper.append_review(version)
    assert _review_row(version.cid) is not None, "the AI review was not appended"

    # The appended review is now served by the feature's endpoint.
    body = _reviews_ok(client, paper.short_id)
    assert any(flag is True for flag in _advisory_flags(body)), body

    status_after = _paper_status(client, paper.short_id)
    assert status_after == status_before, (
        f"the paper status changed from {status_before!r} to {status_after!r} "
        "when the advisory AI review was appended"
    )
