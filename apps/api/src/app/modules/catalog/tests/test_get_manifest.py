"""Tests for ``GET /v1/papers/{id}/v/{n}/manifest`` (plugin: catalog, feature 81).

A paper is put in place the way ``test_get_paper`` does it -- the submissions
plugin's own ``save_paper`` / ``save_version`` / ``transition_version`` -- plus
what this route reads on top of that: a signed ``manifest`` record in the event
log and the files' ``blobs`` rows in the content store.  Reading then goes
through the public route with an anonymous client.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app.modules import content, ledger
from app.modules.submissions import (
    AWAITING_CONSENT,
    save_paper,
    save_version,
    transition_version,
)

_TO_LISTED = ("scanning", "moderation", "listed")

#: ``(path, media type, role)`` of the files a scene version carries by default.
_DEFAULT_FILES = (
    ("main.pdf", "application/pdf", "manuscript"),
    ("figures/fig1.svg", "image/svg+xml", "figure"),
    ("data/results.csv", "text/csv", "dataset"),
)


class Paper:
    """One paper whose versions this test adds and lists."""

    def __init__(self, *, licence: str = "CC-BY-4.0") -> None:
        self.tag = uuid.uuid4().hex
        self.licence = licence
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Manifest paper {self.tag}",
                "abstract": "A paper whose files readers list.",
                "categories": ["cs.CR"],
                "licence": licence,
                "authors": [self.did],
            },
        )
        ledger.append(self.genesis)
        save_paper(
            paper_cid=self.genesis["id"], categories=("cs.CR",), licence=licence
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list["Version"] = []

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.key,
        )

    def add_version(
        self,
        *,
        files=_DEFAULT_FILES,
        licence: Optional[str] = None,
        state: str = AWAITING_CONSENT,
        store_manifest: bool = True,
    ) -> "Version":
        """Store the next version, with its files in the content store."""
        n = len(self.versions) + 1
        licence = licence or self.licence
        prev = self.versions[-1].cid if self.versions else self.genesis["id"]

        entries = []
        for path, media_type, role in files:
            data = f"{self.tag} v{n} {path}".encode()
            blob = content.store_bytes(data, media_type=media_type)
            entries.append(
                {
                    "path": path,
                    "cid": blob.cid,
                    "size": len(data),
                    "mediaType": media_type,
                    "role": role,
                }
            )
        manifest = self._sign("manifest", {"files": entries})
        if store_manifest:
            ledger.append(manifest)

        title = f"Manifest paper {self.tag} -- version {n}"
        record = self._sign(
            "paper.version",
            {
                "paper": self.genesis["id"],
                "n": n,
                "title": title,
                "abstract": f"What version {n} holds.",
                "authors": [self.did],
                "manifest": manifest["id"],
                "licence": licence,
            },
            prev=prev,
        )
        ledger.append(record)
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=f"What version {n} holds.",
            manifest_cid=manifest["id"],
            licence=licence,
            prev_cid=prev,
        )
        version = Version(n, record["id"], manifest["id"], entries)
        self.versions.append(version)
        if state != AWAITING_CONSENT:
            transition_version(version.cid, state)
        return version

    def listed_version(self, **kwargs) -> "Version":
        version = self.add_version(**kwargs)
        for state in _TO_LISTED:
            transition_version(version.cid, state)
        return version


class Version:
    def __init__(self, n: int, cid: str, manifest_cid: str, entries: list[dict]) -> None:
        self.n = n
        self.cid = cid
        self.manifest_cid = manifest_cid
        self.entries = entries


def manifest_url(identifier: str, n) -> str:
    return f"/v1/papers/{identifier}/v/{n}/manifest"


def test_listed_version_returns_each_file_with_its_signed_fields(client):
    paper = Paper()
    version = paper.listed_version()
    for entry in version.entries:
        content.set_scan_status(entry["cid"], content.SCAN_PASSED)

    response = client.get(manifest_url(paper.short_id, 1))

    assert response.status_code == 200
    body = response.json()
    assert body["paper"] == body["shortId"] == paper.short_id
    assert body["n"] == body["version"] == 1
    assert body["versionCid"] == version.cid
    assert body["manifestCid"] == version.manifest_cid
    assert body["licence"] == "CC-BY-4.0"
    # Manifest order, every signed field, the version's licence, the live scan.
    assert body["files"] == [
        {**entry, "licence": "CC-BY-4.0", "scanStatus": "passed", "scan_status": "passed"}
        for entry in version.entries
    ]


def test_scan_status_is_read_live_per_file(client):
    paper = Paper()
    version = paper.listed_version()
    # Listing runs the sanitizer over the version's blobs, so pin each verdict
    # here instead of relying on whatever the scan left behind.
    scanning, passed, failed = (entry["cid"] for entry in version.entries)
    content.set_scan_status(scanning, content.SCAN_SCANNING)
    content.set_scan_status(passed, content.SCAN_PASSED)
    content.set_scan_status(failed, content.SCAN_FAILED)

    files = client.get(manifest_url(paper.short_id, 1)).json()["files"]
    assert [f["scanStatus"] for f in files] == ["scanning", "passed", "failed"]
    assert [f["scan_status"] for f in files] == ["scanning", "passed", "failed"]
    assert files[0]["cid"] == scanning

    content.set_scan_status(scanning, content.SCAN_PASSED)
    files = client.get(manifest_url(paper.short_id, 1)).json()["files"]
    assert files[0]["scanStatus"] == "passed"


def test_n_selects_the_version_and_its_licence(client):
    paper = Paper()
    v1 = paper.listed_version()
    v2 = paper.listed_version(
        files=(("main.pdf", "application/pdf", "manuscript"),), licence="CC0-1.0"
    )

    first = client.get(manifest_url(paper.short_id, 1)).json()
    second = client.get(manifest_url(paper.short_id, 2)).json()

    assert first["versionCid"] == v1.cid and first["licence"] == "CC-BY-4.0"
    assert len(first["files"]) == 3
    assert second["versionCid"] == v2.cid and second["licence"] == "CC0-1.0"
    assert [f["licence"] for f in second["files"]] == ["CC0-1.0"]
    assert [f["cid"] for f in second["files"]] == [v2.entries[0]["cid"]]


def test_the_genesis_cid_names_the_paper_too(client):
    paper = Paper()
    paper.listed_version()

    by_short_id = client.get(manifest_url(paper.short_id, 1))
    by_genesis = client.get(manifest_url(paper.genesis["id"], 1))

    assert by_genesis.status_code == 200
    assert by_genesis.json() == by_short_id.json()


def test_a_file_without_a_blob_row_reads_missing(client):
    from app import db
    from app.modules.content import Blob

    paper = Paper()
    version = paper.listed_version()
    removed = version.entries[0]["cid"]
    content.set_scan_status(version.entries[1]["cid"], content.SCAN_SCANNING)
    with db.SessionLocal() as session:
        session.delete(session.get(Blob, removed))
        session.commit()

    files = client.get(manifest_url(paper.short_id, 1)).json()["files"]

    assert files[0]["cid"] == removed
    assert files[0]["scanStatus"] == "missing"
    assert files[1]["scanStatus"] == "scanning"


def test_the_route_is_public_and_not_cookie_setting(client):
    paper = Paper()
    paper.listed_version()

    response = client.get(manifest_url(paper.short_id, 1))

    assert response.status_code == 200
    assert "authorization" not in response.request.headers
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("state", [AWAITING_CONSENT, "scanning", "moderation", "held", "rejected"])
def test_an_unlisted_version_is_a_404(client, state):
    paper = Paper()
    if state in ("held", "rejected"):
        version = paper.add_version()
        for step in ("scanning", "moderation", state):
            transition_version(version.cid, step)
    else:
        paper.add_version(state=state)

    response = client.get(manifest_url(paper.short_id, 1))

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_an_unlisted_version_looks_like_a_missing_one(client):
    paper = Paper()
    paper.add_version()  # awaiting consent
    unlisted = client.get(manifest_url(paper.short_id, 1))
    missing = client.get(manifest_url(paper.short_id, 9))

    assert unlisted.status_code == missing.status_code == 404
    assert unlisted.json()["detail"].replace("/v/1", "") == missing.json()["detail"].replace("/v/9", "")


def test_an_unlisted_later_version_does_not_hide_a_listed_earlier_one(client):
    paper = Paper()
    paper.listed_version()
    paper.add_version()  # v2 stays awaiting_consent

    assert client.get(manifest_url(paper.short_id, 1)).status_code == 200
    assert client.get(manifest_url(paper.short_id, 2)).status_code == 404


def test_a_paper_this_node_does_not_hold_is_a_404(client):
    # A well-formed short id (valid checksum) for a genesis this node never saw.
    key = SigningKey.generate()
    never_saved = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did_key_from_signing_key(key),
            "created": "2026-01-01T00:00:00Z",
            "prev": None,
            "body": {"seed": uuid.uuid4().hex},
            "proofs": [],
        },
        key,
    )
    unknown_short_id = derive_short_id(never_saved["id"])

    assert client.get(manifest_url(unknown_short_id, 1)).status_code == 404
    assert client.get(manifest_url(never_saved["id"], 1)).status_code == 404
    assert client.get(manifest_url("not-an-id", 1)).status_code == 404


@pytest.mark.parametrize("n", ["0", "-1", "01", "+1", "1.0", "one", "1e3", "9" * 40, "%20"])
def test_a_malformed_version_number_is_a_404_not_a_500(client, n):
    paper = Paper()
    paper.listed_version()

    response = client.get(manifest_url(paper.short_id, n))

    assert response.status_code == 404


def test_a_listed_version_whose_manifest_record_is_not_held_is_a_404(client):
    paper = Paper()
    paper.listed_version(store_manifest=False)

    response = client.get(manifest_url(paper.short_id, 1))

    assert response.status_code == 404


def test_a_manifest_cid_that_is_not_a_manifest_record_is_a_404(client):
    paper = Paper()
    version = paper.listed_version()
    # The genesis record is in the log, but it is not a manifest.
    from app import db
    from app.modules.submissions import PaperVersion

    with db.SessionLocal() as session:
        row = session.get(PaperVersion, version.cid)
        row.manifest_cid = paper.genesis["id"]
        session.commit()

    assert client.get(manifest_url(paper.short_id, 1)).status_code == 404


def test_the_existing_paper_routes_still_resolve(client):
    paper = Paper()
    version = paper.listed_version()

    assert client.get(f"/v1/papers/{paper.short_id}").json()["versionCid"] == version.cid
    assert client.get(f"/v1/papers/{paper.short_id}/v1").json()["versionCid"] == version.cid
