"""CARv1 writing for the export plugin (feature 91).

A CAR ("Content Addressable aRchive") v1 file is::

    varint(len(header)) header  { varint(len(cid) + len(data)) cid data }*

where ``header`` is DAG-CBOR ``{"roots": [CID, ...], "version": 1}``, every
``cid`` is a binary CID and ``data`` is the block that CID names.  The reader
half of the format lives in the CLI (``scholium_cli.car``, feature 95); this
module writes the archives the API serves::

    blocks = [
        Block(cid=compute_file_cid(data), data=data),          # a file
        Block(cid=record_cid, data=record_bytes(envelope)),    # a record
    ]
    archive = encode_car(roots=[record_cid], blocks=blocks)

Everything is encoded deterministically -- minimal varints, DAG-CBOR header
with one possible byte representation, blocks in the order given -- so the
same paper always exports the same archive and a reader can hash whichever
part it holds.

The three block kinds a paper archive carries (records, files and log
entries) are described in :mod:`app.modules.export.paper`; this module only
knows how to turn ``(cid, bytes)`` pairs into the bytes of a CAR.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import BinaryIO, Iterable, Sequence

import dag_cbor
from multiformats import CID

__all__ = [
    "BASE",
    "CAR_VERSION",
    "DAG_CBOR_CODEC",
    "Block",
    "HASH_FUNCTION",
    "block_cid",
    "encode_car",
    "encode_section",
    "encode_varint",
    "write_car",
]

#: The only CAR version this module writes.
CAR_VERSION = 1

#: CID parameters shared by every block: CIDv1 DAG-CBOR sha2-256 base32.
DAG_CBOR_CODEC = "dag-cbor"
HASH_FUNCTION = "sha2-256"
BASE = "base32"


@dataclass(frozen=True)
class Block:
    """One section of a CAR: the CID a reader files the bytes under."""

    cid: CID
    data: bytes


def encode_varint(value: int) -> bytes:
    """Encode ``value`` as an unsigned LEB128 varint (CAR's length encoding)."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"a varint must be a non-negative integer, got {value!r}")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def block_cid(data: bytes) -> CID:
    """The CIDv1 DAG-CBOR id of ``data`` (a non-record block, e.g. a log entry).

    Records use their own record id and files use their raw-codec file id;
    this is the identity a log-entry block is filed under.
    """
    return CID(
        base=BASE,
        version=1,
        codec=DAG_CBOR_CODEC,
        digest=(HASH_FUNCTION, hashlib.sha256(data).digest()),
    )


def encode_section(cid: CID, data: bytes) -> bytes:
    """One CAR section: a length-prefixed ``cid || data`` payload."""
    payload = bytes(cid) + bytes(data)
    return encode_varint(len(payload)) + payload


def _header(roots: Sequence[CID]) -> bytes:
    """The CARv1 header, DAG-CBOR encoded, with its length prefix."""
    body = dag_cbor.encode({"roots": list(roots), "version": CAR_VERSION})
    return encode_varint(len(body)) + body


def encode_car(roots: Iterable[CID], blocks: Iterable[Block]) -> bytes:
    """Return the CARv1 archive of ``blocks`` with the entry point ``roots``.

    ``roots`` names blocks that are present in the archive (a reader follows
    them into the rest); an archive of a single paper roots at its genesis
    record.  Blocks are written in the order given and are not deduplicated
    here -- the collector hands over one block per CID.
    """
    return _header(tuple(roots)) + b"".join(
        encode_section(block.cid, block.data) for block in blocks
    )


def write_car(out: BinaryIO, roots: Iterable[CID], blocks: Iterable[Block]) -> int:
    """Write the CARv1 archive of ``blocks`` to ``out``; return its size in bytes.

    The same bytes :func:`encode_car` returns, but each section is written as
    its block is produced, so ``blocks`` may be a generator and only one block
    is held in memory at a time -- what an archive of a whole node needs.
    """
    written = 0
    header = _header(tuple(roots))
    out.write(header)
    written += len(header)
    for block in blocks:
        section = encode_section(block.cid, block.data)
        out.write(section)
        written += len(section)
    return written
