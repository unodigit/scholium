"""Acceptance tests for: API exposes ``POST /v1/ai-reviews/{cid}/rebuttal`` for
paper authors per ``finding_id`` (ai_review plugin, feature 123).

Criteria (app_spec.xml, feature 123):

* ``POST /v1/ai-reviews/{cid}/rebuttal`` by a non-author returns ``403``.
* A rebuttal posted by an author appears beside its finding in
  ``GET /v1/papers/{id}/ai-reviews``.

The other half of feature 123 -- ``POST /v1/ai-reviews/{cid}/assessments`` for
tier-3 reviewers -- is part of the feature description but is not one of the
two acceptance criteria this suite is written against.

The request
-----------

``{cid}`` is the advisory review's cid, the ``reviewCid`` that
``GET /v1/papers/{id}/ai-reviews`` reports.  The caller is authenticated with
an access token at their trust tier, and names the finding the reply is about
by the ``finding_id`` the same document shows for that finding::

    POST /v1/ai-reviews/{reviewCid}/rebuttal
    Authorization: Bearer <access token>

    {"finding_id": "<the finding's id>", "text": "<the author's reply>"}

The endpoint answers ``201`` for a paper author and ``403`` for anyone else.
A rebuttal is attached to its own finding, so after an author posts one
``GET /v1/papers/{id}/ai-reviews`` shows the text beside the finding named by
``finding_id`` -- inside that finding's object or in a neighbouring object
that names it, under whatever keys the implementation chooses (``rebuttal``,
``rebuttals``, ``responses``, ...).

How the scene is set up
-----------------------

The paper, its version and its AI review belong to other parts of the
``ai_review`` plugin, whose submission handlers are guarded by tier,
endorsement, consent and moderation rules that have nothing to do with
rebutting a finding.  The scene is therefore put in place the way the sibling
``GET .../ai-reviews`` acceptance suite does it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` record, each
  correctly signed and appended to the event log;
* the paper and version indexed through the submissions plugin's own exported
  ``save_paper`` / ``save_version`` -- the calls its handlers make;
* the version *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``);
* the review appended by the ``ai_review`` plugin's exported ``run_ai_review``
  with ``AI_PROVIDER=fake``, under which the reproducibility agent always
  contributes its "no code bundle" finding, so the scene review always has a
  finding to rebut.

The author is the paper's lead author: the DID on the genesis and version and
in the version's byline, with an ``accounts`` row and an access token.  The
non-author is a different DID, also signed in at author tier, who is not on
the paper.

Everything the criteria are about goes through the public surface: the two
``POST`` statuses and the finding/rebuttal values in the anonymous
``GET /v1/papers/{id}/ai-reviews`` document.  The tests never compare a whole
response object, since later features may add fields.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, NamedTuple, Optional

from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_envelope,
    verify_record,
)

from app import db
from app.modules import ledger
from app.modules.ai_review import run_ai_review
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)
from app.security import issue_access_token

PAPERS_URL = "/v1/papers"
AI_REVIEWS_URL = "/v1/ai-reviews"

#: The states a version walks through on its way to being listed.
_TO_LISTED = ("scanning", "moderation", "listed")

#: Keys a response may use for a finding's stable id.  The endpoint accepts the
#: id under ``finding_id``, so a reasonable layout exposes it under one of these.
_FINDING_ID_KEYS = ("finding_id", "findingId", "findingID", "id")

#: Keys a response may use for the review's cid, which the POST path names.
_REVIEW_CID_KEYS = ("reviewCid", "review_cid", "cid")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _now() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _created() -> str:
    """Now as the ``created`` field of a record envelope."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _walk(value: Any) -> Iterator[dict]:
    """Every dict anywhere inside a JSON value, including ``value`` itself."""
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _walk(item)


