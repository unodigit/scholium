"""Tests for ``GET /v1/papers/{id}/v/{n}/consents`` (feature 56).

The scene is a published paper with three listed authors.  Records are put in
the log directly -- the submission handlers belong to other plugins -- and the
consents are signed by the co-authors themselves, which is the only way a
``coauthor.consent`` can exist.  Every test uses fresh DIDs and a unique
paper, so the worker's shared database never causes a collision.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

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

from app.modules import ledger
from app.security import issue_access_token

URL = "/v1/records"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Author:
    """A fresh did:key that can sign any record type."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

    def sign(self, record_type: str, body: dict, *, prev: str | None = None) -> dict:
        record = sign_record(
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
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record


class Published:
    """A paper and its version 1, ready to be addressed by the public API."""

    def __init__(self, authors: list[Author]) -> None:
        self.authors = authors
        tag = uuid.uuid4().hex
        manuscript = f"%PDF-1.7 test manuscript {tag}".encode()
        first = authors[0]

        genesis = first.sign(
            "paper.genesis",
            {
                "seed": tag,
                "title": f"Test paper {tag}",
                "abstract": "A paper whose authors must consent.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [author.did for author in authors],
            },
        )
        manifest = first.sign(
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
        version = first.sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": f"Test paper {tag}",
                "abstract": "A paper whose authors must consent.",
                "authors": [
                    {
                        "did": author.did,
                        "position": index + 1,
                        "creditRoles": ["Conceptualization"],
                    }
                    for index, author in enumerate(authors)
                ],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        self.short_id = derive_short_id(genesis["id"])
        self.genesis_id = genesis["id"]
        self.version_id = version["id"]

    @property
    def n(self) -> int:
        return 1


def consent_record(author: Author, published: Published, decision: str) -> dict:
    return author.sign(
        "coauthor.consent",
        {"version": published.version_id, "role": "author", "decision": decision},
    )


def post_record(client, author: Author, record: dict):
    token = issue_access_token(author.did, 0)
    return client.post(
        URL, json=record, headers={"Authorization": f"Bearer {token}"}
    )


def get_consents(client, published: Published):
    return client.get(f"/v1/papers/{published.short_id}/v/{published.n}/consents")


def statuses_by_did(payload: dict) -> dict[str, str]:
    return {entry["did"]: entry["status"] for entry in payload["authors"]}


@pytest.fixture
def authors() -> list[Author]:
    return [Author(), Author(), Author()]


@pytest.fixture
def published(authors) -> Published:
    return Published(authors)


def test_every_author_starts_waiting(client, authors, published):
    response = get_consents(client, published)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert statuses_by_did(payload) == {author.did: "waiting" for author in authors}
    assert payload["count"] == 3
    assert payload["waiting"] == 3
    assert payload["signed"] == payload["declined"] == 0


def test_accept_reports_signed_and_decline_reports_declined(client, authors, published):
    accepted, declined, waiting = authors
    for author, decision in ((accepted, "accept"), (declined, "decline")):
        response = post_record(client, author, consent_record(author, published, decision))
        assert response.status_code == 201, response.text

    payload = get_consents(client, published).json()
    statuses = statuses_by_did(payload)

    assert statuses[accepted.did] == "signed"
    assert statuses[declined.did] == "declined"
    assert statuses[waiting.did] == "waiting"
    assert payload["signed"] == 1
    assert payload["declined"] == 1
    assert payload["waiting"] == 1

    by_did = {entry["did"]: entry for entry in payload["authors"]}
    assert by_did[accepted.did]["decision"] == "accept"
    assert by_did[accepted.did]["consentCid"]
    assert by_did[declined.did]["decision"] == "decline"
    assert by_did[waiting.did]["decision"] is None


def test_a_consent_appended_to_the_log_alone_is_still_reported(client, authors, published):
    """A sync replay can append a signed consent without running the handler."""
    accepted = authors[1]
    ledger.append(consent_record(accepted, published, "accept"))

    payload = get_consents(client, published).json()

    assert statuses_by_did(payload)[accepted.did] == "signed"
    assert payload["signed"] == 1


def test_a_version_indexed_in_the_database_is_read_from_it(client, authors, published):
    """The submissions handlers store paper/version/authorship rows; read those."""
    from app.modules.submissions import VersionAuthor, save_paper, save_version
    from app.modules import consents

    save_paper(paper_cid=published.genesis_id, categories=("cs.CR",))
    save_version(
        version_cid=published.version_id,
        paper_cid=published.genesis_id,
        n=1,
        title="Test paper",
        abstract="A paper whose authors must consent.",
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=published.genesis_id,
        authors=tuple(
            VersionAuthor(author.did, index + 1, ("Conceptualization",))
            for index, author in enumerate(authors)
        ),
    )
    accepted = authors[0]
    consents.save_consent(
        version_cid=published.version_id,
        author_did=accepted.did,
        consent_cid="bafyreiconsentplaceholder",
        decision="accept",
    )

    payload = get_consents(client, published).json()

    assert statuses_by_did(payload) == {
        accepted.did: "signed",
        authors[1].did: "waiting",
        authors[2].did: "waiting",
    }
    assert payload["state"] == "awaiting_consent"


def test_the_version_state_is_reported(client, published):
    payload = get_consents(client, published).json()

    # The version record was appended without the submissions handler, so the
    # authors are still awaiting consent; the state is reported either way.
    assert payload["state"] == "awaiting_consent"


def test_a_genesis_cid_can_address_the_paper(client, published):
    response = client.get(
        f"/v1/papers/{published.genesis_id}/v/{published.n}/consents"
    )

    assert response.status_code == 200, response.text
    assert response.json()["paper"] == published.short_id


def test_unknown_paper_version_answers_404(client, published):
    response = client.get(f"/v1/papers/{published.short_id}/v/9/consents")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_malformed_paper_id_answers_404(client):
    response = client.get("/v1/papers/not-a-paper-id/v/1/consents")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
