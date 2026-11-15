"""Tests for ``GET /v1/export/archive.car`` (plugin: export, feature 93).

Papers are built the way the paper-export tests build them -- signed records in
the event log and files in the content store -- and the whole archive is then
downloaded through the public route with an anonymous client.  The response is
parsed as a real CARv1 archive and every block is checked against the content
id it is filed under, so what is asserted is the file a third party downloads,
not the collector that built it.

The event log is append-only and shared by every test in a worker, so the
assertions are about what the archive must contain and must not contain, never
about how many entries the log holds.
"""

from __future__ import annotations

import hashlib
import io
import uuid
from dataclasses import dataclass
from typing import Any

import dag_cbor
import pytest
from multiformats import CID
from nacl.signing import SigningKey, VerifyKey
from scholium_record_core import (
    compute_file_id,
    decode_signature,
    public_key_from_did_key,
    record_bytes,
)

from app.modules import content, ledger, moderation
from app.modules.export import archive, archive_car
from app.modules.export.car import Block, encode_car, write_car
from app.modules.moderation.models import Denylist, ensure_tables

from .test_paper_car import DAG_CBOR, RAW, build_paper, parse_car

ARCHIVE = "/v1/export/archive.car"

#: The four fields a signed head carries (``GET /v1/sync/head``).
HEAD_FIELDS = {"seq", "entry_hash", "node_did", "signature"}

NODE_KEY_SEED = bytes(range(32))


@pytest.fixture
def node_key(monkeypatch, tmp_path):
    """Provision a node Ed25519 key (hex seed file) at ``NODE_KEY_PATH``."""
    key_path = tmp_path / "node.key"
    key_path.write_text(NODE_KEY_SEED.hex())
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))
    return SigningKey(NODE_KEY_SEED)


# --------------------------------------------------------------------------- #
# Reading the archive back
# --------------------------------------------------------------------------- #


def _text(cid: CID) -> str:
    return str(cid.set(base="base32"))


@dataclass(frozen=True)
class Exported:
    """One downloaded archive, sorted into the kinds of block it holds."""

    header: dict[str, Any]
    head: dict[str, Any]
    head_cid: CID
    records: dict[str, dict[str, Any]]
    """record id -> canonical record"""
    files: dict[str, bytes]
    """file id -> bytes"""
    log_entries: list[dict[str, Any]]
    block_cids: list[CID]


def read_archive(content_bytes: bytes) -> Exported:
    """Parse a CAR and check every block hashes to the CID it is filed under."""
    header, blocks = parse_car(content_bytes)
    heads: list[tuple[CID, dict[str, Any]]] = []
    records: dict[str, dict[str, Any]] = {}
    files: dict[str, bytes] = {}
    log_entries: list[dict[str, Any]] = []
    for cid, data in blocks:
        assert cid.hashfun.digest(data) == cid.digest, "a block does not match its CID"
        if cid.codec.code == RAW:
            files[_text(cid)] = data
            continue
        assert cid.codec.code == DAG_CBOR
        decoded = dag_cbor.decode(data)
        assert isinstance(decoded, dict)
        if set(decoded) == HEAD_FIELDS:
            heads.append((cid, decoded))
        elif "record_cid" in decoded:
            log_entries.append(decoded)
        elif {"type", "author"} <= set(decoded):
            records[_text(cid)] = decoded
        else:  # pragma: no cover - the exporter never writes anything else
            raise AssertionError(f"unexpected block {cid}")
    assert len(heads) == 1, "an archive carries exactly one signed head"
    return Exported(
        header=header,
        head=heads[0][1],
        head_cid=heads[0][0],
        records=records,
        files=files,
        log_entries=log_entries,
        block_cids=[cid for cid, _ in blocks],
    )


def download(client) -> tuple[Any, Exported]:
    response = client.get(ARCHIVE)
    assert response.status_code == 200
    return response, read_archive(response.content)


def tombstone(file_cid: str) -> None:
    """Take ``file_cid`` down the way moderation does: denylist it, delete the bytes."""
    moderation.tombstone_cid(file_cid, "bafyreidecisionthatcitedmod05")


# --------------------------------------------------------------------------- #
# The archive and its signed head
# --------------------------------------------------------------------------- #


