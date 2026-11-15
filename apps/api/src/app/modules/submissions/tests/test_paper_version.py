"""Tests for accepting ``paper.version`` records (feature 50).

A version is accepted from a tier-2 author when its envelope ``prev`` equals
the paper's current latest version (the genesis cid for the first version) and
its body ``n`` is that version's number plus one.  Accepting it saves the
version to ``paper_versions`` in state ``awaiting_consent`` -- title,
abstract, manifest, licence and change note -- and its listed authors to
``authorship`` with their byline positions and CRediT roles.

Isolation: every test builds its own Ed25519 author and its own paper, exactly
as the genesis tests do, because the worker's database is shared.

A paper is put in place through the real genesis path (an endorsed author
posts a signed ``paper.genesis``) unless a test says otherwise, so the version
handler sees the same ``papers`` row and ledger entry production has.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    derive_short_id,
    did_key_from_signing_key,
    format_version_id,
    sign_record,
)
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import ingest, ledger
from app.modules.endorsements import save_endorsement
from app.modules.identity.models import Account, ensure_account_table
from app.modules.ingest import InvalidRecord
from app.modules.submissions import (
    AWAITING_CONSENT,
    PAPER_GENESIS_TYPE,
    PAPER_VERSION_TYPE,
    UNKNOWN_PAPER,
    VERSION_MIN_TIER,
    VERSION_OUT_OF_SEQUENCE,
    Authorship,
    PaperVersion,
    UnknownPaper,
    VersionOutOfSequence,
    authorship_for,
    expected_chain,
    get_version,
    handle_paper_version,
    latest_version,
    require_known_paper,
    save_version,
    version_authors,
    version_fields,
    versions_for_paper,
)
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_tier(did: str, tier: int) -> None:
    """Give ``did`` an account of exactly ``tier`` (creating or overwriting it)."""
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            session.add(
                Account(
                    did=did,
                    tier=tier,
                    created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                )
            )
        else:
            account.tier = tier
        session.commit()


def endorse(did: str, *categories: str) -> None:
    """Endorse ``did`` in each category (which also grants it tier 2)."""
    for category in categories:
        save_endorsement(
            record_cid=f"cid-{uuid.uuid4().hex}",
            endorser_did=did_key_from_signing_key(SigningKey.generate()),
            endorsee_did=did,
            category=category,
        )


class Author:
    """A signed-in author who can sign any record type."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}

    def record(self, record_type: str, body: dict, *, prev: str | None = None) -> dict:
        """A complete record: ``id`` is the recomputed cid, ``sig`` is this author's."""
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": now(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )


def manifest_cid() -> str:
    """A distinct, non-empty manifest cid (the schema only requires a string)."""
    return f"bafkreimanifest{uuid.uuid4().hex}"


def version_body(paper_cid: str, n: int = 1, **overrides) -> dict:
    """A schema-valid ``paper.version`` body for ``paper_cid``."""
    tag = uuid.uuid4().hex
    body = {
        "paper": paper_cid,
        "n": n,
        "title": f"A verifiable preprint {tag}",
        "abstract": "We show the version is stored as signed.",
        "authors": [],
        "manifest": manifest_cid(),
        "licence": "CC-BY-4.0",
        "changeNote": "First version.",
    }
    body.update(overrides)
    return {key: value for key, value in body.items() if value is not _OMIT}


#: Marks a body field to leave out of the record.
_OMIT = object()


def publish_paper(client, author: Author) -> str:
    """Post one accepted ``paper.genesis``; return the paper's cid."""
    names = [f"cs.T0.{uuid.uuid4().hex}"]
    endorse(author.did, *names)
    genesis = author.record(
        PAPER_GENESIS_TYPE,
        {
            "title": f"A paper that gains versions {uuid.uuid4().hex}",
            "categories": names,
            "licence": "CC-BY-4.0",
        },
    )
    response = client.post(URL, json=genesis, headers=author.headers)
    assert response.status_code == 201, response.text
    return genesis["id"]


