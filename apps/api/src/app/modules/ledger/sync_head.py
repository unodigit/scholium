"""GET /v1/sync/head: the node-signed log head (plugin: ledger).

Feature 14: a peer that mirrors or audits this node's log needs to pin the
head it has seen, so that the node cannot later serve a different history for
the same point in time (docs/tech_architect.md, "Transparency log": each node
signs its log head ``(seq, entryHash)``; two different signed heads for the
same ``seq`` are an equivocation proof)::

    GET /v1/sync/head

    200 OK
    {
      "seq": 41,
      "entry_hash": "9f86d081884c7d659a2feaa0c55ad015...",
      "node_did": "did:key:z6MkfZrSg...",
      "signature": "VXJ4a1RJRldBd29KcEJRd01RT..."
    }

* ``seq`` / ``entry_hash`` are the current last entry of the event log -- the
  same head :func:`app.modules.ledger.service.latest` returns, with the
  32-byte digest in hex, the wire form ``GET /v1/sync/range`` serves.  An
  empty log has the genesis head: ``seq`` 0 and the all-zero digest
  :data:`GENESIS_PREV_HASH`, so even a node that has appended nothing yet
  commits to "still nothing" and cannot equivocate about it later.
* ``node_did`` is the ``did:key`` of the node Ed25519 key loaded from
  ``NODE_KEY_PATH`` (the same file :mod:`app.modules.ledger.origin` reads for
  ``origin_node``).  It is derived from the signing key itself, so the
  ``NODE_DID``-style environment overrides never detach the DID a head is
  published under from the key that signed it.
* ``signature`` is that key's Ed25519 signature over the head, served as
  unpadded base64url exactly like record signatures.

Signed bytes (:func:`head_message`): the canonical JSON object of the three
response fields -- ``entry_hash`` (lowercase hex), ``node_did`` and ``seq`` --
sorted by key with compact separators, encoded as UTF-8::

    {"entry_hash":"<64 hex>","node_did":"did:key:...","seq":41}

Including ``node_did`` binds the signer into the signed statement, making each
response a self-contained, replayable attestation.

The key file is read on every request (rotation takes effect without a
restart).  A node whose key is missing or unreadable cannot sign a head, so
the endpoint answers ``503`` RFC 9457 problem details rather than an
unsigned or wrongly-signed body.
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from scholium_record_core import encode_signature

from .hashing import GENESIS_PREV_HASH
from .models import EventLog
from .origin import did_key_from_public_key, node_signing_key
from .service import latest

__all__ = [
    "GENESIS_HEAD",
    "NODE_KEY_UNAVAILABLE_TYPE",
    "SyncHead",
    "head_message",
    "router",
    "signed_head",
]

#: Router the module loader mounts under ``/v1`` (serves ``/v1/sync/head``).
router = APIRouter(prefix="/sync", tags=["sync"])

#: Problem-details type URN for a node key that cannot be loaded or signed with.
NODE_KEY_UNAVAILABLE_TYPE = "urn:scholium:problem:node-key-unavailable"

#: The head of a log with no entries: ``seq`` 0 over the genesis digest.
GENESIS_HEAD = (0, GENESIS_PREV_HASH)


class SyncHead(BaseModel):
    """The node-signed log head as served by ``GET /v1/sync/head``."""

    model_config = ConfigDict(extra="forbid")

    #: Sequence number of the log's last entry (0 for an empty log).
    seq: int
    #: That entry's 32-byte ``entry_hash`` in hex (all zeros for an empty log).
    entry_hash: str
    #: ``did:key`` of the Ed25519 key at ``NODE_KEY_PATH`` -- the signer.
    node_did: str
    #: Ed25519 signature over :func:`head_message`, unpadded base64url.
    signature: str


def head_message(seq: int, entry_hash: bytes, node_did: str) -> bytes:
    """Return the exact bytes this node signs for head ``(seq, entry_hash)``.

    Canonical JSON of ``entry_hash`` (lowercase hex), ``node_did`` and ``seq``
    -- keys sorted, no insignificant whitespace, UTF-8 -- the same
    serialisation discipline as canonical DAG-CBOR: fixed field order, one
    possible encoding.
    """
    return json.dumps(
        {
            "entry_hash": bytes(entry_hash).hex(),
            "node_did": node_did,
            "seq": int(seq),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def signed_head(key, entry: Optional[EventLog]) -> SyncHead:
    """Sign the head of ``entry`` (the genesis head when ``None``) with ``key``.

    ``key`` is the :class:`nacl.signing.SigningKey` from
    :func:`~app.modules.ledger.origin.node_signing_key`; the returned
    ``node_did`` is derived from it so the signature always verifies against
    the DID the head is published under.
    """
    seq, digest = (int(entry.seq), bytes(entry.entry_hash)) if entry is not None else GENESIS_HEAD
    did = did_key_from_public_key(bytes(key.verify_key))
    signature = key.sign(head_message(seq, digest, did)).signature
    return SyncHead(
        seq=seq,
        entry_hash=digest.hex(),
        node_did=did,
        signature=encode_signature(signature),
    )


def _node_key_unavailable() -> HTTPException:
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.ledger` half-initialized with no
    # `router` attribute and silently skip mounting it.  (Same reason as the
    # sync-range plugin's reversed-range rejection.)
    from app.errors import ProblemException

    from app.settings import settings

    return ProblemException(
        503,
        "This node cannot sign its log head: no usable Ed25519 key was found "
        f"at NODE_KEY_PATH ({settings.NODE_KEY_PATH!r}). Provision the node "
        "key and retry.",
        type=NODE_KEY_UNAVAILABLE_TYPE,
    )


@router.get(
    "/head",
    response_model=SyncHead,
    summary="Return the node-signed head of this node's event log",
)
def get_sync_head() -> SyncHead:
    """Return ``(seq, entry_hash)`` signed with the node key from ``NODE_KEY_PATH``.

    Answers ``503`` problem details when that key cannot be loaded.
    """
    key = node_signing_key()
    if key is None:
        raise _node_key_unavailable()
    return signed_head(key, latest())