def test_export_returns_a_carv1_archive_rooted_at_the_signed_head(client, node_key):
    build_paper()

    response, exported = download(client)

    assert response.headers["content-type"] == "application/vnd.ipld.car"
    assert response.headers["content-disposition"] == 'attachment; filename="archive.car"'
    assert int(response.headers["content-length"]) == len(response.content)
    assert exported.header["version"] == 1
    assert [cid for cid in exported.header["roots"]] == [exported.head_cid]


def test_the_head_is_the_nodes_signature_over_the_last_log_entry(client, node_key):
    build_paper()

    _, exported = download(client)

    head = exported.head
    last = max(exported.log_entries, key=lambda entry: entry["seq"])
    assert head["seq"] == last["seq"]
    assert head["entry_hash"] == bytes(last["entry_hash"]).hex()
    assert head["node_did"] == ledger.did_key_from_public_key(bytes(node_key.verify_key))

    verify_key = VerifyKey(public_key_from_did_key(head["node_did"]))
    message = ledger.head_message(head["seq"], bytes.fromhex(head["entry_hash"]), head["node_did"])
    verify_key.verify(message, decode_signature(head["signature"]))  # raises if forged


def test_the_head_is_the_document_sync_head_serves(client, node_key):
    build_paper()

    _, exported = download(client)
    served = client.get("/v1/sync/head").json()

    # The log may not have moved between the two requests, and the signature is
    # deterministic, so the two documents are the same document.
    assert exported.head == served


def test_the_head_covers_every_log_entry_from_the_first_with_an_unbroken_chain(client, node_key):
    build_paper()

    _, exported = download(client)

    entries = sorted(exported.log_entries, key=lambda entry: entry["seq"])
    assert [entry["seq"] for entry in entries] == list(range(1, exported.head["seq"] + 1))
    previous = b"\x00" * 32
    for entry in entries:
        assert bytes(entry["prev_hash"]) == previous
        expected = hashlib.sha256(
            previous + entry["record_cid"].encode() + bytes(entry["raw"])
        ).digest()
        assert bytes(entry["entry_hash"]) == expected
        previous = expected
    assert previous.hex() == exported.head["entry_hash"]


def test_the_same_log_exports_identical_bytes(client, node_key):
    build_paper()

    first = client.get(ARCHIVE).content
    second = client.get(ARCHIVE).content

    assert first == second


# --------------------------------------------------------------------------- #
# What the archive holds
# --------------------------------------------------------------------------- #


def test_every_paper_record_log_entry_and_file_is_in_the_archive(client, node_key):
    papers = [build_paper(), build_paper()]
    posted = papers[0].sign(
        "discussion.post",
        {
            "paper": papers[0].paper_cid,
            "target": papers[0].version["id"],
            "anchor": {"paragraph": 1},
            "text": "a question",
            "parent": None,
        },
        offset=5,
    )
    papers[0].append(posted)

    _, exported = download(client)

    logged = {entry["record_cid"] for entry in exported.log_entries}
    for paper in papers:
        for record in (paper.genesis, paper.manifest, paper.version):
            # The block is filed under the record id and holds the canonical bytes.
            assert exported.records[record["id"]] == dag_cbor.decode(record_bytes(record))
            assert record["id"] in logged
        assert exported.files[paper.file_cid] == paper.file_data
    assert posted["id"] in exported.records
    assert posted["id"] in logged
    assert {
        entry["record_cid"]: bytes(entry["raw"]) for entry in exported.log_entries
    }[posted["id"]] == record_bytes(posted)


def test_every_logged_record_is_a_record_block_and_nothing_is_written_twice(client, node_key):
    build_paper()

    _, exported = download(client)

    assert {entry["record_cid"] for entry in exported.log_entries} == set(exported.records)
    texts = [_text(cid) for cid in exported.block_cids]
    assert len(texts) == len(set(texts))


def test_a_file_no_record_names_is_not_exported(client, node_key):
    build_paper()
    data = f"an upload nothing refers to {uuid.uuid4().hex}".encode()
    content.store_bytes(data, media_type="application/pdf")

    _, exported = download(client)

    assert compute_file_id(data) not in exported.files