def publish_version(client, author: Author, paper_cid: str, n: int = 1, **overrides) -> dict:
    """Post one accepted ``paper.version``; return the signed record."""
    body = version_body(paper_cid, n, **overrides)
    if "authors" not in overrides:
        body["authors"] = [author.did]
    latest = latest_version(paper_cid)
    prev = latest.version_cid if latest is not None else paper_cid
    record = author.record(PAPER_VERSION_TYPE, body, prev=prev)
    response = client.post(URL, json=record, headers=author.headers)
    assert response.status_code == 201, response.text
    return record


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def assert_not_in_ledger(client, cid: str) -> None:
    response = client.get(f"/v1/records/{cid}")
    assert response.status_code == 404, response.text


@pytest.fixture
def author() -> Author:
    return Author()


@pytest.fixture
def paper(client, author) -> str:
    """An accepted paper owned by ``author`` (who is therefore tier 2)."""
    return publish_paper(client, author)


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #


def test_registration_requires_tier_2():
    registration = ingest.get(PAPER_VERSION_TYPE)
    assert registration is not None
    assert registration.handler is handle_paper_version
    assert int(registration.min_tier) == VERSION_MIN_TIER == 2


# --------------------------------------------------------------------------- #
# The success path
# --------------------------------------------------------------------------- #


def test_a_first_version_reaches_the_ledger(client, author, paper):
    record = publish_version(client, author, paper)

    stored = client.get(f"/v1/records/{record['id']}")
    assert stored.status_code == 200, stored.text
    assert stored.json()["body"] == record["body"]


def test_the_response_reports_the_version_id_and_awaiting_consent(client, author, paper):
    body = version_body(paper)
    body["authors"] = [author.did]
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    answer = response.json()
    assert answer["id"] == record["id"]
    assert answer["state"] == AWAITING_CONSENT == "awaiting_consent"
    assert answer["shortId"] == format_version_id(derive_short_id(paper), 1)


def test_the_version_is_saved_with_its_metadata(client, author, paper):
    body = version_body(
        paper,
        title="A title kept exactly",
        abstract="An abstract kept exactly.",
        licence="CC-BY-SA-4.0",
        changeNote="Adds the missing proof.",
    )
    body["authors"] = [author.did]
    manifest = body["manifest"]
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=author.headers)
    assert response.status_code == 201, response.text

    version = get_version(record["id"])
    assert version is not None
    assert version.version_cid == record["id"]
    assert version.paper_cid == paper
    assert version.n == 1
    assert version.title == "A title kept exactly"
    assert version.abstract == "An abstract kept exactly."
    assert version.manifest_cid == manifest
    assert version.licence == "CC-BY-SA-4.0"
    assert version.change_note == "Adds the missing proof."
    assert version.prev_cid == paper
    assert version.state == AWAITING_CONSENT
    assert version.listed_at is None


def test_the_authors_are_saved_with_positions_and_credit_roles(client, author, paper):
    coauthor = did_key_from_signing_key(SigningKey.generate())
    body = version_body(
        paper,
        authors=[
            {
                "did": author.did,
                "creditRoles": ["Conceptualization", "Writing"],
                "position": 1,
            },
            {"did": coauthor, "creditRoles": ["Software"], "position": 2},
        ],
    )
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=author.headers)
    assert response.status_code == 201, response.text

    rows = authorship_for(record["id"])
    assert [(row.author_did, row.position) for row in rows] == [
        (author.did, 1),
        (coauthor, 2),
    ]
    assert [row.credit_roles for row in rows] == [
        ["Conceptualization", "Writing"],
        ["Software"],
    ]
    assert all(row.consent_cid is None and row.consent_decision is None for row in rows)


def test_a_plain_did_author_is_saved_without_credit_roles(client, author, paper):
    coauthor = did_key_from_signing_key(SigningKey.generate())
    body = version_body(paper, authors=[author.did, coauthor])
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    rows = authorship_for(record["id"])
    assert [row.author_did for row in rows] == [author.did, coauthor]
    assert [row.position for row in rows] == [1, 2]
    assert [row.credit_roles for row in rows] == [None, None]


def test_the_credit_alias_is_kept_as_credit_roles(client, author, paper):
    body = version_body(
        paper, authors=[{"did": author.did, "credit": ["Investigation"]}]
    )
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    assert authorship_for(record["id"])[0].credit_roles == ["Investigation"]


