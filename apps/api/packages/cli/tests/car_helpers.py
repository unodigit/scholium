"""Builders for CAR archives and signed papers used by the CLI tests.

Writing a CAR is test-only code: the CLI reads archives, the API's export
module writes them.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

import dag_cbor
from multiformats import CID
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_cid,
    compute_file_id,
    compute_record_cid,
    derive_short_id,
    did_key_from_signing_key,
    record_bytes,
    sign_record,
)

KEYS = {
    name: SigningKey(bytes([index]) * 32)
    for index, name in enumerate(
        ["alice", "bob", "carol", "mallory", "committee", "dave"], start=1
    )
}

DAG_CBOR = "dag-cbor"


def did(name: str) -> str:
    return did_key_from_signing_key(KEYS[name])


# --- CAR writing --------------------------------------------------------


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def section(cid: CID, data: bytes) -> bytes:
    body = bytes(cid) + data
    return varint(len(body)) + body


def header(roots: list[CID] | tuple[CID, ...] = (), version: int = 1) -> bytes:
    body = dag_cbor.encode({"roots": list(roots), "version": version})
    return varint(len(body)) + body


def write_car(
    blocks: list[tuple[CID, bytes]], roots: list[CID] | tuple[CID, ...] = ()
) -> bytes:
    return header(roots) + b"".join(section(cid, data) for cid, data in blocks)


def dag_cbor_cid(data: bytes) -> CID:
    return CID("base32", 1, DAG_CBOR, ("sha2-256", hashlib.sha256(data).digest()))


def full_record_block(record: dict[str, Any]) -> tuple[CID, bytes]:
    """The whole envelope (content fields, ``id``, ``sig``) as one block."""
    data = dag_cbor.encode(record)
    return dag_cbor_cid(data), data


def canonical_record_block(record: dict[str, Any]) -> tuple[CID, bytes]:
    """Only the bytes the record id hashes: the block CID *is* the record id."""
    return compute_record_cid(record), record_bytes(record)


def file_block(data: bytes) -> tuple[CID, bytes]:
    return compute_file_cid(data), data


# --- signed papers ------------------------------------------------------


def signed(name, record_type, body, prev=None, created="2026-11-14T05:33:00Z"):
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did(name),
            "created": created,
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        KEYS[name],
    )


def manuscript(n: int) -> bytes:
    return f"manuscript v{n}".encode()


def file_entry(path: str, data: bytes, size: int | None = None) -> dict[str, Any]:
    return {
        "path": path,
        "cid": compute_file_id(data),
        "size": len(data) if size is None else size,
        "mediaType": "application/pdf",
        "role": "manuscript",
    }


@dataclass
class Paper:
    genesis: dict
    versions: list = field(default_factory=list)
    manifests: list = field(default_factory=list)
    consents: list = field(default_factory=list)  # one list per version
    extra: list = field(default_factory=list)
    files: dict = field(default_factory=dict)  # path -> bytes

    @property
    def paper_id(self) -> str:
        return self.genesis["id"]

    @property
    def short_id(self) -> str:
        return derive_short_id(self.paper_id)

    def records(self) -> list[dict]:
        flat = [self.genesis]
        for index, version in enumerate(self.versions):
            flat.append(self.manifests[index])
            flat.append(version)
            flat.extend(self.consents[index])
        return flat + self.extra

    def blocks(self, records=None, with_files=True) -> list[tuple[CID, bytes]]:
        blocks = [full_record_block(r) for r in (self.records() if records is None else records)]
        if with_files:
            blocks += [file_block(data) for data in self.files.values()]
        return blocks

    def car(self, **kwargs) -> bytes:
        return write_car(self.blocks(**kwargs))


def add_version(paper, authors=("alice", "bob"), submitter="alice", file_size=None):
    n = len(paper.versions) + 1
    prev = paper.versions[-1]["id"] if paper.versions else paper.paper_id
    data = manuscript(n)
    path = f"main-v{n}.pdf"
    paper.files[path] = data
    manifest = signed(
        submitter, "manifest", {"files": [file_entry(path, data, file_size)]}
    )
    version = signed(
        submitter,
        "paper.version",
        {
            "paper": paper.paper_id,
            "n": n,
            "title": f"A Paper, version {n}",
            "abstract": "Abstract.",
            "authors": [{"did": did(a), "credit": ["writing"]} for a in authors],
            "manifest": manifest["id"],
            "licence": "CC-BY-4.0",
            "changeNote": f"change {n}",
        },
        prev=prev,
    )
    paper.manifests.append(manifest)
    paper.versions.append(version)
    paper.consents.append(
        [
            signed(
                a,
                "coauthor.consent",
                {"version": version["id"], "role": "author", "decision": "accept"},
            )
            for a in authors
        ]
    )
    return version


def make_paper(versions=1, authors=("alice", "bob"), seed="s-1", file_size=None) -> Paper:
    genesis = signed(
        "alice",
        "paper.genesis",
        {"seed": seed, "title": "A Paper", "categories": ["math"], "licence": "CC-BY-4.0"},
    )
    paper = Paper(genesis)
    for _ in range(versions):
        add_version(paper, authors, file_size=file_size)
    return paper


def notice(name, record_type, target, **body):
    return signed(name, record_type, {"target": target, "reason": "r", **body})


def tombstone(name, target):
    return signed(
        name,
        "moderation.decision",
        {"target": target, "action": "tombstone", "clause": "MOD-09", "reasonCid": "x"},
    )


def flip(data: bytes, index: int, mask: int = 0xFF) -> bytes:
    changed = bytearray(data)
    changed[index] ^= mask
    return bytes(changed)
