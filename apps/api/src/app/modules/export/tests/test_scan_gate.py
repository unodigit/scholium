"""The paper export applies the same scan gate as ``GET /v1/content`` (bug).

``GET /v1/content/{cid}`` hands out a file's bytes only once its blob's
``scan_status`` is ``passed``: ``423`` while it is still scanning, ``410`` once
it failed.  The per-paper CAR export read the same bytes straight from the
store, so an author -- or anyone, for a listed paper -- received the bytes of a
file nobody had cleared.  An export must carry no bytes for a file that is not
clean; its records and log entries still travel so the history stays verifiable.
"""

from __future__ import annotations

import pytest

from app.modules import content, submissions
from app.security import issue_access_token

from .test_paper_car import EXPORT, build_paper, parsed


def _bearer(did: str, tier: int = 2) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


NOT_CLEAN = (content.SCAN_SCANNING, content.SCAN_FAILED)


@pytest.mark.parametrize("status", NOT_CLEAN)
def test_a_listed_papers_export_carries_no_bytes_of_a_file_that_is_not_clean(client, status):
    paper = build_paper()
    content.set_scan_status(paper.file_cid, status)

    response = client.get(EXPORT.format(paper.short_id))

    assert response.status_code == 200
    archive = parsed(response)
    assert archive.files == {}
    assert paper.file_data not in response.content
    # The records still travel, so ``scholium verify`` can check the history.
    assert paper.manifest["id"] in archive.records
    assert paper.version["id"] in archive.records


@pytest.mark.parametrize("status", NOT_CLEAN)
def test_an_authors_export_of_an_unlisted_paper_carries_no_unscanned_bytes(client, status):
    paper = build_paper(state=submissions.AWAITING_CONSENT)
    content.set_scan_status(paper.file_cid, status)

    response = client.get(EXPORT.format(paper.short_id), headers=_bearer(paper.did))

    archive = parsed(response)
    assert archive.files == {}
    assert paper.file_data not in response.content


def test_the_export_and_the_content_route_agree_on_an_unscanned_file(client):
    paper = build_paper(state=submissions.AWAITING_CONSENT)
    content.set_scan_status(paper.file_cid, content.SCAN_SCANNING)
    author = _bearer(paper.did)

    assert client.get(f"/v1/content/{paper.file_cid}", headers=author).status_code == 423
    assert parsed(client.get(EXPORT.format(paper.short_id), headers=author)).files == {}


def test_an_authors_export_carries_the_bytes_once_the_file_is_clean(client):
    paper = build_paper(state=submissions.AWAITING_CONSENT)
    author = _bearer(paper.did)
    assert content.get_blob(paper.file_cid).scan_status == content.SCAN_PASSED

    archive = parsed(client.get(EXPORT.format(paper.short_id), headers=author))

    assert archive.files == {paper.file_cid: paper.file_data}