def test_authors_are_returned_in_byline_order(client, author, paper):
    first = author.did
    second = did_key_from_signing_key(SigningKey.generate())
    body = version_body(
        paper,
        authors=[
            {"did": second, "position": 2},
            {"did": first, "position": 1},
        ],
    )
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    assert [row.author_did for row in authorship_for(record["id"])] == [first, second]


def test_an_author_without_a_position_takes_its_list_position(client, author, paper):
    coauthor = did_key_from_signing_key(SigningKey.generate())
    body = version_body(paper, authors=[author.did, {"did": coauthor}])
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    assert [row.position for row in authorship_for(record["id"])] == [1, 2]


# --------------------------------------------------------------------------- #
# The version chain
# --------------------------------------------------------------------------- #


def test_expected_chain_starts_at_the_genesis(client, author, paper):
    assert expected_chain(paper) == (paper, 1)


def test_a_second_version_extends_the_first(client, author, paper):
    first = publish_version(client, author, paper)
    assert expected_chain(paper) == (first["id"], 2)

    second = publish_version(client, author, paper, n=2, changeNote="Second version.")

    assert get_version(second["id"]).prev_cid == first["id"]
    assert get_version(second["id"]).n == 2
    assert [version.n for version in versions_for_paper(paper)] == [1, 2]


def test_every_earlier_version_stays_resolvable(client, author, paper):
    first = publish_version(client, author, paper)
    second = publish_version(client, author, paper, n=2)
    third = publish_version(client, author, paper, n=3)

    assert get_version(first["id"]).n == 1
    assert get_version(second["id"]).n == 2
    assert get_version(third["id"]).n == 3
    assert [version.n for version in versions_for_paper(paper)] == [1, 2, 3]


def test_a_stale_prev_is_refused(client, author, paper):
    first = publish_version(client, author, paper)
    body = version_body(paper, n=2)
    body["authors"] = [author.did]
    stale = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=stale, headers=author.headers)

    error = assert_problem(response, 409)
    assert error["type"] == VERSION_OUT_OF_SEQUENCE
    assert error["expected_prev"] == first["id"]
    assert error["expected_n"] == 2
    assert error["submitted_prev"] == paper
    assert get_version(stale["id"]) is None
    assert_not_in_ledger(client, stale["id"])


def test_a_version_number_that_skips_ahead_is_refused(client, author, paper):
    first = publish_version(client, author, paper)
    body = version_body(paper, n=3)
    body["authors"] = [author.did]
    skipped = author.record(PAPER_VERSION_TYPE, body, prev=first["id"])

    response = client.post(URL, json=skipped, headers=author.headers)

    error = assert_problem(response, 409)
    assert error["type"] == VERSION_OUT_OF_SEQUENCE
    assert error["expected_n"] == 2
    assert error["submitted_n"] == 3
    assert get_version(skipped["id"]) is None


def test_a_first_version_must_be_number_one(client, author, paper):
    body = version_body(paper, n=2)
    body["authors"] = [author.did]
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=author.headers)

    error = assert_problem(response, 409)
    assert error["expected_n"] == 1
    assert error["expected_prev"] == paper
    assert get_version(record["id"]) is None


def test_a_prev_that_is_another_papers_version_is_refused(client, author, paper):
    other_author = Author()
    other_paper = publish_paper(client, other_author)
    other_first = publish_version(client, other_author, other_paper)

    body = version_body(paper, n=1)
    body["authors"] = [author.did]
    wrong_chain = author.record(PAPER_VERSION_TYPE, body, prev=other_first["id"])

    response = client.post(URL, json=wrong_chain, headers=author.headers)

    error = assert_problem(response, 409)
    assert error["expected_prev"] == paper
    assert get_version(wrong_chain["id"]) is None


# --------------------------------------------------------------------------- #
# The paper must exist
# --------------------------------------------------------------------------- #


