"""Every export path applies the content visibility rule (bug: export leaked PDFs).

``GET /v1/content/{cid}`` refuses the bytes of a paper whose versions are all
unlisted (:mod:`app.modules.content.visibility`).  An export is serving those
same bytes, so it must apply the same rule: a file block is written only when
the caller may read the file -- the paper is listed, or the caller is one of
the version's authors, or a moderator (tier 4).  Records and log entries are
still exported, so a reader can verify the paper offline; only the bytes of a
paper under moderation are withheld.

The rule itself must not be copied into the exporters: these tests only assert
the observable effect on each public route.
"""

from __future__ import annotations

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

from app.modules import submissions
from app.security import issue_access_token

from .test_archive_car import ARCHIVE, read_archive
from .test_paper_car import EXPORT, build_paper, parsed

USER_EXPORT = "/v1/export/user/{}.car"
RECORDS_EXPORTS = ("/v1/papers/{}/records", "/v1/export/paper/{}/records")
OAI = "/v1/oai"

#: The states a version is in before it becomes public.
UNLISTED_STATES = (
    submissions.AWAITING_CONSENT,
    submissions.SCANNING,
    submissions.MODERATION,
    submissions.HELD,
    submissions.REJECTED,
    submissions.DRAFT,
)


def _bearer(did: str, tier: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


@pytest.fixture
def node_key(monkeypatch, tmp_path):
    """Provision a node Ed25519 key so ``/v1/export/archive.car`` can sign a head."""
    key_path = tmp_path / "node.key"
    key_path.write_text(bytes(range(32)).hex())
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))
    return SigningKey(bytes(range(32)))


def _unlisted(state: str = submissions.MODERATION):
    return build_paper(state=state)


# --------------------------------------------------------------------------- #
# GET /v1/export/paper/{id}.car
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("state", UNLISTED_STATES)
def test_anonymous_paper_export_of_an_unlisted_paper_carries_no_file_bytes(client, state):
    paper = _unlisted(state)

    response = client.get(EXPORT.format(paper.short_id))
    archive = parsed(response)

    assert b"%PDF" not in response.content
    assert paper.file_cid not in archive.files
    assert archive.files == {}
    # The records still travel, so ``scholium verify`` can check the history.
    assert paper.genesis["id"] in archive.records
    assert paper.manifest["id"] in archive.records
    assert paper.version["id"] in archive.records


def test_being_an_author_or_a_moderator_may_export_unlisted_file_bytes(client):
    paper = _unlisted(submissions.MODERATION)

    for did, tier in ((paper.did, 2), (did_key_from_signing_key(SigningKey.generate()), 4)):
        response = client.get(EXPORT.format(paper.short_id), headers=_bearer(did, tier))
        archive = parsed(response)

        assert archive.files == {paper.file_cid: paper.file_data}, (did, tier)
        assert paper.file_data in response.content


def test_a_stranger_gets_the_records_but_not_the_file_bytes(client):
    paper = _unlisted(submissions.MODERATION)
    stranger = did_key_from_signing_key(SigningKey.generate())

    archive = parsed(
        client.get(EXPORT.format(paper.short_id), headers=_bearer(stranger, 2))
    )

    assert paper.version["id"] in archive.records
    assert paper.file_cid not in archive.files


def test_an_unusable_token_is_read_as_anonymous(client):
    paper = _unlisted(submissions.MODERATION)

    response = client.get(
        EXPORT.format(paper.short_id), headers={"Authorization": "Bearer not-a-token"}
    )

    assert response.status_code == 200
    assert parsed(response).files == {}


def test_a_listed_papers_anonymous_export_still_carries_its_file(client):
    paper = _unlisted(submissions.LISTED)

    response = client.get(EXPORT.format(paper.short_id))
    archive = parsed(response)

    assert archive.files == {paper.file_cid: paper.file_data}
    assert paper.file_data in response.content


# --------------------------------------------------------------------------- #
# GET /v1/export/archive.car
# --------------------------------------------------------------------------- #


def test_anonymous_archive_export_carries_no_unlisted_file_bytes(client, node_key):
    paper = _unlisted(submissions.HELD)

    response = client.get(ARCHIVE)
    assert response.status_code == 200
    exported = read_archive(response.content)

    assert paper.file_data not in response.content
    assert paper.file_cid not in exported.files
    assert paper.version["id"] in exported.records


def test_the_archive_exports_an_authors_own_unlisted_file_bytes(client, node_key):
    paper = _unlisted(submissions.MODERATION)

    response = client.get(ARCHIVE, headers=_bearer(paper.did, 2))
    exported = read_archive(response.content)

    assert exported.files[paper.file_cid] == paper.file_data


def test_the_archive_carries_a_listed_papers_file(client, node_key):
    paper = _unlisted(submissions.LISTED)

    exported = read_archive(client.get(ARCHIVE).content)

    assert exported.files[paper.file_cid] == paper.file_data


# --------------------------------------------------------------------------- #
# GET /v1/export/user/{did}.car
# --------------------------------------------------------------------------- #


def test_anonymous_user_export_carries_no_unlisted_file_bytes(client):
    paper = _unlisted(submissions.MODERATION)

    response = client.get(USER_EXPORT.format(paper.did))
    assert response.status_code == 200
    archive = parsed(response)

    assert paper.file_data not in response.content
    assert paper.file_cid not in archive.files
    assert paper.version["id"] in archive.records


def test_a_user_export_for_the_author_carries_their_own_unlisted_file_bytes(client):
    paper = _unlisted(submissions.MODERATION)

    archive = parsed(
        client.get(USER_EXPORT.format(paper.did), headers=_bearer(paper.did, 2))
    )

    assert archive.files == {paper.file_cid: paper.file_data}


# --------------------------------------------------------------------------- #
# Per-paper records export
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("path", RECORDS_EXPORTS)
def test_the_records_export_of_an_unlisted_paper_carries_no_file_bytes(client, path):
    paper = _unlisted(submissions.MODERATION)

    response = client.get(path.format(paper.short_id))

    assert response.status_code == 200
    assert paper.file_data not in response.content
    # The records still travel: the manifest names the cid, and the version
    # and its log entry are what verification checks.
    assert paper.version["id"].encode() in response.content
    assert paper.manifest["id"].encode() in response.content


# --------------------------------------------------------------------------- #
# OAI-PMH
# --------------------------------------------------------------------------- #


def test_oai_never_disseminates_an_unlisted_paper_or_its_file(client):
    paper = _unlisted(submissions.MODERATION)

    response = client.get(
        OAI,
        params={"verb": "GetRecord", "identifier": f"oai:scholium:{paper.short_id}"},
    )

    assert response.status_code == 200
    assert b"idDoesNotExist" in response.content
    assert paper.file_cid.encode() not in response.content


def test_oai_list_records_never_names_an_unlisted_file(client):
    paper = _unlisted(submissions.MODERATION)

    response = client.get(OAI, params={"verb": "ListRecords"})

    assert response.status_code == 200
    assert paper.short_id.encode() not in response.content
    assert paper.file_cid.encode() not in response.content
