"""GET /v1/records/{cid}: read back one stored envelope (plugin: ledger).

Feature 15: anyone holding a record's cid can read the envelope this node
appended to its event log, as JSON::

    GET /v1/records/bafyreihbppt2cuitohaq...

    200 OK
    {
      "v": 1,
      "type": "paper.version",
      "author": "did:key:z6Mk...",
      "created": "2026-11-14T05:33:00Z",
      "prev": null,
      "body": {"...": "..."},
      "proofs": [],
      "id": "bafyreihbppt2cuitohaq..."
    }

The document served is the stored envelope itself, rebuilt from exactly
what ``event_log`` kept (feature 12): the canonical DAG-CBOR bytes in
``raw`` -- the seven content fields ``v``, ``type``, ``author``,
``created``, ``prev``, ``body`` and ``proofs`` that
:func:`scholium_record_core.record_bytes` encoded and the record id
commits to -- decoded back to JSON, with ``id`` set to the row's
``record_cid``.  The served JSON therefore round-trips: recomputing
:func:`scholium_record_core.compute_record_id` over it returns the cid in
the URL, so a client can confirm it was served what it asked for without
trusting the node.

``id`` and ``sig`` are the two envelope fields excluded from the record
id; of those, only ``id`` is a column of the log.  ``sig`` is checked at
ingest and not retained by ``event_log``, so it is not part of the
response -- the ledger's own attestation over the stored record is served
by ``GET /v1/records/{cid}/proof`` instead.

A cid with no entry in the log -- including one that is not a well-formed
record id at all -- is a 404 RFC 9457 problem details response.
"""

from __future__ import annotations

import base64
from typing import Any, List, Optional

import dag_cbor
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from scholium_record_core import ENVELOPE_FIELDS

from .models import EventLog
from .service import entry_by_cid

__all__ = [
    "RECORD_NOT_FOUND_TYPE",
    "RecordEnvelope",
    "router",
    "stored_envelope",
]

#: Router the module loader mounts under ``/v1`` (serves ``/v1/records/{cid}``).
router = APIRouter(prefix="/records", tags=["records"])

#: Problem-details type URN for a cid that has no entry in the event log.
RECORD_NOT_FOUND_TYPE = "urn:scholium:problem:record-not-found"

#: Longest cid shown verbatim in a problem detail before ellipsis.
_SHOW_LIMIT = 60


class RecordEnvelope(BaseModel):
    """The stored record envelope exactly as ``GET /v1/records/{cid}`` serves it.

    Field order follows the envelope definition in
    :mod:`scholium_record_core.envelope`; ``id`` is the row's
    ``record_cid``.
    """

    model_config = ConfigDict(extra="forbid")

    v: int
    type: str
    author: str
    created: str
    #: Previous record's cid, or ``null`` for a genesis record.
    prev: Optional[str]
    body: dict[str, Any]
    proofs: List[Any]
    id: str


def _show(cid: str) -> str:
    text = str(cid)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


def _jsonable(value: Any) -> Any:
    """Map decoded DAG-CBOR values onto their JSON wire form.

    DAG-CBOR ``bytes`` have no JSON counterpart; they are served as
    standard base64, the same encoding ``GET /v1/sync/range`` uses for a
    row's ``raw`` bytes.  Every other value ``record_bytes`` can encode is
    already JSON.
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    return value


def stored_envelope(entry: EventLog) -> RecordEnvelope:
    """Rebuild the stored envelope of one :class:`EventLog` row.

    ``raw`` is decoded back into the seven content fields and ``id`` is
    set from ``record_cid``.  Because the row's ``entry_hash`` committed
    to ``raw`` and the log is append-only, what this returns is exactly
    what was appended.
    """
    content = dag_cbor.decode(bytes(entry.raw))
    envelope = {field: _jsonable(content[field]) for field in ENVELOPE_FIELDS}
    envelope["id"] = entry.record_cid
    return RecordEnvelope.model_validate(envelope)


def _record_not_found(cid: str) -> HTTPException:
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.ledger` half-initialized with no
    # `router` attribute and silently skip mounting it.  (Same reason as the
    # sync-range plugin's reversed-range rejection.)
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No record with id '{_show(cid)}' is in this node's event log.",
        type=RECORD_NOT_FOUND_TYPE,
    )


@router.get(
    "/{cid}",
    response_model=RecordEnvelope,
    summary="Read one stored record envelope by its cid",
)
def get_record(cid: str) -> RecordEnvelope:
    """Return the stored signed envelope for record id ``cid`` as JSON.

    Unknown cids -- including strings that are not well-formed record ids
    -- answer 404 problem details.
    """
    entry = entry_by_cid(cid)
    if entry is None:
        raise _record_not_found(cid)
    return stored_envelope(entry)
