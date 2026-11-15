"""The event-log hash chain.

Every row commits to the row before it::

    entry_hash = sha256(prev_hash || record_cid || raw)

where ``prev_hash`` is the previous row's ``entry_hash``, ``record_cid`` is
the record id encoded as UTF-8, and ``raw`` is the record's canonical
DAG-CBOR bytes.  The first entry in a chain uses
:data:`GENESIS_PREV_HASH` -- 32 zero bytes -- as its predecessor, the usual
convention for hash chains.

Because each hash covers its predecessor's hash, rewriting, reordering or
removing a row breaks the chain at that ``seq``; :func:`verify_entry_hash`
lets a reader check individual links while
:func:`app.modules.ledger.verify.verify_log` checks a whole sequence.
"""

from __future__ import annotations

import hashlib
from typing import Union

__all__ = [
    "GENESIS_PREV_HASH",
    "HASH_SIZE",
    "compute_entry_hash",
    "verify_entry_hash",
]

#: Size of a SHA-256 digest in bytes.
HASH_SIZE = 32

#: ``prev_hash`` of the first entry of a chain.
GENESIS_PREV_HASH = b"\x00" * HASH_SIZE

BytesLike = Union[bytes, bytearray, memoryview]


def _as_bytes(value: BytesLike, field: str) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, (bytearray, memoryview)):
        return bytes(value)
    raise TypeError(f"{field} must be bytes, got {type(value).__name__}")


def compute_entry_hash(prev_hash: BytesLike, record_cid: str, raw: BytesLike) -> bytes:
    """Return ``sha256(prev_hash || record_cid || raw)`` as 32 bytes.

    ``record_cid`` enters the digest as its UTF-8 encoding.  Raises
    ``TypeError`` when a binary argument is not bytes-like or ``record_cid``
    is not a string.
    """
    prev = _as_bytes(prev_hash, "prev_hash")
    if not isinstance(record_cid, str):
        raise TypeError(f"record_cid must be a string, got {type(record_cid).__name__}")
    body = _as_bytes(raw, "raw")
    return hashlib.sha256(prev + record_cid.encode("utf-8") + body).digest()


def verify_entry_hash(prev_hash: BytesLike, record_cid: str, raw: BytesLike, entry_hash: BytesLike) -> bool:
    """True when ``entry_hash`` is the hash of this link in the chain."""
    expected = compute_entry_hash(prev_hash, record_cid, raw)
    return expected == _as_bytes(entry_hash, "entry_hash")
