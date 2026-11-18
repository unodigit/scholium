"""HTTP routes for the appeals plugin.

The module loader mounts this router under ``/v1``, so the routes below serve
``POST /v1/appeals``, ``GET /v1/appeals/{cid}`` and
``POST /v1/appeals/{cid}/votes``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Optional

from fastapi import APIRouter, Body, Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.errors import ProblemException
from app.modules import submissions
from app.modules.ingest import ingest
from app.security import Principal, Tier, get_current_principal, require_tier

from .errors import AppealNotFound
from .panel import get_panel
from .service import APPEAL_TYPE, apply_appeal, get_appeal, resolve_decision
from .votes import cast_vote, decision_for_appeal, vote_fields

__all__ = ["AppealAccepted", "AppealDetailOut", "PanelSeatOut", "VoteAccepted", "router"]

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
    version = None
    if decision.version_cid is not None:
        version = submissions.get_version(decision.version_cid)
    elif paper is not None and getattr(paper, "latest_version_cid", None):
        version = submissions.get_version(paper.latest_version_cid)
    if paper is not None and version is not None:
        short_id = f"{paper.short_id}/v{int(version.n)}"

    return AppealAccepted(
        id=result.record_id,
        shortId=short_id,
        target=str(appeal.decision_cid),
        status=str(appeal.status),
        anchor=result.anchor,
    )


class PanelSeatOut(BaseModel):
    """One seat on an appeal's panel."""

    #: The seated member's DID.
    did: str
    #: Alias of ``did``, matching ``appeal_panels.member_did``.
    member_did: str
    #: Alias of ``did``.
    member: str
    #: The member's vote, or ``null`` until they vote.
    vote: Optional[str] = None


class AppealDetailOut(BaseModel):
    """The ``200 OK`` body of ``GET /v1/appeals/{cid}``.

    ``panel`` is filled in only for a caller who holds a seat on it or whose
    tier is 4 (:attr:`viewer_on_panel` says which): a seat is not public, and
    showing it to other readers would let them lobby the panel and would tell
    a member they were *not* drawn.
    """

    #: cid of the appeal record.
    id: str
    #: Alias of ``id``, matching ``appeals.appeal_cid``.
    appeal_cid: str
    #: cid of the ``moderation.decision`` being appealed.
    decision_cid: str
    #: Alias of ``decision_cid``.
    decision: str
    #: The DID that signed the appeal.
    appellant_did: str
    #: Alias of ``appellant_did``.
    appellant: str
    #: Why the decision is appealed.
    grounds: str
    #: ``pending`` until a panel decides it, then the panel's outcome.
    status: str
    #: When the appeal record is dated (UTC).
    filed_at: datetime
    #: The panel's outcome once it has decided, else ``null``.
    outcome: Optional[str] = None
    #: cid of the ``appeal.decision`` record, once there is one.
    resolution: Optional[str] = None
    #: Whether the caller holds a seat on this appeal's panel.
    viewer_on_panel: bool = False
    #: Who sits on the panel; empty unless the caller is seated or tier 4.
    panel: list[PanelSeatOut] = []


#: Bearer credentials, read to widen the appeal view for its panel and tier 4.
_bearer = HTTPBearer(auto_error=False)