def test_a_version_for_an_unknown_paper_is_refused(client, author):
    set_tier(author.did, 2)
    # A real, correctly signed genesis cid that was never accepted here.
    unknown = author.record(
        PAPER_GENESIS_TYPE,
        {
            "title": f"Never submitted {uuid.uuid4().hex}",
            "categories": [f"cs.T0.{uuid.uuid4().hex}"],
            "licence": "CC-BY-4.0",
        },
    )
    body = version_body(unknown["id"], n=1)
    body["authors"] = [author.did]
    record = author.record(PAPER_VERSION_TYPE, body, prev=unknown["id"])

    response = client.post(URL, json=record, headers=author.headers)

    error = assert_problem(response, 422)
    assert error["type"] == UNKNOWN_PAPER
    assert error["errors"][0]["loc"] == ["body", "paper"]
    assert get_version(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_a_paper_known_only_from_the_ledger_is_accepted(client, author):
    """A node that logs records without deriving rows can still accept versions."""
    set_tier(author.did, 2)
    genesis = author.record(
        PAPER_GENESIS_TYPE,
        {
            "title": f"Ledger-only paper {uuid.uuid4().hex}",
            "categories": [f"cs.T0.{uuid.uuid4().hex}"],
            "licence": "CC-BY-4.0",
        },
    )
    ledger.append(genesis)

    require_known_paper(genesis["id"])  # does not raise

    record = publish_version(client, author, genesis["id"])

    assert get_version(record["id"]).paper_cid == genesis["id"]


def test_require_known_paper_refuses_an_unknown_cid():
    unknown = Author().record(
        PAPER_GENESIS_TYPE,
        {"title": "x", "categories": ["cs.T0.x"], "licence": "CC-BY-4.0"},
    )

    with pytest.raises(UnknownPaper) as caught:
        require_known_paper(unknown["id"])
    assert caught.value.status_code == 422


def test_require_known_paper_does_not_accept_a_non_genesis_record(client, author, paper):
    """A version cid is not a paper, even though it is in the log."""
    version = publish_version(client, author, paper)

    with pytest.raises(UnknownPaper):
        require_known_paper(version["id"])


# --------------------------------------------------------------------------- #
# Authorization
# --------------------------------------------------------------------------- #


def test_an_author_with_no_account_is_refused(client, author, paper):
    newcomer = Author()
    body = version_body(paper, n=1)
    body["authors"] = [newcomer.did]
    record = newcomer.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=newcomer.headers)

    error = assert_problem(response, 403)
    assert error["required_tier"] == 2
    assert get_version(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_a_tier_1_author_is_refused(client, author, paper):
    member = Author()
    set_tier(member.did, 1)
    body = version_body(paper, n=1)
    body["authors"] = [member.did]
    record = member.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=member.headers)

    error = assert_problem(response, 403)
    assert error["required_tier"] == 2
    assert get_version(record["id"]) is None


def test_the_handler_enforces_the_tier_itself(author, paper):
    member = Author()
    set_tier(member.did, 1)
    body = version_body(paper, n=1)
    body["authors"] = [member.did]
    record = member.record(PAPER_VERSION_TYPE, body, prev=paper)

    with pytest.raises(ingest.InsufficientAuthorTier):
        handle_paper_version(record)

    assert get_version(record["id"]) is None


def test_a_tier_4_author_may_publish(client, author, paper):
    moderator = Author()
    set_tier(moderator.did, 4)
    body = version_body(paper, n=1)
    body["authors"] = [moderator.did]
    record = moderator.record(PAPER_VERSION_TYPE, body, prev=paper)

    response = client.post(URL, json=record, headers=moderator.headers)

    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------- #
# The handler and the tables
# --------------------------------------------------------------------------- #


def test_the_handler_returns_awaiting_consent(author, paper):
    body = version_body(paper, n=1)
    body["authors"] = [author.did]
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)

    assert handle_paper_version(record) == AWAITING_CONSENT
    assert get_version(record["id"]).state == AWAITING_CONSENT


def test_saving_the_same_version_twice_keeps_one_row(author, paper):
    body = version_body(paper, n=1)
    body["authors"] = [author.did]
    record = author.record(PAPER_VERSION_TYPE, body, prev=paper)
    assert handle_paper_version(record) == AWAITING_CONSENT

    assert handle_paper_version(record) == AWAITING_CONSENT

    with db.SessionLocal() as session:
        versions = session.query(PaperVersion).filter_by(paper_cid=paper).count()
        authors = session.query(Authorship).filter_by(version_cid=record["id"]).count()
    assert versions == 1
    assert authors == 1


