"""Tests for claiming an imported paper (feature 125).

An author claims an ``external.mirror`` by signing a ``paper.version`` that
names the mirror's cid in ``mirror``.  When the signer's linked ORCID iD is one
the mirror names for an author, the paper's ``papers`` row is saved with
``claimed = true``; otherwise the version is an ordinary version and ``claimed``
is left alone.

The tests use the real paths end to end: a mirror is created by
``POST /v1/imports/arxiv``, the paper by a signed ``paper.genesis`` and the
claim by a signed ``paper.version``, both through ``POST /v1/records``; the
signer's ORCID is linked with ``issue_orcid_credential``.

A freshly accepted genesis already has ``claimed = true`` (the column's
default), so the tests that expect a claim first save ``claimed = false`` to the
paper's row -- the state of a paper imported on its authors' behalf -- which is
what makes the false -> true transition observable.

Isolation: every test builds its own author, paper, mirror and ORCID iD, because
the worker's database persists between tests and runs, and an ORCID iD can be
linked to one DID only.
"""

from __future__ import annotations

import logging
import os
import random
import subprocess
import sys
import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record
from sqlalchemy import update

from app import db
from app.modules import ledger
from app.modules.endorsements import save_endorsement
from app.modules.imports import claims
from app.modules.imports import service as import_service
from app.modules.ingest import PAPER_GENESIS_TYPE, PAPER_VERSION_TYPE
from app.modules.orcid import issue_orcid_credential
from app.modules.orcid.models import Credential
from app.modules.submissions import Paper, get_paper, get_version
from app.security import issue_access_token

from .conftest import unique_arxiv_id

RECORDS = "/v1/records"
IMPORTS = "/v1/imports/arxiv"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_orcid() -> str:
    """A well-formed ORCID iD (valid MOD 11-2 check digit) nobody has linked yet."""
    base = "".join(random.choice("0123456789") for _ in range(15))
    total = 0
    for digit in base:
        total = (total + int(digit)) * 2
    check = (12 - total % 11) % 11
    digits = base + ("X" if check == 10 else str(check))
    return "-".join(digits[i : i + 4] for i in range(0, 16, 4))


class Author:
    """A signed-in author who can sign any record type."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}

    def record(self, record_type: str, body: dict, *, prev: str | None = None) -> dict:
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

    def link_orcid(self, orcid: str | None = None) -> str:
        """Link an ORCID iD to this DID (as the callback does) and return it."""
        orcid = orcid or new_orcid()
        issue_orcid_credential(self.did, orcid)
        return orcid


def publish_paper(client, author: Author) -> str:
    """Post one accepted ``paper.genesis`` by ``author`` (endorsed, so tier 2)."""
    category = f"cs.T0.{uuid.uuid4().hex}"
    save_endorsement(
        record_cid=f"cid-{uuid.uuid4().hex}",
        endorser_did=did_key_from_signing_key(SigningKey.generate()),
        endorsee_did=author.did,
        category=category,
    )
    genesis = author.record(
        PAPER_GENESIS_TYPE,
        {
            "title": f"A paper that claims an import {uuid.uuid4().hex}",
            "categories": [category],
            "licence": "CC-BY-4.0",
        },
    )
    response = client.post(RECORDS, json=genesis, headers=author.headers)
    assert response.status_code == 201, response.text
    return genesis["id"]


def version_record(author: Author, paper: str, **body_overrides) -> dict:
    """A signed first ``paper.version`` of ``paper``; ``None`` overrides drop a member."""
    body = {
        "paper": paper,
        "n": 1,
        "title": f"A claiming version {uuid.uuid4().hex}",
        "abstract": "We claim an imported paper.",
        "authors": [author.did],
        "manifest": f"bafkreimanifest{uuid.uuid4().hex}",
        "licence": "CC-BY-4.0",
        "changeNote": "First version.",
    }
    body.update(body_overrides)
    body = {key: value for key, value in body.items() if value is not None}
    return author.record(PAPER_VERSION_TYPE, body, prev=paper)


def publish_version(client, author: Author, paper: str, **body_overrides) -> dict:
    """Post an accepted first version of ``paper``; return the signed record."""
    record = version_record(author, paper, **body_overrides)
    response = client.post(RECORDS, json=record, headers=author.headers)
    assert response.status_code == 201, response.text
    return record


def import_paper(client, moderator, monkeypatch, authors: list) -> str:
    """Import a unique arXiv paper whose metadata lists ``authors``; return the mirror's cid."""

    def metadata(ident):
        return {
            "title": f"Imported {ident.base}",
            "abstract": "An imported abstract.",
            "authors": authors,
            "categories": ["cs.LG"],
            "arxivId": ident.base,
        }

    monkeypatch.setattr(import_service, "fetch_metadata", metadata)
    response = client.post(IMPORTS, json={"arxiv_id": unique_arxiv_id()}, headers=moderator)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def set_claimed(paper: str, value: bool) -> None:
    with db.SessionLocal() as session:
        session.execute(update(Paper).where(Paper.paper_cid == paper).values(claimed=value))
        session.commit()