def _optional_principal(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """The caller when a token is sent; ``None`` for a reader with none."""
    if credentials is None:
        return None
    return get_current_principal(request, credentials)


@router.get(
    "/{cid}",
    response_model=AppealDetailOut,
    summary="Read one appeal; its panel to the panel and to moderators",
)
def get_appeal_detail(
    cid: str,
    caller: Optional[Principal] = Depends(_optional_principal),
) -> AppealDetailOut:
    """Return appeal ``cid``; its panel only to the seated members and tier 4.

    The appeal itself is a public record, so any reader may see it, with no
    token at all.  The three members the draw seated are not public: ``panel``
    is filled in only for a caller holding a seat on it or at tier 4
    (Moderator).  An unknown cid is ``404`` problem details.
    """
    appeal = get_appeal(cid)
    if appeal is None:
        raise AppealNotFound(cid)

    seats = get_panel(cid)
    on_panel = caller is not None and caller.did in {str(seat.member_did) for seat in seats}
    may_see_panel = on_panel or (caller is not None and caller.tier >= int(Tier.MODERATOR))

    decision = decision_for_appeal(cid)
    outcome: Optional[str] = None
    resolution: Optional[str] = None
    if decision is not None:
        resolution = str(decision.record_cid)
        body = decision.body if isinstance(decision.body, Mapping) else {}
        if isinstance(body.get("outcome"), str):
            outcome = body["outcome"]

    return AppealDetailOut(
        id=str(appeal.appeal_cid),
        appeal_cid=str(appeal.appeal_cid),
        decision_cid=str(appeal.decision_cid),
        decision=str(appeal.decision_cid),
        appellant_did=str(appeal.appellant_did),
        appellant=str(appeal.appellant_did),
        grounds=str(appeal.grounds),
        status=str(appeal.status),
        filed_at=appeal.filed_at,
        outcome=outcome,
        resolution=resolution,
        viewer_on_panel=on_panel,
        panel=[
            PanelSeatOut(
                did=str(seat.member_did),
                member_did=str(seat.member_did),
                member=str(seat.member_did),
                vote=seat.vote,
            )
            for seat in seats
            if may_see_panel
        ],
    )


class VoteAccepted(BaseModel):
    """The ``200 OK`` body of ``POST /v1/appeals/{cid}/votes``."""

    #: cid of the appeal that was voted on.
    appeal: str
    #: The outcome the caller backed.
    vote: str
    #: Always ``True``: the vote was accepted and recorded.
    counted: bool = True
    #: How many of the panel's three seats now carry a vote.
    votes: int
    #: cid of the ``appeal.decision`` once two seats agree, else ``None``.
    decision: Optional[str] = None
    #: The outcome the panel agreed on, when the appeal has been decided.
    outcome: Optional[str] = None
    #: When this vote was recorded (UTC).
    votedAt: Optional[datetime] = None


@router.post(
    "/{cid}/votes",
    status_code=200,
    response_model=VoteAccepted,
    summary="Cast a panel member's vote on an appeal",
)
def post_vote(
    cid: str,
    body: dict[str, Any] = Body(..., description="The vote: {'vote'|'outcome', 'reasons'}."),
    principal: Principal = Depends(require_tier(int(Tier.READER))),
) -> VoteAccepted:
    """Record the caller's vote on appeal ``cid``; decide it when two seats agree.

    The caller must be one of the three members seated on this appeal's panel;
    anyone else is a ``403``.  The vote is saved to ``appeal_panels.vote`` and
    the reasons beside it.  When two members of the three back the same
    outcome, the node signs and appends an ``appeal.decision`` (``outcome`` and
    ``reasons``, targeting the appeal) to the public log, retrievable from
    ``GET /v1/records/{cid}``.

    The outcome may be sent as ``outcome`` or ``vote`` and the reasons as
    ``reasons`` or ``reason``; a member's latest vote replaces their earlier
    one, and a vote cast after the decision reports that same decision without
    producing a second one.

    Failures are RFC 9457 problem details: ``401`` for a missing or invalid
    token, ``403`` when the caller holds no seat on the panel, ``404`` for an
    unknown appeal, ``409`` when no panel is seated yet, ``422`` for an unknown
    outcome, and ``503`` when a majority agreed but the node has no signing key.
    """
    outcome, reasons = vote_fields(body)
    result = cast_vote(cid, principal.did, outcome, reasons)
    from datetime import datetime, timezone

    return VoteAccepted(
        appeal=result.appeal_cid,
        vote=result.outcome,
        counted=True,
        votes=result.votes_cast,
        decision=result.decision_cid,
        outcome=result.decided_outcome,
        votedAt=datetime.now(timezone.utc),
    )
