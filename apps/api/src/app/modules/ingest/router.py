"""``POST /v1/records``: submit a client-signed record (plugin: ingest).

Feature 20: every write on this API is a client-signed record envelope::

    POST /v1/records
    Authorization: Bearer <access token>
    Content-Type: application/json

    {"v": 1, "type": "endorsement", "author": "did:key:z6Mk...",
     "created": "2026-11-14T05:33:00Z", "prev": null,
     "body": {...}, "proofs": [], "id": "bafyrei...", "sig": "..."}

    201 Created
    {"id": "bafyrei...", "shortId": null, "state": "accepted",
     "anchor": "pending"}

The pipeline is :func:`app.modules.ingest.service.ingest`, which validates the
envelope and its body, recomputes the cid, verifies the signature against the
author's active key, runs the type handler and appends the record to the event
log.  ``id`` is the record's cid; ``shortId`` is the ``sch:`` id of the paper
the record belongs to (``paper.genesis`` and ``paper.version`` only, ``null``
otherwise); ``state`` is what the handler reported (or ``"accepted"``); and
``anchor`` is always ``"pending"`` -- this node does not anchor its log
on-chain yet, and reports that as a state rather than an error.

Refusals are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no usable access token, or the record's signature does not verify
  against the author's active key (:class:`InvalidRecordSignature`);
* ``409`` -- the cid is already in the event log (:class:`DuplicateRecord`);
* ``422`` -- the envelope or its body is invalid (:class:`InvalidRecord`), the
  id is not the recomputed cid (:class:`RecordIdMismatch`), or no module
  registered the record type (:class:`UnknownRecordType`).

A refused record never reaches the ledger, so ``GET /v1/records/{cid}`` keeps
answering 404 for it.

Feature 22: an optional ``Idempotency-Key`` header makes the submission safe to
retry.  The first ``201`` is stored under the key in the ``idempotency_keys``
table; a repeat with the same key answers that stored ``201`` again (marked
``Idempotent-Replayed: true``) without running the handler or touching the
ledger.  A key reused for a *different* record is a ``422``
(:class:`IdempotencyKeyReused`), and a blank or over-long key is a ``422``
(:class:`InvalidIdempotencyKey`).  See :mod:`app.modules.ingest.idempotency`.

The endpoint requires an authenticated caller (any tier): the middleware that
throttles writes keys on the access token, and feature 21 enforces the
handler's ``min_tier`` against the author's account tier.  The *record's*
authority comes from its signature, so the caller need not be the author --
relaying an authentic record is allowed.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Depends, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app.security import require_tier

from . import idempotency
from .service import ANCHOR_PENDING, IngestResult, ingest

__all__ = [
    "RecordAccepted",
    "router",
]

#: Router the module loader mounts under ``/v1`` (serves ``POST /v1/records``).
router = APIRouter(prefix="/records", tags=["records"])


class RecordAccepted(BaseModel):
    """The ``201 Created`` body of ``POST /v1/records``."""

    model_config = ConfigDict(extra="forbid")

    #: The record's cid -- the CID recomputed from its content.
    id: str
    #: The paper's ``sch:`` id, for paper records; ``null`` for every other type.
    shortId: Optional[str] = None
    #: The state the type handler reported, or ``"accepted"``.
    state: str
    #: Public-timestamp status; always ``"pending"`` until anchoring exists.
    anchor: Literal["pending"] = ANCHOR_PENDING

    @classmethod
    def from_result(cls, result: IngestResult) -> "RecordAccepted":
        """Build the wire document from what the pipeline returned."""
        return cls(
            id=result.record_id,
            shortId=result.short_id,
            state=result.state,
            anchor=result.anchor,
        )


@router.post(
    "",
    status_code=201,
    response_model=RecordAccepted,
    summary="Submit a client-signed record",
    dependencies=[Depends(require_tier(0))],
)
def post_record(
    record: dict[str, Any] = Body(..., description="The signed record envelope."),
    idempotency_key: Optional[str] = Header(
        default=None,
        alias=idempotency.HEADER,
        description=(
            "Makes the submission safe to retry: a repeat with the same key "
            "replays the first 201 instead of failing as a duplicate."
        ),
    ),
) -> Any:
    """Validate, verify and append one signed record; return its cid and state."""
    if idempotency_key is None:
        return RecordAccepted.from_result(ingest(record))

    response, replayed = idempotency.execute(
        idempotency.normalise_key(idempotency_key),
        record,
        lambda: RecordAccepted.from_result(ingest(record)).model_dump(),
    )
    if replayed:
        # The stored body goes back exactly as it was first sent.
        return JSONResponse(
            response, status_code=201, headers={idempotency.REPLAYED_HEADER: "true"}
        )
    return response
