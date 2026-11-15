"""HTTP routes for the appeals plugin.

The module loader mounts this router under ``/v1``, so the route below serves
``POST /v1/appeals``.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel

from app.errors import ProblemException
from app.modules import submissions
from app.modules.ingest import ingest
from app.security import require_tier

from .service import APPEAL_TYPE, apply_appeal, resolve_decision

__all__ = ["AppealAccepted", "router"]

router = APIRouter(prefix="/appeals", tags=["appeals"])


class AppealAccepted(BaseModel):
    """The ``201 Created`` body of ``POST /v1/appeals``."""

    #: The appeal record's cid (also its ``appeal_cid`` in ``appeals``).
    id: str
    #: The version's ``sch:xxxx-xxxx-xxxx/vN`` id, when the paper is indexed.
    shortId: Optional[str] = None
    #: cid of the moderation decision that was appealed.
    target: str
    #: Where the appeal stands; ``pending`` until a panel decides it.
    status: str
    #: Public-timestamp status; always ``"pending"`` until anchoring exists.
    anchor: str = "pending"


@router.post(
    "",
    status_code=201,
    response_model=AppealAccepted,
    summary="Appeal a moderation decision",
    dependencies=[Depends(require_tier(0))],
)
def post_appeal(
    record: dict[str, Any] = Body(..., description="The signed appeal envelope."),
) -> AppealAccepted:
    """Accept a signed ``appeal`` of a moderation decision, once.

    The appeal goes through the same pipeline as ``POST /v1/records`` --
    envelope, body schema (``target`` and ``grounds`` are required), cid,
    signature -- and then this plugin's checks: ``target`` must be a
    ``moderation.decision`` this node holds, the signer must be an author of
    the paper it was about, and the decision must not have been appealed
    already.  An accepted appeal is appended to the public log
    (``GET /v1/records/{cid}``) and saved to ``appeals`` with status
    ``pending``.

    Failures are RFC 9457 problem details: ``401`` for a missing token or a bad
    signature, ``403`` when the signer is not an author of the paper, ``409``
    when the decision has been appealed already (or the record is a repeat),
    ``422`` for an invalid record, blank grounds or an unknown target.
    """
    if record.get("type") != APPEAL_TYPE:
        raise ProblemException(
            422,
            f"This endpoint accepts {APPEAL_TYPE!r} records, got {record.get('type')!r}.",
            errors=[
                {
                    "loc": ["body", "type"],
                    "msg": f"The record must be an {APPEAL_TYPE}.",
                    "type": "wrong_record_type",
                    "input": record.get("type"),
                }
            ],
        )

    result = ingest(record)
    # The ledger subscriber normally saved the appeal as it was appended; this
    # is a no-op then, and the one that reports a failure when it did not.
    appeal = apply_appeal(record)

    short_id: Optional[str] = None
    decision = resolve_decision(appeal.decision_cid)
    paper = submissions.get_paper(decision.paper_cid)
    version = submissions.get_version(decision.version_cid)
    if paper is not None and version is not None:
        short_id = f"{paper.short_id}/v{int(version.n)}"

    return AppealAccepted(
        id=result.record_id,
        shortId=short_id,
        target=str(appeal.decision_cid),
        status=str(appeal.status),
        anchor=result.anchor,
    )