def test_a_manifest_file_whose_bytes_are_missing_is_omitted(client, node_key):
    paper = build_paper(store_file=False)

    _, exported = download(client)

    assert paper.manifest["id"] in exported.records
    assert paper.file_cid not in exported.files


# --------------------------------------------------------------------------- #
# Tombstoned bytes
# --------------------------------------------------------------------------- #


def test_tombstoned_bytes_are_excluded_and_everything_else_is_kept(client, node_key):
    taken_down = build_paper()
    kept = build_paper()
    _, before = download(client)
    assert taken_down.file_cid in before.files

    tombstone(taken_down.file_cid)
    _, exported = download(client)

    assert taken_down.file_cid not in exported.files
    assert exported.files[kept.file_cid] == kept.file_data
    # The takedown touches bytes, never history: the manifest that names the
    # file and every log entry are still there, and the chain still ends at the head.
    assert taken_down.manifest["id"] in exported.records
    assert {taken_down.genesis["id"], taken_down.version["id"]} <= set(exported.records)
    assert {entry["record_cid"] for entry in before.log_entries} <= {
        entry["record_cid"] for entry in exported.log_entries
    }


def test_denylisted_bytes_still_on_disk_are_not_exported(client, node_key):
    """Tombstoning denylists first and deletes second; the window between is closed too."""
    paper = build_paper()
    ensure_tables()
    from app import db

    with db.SessionLocal() as session:
        session.add(Denylist(cid=paper.file_cid, decision_cid="bafyreidecision"))
        session.commit()
    assert content.exists(paper.file_cid)

    _, exported = download(client)

    assert paper.file_cid not in exported.files
    assert paper.manifest["id"] in exported.records


def test_a_takedown_that_lands_while_the_file_is_read_is_still_excluded(
    client, node_key, monkeypatch
):
    paper = build_paper()
    answers: dict[str, int] = {}

    def tombstoned_after_the_first_look(cid: str) -> bool:
        answers[cid] = answers.get(cid, 0) + 1
        return cid == paper.file_cid and answers[cid] > 1

    monkeypatch.setattr(content, "is_tombstoned", tombstoned_after_the_first_look)

    _, exported = download(client)

    assert answers[paper.file_cid] > 1, "the exporter must look again after reading"
    assert paper.file_cid not in exported.files


def test_bytes_the_sanitizer_rejected_are_not_exported(client, node_key):
    rejected = build_paper()
    cleared = build_paper()
    content.set_scan_status(rejected.file_cid, content.SCAN_FAILED)
    content.set_scan_status(cleared.file_cid, content.SCAN_PASSED)

    _, exported = download(client)

    assert rejected.file_cid not in exported.files
    assert exported.files[cleared.file_cid] == cleared.file_data
    assert rejected.manifest["id"] in exported.records


# --------------------------------------------------------------------------- #
# One consistent snapshot
# --------------------------------------------------------------------------- #


def test_records_accepted_while_the_archive_is_written_are_not_in_it(
    client, node_key, monkeypatch
):
    build_paper()
    latecomers: list = []
    real_latest = ledger.latest

    def latest_then_a_new_paper_arrives():
        head = real_latest()
        if not latecomers:
            latecomers.append(build_paper())
        return head

    monkeypatch.setattr(ledger, "latest", latest_then_a_new_paper_arrives)

    _, exported = download(client)

    (late,) = latecomers
    assert real_latest().seq > exported.head["seq"]
    assert late.genesis["id"] not in exported.records
    assert late.file_cid not in exported.files
    last = max(exported.log_entries, key=lambda entry: entry["seq"])
    assert last["seq"] == exported.head["seq"]
    assert bytes(last["entry_hash"]).hex() == exported.head["entry_hash"]


def test_an_empty_log_exports_the_genesis_head_and_nothing_else(monkeypatch, node_key):
    monkeypatch.setattr(ledger, "latest", lambda: None)
    monkeypatch.setattr(ledger, "entries", lambda **_: [])

    out = io.BytesIO()
    full = archive.collect_archive(node_key)
    size = full.write_to(out)

    exported = read_archive(out.getvalue())
    assert size == len(out.getvalue())
    assert exported.head["seq"] == 0
    assert exported.head["entry_hash"] == ledger.GENESIS_PREV_HASH.hex()
    assert exported.records == {} and exported.files == {} and exported.log_entries == []
    assert exported.header["roots"] == [exported.head_cid]