def is_claimed(paper: str) -> bool:
    row = get_paper(paper)
    assert row is not None
    return bool(row.claimed)


@pytest.fixture(autouse=True)
def subscribed():
    """Make sure the claim subscriber is registered (another test file clears them all)."""
    ledger.subscribe(PAPER_VERSION_TYPE, claims.on_paper_version)


@pytest.fixture
def author() -> Author:
    return Author()


@pytest.fixture
def unclaimed_paper(client, author) -> str:
    """A paper by ``author`` whose row says it is not claimed yet."""
    paper = publish_paper(client, author)
    set_claimed(paper, False)
    assert is_claimed(paper) is False
    return paper


# --------------------------------------------------------------------------- #
# The claim
# --------------------------------------------------------------------------- #


def test_a_version_naming_the_mirror_claims_the_paper_when_the_orcid_matches(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}, "Grace"])

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is True


def test_the_claim_is_saved_through_the_ledger_subscriber(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])
    record = publish_version(client, author, unclaimed_paper, mirror=mirror)

    # Re-running the claim on the stored entry changes nothing and still reports it.
    set_claimed(unclaimed_paper, False)
    entry = ledger.entry_by_cid(record["id"])
    claim = claims.claim_imported_paper(entry)

    assert claim == claims.Claim(
        paper_cid=unclaimed_paper,
        version_cid=record["id"],
        mirror_cid=mirror,
        signer=author.did,
        orcid=orcid,
    )
    assert is_claimed(unclaimed_paper) is True
    assert claims.claim_imported_paper(entry) == claim  # idempotent


def test_the_claimed_version_is_stored_like_any_other(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])

    record = publish_version(client, author, unclaimed_paper, mirror=mirror)

    version = get_version(record["id"])
    assert version is not None and version.state == "awaiting_consent"
    stored = client.get(f"/v1/records/{record['id']}")
    assert stored.status_code == 200
    assert stored.json()["body"]["mirror"] == mirror


@pytest.mark.parametrize(
    "spelling",
    [
        lambda orcid: orcid,
        lambda orcid: f"https://orcid.org/{orcid}",
        lambda orcid: f" {orcid.lower()} ",
    ],
    ids=["bare", "url", "lowercase-padded"],
)
def test_every_spelling_of_the_mirrors_orcid_matches(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper, spelling
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": spelling(orcid)}])

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is True


def test_any_listed_author_orcid_can_claim(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    other = new_orcid()
    mirror = import_paper(
        client,
        moderator,
        monkeypatch,
        ["No Orcid", {"name": "Other", "orcid": other}, {"name": "Ada", "orcid": orcid}],
    )

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is True


def test_a_claim_on_an_already_claimed_paper_leaves_it_claimed(
    client, node_key, moderator, monkeypatch, author
):
    paper = publish_paper(client, author)  # the genesis default is claimed
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])

    publish_version(client, author, paper, mirror=mirror)

    assert is_claimed(paper) is True


# --------------------------------------------------------------------------- #
# No claim: the version is still accepted and claimed is left alone
# --------------------------------------------------------------------------- #