def test_two_versions_cannot_share_a_number(author, paper):
    first = save_version(
        version_cid=f"cid-{uuid.uuid4().hex}",
        paper_cid=paper,
        n=1,
        title="First",
        abstract="",
        manifest_cid=manifest_cid(),
        licence="CC-BY-4.0",
        prev_cid=paper,
    )
    assert first.n == 1

    with pytest.raises(IntegrityError):
        save_version(
            version_cid=f"cid-{uuid.uuid4().hex}",
            paper_cid=paper,
            n=1,
            title="Also first",
            abstract="",
            manifest_cid=manifest_cid(),
            licence="CC-BY-4.0",
            prev_cid=paper,
        )


def test_versions_for_an_unknown_paper_are_empty():
    assert versions_for_paper("not-a-paper") == []
    assert latest_version("not-a-paper") is None


# --------------------------------------------------------------------------- #
# Body validation (direct callers)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "overrides, field",
    [
        ({"paper": ""}, "paper"),
        ({"paper": "not-a-cid"}, "paper"),
        ({"n": 0}, "n"),
        ({"n": True}, "n"),
        ({"n": "1"}, "n"),
        ({"title": ""}, "title"),
        ({"title": 5}, "title"),
        ({"abstract": 5}, "abstract"),
        ({"manifest": ""}, "manifest"),
        ({"licence": "   "}, "licence"),
        ({"licence": 5}, "licence"),
        ({"changeNote": 5}, "changeNote"),
        ({"authors": []}, "authors"),
        ({"authors": "did:key:z6Mk"}, "authors"),
    ],
)
def test_an_unusable_body_field_is_a_422(paper, overrides, field):
    body = version_body(paper, **overrides)

    with pytest.raises(InvalidRecord) as caught:
        version_fields(body)

    assert caught.value.status_code == 422
    assert caught.value.errors[0]["loc"][:2] == ["body", field]


def test_a_duplicate_author_is_a_422(paper):
    body = version_body(paper, authors=["did:key:z6MkA", "did:key:z6MkA"])

    with pytest.raises(InvalidRecord) as caught:
        version_fields(body)

    assert caught.value.status_code == 422
    assert caught.value.errors[0]["loc"] == ["body", "authors", 1]


@pytest.mark.parametrize(
    "authors",
    [
        [5],
        [{"did": "not-a-did"}],
        [{"creditRoles": ["Software"]}],
        [{"did": "did:key:z6MkA", "creditRoles": "Software"}],
        [{"did": "did:key:z6MkA", "creditRoles": [""]}],
        [{"did": "did:key:z6MkA", "position": 0}],
        [{"did": "did:key:z6MkA", "position": "1"}],
    ],
)
def test_an_unusable_author_entry_is_a_422(paper, authors):
    with pytest.raises(InvalidRecord) as caught:
        version_authors({"authors": authors})

    assert caught.value.status_code == 422
    assert caught.value.errors[0]["loc"][:2] == ["body", "authors"]


def test_a_licence_is_trimmed(paper):
    fields = version_fields(
        version_body(paper, licence="  CC0-1.0 ", authors=["did:key:z6MkA"])
    )

    assert fields.licence == "CC0-1.0"


def test_a_null_change_note_is_stored_as_none(paper):
    fields = version_fields(
        version_body(paper, changeNote=None, authors=["did:key:z6MkA"])
    )

    assert fields.change_note is None


def test_version_fields_keeps_what_the_record_states(paper):
    body = version_body(
        paper,
        n=4,
        title="T",
        abstract="",
        changeNote="C",
        authors=[
            {
                "did": "did:key:z6MkA",
                "creditRoles": ["Writing"],
                "position": 3,
            }
        ],
    )

    fields = version_fields(body)

    assert fields.paper_cid == paper
    assert fields.n == 4
    assert fields.title == "T"
    assert fields.abstract == ""
    assert fields.change_note == "C"
    assert list(fields.authors) == version_authors(body)


def test_an_emitted_out_of_sequence_error_names_both_problems():
    error = VersionOutOfSequence(
        "paper-cid",
        expected_prev="version-1",
        expected_n=2,
        submitted_prev="paper-cid",
        submitted_n=5,
    )

    assert error.status_code == 409
    assert error.type == VERSION_OUT_OF_SEQUENCE
    assert error.expected_prev == "version-1"
    assert error.expected_n == 2
    assert {entry["loc"][0] for entry in error.errors} == {"prev", "body"}
