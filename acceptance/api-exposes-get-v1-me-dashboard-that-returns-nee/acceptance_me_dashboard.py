"""Acceptance tests for: API exposes ``GET /v1/me/dashboard`` that returns
``needs_attention`` (consents to sign, review invitations, author replies,
moderation outcomes), ``my_papers`` with status and review counts and
``my_reviews`` with sealed or revealed state (me plugin, feature 126).

Criteria (app_spec.xml, feature 126):

* ``GET /v1/me/dashboard`` for a co-author with a pending consent lists it in
  ``needs_attention``.

The scene
---------

A version of a paper lists several authors and waits in ``awaiting_consent``
until every one of them has signed a ``coauthor.consent`` (features 54-56).  A
listed author who has not signed yet has a *pending consent*: a thing the
dashboard owes them -- "consents to sign" is the first category the feature
names under ``needs_attention``.

The test builds exactly that, with two listed authors:

* the **submitter**, who starts the paper and has already signed their own
  consent, through the real ``POST /v1/records``; and
* the **co-author**, a different signed-in member, who has *not* signed.

The paper is put in the node the way the sibling suites do it: a
``paper.genesis``, a ``manifest`` and a ``paper.version`` signed by the
submitter and appended to the event log, the paper and its version indexed
through the submissions plugin's own exported ``save_paper`` / ``save_version``
(the calls its handlers make), the version left in ``awaiting_consent`` with
both authors on its byline.  Before the dashboard is read, the scene is
checked against the consent tracker (``GET /v1/papers/{id}/v/{n}/consents``,
feature 56): the co-author must be ``waiting`` and the submitter ``signed``, so
a failure further on can only be the dashboard's.

Reading the response
--------------------

The criterion fixes *that* the pending consent is listed in ``needs_attention``;
it does not fix the JSON layout -- ``needs_attention`` may be one flat list of
items or an object grouping them by kind.  "Lists it" is therefore read as: the
``needs_attention`` value names the paper or the version the consent is for, by
any of the identities the system gives them -- the paper's ``sch:`` short id,
the cid of its genesis or of the version, or the title -- somewhere inside it.

Only the ``needs_attention`` value is searched.  The co-author is also a listed
author of the paper, so ``my_papers`` may well mention it too; a mention there
says nothing about whether the pending consent is listed under
``needs_attention``.  A whole response object is never compared, since later
features may add fields and reasons to attend.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Optional

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
DASHBOARD_URL = "/v1/me/dashboard"

#: The endpoint every signed record is written through.
RECORDS_URL = "/v1/records"

#: The record type a listed author signs to accept or decline authorship.
CONSENT_TYPE = "coauthor.consent"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"

#: Trust tiers of the two people in the scene.  A consent can be signed at any
#: tier; the co-author is an ordinary signed-in member, the submitter an author.
SUBMITTER_TIER = 2
COAUTHOR_TIER = 1


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
    """Every string anywhere inside a JSON value, object keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _all_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_strings(item)


# --------------------------------------------------------------------------- #
# The scene: a paper with a submitter who has signed and a co-author who has not
# --------------------------------------------------------------------------- #


class Member:
    """A signed-in member: a fresh did:key, an ``accounts`` row and an access token."""

    def __init__(self, tier: int) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(
                Account(did=self.did, tier=tier, created_at=_now() - timedelta(days=400))
            )
            session.commit()

        #: The member's credentials: an access token at their tier.
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        """A complete signed record by this member; the fixture fails if it is not valid."""
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
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        assert validate_body(record_type, body) == [], validate_body(record_type, body)
        return record


class PaperAwaitingConsent:
    """One paper whose first version lists a submitter and a co-author."""

    def __init__(self, submitter: Member, coauthor: Member) -> None:
        self.tag = uuid.uuid4().hex
        self.submitter = submitter
        self.coauthor = coauthor
        self.title = f"Dashboard pending consent acceptance paper {self.tag}"
        self.abstract = "A paper whose co-author has been asked to consent."
        authors = [submitter.did, coauthor.did]

        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag}".encode()

        genesis = submitter.sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": self.abstract,
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": list(authors),
            },
        )
        manifest = submitter.sign(
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
            for position, did in enumerate(authors, start=1)
        ]
        version = submitter.sign(
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

        # Index the paper and its version the way the submissions handlers do:
        # the version waits in ``awaiting_consent`` (the default) with both
        # authors on its byline and neither consent saved yet.
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
                for position, did in enumerate(authors, start=1)
            ),
        )

        #: cid of the paper's ``paper.genesis`` record.
        self.paper_cid: str = genesis["id"]
        #: cid of the version the consents are for.
        self.version_cid: str = version["id"]
        #: The ``sch:xxxx-xxxx-xxxx`` id the paper is addressed by.
        self.short_id: str = derive_short_id(genesis["id"])

    @property
    def identities(self) -> tuple[str, ...]:
        """Every identity the system gives the paper and its version."""
        return (self.short_id, self.paper_cid, self.version_cid, self.title)

    def sign_consent(self, client, member: Member, decision: str = "accept") -> None:
        """``member`` signs a ``coauthor.consent`` and the node accepts it."""
        record = member.sign(
            CONSENT_TYPE,
            {
                "version": self.version_cid,
                "role": "Conceptualization",
                "decision": decision,
            },
        )
        response = client.post(RECORDS_URL, json=record, headers=member.headers)
        assert response.status_code == 201, (
            f"the node should accept a consent from a listed author; "
            f"got {response.status_code}: {response.text}"
        )


def _consent_statuses(client, paper: PaperAwaitingConsent) -> dict[str, str]:
    """Each listed author's consent status, read from the consent tracker (feature 56)."""
    response = client.get(f"/v1/papers/{paper.short_id}/v/1/consents")
    assert response.status_code == 200, (
        f"the consent tracker should list the scene's version; "
        f"got {response.status_code}: {response.text}"
    )
    return {entry["did"]: entry["status"] for entry in response.json()["authors"]}


# --------------------------------------------------------------------------- #
# Criterion 1: a co-author with a pending consent sees it in needs_attention
# --------------------------------------------------------------------------- #


def test_dashboard_for_a_coauthor_with_a_pending_consent_lists_it_in_needs_attention(
    client,
):
    submitter = Member(SUBMITTER_TIER)
    coauthor = Member(COAUTHOR_TIER)
    paper = PaperAwaitingConsent(submitter, coauthor)

    # The submitter has signed their own consent; the co-author has not.
    paper.sign_consent(client, submitter)
    statuses = _consent_statuses(client, paper)
    assert statuses[submitter.did] == "signed", statuses
    assert statuses[coauthor.did] == "waiting", (
        f"the co-author must still owe a consent for this scene; got {statuses}"
    )

    response = client.get(DASHBOARD_URL, headers=coauthor.headers)

    assert response.status_code == 200, (
        f"GET {DASHBOARD_URL} should answer the signed-in co-author with 200; "
        f"got {response.status_code}: {response.text}"
    )
    dashboard = response.json()
    assert isinstance(dashboard, dict) and "needs_attention" in dashboard, (
        f"the dashboard should have a needs_attention member; got {response.text}"
    )

    needs_attention = dashboard["needs_attention"]
    mentioned = [
        text
        for text in _all_strings(needs_attention)
        if any(identity in text for identity in paper.identities)
    ]
    assert mentioned, (
        f"the co-author's pending consent for paper {paper.short_id} "
        f"(version {paper.version_cid}) should be listed in needs_attention, "
        f"but nothing in it names the paper or the version; "
        f"needs_attention was {needs_attention!r}"
    )
