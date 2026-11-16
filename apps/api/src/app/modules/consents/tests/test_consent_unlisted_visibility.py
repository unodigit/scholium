"""Regression: co-author list of an unlisted version is not public."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record, verify_record

from app.modules import ledger
from app.security import issue_access_token

URL = "/v1/records"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Author:
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
        return record


class Published:
    def __init__(self, authors: list[Author]) -> None:
        self.authors = authors
        tag = uuid.uuid4().hex
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
        manifest = first.sign("manifest", {"files": []})
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
        self.n = 1


@pytest.fixture
def authors() -> list[Author]:
    return [Author(), Author()]


@pytest.fixture
def published(authors) -> Published:
    return Published(authors)


def _bearer(did: str, tier: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _url(published: Published) -> str:
    return f"/v1/papers/{published.short_id}/v/{published.n}/consents"


def test_anonymous_gets_404(client, published):
    response = client.get(_url(published))
    assert response.status_code == 404


def test_author_gets_200(client, authors, published):
    response = client.get(_url(published), headers=_bearer(authors[0].did, 0))
    assert response.status_code == 200


def test_tier4_moderator_gets_200(client, published):
    moderator = did_key_from_signing_key(SigningKey.generate())
    response = client.get(_url(published), headers=_bearer(moderator, 4))
    assert response.status_code == 200


def test_stranger_gets_404(client, published):
    stranger = did_key_from_signing_key(SigningKey.generate())
    response = client.get(_url(published), headers=_bearer(stranger, 2))
    assert response.status_code == 404


def test_unusable_token_is_anonymous(client, published):
    response = client.get(
        _url(published), headers={"Authorization": "Bearer not-a-token"}
    )
    assert response.status_code == 404