def _values(value: Any) -> Iterator[str]:
    """Every string value anywhere inside a JSON value (dict keys excluded)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _values(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _values(item)


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


def _findings(body: Any) -> list[dict]:
    """Every finding object anywhere in the response.

    A finding is the object the plugin's reports carry: the one naming a
    ``claim`` and its ``evidence``.  The endpoint may group findings by agent
    or collect them in one list.
    """
    return [
        item
        for item in _walk(body)
        if isinstance(item, dict) and "claim" in item and "evidence" in item
    ]


def _finding_ref(finding: dict) -> Optional[Any]:
    """The stable id a finding exposes, or ``None`` when it exposes none."""
    for key in _FINDING_ID_KEYS:
        value = finding.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip():
            return value
    return None


def _review_ref(body: Any) -> Optional[str]:
    """The advisory review's cid, the ``{cid}`` of the rebuttal URL."""
    for key in _REVIEW_CID_KEYS:
        value = _field(body, key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _first_finding(body: Any) -> dict:
    """The finding these tests rebut, with a stable id to name it by."""
    findings = _findings(body)
    assert findings, (
        "GET /v1/papers/{id}/ai-reviews reported no finding to rebut; the fake "
        f"provider's no-code-bundle finding was expected: {body}"
    )
    for finding in findings:
        if _finding_ref(finding) is not None:
            return finding
    assert False, (
        "no finding in GET /v1/papers/{id}/ai-reviews exposes a stable id "
        f"(looked for {', '.join(_FINDING_ID_KEYS)}), so a client cannot name "
        f"one to POST .../rebuttal as finding_id: {body}"
    )


def _finding_matching(
    body: Any, finding_id: Any, claim: str
) -> Optional[dict]:
    """The finding identified by ``finding_id``, else by its unique ``claim``."""
    findings = _findings(body)
    for finding in findings:
        ref = _finding_ref(finding)
        if ref is not None and str(ref) == str(finding_id):
            return finding
    for finding in findings:
        if finding.get("claim") == claim:
            return finding
    return None


def _names_finding(item: dict, finding_id: Any, claim: str) -> bool:
    """Whether ``item`` is about the finding: it names its id, key or claim."""
    for key in _FINDING_ID_KEYS:
        value = item.get(key)
        if value is not None and str(value) == str(finding_id):
            return True
    # A layout may key a mapping by the finding id instead of carrying a field.
    for key in item:
        if isinstance(key, str) and key == str(finding_id):
            return True
    return item.get("claim") == claim


def _rebuttal_beside(
    body: Any, finding: dict, finding_id: Any, claim: str, text: str
) -> bool:
    """Whether ``text`` is shown beside ``finding`` rather than loose in the body.

    The rebuttal may sit inside the finding's own object (under any key the
    implementation chooses) or in a neighbouring object that names the finding
    by its id or claim; either way it is attached to *this* finding.
    """
    if text in set(_values(finding)):
        return True
    for item in _walk(body):
        if text in set(_values(item)) and _names_finding(item, finding_id, claim):
            return True
    return False


# --------------------------------------------------------------------------- #
# The scene: a listed paper whose advisory AI review has been appended
# --------------------------------------------------------------------------- #


class Version(NamedTuple):
    """One version of a scene paper."""

    n: int
    cid: str
    title: str


class ScenePaper:
    """A paper started by a ``paper.genesis`` and its first ``paper.version``."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.categories = ["cs.CR"]
        self.licence = "CC-BY-4.0"
        self._keys = [SigningKey.generate() for _ in range(2)]
        #: The listed authors' DIDs, in byline order.
        self.author_dids = [did_key_from_signing_key(key) for key in self._keys]

        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Rebuttal acceptance paper {self.tag}",
                "abstract": "A paper whose AI findings its authors can rebut.",
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
                "created": _created(),
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
        title = f"Rebuttal acceptance paper {self.tag} -- version {n}"
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

    # -- the people ------------------------------------------------------ #

    def lead_author(self) -> "Member":
        """The paper's lead author, signed in at author tier."""
        return Member(self.author_dids[0], tier=2)

    def non_author(self) -> "Member":
        """A signed-in author-tier account who is not on the paper."""
        return Member(did_key_from_signing_key(SigningKey.generate()), tier=2)


class Member:
    """A signed-in account at ``tier``: an ``accounts`` row and an access token."""

    def __init__(self, did: str, tier: int) -> None:
        self.did = did
        self.tier = tier

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(Account(did=did, tier=tier, created_at=_now()))
            session.commit()

        self.headers = {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _publish() -> ScenePaper:
    """A listed paper whose version has had its advisory AI review appended."""
    paper = ScenePaper()
    version = paper.add_version()
    paper.list_version(version)
    review_cid = paper.append_review(version)
    assert review_cid, "run_ai_review returned no review cid"
    return paper


# --------------------------------------------------------------------------- #
# Reading and writing through the public surface
# --------------------------------------------------------------------------- #


def _review_document(client, ident: str) -> Any:
    """``GET /v1/papers/{ident}/ai-reviews`` -- must answer 200; return its JSON."""
    response = client.get(f"{PAPERS_URL}/{ident}/ai-reviews")
    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{ident}/ai-reviews -> {response.status_code}: "
        f"{response.text}"
    )
    return response.json()


def _post_rebuttal(client, review_cid: str, member: Member, finding_id: Any, text: str):
    """``POST /v1/ai-reviews/{review_cid}/rebuttal`` as ``member``."""
    return client.post(
        f"{AI_REVIEWS_URL}/{review_cid}/rebuttal",
        json={"finding_id": finding_id, "text": text},
        headers=member.headers,
    )


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_rebuttal_by_a_non_author_returns_403(client):
    """POST .../rebuttal by a non-author is refused with 403."""
    paper = _publish()
    before = _review_document(client, paper.short_id)
    finding = _first_finding(before)
    finding_id = _finding_ref(finding)
    review_cid = _review_ref(before)
    assert review_cid, (
        f"GET .../ai-reviews exposes no review cid to name in the rebuttal URL: {before}"
    )

    stranger = paper.non_author()
    response = _post_rebuttal(
        client,
        review_cid,
        stranger,
        finding_id,
        f"A stranger's reply {uuid.uuid4().hex}",
    )

    assert response.status_code == 403, (
        "a non-author posting a rebuttal should be refused with 403; "
        f"got {response.status_code}: {response.text}"
    )


def test_an_authors_rebuttal_appears_beside_its_finding(client):
    """A rebuttal an author posts is shown beside that finding by GET .../ai-reviews."""
    paper = _publish()
    before = _review_document(client, paper.short_id)
    finding = _first_finding(before)
    finding_id = _finding_ref(finding)
    claim = finding["claim"]
    review_cid = _review_ref(before)
    assert review_cid, (
        f"GET .../ai-reviews exposes no review cid to name in the rebuttal URL: {before}"
    )

    text = f"The authors' rebuttal {uuid.uuid4().hex}"
    author = paper.lead_author()

    posted = _post_rebuttal(client, review_cid, author, finding_id, text)
    assert posted.status_code == 201, (
        "a paper author posting a rebuttal should be accepted with 201; "
        f"got {posted.status_code}: {posted.text}"
    )

    after = _review_document(client, paper.short_id)
    shown = _finding_matching(after, finding_id, claim)
    assert shown is not None, (
        f"the finding {finding_id!r} the rebuttal replies to is no longer in "
        f"GET .../ai-reviews: {after}"
    )
    assert _rebuttal_beside(after, shown, finding_id, claim, text), (
        f"the author's rebuttal {text!r} should appear beside its finding "
        f"{finding_id!r}, but nothing in the response attaches it to that "
        f"finding: {shown}"
    )
