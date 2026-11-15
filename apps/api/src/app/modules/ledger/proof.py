"""GET /v1/records/{cid}/proof: the ledger's proof for one record (plugin: ledger).

Feature 16: a client that fetched a record by cid asks the node what the
ledger attests about it (docs/tech_architect.md, "Verification algorithm":
``proof = fetch(/records/{v.id}/proof)``)::

    GET /v1/records/bafyreihbppt2cuitohaq.../proof

    200 OK
    {
      "seq": 38,
      "entry_hash": "9f86d081884c7d659a2feaa0c55ad015...",
      "prev_hash": "2c26b46b68ffc68ff99b453c1d304134...",
      "head": {
        "seq": 41,
        "entry_hash": "60303ae22b998861bce3b28f33eec1be...",
        "node_did": "did:key:z6MkfZrSg...",
        "signature": "VXJ4a1RJRldBd29KcEJRd01RT..."
      },
      "anchor": "pending"
    }

* ``seq``, ``entry_hash`` and ``prev_hash`` are the record's own log entry:
  its position in the event log and the two links of the hash chain it sits
  in, the 32-byte SHA-256 digests in hex -- the wire form
  ``GET /v1/sync/range`` serves.  A client holding the envelope (from
  ``GET /v1/records/{cid}``) can recompute ``entry_hash`` as
  ``sha256(prev_hash || utf8(cid) || raw)``, where ``raw`` is
  :func:`scholium_record_core.record_bytes` of the envelope.  The first
  entry's ``prev_hash`` is the all-zero genesis digest.
* ``head`` is the node-signed log head *as of this request*: exactly the
  document ``GET /v1/sync/head`` serves (``seq``, ``entry_hash``,
  ``node_did`` and ``signature`` over :func:`~.sync_head.head_message`).
  The log is append-only, so the head's ``seq`` is at or after the record's
  and the head commits to a chain that contains the record.  Its
  ``seq``/``entry_hash`` are the *log's* last entry, not the record's --
  they equal the record's own only while it is the newest entry.
* ``anchor`` is the record's public-timestamp status.  This node does not
  anchor logs on-chain yet, so the status is always :data:`ANCHOR_PENDING`
  (``"pending"``): a state, not an error (docs/design.md, "Calm under
  failure").  The architecture's ``POST /v1/records`` response carries the
  same ``"anchor": "pending"`` token.

Errors are RFC 9457 problem details via the app-wide handlers: ``404`` for a
cid with no entry in the log (including strings that are not record ids at
all -- the same answer ``GET /v1/records/{cid}`` gives, and checked first, so
an unknown cid is a 404 even on a node with no key) and ``503`` when the node
key is missing or unreadable, because the head cannot then be signed and the
endpoint never serves an unsigned or wrongly-signed proof.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from .models import EventLog
from .origin import node_signing_key
from .records import _record_not_found
from .service import entry_by_cid, latest
from .sync_head import SyncHead, _node_key_unavailable, signed_head

__all__ = [
    "ANCHOR_PENDING",
    "RecordProof",
    "record_proof",
    "router",
]

#: Router the module loader mounts under ``/v1`` (serves ``/v1/records/{cid}/proof``).
router = APIRouter(prefix="/records", tags=["records"])

#: Anchor status of every record until the node anchors its log on-chain.
ANCHOR_PENDING = "pending"


class RecordProof(BaseModel):
    """The ledger's proof for one record as served by ``GET /v1/records/{cid}/proof``."""

    model_config = ConfigDict(extra="forbid")

    #: Sequence number of the record's entry in the event log.
    seq: int
    #: The record entry's ``sha256(prev_hash || record_cid || raw)`` in hex.
    entry_hash: str
    #: The previous entry's ``entry_hash`` in hex; 32 zero bytes for the first entry.
    prev_hash: str
    #: The node-signed head of the log now -- same document as ``GET /v1/sync/head``.
    head: SyncHead
    #: Public-timestamp status; always ``"pending"`` until anchoring exists.
    anchor: Literal["pending"]


def record_proof(entry: EventLog, head: SyncHead) -> RecordProof:
    """Build the proof of ``entry`` under the already-signed log ``head``."""
    return RecordProof(
        seq=int(entry.seq),
        entry_hash=bytes(entry.entry_hash).hex(),
        prev_hash=bytes(entry.prev_hash).hex(),
        head=head,
        anchor=ANCHOR_PENDING,
    )


@router.get(
    "/{cid}/proof",
    response_model=RecordProof,
    summary="Read the ledger's proof for one record by its cid",
)
def get_record_proof(cid: str) -> RecordProof:
    """Return the record's log position and hash links with the signed log head.

    Unknown cids -- including strings that are not well-formed record ids --
    answer 404 problem details; a node that cannot sign its head answers 503.
    """
    entry = entry_by_cid(cid)
    if entry is None:
        raise _record_not_found(cid)
    key = node_signing_key()
    if key is None:
        raise _node_key_unavailable()
    # Read after the entry: the log only grows, so this head is never before it.
    return record_proof(entry, signed_head(key, latest()))
