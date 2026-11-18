"""What a Scholium archive holds, ready for verification.

A paper's CAR carries three kinds of block:

* **records** -- DAG-CBOR blocks that decode to a signed envelope (a map
  with at least a string ``type`` and ``author``).  Two layouts are read:

  - a *full* envelope: the seven content fields plus ``sig`` (and
    optionally ``id``) in one map.  The block's own CID is then the hash of
    those bytes, which is not the record id; the record id is the ``id``
    field, and :func:`scholium_record_core.verify_paper` recomputes it from
    the content and compares.
  - a *canonical* record: exactly the bytes the record id is computed over
    (what the ledger keeps as ``raw``).  The block CID is the record id, so
    it is used as ``id``.  Such a block carries no ``sig`` of its own; when
    the archive also carries its log entry, that entry's ``sig`` is attached
    here so the author's signature can still be checked over these bytes.
    Without either, the verifier reports the record as unsigned rather than
    guessing.

* **files** -- raw-codec blocks holding the bytes of a manuscript, figure,
  dataset, ... named by their sha2-256 file id.
* **log entries** -- DAG-CBOR blocks holding one ``event_log`` row: a map
  with at least ``seq``, ``record_cid``, ``raw``, ``prev_hash`` and
  ``entry_hash``.  They are kept for ``scholium rebuild``, which verifies the
  hash chain over them; ``scholium verify`` uses them to attach the author's
  signature to each canonical record and, for a whole-node archive, to check
  the log's hash chain.
* **the signed head** -- a DAG-CBOR block holding the document
  ``GET /v1/sync/head`` serves (``seq``, ``entry_hash``, ``node_did``,
  ``signature``).  Only a whole-node export carries one; it commits the node
  to the entries before the head and is what ``scholium verify`` checks when
  it verifies every paper of a node.
* **anything else** -- hash-checked like every block, then ignored.

Every block is hash-checked.  A block whose bytes do not hash to its CID is
never used as evidence; it is recorded in :attr:`Archive.corrupt` so the
verifier can fail the archive.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import dag_cbor
from dag_cbor.decoding.err import CBORDecodingError
from multiformats import CID
from scholium_record_core import record_bytes

from .car import Car, block_problem

__all__ = ["LOG_ENTRY_KEYS", "Archive", "load_archive"]

#: Multicodec codes of the blocks the verifier reads.
_DAG_CBOR = 0x71
_RAW = 0x55

#: Base a record id is spelled in (the same as ``compute_record_id``).
_RECORD_ID_BASE = "base32"

#: The fields every event-log entry block carries (the ``event_log`` columns
#: the chain is computed over).  Anything else the node stores
#: (``record_type``, ``author_did``, ``body``, ``received_at``,
#: ``origin_node``) rides along unvalidated.
LOG_ENTRY_KEYS = ("seq", "record_cid", "raw", "prev_hash", "entry_hash")

#: The fields ``GET /v1/sync/head`` signs (and the block a whole-node export
#: roots the archive at).
HEAD_KEYS = ("seq", "entry_hash", "node_did", "signature")


@dataclass(frozen=True)
class Archive:
    """The blocks of a CAR, sorted into what verification uses."""

    block_count: int
    records: tuple[dict[str, Any], ...]
    """Envelopes of the intact record blocks, in archive order, each with ``id``."""
    log_entries: tuple[dict[str, Any], ...] = ()
    """Decoded event-log entry blocks, in archive order, unvalidated."""
    head: dict[str, Any] | None = None
    """The decoded signed log head of a whole-node export, when it carries one."""
    files: dict[bytes, bytes] = field(default_factory=dict)
    """Intact raw blocks: binary CID -> bytes."""
    corrupt: dict[bytes, str] = field(default_factory=dict)
    """Binary CID -> why its block's bytes do not match it."""
    cids: dict[bytes, CID] = field(default_factory=dict)
    """Binary CID -> the CID, so messages can name a block (text is costly)."""

    def corrupt_messages(self) -> list[str]:
        return [
            f"block {_label(self.cids[key])}: {problem}"
            for key, problem in self.corrupt.items()
        ]


def _label(cid: CID) -> str:
    """``cid`` as text, in base32 where its version allows (CIDv0 cannot)."""
    return str(cid.set(base=_RECORD_ID_BASE)) if cid.version else str(cid)


