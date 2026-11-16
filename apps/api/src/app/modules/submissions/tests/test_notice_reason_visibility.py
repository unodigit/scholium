"""A ``reasonCid`` must be a file ``GET /v1/content`` would serve to the signer.

The reason text is copied into the ``notices`` row, which ``GET /v1/papers/{id}``
serves publicly.  So a ``reasonCid`` may name only a file the signer could
download themselves: the same three gates the router applies -- stored, not
tombstoned, visible to the caller, and passed its scan -- rather than a looser
rule of their own.

Two bypasses are pinned here:

* a file named only by a *standalone* manifest (no ``paper.version`` references
  that manifest) is ``404`` on ``/v1/content``, so it must be
  ``422 reason_not_readable`` here, not published;
* a blob the sanitizer has not passed (``scanning``/``failed``) is ``423``/``451``
  on ``/v1/content``, so it must be refused here too.
"""

from __future__ import annotations

import uuid

import pytest

from app.modules import content
from app.modules.submissions import CORRECTION_TYPE, get_notice

from .test_notices import (  # noqa: F401 - fixture re-exports
    URL,
    Account_,
    assert_problem,
    author,
    paper,
)

TEXT = "The analysis code had an off-by-one error."


def _reason_text() -> str:
    """Text unique to one test: the worker's database and index are shared."""
    return f"{TEXT} ({uuid.uuid4().hex})"


def _stored_file(text: str | None = None, *, scan: str | None = content.SCAN_PASSED) -> tuple[str, str]:
    """Store a unique reason file in ``scan``; return its cid and text."""
    text = text or _reason_text()
    blob = content.store_bytes(text.encode())
    if scan is not None:
        content.set_scan_status(blob.cid, scan)
    return blob.cid, text


def _standalone_manifest(uploader: Account_, cid: str, size: int) -> dict:
    """A ``manifest`` record no version will point at."""
    return uploader.record(
        "manifest",
        {
            "files": [
                {
                    "path": "attachment.txt",
                    "cid": cid,
                    "size": size,
                    "mediaType": "text/plain",
                    "role": "supplement",
                }
            ]
        },
    )


def _reason_record(author_: Account_, target: str, cid: str) -> dict:
    return author_.record(
        CORRECTION_TYPE,
        {"target": target, "reasonCid": cid},
    )


def test_a_file_named_only_by_a_standalone_manifest_is_not_published(client, author, paper):
    uploader = Account_()
    cid, text = _stored_file()
    manifest = _standalone_manifest(uploader, cid, len(text.encode()))
    posted = client.post(URL, json=manifest, headers=uploader.headers)
    assert posted.status_code == 201, posted.text

    # The signer gets the unknown-cid 404 from the route the text would leak out of.
    served = client.get(f"/v1/content/{cid}", headers=author.headers)
    assert served.status_code == 404, served.text

    record = _reason_record(author, paper, cid)
    error = assert_problem(client.post(URL, json=record, headers=author.headers), 422)

    assert error["errors"][0]["loc"] == ["body", "reasonCid"]
    assert error["errors"][0]["type"] == "reason_not_readable"
    assert get_notice(record["id"]) is None


@pytest.mark.parametrize(
    ("scan", "served_status"),
    [(content.SCAN_SCANNING, 423), (content.SCAN_FAILED, 451)],
)
def test_a_file_the_signer_could_not_download_is_not_published(client, author, paper, scan, served_status):
    cid, _text = _stored_file(scan=scan)

    served = client.get(f"/v1/content/{cid}", headers=author.headers)
    assert served.status_code == served_status, served.text

    record = _reason_record(author, paper, cid)
    error = assert_problem(client.post(URL, json=record, headers=author.headers), 422)

    assert error["errors"][0]["loc"] == ["body", "reasonCid"]
    assert error["errors"][0]["type"] == "reason_not_readable"
    assert get_notice(record["id"]) is None


def test_a_scanned_file_the_signer_may_read_is_still_published(client, author, paper):
    """The control: the ordinary case is unchanged."""
    cid, text = _stored_file()
    assert client.get(f"/v1/content/{cid}", headers=author.headers).status_code == 200

    record = _reason_record(author, paper, cid)
    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    assert get_notice(record["id"]).reason == text


def test_a_moderator_may_publish_a_scanned_file_no_version_references(client, author, paper):
    """Tier 4 passes the visibility gate, so a stored, scanned file is usable."""
    moderator = Account_(tier=4)
    cid, text = _stored_file()

    record = _reason_record(moderator, paper, cid)
    assert client.post(URL, json=record, headers=moderator.headers).status_code == 201

    assert get_notice(record["id"]).reason == text
