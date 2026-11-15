"""verify_log: recompute the event log's hash chain (feature 18).

:func:`verify_log` checks a sequence of log entries against the rule every
:func:`~app.modules.ledger.service.append` committed to::

    entry_hash_i  == sha256(prev_hash_i || utf8(record_cid_i) || raw_i)
    prev_hash_i   == entry_hash_(i-1)          (genesis: 32 zero bytes)

    from app.modules import ledger

    ledger.verify_log(ledger.entries())        # None: the chain is intact
    ledger.verify_log(ledger.entries())        # 42: seq 42 is the first break

It returns the **first broken seq** -- the earliest ``seq`` at which the
sequence stops being the chain the node committed to -- and ``None`` when
every entry verifies.  Rewriting, reordering or removing a row all show up
as a break, because each row's hash covers its predecessor's hash:

* **rewritten** -- a row's ``raw``, ``record_cid``, ``prev_hash`` or
  ``entry_hash`` was edited.  The row's own hash no longer recomputes (or,
  if the attacker also recomputed it, the *next* row no longer links to
  it).  The reported seq is the first row that cannot be reproduced.
* **reordered** -- the rows are not in ascending ``seq`` order.  The
  reported seq is the first expected seq the sequence does not supply in
  its place, so ``[1, 3, 2]`` reports ``2``.
* **removed** -- a row is missing.  Rows are expected to be consecutive,
  so a gap reports the first missing seq; ``[1, 2, 4]`` reports ``3``.
  Removing the *first* row is detected for the same reason: a full log
  starts at seq 1.

Because a hash chain commits "backwards only", the first entry needs an
anchor for its own ``prev_hash``.  By default the sequence is verified as a
**whole log**: it must start at seq 1 with
:data:`~app.modules.ledger.hashing.GENESIS_PREV_HASH` as its predecessor.
To verify a **window** -- one page of ``GET /v1/sync/range``, say -- pass
the ``entry_hash`` of the row just before the window as ``anchor``::

    held = ledger.entries(through=499)[-1]     # the last row the caller holds
    page = ledger.entries(after=499, through=999)
    ledger.verify_log(page, anchor=held.entry_hash)

With an anchor, the window's first row is still linked (to the anchor) but
its ``seq`` may be anything; from there rows must be consecutive.

Input
-----

``entries`` is an iterable of log entries in ``seq`` order.  Each entry may
be:

* a persisted :class:`~app.modules.ledger.models.EventLog` row (what
  :func:`~app.modules.ledger.service.entries` returns),
* a plain mapping with the same keys (``EventLog.to_dict()``), or
* an object with the same attributes, such as the sync range's
  ``SyncEntry`` wire model.

Hashes (``prev_hash``, ``entry_hash``) may be raw bytes-like or lowercase
hexadecimal strings; ``raw`` may be the canonical DAG-CBOR bytes or their
standard-base64 form.  Both wire encodings are what ``GET /v1/sync/range``
serves, so a third party can verify a replayed page without decoding it::

    ledger.verify_log(response.json())

The function only reads: it never raises on a broken chain, and it never
writes to (or repairs) the log.  Malformed *input* -- a non-iterable, a
missing field, a ``seq`` that is not an integer, a hash that is neither
bytes nor hex -- raises ``TypeError``/``ValueError`` rather than being
reported as a break.

A broken link is reported, not diagnosed: the caller knows which seq to
fetch and inspect.  Detecting that the *tail* was truncated (removing the
last row) needs knowledge the sequence does not carry -- compare the last
``seq`` with the signed head (``GET /v1/sync/head``) for that.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Iterable, Mapping
from typing import Any, Optional, Union

from .hashing import GENESIS_PREV_HASH, compute_entry_hash

__all__ = ["verify_log"]

HashLike = Union[bytes, bytearray, memoryview, str]


def _field(entry: Any, name: str) -> Any:
    """Read ``name`` from a mapping or an attribute-bearing entry."""
    if isinstance(entry, Mapping):
        try:
            return entry[name]
        except KeyError:
            raise TypeError(f"a log entry is missing the {name!r} field") from None
    try:
        return getattr(entry, name)
    except AttributeError:
        raise TypeError(
            f"a log entry of type {type(entry).__name__} has no {name!r} attribute"
        ) from None


def _hash_bytes(value: Any, name: str) -> bytes:
    """Normalise a hash column: raw bytes-like, or a hexadecimal string."""
    if isinstance(value, str):
        try:
            return bytes.fromhex(value)
        except ValueError:
            raise ValueError(f"{name} is not valid hexadecimal: {value!r}") from None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    raise TypeError(
        f"{name} must be bytes or a hexadecimal string, got {type(value).__name__}"
    )


def _raw_bytes(value: Any) -> bytes:
    """Normalise ``raw``: canonical DAG-CBOR bytes, or their base64 wire form."""
    if isinstance(value, str):
        try:
            return base64.b64decode(value.encode("ascii"), validate=True)
        except (binascii.Error, ValueError):
            raise ValueError(f"raw is not valid standard base64: {value!r}") from None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    raise TypeError(
        f"raw must be bytes or a base64 string, got {type(value).__name__}"
    )


def verify_log(
    entries: Iterable[Any],
    *,
    anchor: Optional[HashLike] = None,
) -> Optional[int]:
    """Return the first broken seq in ``entries``, or ``None`` if intact.

    Recomputes every entry's ``entry_hash`` from its own fields and checks
    that each entry links to its predecessor's hash, in ``seq`` order.  The
    sequence is verified as a whole log (from seq 1, genesis anchor) unless
    ``anchor`` -- the ``entry_hash`` of the entry just before the window --
    is given.

    Raises ``TypeError`` for input that is not an iterable of entries or is
    missing a field, and ``ValueError`` for values of the wrong encoding.
    A well-formed but broken chain is *reported*, never raised: the return
    value is the seq of the first entry (or first expected seq) that does
    not verify.
    """
    try:
        iterator = iter(entries)
    except TypeError:
        raise TypeError(
            "verify_log expects an iterable of log entries, got "
            f"{type(entries).__name__}"
        ) from None

    if anchor is None:
        expected_prev: Optional[bytes] = GENESIS_PREV_HASH
        expected_seq: Optional[int] = 1
    else:
        expected_prev = _hash_bytes(anchor, "anchor")
        expected_seq = None

    for entry in iterator:
        seq = _field(entry, "seq")
        if isinstance(seq, bool) or not isinstance(seq, int):
            raise TypeError(f"seq must be an integer, got {type(seq).__name__}")

        record_cid = _field(entry, "record_cid")
        if not isinstance(record_cid, str):
            raise TypeError(
                f"record_cid must be a string, got {type(record_cid).__name__}"
            )

        prev_hash = _hash_bytes(_field(entry, "prev_hash"), "prev_hash")
        entry_hash = _hash_bytes(_field(entry, "entry_hash"), "entry_hash")
        raw = _raw_bytes(_field(entry, "raw"))

        # Rows must appear in seq order and without holes, so a reordered or
        # removed row surfaces at the first seq the sequence fails to place.
        if expected_seq is not None and seq != expected_seq:
            return min(seq, expected_seq)

        # The link: this row must commit to the predecessor's hash.
        if expected_prev is not None and prev_hash != expected_prev:
            return seq

        # The row's own hash: its fields must still produce entry_hash.
        if compute_entry_hash(prev_hash, record_cid, raw) != entry_hash:
            return seq

        expected_prev = entry_hash
        expected_seq = seq + 1

    return None
