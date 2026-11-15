"""Tests for ``GET /v1/export/paper/{id}.car`` (plugin: export, feature 91).

A paper is built the way the rest of the API builds one -- signed records in
the event log and the submissions plugin's rows -- and then exported through
the public route with an anonymous client.  The response is parsed as a real
CARv1 archive and every block is checked against the content id it is filed
under, so what is asserted is the file a reader downloads, not the collector
that built it.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from typing import Any, Optional

import dag_cbor
import pytest
from multiformats import CID
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    record_bytes,
    sign_record,
)

from app.modules import content, ledger
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
)

EXPORT = "/v1/export/paper/{}.car"

DAG_CBOR = 0x71
RAW = 0x55


# --------------------------------------------------------------------------- #
# A minimal CARv1 reader (the CLI has the full one; this owns no production code)
# --------------------------------------------------------------------------- #


def _varint(view: memoryview, offset: int, end: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < end:
        byte = view[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
    raise AssertionError("the archive ends inside a varint")


def _cid(view: memoryview, start: int, end: int) -> tuple[CID, int]:
    position = start
    for _ in range(3):  # CID version, codec, multihash function
        _, position = _varint(view, position, end)
    digest_size, position = _varint(view, position, end)
    length = position - start + digest_size
    assert start + length <= end, "a section is too short to hold its CID"
    return CID.decode(bytes(view[start : start + length])), start + length


def parse_car(data: bytes) -> tuple[dict[str, Any], list[tuple[CID, bytes]]]:
    """Return ``(header, [(cid, data), ...])`` for a CARv1 archive."""
    view = memoryview(data)
    size, offset = _varint(view, 0, len(view))
    header = dag_cbor.decode(bytes(view[offset : offset + size]))
    offset += size
    blocks: list[tuple[CID, bytes]] = []
    while offset < len(view):
        size, start = _varint(view, offset, len(view))
        end = start + size
        cid, payload = _cid(view, start, end)
        blocks.append((cid, bytes(view[payload:end])))
        offset = end
    return header, blocks


def _text(cid: CID) -> str:
    return str(cid.set(base="base32"))


@dataclass(frozen=True)
class Parsed:
    """One exported archive, sorted into the three block kinds."""

    header: dict[str, Any]
    ids: set[str]
    records: dict[str, dict[str, Any]]
    """record id -> canonical envelope"""
    files: dict[str, bytes]
    """file id -> bytes"""
    log_entries: list[dict[str, Any]]


def parsed(response) -> Parsed:
    """Parse the CAR a response carries and check every block hashes to its CID."""
    assert response.status_code == 200
    header, blocks = parse_car(response.content)
    records: dict[str, dict[str, Any]] = {}
    files: dict[str, bytes] = {}
    log_entries: list[dict[str, Any]] = []
    for cid, data in blocks:
        assert cid.hashfun.digest(data) == cid.digest, "a block does not match its CID"
        decoded = None
        if cid.codec.code == DAG_CBOR:
            decoded = dag_cbor.decode(data)
        if cid.codec.code == RAW:
            files[_text(cid)] = data
        elif isinstance(decoded, dict) and "record_cid" in decoded:
            log_entries.append(decoded)
        elif isinstance(decoded, dict) and {"type", "author"} <= set(decoded):
            records[_text(cid)] = decoded
        else:  # pragma: no cover - the exporter never writes anything else
            raise AssertionError(f"unexpected block {cid}")
    return Parsed(
        header=header,
        ids={_text(cid) for cid, _ in blocks},
        records=records,
        files=files,
        log_entries=log_entries,
    )


# --------------------------------------------------------------------------- #
# A paper built from signed records
# --------------------------------------------------------------------------- #


@dataclass
class BuiltPaper:
    """One paper whose signed records are in the event log."""

    tag: str
    key: SigningKey
    did: str
    genesis: dict
    manifest: dict
    version: dict
    file_data: bytes
    file_cid: str

    @property
    def paper_cid(self) -> str:
        return self.genesis["id"]

    @property
    def short_id(self) -> str:
        return derive_short_id(self.paper_cid)

    def sign(
        self, record_type: str, body: dict, *, prev: Optional[str] = None, offset: int = 0
    ) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": f"2026-11-15T09:00:{min(offset, 59):02d}Z",
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.key,
        )

    def append(self, record: dict) -> None:
        ledger.append(record)


def build_paper(*, store_file: bool = True, file_bytes: Optional[bytes] = None) -> BuiltPaper:
    """Create a paper's signed genesis, manifest and version in the log."""
    tag = uuid.uuid4().hex
    key = SigningKey.generate()
    did = did_key_from_signing_key(key)
    data = file_bytes if file_bytes is not None else f"manuscript {tag}".encode()

    genesis = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did,
            "created": "2026-11-15T09:00:00Z",
            "prev": None,
            "body": {
                "seed": tag,
                "title": f"Exported paper {tag}",
                "abstract": "Everything a reader needs to verify it offline.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [did],
            },
            "proofs": [],
        },
        key,
    )
    save_paper(paper_cid=genesis["id"], categories=("cs.CR",), licence="CC-BY-4.0")

    file_cid = compute_file_id(data)
    if store_file:
        content.store_bytes(data, media_type="application/pdf")

    manifest = sign_record(
        {
            "v": 1,
            "type": "manifest",
            "author": did,
            "created": "2026-11-15T09:00:01Z",
            "prev": None,
            "body": {
                "files": [
                    {
                        "path": "paper.pdf",
                        "cid": file_cid,
                        "size": len(data),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
            "proofs": [],
        },
        key,
    )

    version = sign_record(
        {
            "v": 1,
            "type": "paper.version",
            "author": did,
            "created": "2026-11-15T09:00:02Z",
            "prev": genesis["id"],
            "body": {
                "paper": genesis["id"],
                "n": 1,
                "title": f"Exported paper {tag}",
                "abstract": "Everything a reader needs to verify it offline.",
                "authors": [{"did": did, "position": 1, "creditRoles": ["Conceptualization"]}],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "first version",
            },
            "proofs": [],
        },
        key,
    )
    save_version(
        version_cid=version["id"],
        paper_cid=genesis["id"],
        n=1,
        title=version["body"]["title"],
        abstract=version["body"]["abstract"],
        manifest_cid=manifest["id"],
        licence="CC-BY-4.0",
        prev_cid=genesis["id"],
        authors=(VersionAuthor(did, 1, ("Conceptualization",)),),
    )

    for record in (genesis, manifest, version):
        ledger.append(record)

    return BuiltPaper(
        tag=tag,
        key=key,
        did=did,
        genesis=genesis,
        manifest=manifest,
        version=version,
        file_data=data,
        file_cid=file_cid,
    )


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def test_export_returns_a_carv1_archive_of_records_files_and_log_entries(client):
    paper = build_paper()

    response = client.get(EXPORT.format(paper.short_id))

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.ipld.car"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert disposition.endswith('.car"')

    archive = parsed(response)

    # CARv1 header rooted at the paper's genesis record.
    assert archive.header["version"] == 1
    assert [_text(cid) for cid in archive.header["roots"]] == [paper.paper_cid]

    # Every record block is filed under the record id and holds exactly the
    # canonical bytes that id commits to.
    expected_records = {
        paper.genesis["id"]: paper.genesis,
        paper.manifest["id"]: paper.manifest,
        paper.version["id"]: paper.version,
    }
    for record_id, record in expected_records.items():
        assert record_id in archive.records
        assert archive.records[record_id] == dag_cbor.decode(record_bytes(record))
    assert not (set(archive.records) - set(expected_records))

    # The signed manifest's file is present, byte for byte.
    assert archive.files == {paper.file_cid: paper.file_data}

    # Every included record has its event_log row, and the chain rule holds.
    assert {entry["record_cid"] for entry in archive.log_entries} == set(expected_records)
    by_id = {record["id"]: record for record in expected_records.values()}
    for entry in archive.log_entries:
        assert entry["raw"] == record_bytes(by_id[entry["record_cid"]])
        assert entry["record_type"] == by_id[entry["record_cid"]]["type"]
        assert entry["author_did"] == by_id[entry["record_cid"]]["author"]
        expected = hashlib.sha256(
            bytes(entry["prev_hash"]) + entry["record_cid"].encode() + bytes(entry["raw"])
        ).digest()
        assert bytes(entry["entry_hash"]) == expected


def test_records_that_name_the_paper_are_included(client):
    paper = build_paper()
    consent = paper.sign(
        "coauthor.consent",
        {
            "version": paper.version["id"],
            "paper": paper.paper_cid,
            "role": "author",
            "decision": "accept",
        },
        offset=1,
    )
    discussion = paper.sign(
        "discussion.post",
        {
            "paper": paper.paper_cid,
            "target": paper.version["id"],
            "anchor": {"paragraph": 1},
            "text": f"A question about {paper.tag}",
            "parent": None,
        },
        offset=2,
    )
    for record in (consent, discussion):
        paper.append(record)

    archive = parsed(client.get(EXPORT.format(paper.paper_cid)))

    assert consent["id"] in archive.records
    assert discussion["id"] in archive.records
    assert {entry["record_cid"] for entry in archive.log_entries} >= {
        paper.genesis["id"],
        paper.manifest["id"],
        paper.version["id"],
        consent["id"],
        discussion["id"],
    }


def test_another_papers_records_are_not_included(client):
    paper = build_paper()
    other = build_paper()
    other_post = other.sign(
        "discussion.post",
        {
            "paper": other.paper_cid,
            "target": other.version["id"],
            "anchor": {"paragraph": 1},
            "text": "not this paper",
            "parent": None,
        },
        offset=3,
    )
    other.append(other_post)

    archive = parsed(client.get(EXPORT.format(paper.short_id)))

    assert other.paper_cid not in archive.records
    assert other.version["id"] not in archive.records
    assert other_post["id"] not in archive.records
    assert other.file_cid not in archive.files


@pytest.mark.parametrize("spelling", ["short_id", "paper_cid", "oai"])
def test_every_public_spelling_of_the_paper_exports_the_same_blocks(client, spelling):
    paper = build_paper()
    identifier = {
        "short_id": paper.short_id,
        "paper_cid": paper.paper_cid,
        "oai": f"oai:scholium:{paper.short_id}",
    }[spelling]

    archive = parsed(client.get(EXPORT.format(identifier)))

    assert paper.genesis["id"] in archive.records
    assert paper.version["id"] in archive.records
    assert paper.file_cid in archive.files


def test_a_version_id_resolves_to_its_paper():
    """A version id has a slash, so callers of the collector can still use it."""
    from app.modules.export.paper import collect_paper

    paper = build_paper()

    archive = collect_paper(f"{paper.short_id}/v1")

    assert archive is not None
    assert archive.paper_cid == paper.paper_cid
    assert paper.version["id"] in {str(block.cid.set(base="base32")) for block in archive.records}


def test_a_manifest_file_whose_bytes_are_missing_is_omitted(client):
    paper = build_paper(store_file=False)

    response = client.get(EXPORT.format(paper.short_id))
    archive = parsed(response)

    assert response.status_code == 200
    # The manifest is still there; only the bytes the node does not hold are
    # left out, so the archive never claims a file it cannot produce.
    assert paper.manifest["id"] in archive.records
    assert paper.file_cid not in archive.files


def test_an_unknown_or_malformed_paper_is_a_404_problem(client):
    for identifier in ("sch:nowhere-nowhere-nowhere", "bafyreinotarecord", "not-a-paper"):
        response = client.get(EXPORT.format(identifier))

        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/problem+json")
        body = response.json()
        assert body["type"] == "urn:scholium:problem:paper-not-found"
        assert body["status"] == 404
