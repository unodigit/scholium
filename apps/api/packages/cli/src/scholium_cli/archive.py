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
    it is used as ``id``.  Such a block carries no ``sig``, and the record
    cannot be authenticated unless the signature is supplied some other way;
    the verifier reports it as unsigned rather than guessing.

* **files** -- raw-codec blocks holding the bytes of a manuscript, figure,
  dataset, ... named by their sha2-256 file id.
* **anything else** (log entries, ...) -- hash-checked like every block,
  then ignored by the paper verifier.

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

from .car import Car, block_problem

__all__ = ["Archive", "load_archive"]

#: Multicodec codes of the blocks the verifier reads.
_DAG_CBOR = 0x71
_RAW = 0x55

#: Base a record id is spelled in (the same as ``compute_record_id``).
_RECORD_ID_BASE = "base32"


@dataclass(frozen=True)
class Archive:
    """The blocks of a CAR, sorted into what verification uses."""

    block_count: int
    records: tuple[dict[str, Any], ...]
    """Envelopes of the intact record blocks, in archive order, each with ``id``."""
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


def load_archive(car: Car) -> Archive:
    """Sort the blocks of ``car`` and hash-check every one of them."""
    records: list[dict[str, Any]] = []
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
    return Archive(
        block_count=len(car.blocks),
        records=tuple(records),
        files=files,
        corrupt=corrupt,
        cids=cids,
    )
