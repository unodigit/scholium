"""GET /v1/sync/range: replay a seq window of the event log (plugin: ledger).

Feature 17: a third party that wants its own copy of this node's log -- to
audit it, mirror it, or recheck the hash chain -- replays it one seq
window at a time::

    GET /v1/sync/range?from=0&to=499

    200 OK
    [
      {
        "seq": 1,
        "record_cid": "bafyrei...",
        "record_type": "paper.version",
        "author_did": "did:key:z6Mk...",
        "body": {"...": "..."},
        "raw": "<base64 canonical DAG-CBOR>",
        "prev_hash": "0000...00",
        "entry_hash": "9f86...08f",
        "received_at": "2026-11-15T09:30:12Z",
        "origin_node": "did:key:z6Mk..."
      },
      ...
    ]

Bounds follow the ledger's cursor semantics (the same ones
:func:`app.modules.ledger.service.entries` implements):

* ``from`` is the **exclusive** lower bound -- the last ``seq`` the caller
  already holds.  ``from=0`` (the default) replays from the first entry,
  so a fresh verifier starts at the genesis link.
* ``to`` is the **inclusive** upper bound; omit it to read through the
  current head (bound it, or pass ``limit``, when replaying a live log).

Entries come back in ``seq`` order and carry every persisted column, which
is exactly what an offline verifier needs: ``raw`` is the canonical
DAG-CBOR bytes the record id commits to (base64) and
``prev_hash``/``entry_hash`` are the 32-byte SHA-256 digests in hex, so
both chain rules can be recomputed client-side::

    entry_hash  == sha256(prev_hash || utf8(record_cid) || raw)
    prev_hash_i == entry_hash_(i-1)        (genesis: 32 zero bytes)

Errors are RFC 9457 problem details via the app-wide handlers: ``400``
for a reversed range (``to`` below ``from``) and ``422`` for bounds that
are not non-negative integers.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, field_serializer

from .models import EventLog
from .service import entries

__all__ = [
    "MAX_PAGE",
    "REVERSED_RANGE_TYPE",
    "SyncEntry",
    "router",
    "serialise_entry",
]

#: Router the module loader mounts under ``/v1`` (serves ``/v1/sync/range``).
router = APIRouter(prefix="/sync", tags=["sync"])

#: Largest page this endpoint returns in one response.
MAX_PAGE = 1000

#: Problem-details type URN for a range whose ``to`` precedes its ``from``.
REVERSED_RANGE_TYPE = "urn:scholium:problem:reversed-sync-range"


class SyncEntry(BaseModel):
    """One ``event_log`` row as served to a replaying third party."""

    model_config = ConfigDict(extra="forbid")

    seq: int
    record_cid: str
    record_type: str
    author_did: str
    body: dict[str, Any]
    #: Canonical DAG-CBOR bytes of the record, standard base64.
    raw: str
    #: The author's detached signature over ``raw``, when the node retained one
    #: (ingest always passes a signed record). ``None`` for unsigned entries.
    sig: Optional[str] = None
    #: Previous entry's ``entry_hash`` in hex; 32 zero bytes for the first entry.
    prev_hash: str
    #: ``sha256(prev_hash || record_cid || raw)`` in hex.
    entry_hash: str
    #: UTC instant the node appended the record (ISO 8601, ``Z`` suffix).
    received_at: datetime
    origin_node: str

    @field_serializer("received_at")
    def _serialise_received_at(self, value: datetime) -> str:
        # event_log stores naive UTC timestamps; serve one unambiguous instant.
        return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def serialise_entry(entry: EventLog) -> SyncEntry:
    """Map one persisted row onto its wire form (hex hashes, base64 raw)."""
    return SyncEntry(
        seq=int(entry.seq),
        record_cid=entry.record_cid,
        record_type=entry.record_type,
        author_did=entry.author_did,
        body=dict(entry.body),
        raw=base64.b64encode(bytes(entry.raw)).decode("ascii"),
        sig=entry.sig,
        prev_hash=bytes(entry.prev_hash).hex(),
        entry_hash=bytes(entry.entry_hash).hex(),
        received_at=entry.received_at,
        origin_node=entry.origin_node,
    )


def _reversed_range(from_seq: int, to_seq: int) -> HTTPException:
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.ledger` half-initialized with no
    # `router` attribute and silently skip mounting it.  (Same reason as the
    # uploads plugin's too-large rejection.)
    from app.errors import ProblemException

    return ProblemException(
        400,
        f"The sync range is reversed: 'to' ({to_seq}, inclusive) must not be "
        f"below 'from' ({from_seq}, exclusive).",
        type=REVERSED_RANGE_TYPE,
    )


@router.get(
    "/range",
    response_model=List[SyncEntry],
    summary="Replay a seq window of the event log",
)
def get_sync_range(
    from_: Optional[int] = Query(
        default=None,
        alias="from",
        ge=0,
        description=(
            "Exclusive lower bound: entries with a greater seq are returned. "
            "This is the last seq the caller already holds; omit it (or send 0) "
            "to replay from the first entry."
        ),
    ),
    to: Optional[int] = Query(
        default=None,
        ge=0,
        description="Inclusive upper bound on seq; omit to read through the current head.",
    ),
    limit: Optional[int] = Query(
        default=None,
        ge=1,
        le=MAX_PAGE,
        description=f"Cap on entries per response (at most {MAX_PAGE}); useful with an open-ended 'to'.",
    ),
) -> List[SyncEntry]:
    """Return log entries in ``seq`` order with their chain hashes."""
    after = from_ if from_ is not None else 0
    if to is not None and to < after:
        raise _reversed_range(after, to)
    rows = entries(after=after, through=to, limit=limit)
    return [serialise_entry(row) for row in rows]