def test_a_different_orcid_does_not_claim(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": new_orcid()}])

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is False


def test_a_signer_with_no_linked_orcid_does_not_claim(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": new_orcid()}])

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is False


def test_the_orcid_a_version_states_for_itself_is_not_trusted(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    mirrors_orcid = new_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": mirrors_orcid}])

    # The signer claims the mirror's iD in their own author entry but has not linked it.
    publish_version(
        client,
        author,
        unclaimed_paper,
        mirror=mirror,
        authors=[{"did": author.did, "orcid": mirrors_orcid}],
    )

    assert is_claimed(unclaimed_paper) is False


def test_a_revoked_orcid_credential_does_not_claim(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    with db.SessionLocal() as session:
        session.execute(update(Credential).where(Credential.did == author.did).values(status="revoked"))
        session.commit()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is False


def test_a_mirror_that_names_authors_only_by_name_cannot_be_claimed(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    # arXiv lists authors by name, so a name can never claim: it would be spoofable.
    author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, ["Ada Mock", "Grace Mock"])

    publish_version(client, author, unclaimed_paper, mirror=mirror)

    assert is_claimed(unclaimed_paper) is False


def test_a_mock_arxiv_import_cannot_be_claimed(client, node_key, moderator, author, unclaimed_paper):
    author.link_orcid()
    response = client.post(IMPORTS, json={"arxiv_id": unique_arxiv_id()}, headers=moderator)
    assert response.status_code == 201, response.text

    publish_version(client, author, unclaimed_paper, mirror=response.json()["id"])

    assert is_claimed(unclaimed_paper) is False


def test_a_version_that_names_no_mirror_claims_nothing(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])

    publish_version(client, author, unclaimed_paper)

    assert is_claimed(unclaimed_paper) is False


@pytest.mark.parametrize("reference", ["bafyreinotarecord", "", 7, ["x"]], ids=["unknown", "empty", "int", "list"])
def test_a_reference_to_no_mirror_claims_nothing(
    client, node_key, author, unclaimed_paper, reference
):
    author.link_orcid()

    publish_version(client, author, unclaimed_paper, mirror=reference)

    assert is_claimed(unclaimed_paper) is False


def test_a_reference_to_a_record_that_is_not_a_mirror_claims_nothing(
    client, node_key, author, unclaimed_paper
):
    author.link_orcid()

    # The paper's own genesis is a record in the ledger, but not an external.mirror.
    publish_version(client, author, unclaimed_paper, mirror=unclaimed_paper)

    assert is_claimed(unclaimed_paper) is False


def test_a_record_this_node_did_not_accept_as_a_version_claims_nothing(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])

    # Appended straight to the ledger: the paper.version handler never saw it,
    # so there is no paper_versions row for it.
    record = version_record(author, unclaimed_paper, mirror=mirror)
    ledger.append(record)

    assert get_version(record["id"]) is None
    assert is_claimed(unclaimed_paper) is False


def test_a_claim_for_a_paper_without_a_row_saves_nothing(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])
    record = publish_version(client, author, unclaimed_paper, mirror=mirror)
    set_claimed(unclaimed_paper, False)

    assert claims.mark_claimed("bafyreinosuchpaper") is False
    assert claims.mark_claimed(unclaimed_paper) is True
    assert is_claimed(unclaimed_paper) is True
    assert ledger.entry_by_cid(record["id"]) is not None


def test_a_failing_claim_does_not_fail_the_submission(
    client, node_key, moderator, monkeypatch, author, unclaimed_paper, caplog
):
    orcid = author.link_orcid()
    mirror = import_paper(client, moderator, monkeypatch, [{"name": "Ada", "orcid": orcid}])

    def boom(paper_cid):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(claims, "mark_claimed", boom)
    with caplog.at_level(logging.ERROR):
        record = publish_version(client, author, unclaimed_paper, mirror=mirror)

    # The version is stored and in the ledger; the claim was lost and logged.
    assert get_version(record["id"]) is not None
    assert ledger.entry_by_cid(record["id"]) is not None
    assert is_claimed(unclaimed_paper) is False
    assert "database unavailable" in caplog.text


# --------------------------------------------------------------------------- #
# Pieces
# --------------------------------------------------------------------------- #


def test_the_subscriber_is_registered_when_the_package_is_imported(tmp_path):
    # A fresh interpreter, so the check does not depend on (or disturb) the
    # subscriptions this process has already made.
    program = (
        "import app.modules.imports\n"
        "import app.modules.imports.claims\n"  # a second import must not subscribe twice
        "from app.modules import ledger\n"
        "print(ledger.subscriber_count('paper.version'))\n"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", program],
        cwd=tmp_path,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{tmp_path / 'fresh.db'}"},
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "1"


@pytest.mark.parametrize(
    "body, expected",
    [
        ({"mirror": "bafyreiabc"}, "bafyreiabc"),
        ({"mirror": ""}, None),
        ({"mirror": None}, None),
        ({"mirror": 5}, None),
        ({"paper": "x"}, None),
        (None, None),
        ("bafyreiabc", None),
        ([], None),
    ],
)
def test_mirror_reference(body, expected):
    assert claims.mirror_reference(body) == expected


@pytest.mark.parametrize(
    "mirror_body, expected",
    [
        ({"metadata": {"authors": ["A", "B"]}}, set()),
        ({"metadata": {"authors": [{"name": "A"}]}}, set()),
        ({"metadata": {"authors": [{"orcid": "0000-0002-1825-0097"}]}}, {"0000-0002-1825-0097"}),
        ({"metadata": {"authors": [{"orcid": "https://orcid.org/0000-0002-1825-009x"}]}}, {"0000-0002-1825-009X"}),
        ({"metadata": {"authors": [{"orcid": "not an orcid"}, {"orcid": 5}, {"orcid": None}]}}, set()),
        (
            {"metadata": {"authors": [{"orcid": "0000-0002-1825-0097"}, {"orcid": "0000-0001-5109-3700"}]}},
            {"0000-0002-1825-0097", "0000-0001-5109-3700"},
        ),
        ({"metadata": {"authors": "0000-0002-1825-0097"}}, set()),
        ({"metadata": {"orcid": "0000-0002-1825-0097"}}, set()),
        ({"metadata": None}, set()),
        ({}, set()),
        (None, set()),
    ],
)
def test_mirror_author_orcids(mirror_body, expected):
    assert claims.mirror_author_orcids(mirror_body) == frozenset(expected)


def test_linked_orcid_reads_the_current_credential(client, node_key, author):
    assert claims.linked_orcid(author.did) is None
    orcid = author.link_orcid()
    assert claims.linked_orcid(author.did) == orcid