# --------------------------------------------------------------------------- #
# A node that cannot sign
# --------------------------------------------------------------------------- #


def test_a_node_without_a_key_answers_503_instead_of_an_unsigned_archive(
    client, monkeypatch, tmp_path
):
    build_paper()
    monkeypatch.setattr(
        "app.modules.ledger.origin.settings.NODE_KEY_PATH", str(tmp_path / "missing.key")
    )

    response = client.get(ARCHIVE)

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    problem = response.json()
    assert problem["type"] == ledger.NODE_KEY_UNAVAILABLE_TYPE
    assert problem["status"] == 503
    assert str(tmp_path) not in problem["detail"], "a public error must not name server paths"


def test_an_unreadable_key_file_answers_503(client, monkeypatch, tmp_path):
    key_path = tmp_path / "garbage.key"
    key_path.write_text("not a key")
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))

    response = client.get(ARCHIVE)

    assert response.status_code == 503
    assert response.json()["type"] == ledger.NODE_KEY_UNAVAILABLE_TYPE


# --------------------------------------------------------------------------- #
# Writing: paging, spooling, and the CAR writer
# --------------------------------------------------------------------------- #


def test_paging_and_spilling_to_disk_do_not_change_the_bytes(client, node_key, monkeypatch):
    build_paper()
    build_paper()
    expected = client.get(ARCHIVE).content

    monkeypatch.setattr(archive, "PAGE_SIZE", 2)  # many pages
    monkeypatch.setattr(archive_car, "SPOOL_MAX_BYTES", 64)  # rolls to a real file at once
    monkeypatch.setattr(archive_car, "CHUNK_SIZE", 100)  # many chunks

    assert client.get(ARCHIVE).content == expected


def test_a_failure_while_writing_is_an_error_not_a_truncated_archive(
    client, node_key, monkeypatch
):
    build_paper()

    def broken(_entry):
        raise RuntimeError("the disk went away")

    monkeypatch.setattr(archive, "_log_entry_block", broken)

    with pytest.raises(RuntimeError):
        client.get(ARCHIVE)


def test_write_car_writes_the_bytes_encode_car_returns():
    blocks = [Block(cid=archive.block_cid(data), data=data) for data in (b"one", b"two", b"")]
    roots = [blocks[0].cid]
    out = io.BytesIO()

    size = write_car(out, roots, iter(blocks))

    assert out.getvalue() == encode_car(roots, blocks)
    assert size == len(out.getvalue())


# --------------------------------------------------------------------------- #
# The other export routes are unaffected
# --------------------------------------------------------------------------- #


def test_the_per_paper_and_per_user_routes_still_answer(client, node_key):
    paper = build_paper()

    assert client.get(f"/v1/export/paper/{paper.short_id}.car").status_code == 200
    assert client.get(f"/v1/export/user/{paper.did}.car").status_code == 200


# --------------------------------------------------------------------------- #
# The CLI's reader accepts what the API writes
# --------------------------------------------------------------------------- #


def test_the_cli_reader_accepts_the_archive_and_the_head_is_not_mistaken_for_a_record(
    client, node_key
):
    car = pytest.importorskip("scholium_cli.car")
    loader = pytest.importorskip("scholium_cli.archive")
    paper = build_paper()

    response = client.get(ARCHIVE)
    read = car.read_car(response.content)
    loaded = loader.load_archive(read)

    assert loaded.corrupt == {}
    assert read.roots and len(read.roots) == 1
    ids = {record["id"] for record in loaded.records}
    assert {paper.genesis["id"], paper.manifest["id"], paper.version["id"]} <= ids
    assert paper.file_cid in {
        str(read_block.cid.set(base="base32"))
        for read_block in read.blocks
        if read_block.cid.codec.code == RAW
    }
    # Records and log entries are told apart from the head: one entry per record.
    assert {entry["record_cid"] for entry in loaded.log_entries} == ids
    assert len(read.blocks) == 1 + len(loaded.records) + len(loaded.log_entries) + len(loaded.files)
