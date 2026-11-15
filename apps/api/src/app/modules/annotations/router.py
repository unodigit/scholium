"""``POST /v1/annotations``: submit a signed annotation (plugin: annotations).

Feature 103: a client-signed ``discussion.post`` record whose anchor names a
version cid, a ``paragraph_id``, a ``quote`` and an ``offset`` is accepted
through the standard ingest pipeline and answers ``201 Created``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel

from app.security import require_tier

from app.modules.ingest.router import RecordAccepted
from app.modules.ingest.service import ingest

__all__ = ["router"]

router = APIRouter(prefix="/annotations", tags=["annotations"])


@router.post(
    "",
    status_code=201,
    response_model=RecordAccepted,
    summary="Submit a signed annotation",
    dependencies=[Depends(require_tier(0))],
)
def post_annotation(
    record: dict[str, Any] = Body(..., description="The signed discussion.post envelope."),
) -> RecordAccepted:
    """Validate, verify and append one signed annotation; return its cid and state."""
    return RecordAccepted.from_result(ingest(record))