def _decode_record(data: bytes) -> dict[str, Any] | None:
    try:
        value = dag_cbor.decode(data)
    except (CBORDecodingError, ValueError, RecursionError):
        return None
    if (
        isinstance(value, dict)
        and isinstance(value.get("type"), str)
        and isinstance(value.get("author"), str)
    ):
        return value
    return None


def _decode_log_entry(data: bytes) -> dict[str, Any] | None:
    """Decode an event-log entry block, or ``None`` for anything else.

    Only the map shape is checked here (the five chain fields present, a
    ``seq`` that is an integer); the field values are validated where they
    are used, by :mod:`scholium_cli.rebuild`.
    """
    try:
        value = dag_cbor.decode(data)
    except (CBORDecodingError, ValueError, RecursionError):
        return None
    if not isinstance(value, dict) or any(key not in value for key in LOG_ENTRY_KEYS):
        return None
    seq = value.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int):
        return None
    return value


def _decode_head(data: bytes) -> dict[str, Any] | None:
    """Decode a signed log-head block, or ``None`` for anything else.

    The shape is exactly the document ``GET /v1/sync/head`` serves; whether
    the signature is authentic is decided later, by the verifier.
    """
    try:
        value = dag_cbor.decode(data)
    except (CBORDecodingError, ValueError, RecursionError):
        return None
    if not isinstance(value, dict) or any(key not in value for key in HEAD_KEYS):
        return None
    return value


def _attach_signatures(
    records: list[dict[str, Any]], log_entries: list[dict[str, Any]]
) -> None:
    """Give each canonical record the ``sig`` its log entry carries, in place.

    A canonical record block is the bytes the record id hashes, and the id
    deliberately excludes ``sig``.  Nodes export the signature on the record's
    log entry instead.  Only a signature whose entry names this record *and*
    whose ``raw`` decodes to exactly these bytes is attached, so a log entry
    cannot lend its signature to a different record; the signature itself is
    still checked cryptographically later.
    """
    by_id = {
        record["id"]: record
        for record in records
        if isinstance(record.get("id"), str)
    }
    for entry in log_entries:
        record_id = entry.get("record_cid")
        signature = entry.get("sig")
        raw = entry.get("raw")
        if not isinstance(record_id, str) or not isinstance(signature, str):
            continue
        record = by_id.get(record_id)
        if record is None or record.get("sig") is not None:
            continue  # a full envelope already has its own signature
        if isinstance(raw, (bytes, bytearray)):
            try:
                if record_bytes(record) != bytes(raw):
                    continue
            except (ValueError, KeyError, TypeError):
                continue
        record["sig"] = signature


def load_archive(car: Car) -> Archive:
    """Sort the blocks of ``car`` and hash-check every one of them."""
    records: list[dict[str, Any]] = []
    log_entries: list[dict[str, Any]] = []
    head: dict[str, Any] | None = None
    files: dict[bytes, bytes] = {}
    corrupt: dict[bytes, str] = {}
    cids: dict[bytes, CID] = {}
    seen: set[tuple[bytes, bytes]] = set()

    for block in car.blocks:
        key = bytes(block.cid)
        cids.setdefault(key, block.cid)
        if (key, block.data) in seen:
            continue  # an exact duplicate adds nothing
        seen.add((key, block.data))

        problem = block_problem(block)
        if problem is not None:
            corrupt[key] = problem
            continue
        codec = block.cid.codec.code
        if codec == _RAW:
            files[key] = block.data
        elif codec == _DAG_CBOR:
            record = _decode_record(block.data)
            if record is not None:
                if "id" not in record:
                    record["id"] = _label(block.cid)
                records.append(record)
                continue
            entry = _decode_log_entry(block.data)
            if entry is not None:
                log_entries.append(entry)
                continue
            signed_head = _decode_head(block.data)
            if signed_head is not None and head is None:
                head = signed_head
    _attach_signatures(records, log_entries)
    return Archive(
        block_count=len(car.blocks),
        records=tuple(records),
        log_entries=tuple(log_entries),
        head=head,
        files=files,
        corrupt=corrupt,
        cids=cids,
    )
