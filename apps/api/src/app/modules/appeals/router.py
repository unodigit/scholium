"""HTTP routes for the appeals plugin.

The module loader mounts this router under ``/v1``, so the routes below serve
``POST /v1/appeals``, ``GET /v1/appeals/{cid}`` and
``POST /v1/appeals/{cid}/votes``.
"""

from __future__ import annotations

from datetime import datetime, timezone
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
from .service import (
    APPEAL_TYPE,
    apply_appeal,
    get_appeal,
    panel_state,
    resolve_decision,
    vote_deadline,
)
from .subject import describe_subject, readable_content
from .votes import cast_vote, decide_without_panel, decision_for_appeal, vote_fields

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
    #: The caller's vote on this appeal, when they hold a seat and have voted.
    viewer_vote: Optional[str] = None
    #: When the caller's vote was cast (UTC), when they hold a seat and have
    #: voted.  A reloaded vote form opens in its recorded state with it.
    viewer_voted_at: Optional[datetime] = None
    #: How many of the panel's seats carry a vote; the panel's own tally, shown
    #: only to a caller who may see the panel (nobody else is told how the
    #: panel is getting on).
    votes_cast: int = 0
    #: cid of the record the appealed decision was about.
    target_cid: Optional[str] = None
    #: What kind of record it was: ``paper``, ``post``, ``annotation`` or ``review``.
    target_kind: Optional[str] = None
    #: The signed record type of the target (``discussion.post``, ``paper.version``, ...).
    record_type: Optional[str] = None
    #: The title of the paper the target is, or belongs to.
    paper_title: Optional[str] = None
    #: The first words of a hidden post or review; a paper has none.  ``null``
    #: unless the caller may judge or contest the decision (a seated member, a
    #: tier-4 moderator or the appellant), and for a formal review's report
    #: ``null`` while that version's report gate is closed, unless the caller is
    #: a tier-4 moderator or the review's author.
    excerpt: Optional[str] = None
    #: Where the target can be read: the paper, or the thread a post is in.
    #: ``null`` unless the caller may judge or contest the decision, like ``excerpt``.
    target_link: Optional[str] = None
    #: What the appealed decision did to it: ``hide``, ``dismiss``, ``reject``, ...
    decision_action: Optional[str] = None
    #: Who sits on the panel; empty unless the caller is seated or tier 4.
    panel: list[PanelSeatOut] = []
    #: The panel's state for a reader: ``awaiting_panel``, ``not_formed`` or
    #: ``decided``.  ``not_formed`` means fewer eligible members than the panel
    #: needs; the appeal is retried and may later be decided without a panel.
    panel_status: str = "awaiting_panel"
    #: When the panel's vote is due (the appeal's filed date plus 14 days).
    deadline: Optional[datetime] = None
    #: True when a tier-4 moderator decided it without a panel.
    decided_without_panel: bool = False


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
    (Moderator).  What the appealed record *says* is not public either, since it
    may be a hidden post or a review whose report is still sealed: ``excerpt``
    and ``target_link`` are filled in only for a caller who may judge or contest
    the decision (a seated member, a tier-4 moderator or the appellant), and a
    sealed report's excerpt only for a moderator or the review's author.  An
    unknown cid is ``404`` problem details.
    """
    appeal = get_appeal(cid)
    if appeal is None:
        raise AppealNotFound(cid)

    seats = get_panel(cid)
    on_panel = caller is not None and caller.did in {str(seat.member_did) for seat in seats}
    is_moderator = caller is not None and caller.tier >= int(Tier.MODERATOR)
    is_appellant = caller is not None and caller.did == str(appeal.appellant_did)
    may_see_panel = on_panel or is_moderator

    viewer_vote: Optional[str] = None
    viewer_voted_at: Optional[datetime] = None
    if on_panel and caller is not None:
        for seat in seats:
            if str(seat.member_did) != caller.did:
                continue
            if isinstance(seat.vote, str):
                viewer_vote = str(seat.vote)
            voted_at = getattr(seat, "voted_at", None)
            if isinstance(voted_at, datetime):
                viewer_voted_at = (
                    voted_at.replace(tzinfo=timezone.utc)
                    if voted_at.tzinfo is None
                    else voted_at.astimezone(timezone.utc)
                )
    # The tally is the panel's business; a reader outside it is not told.
    votes_cast = (
        sum(1 for seat in seats if isinstance(seat.vote, str) and seat.vote)
        if may_see_panel
        else 0
    )

    decision = decision_for_appeal(cid)
    outcome: Optional[str] = None
    resolution: Optional[str] = None
    decided_without_panel = False
    if decision is not None:
        resolution = str(decision.record_cid)
        body = decision.body if isinstance(decision.body, Mapping) else {}
        if isinstance(body.get("outcome"), str):
            outcome = body["outcome"]
        decided_without_panel = body.get("decided_without_panel") is True

    target_cid: Optional[str] = None
    try:
        target_cid = resolve_decision(str(appeal.decision_cid)).target_cid
    except Exception:  # a decision this node no longer holds describes nothing
        target_cid = None
    subject = describe_subject(target_cid, str(appeal.decision_cid)) if target_cid else None
    # What the record says is not public: it may be hidden, or a review report
    # still sealed.  Only whoever may judge or contest the decision reads it.
    excerpt: Optional[str] = None
    target_link: Optional[str] = None
    if subject is not None:
        excerpt, target_link = readable_content(
            subject,
            may_judge=on_panel or is_moderator or is_appellant,
            is_moderator=is_moderator,
            viewer_did=caller.did if caller is not None else None,
        )
    deadline = vote_deadline(appeal)
    if deadline is not None:
        deadline = deadline.replace(tzinfo=timezone.utc)

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
        viewer_vote=viewer_vote,
        viewer_voted_at=viewer_voted_at,
        votes_cast=votes_cast,
        target_cid=target_cid,
        target_kind=subject.kind if subject is not None else None,
        record_type=subject.record_type if subject is not None else None,
        paper_title=subject.title if subject is not None else None,
        excerpt=excerpt,
        target_link=target_link,
        decision_action=subject.action if subject is not None else None,
        panel_status=panel_state(appeal, decided=decision is not None),
        deadline=deadline,
        decided_without_panel=decided_without_panel,
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


@router.post(
    "/{cid}/decide",
    status_code=200,
    response_model=VoteAccepted,
    summary="Decide a panel-less appeal after its deadline",
)
def post_decide_without_panel(
    cid: str,
    body: dict[str, Any] = Body(..., description="The decision: {'outcome', 'reasons'}."),
    principal: Principal = Depends(require_tier(int(Tier.MODERATOR))),
) -> VoteAccepted:
    """A tier-4 moderator decides an appeal whose panel could never be formed.

    This is the fallback for an appeal the draw could not seat: once its
    14-day deadline has passed, a tier-4 moderator who is not involved in the
    decision (not the deciding moderator, an author, the appellant or a
    reporter) may decide it.  The ``appeal.decision`` is published with
    ``decided_without_panel: true`` and no votes.

    Failures are RFC 9457 problem details: ``401`` for a missing token,
    ``403`` for a caller below tier 4 or one involved in the decision, ``404``
    for an unknown appeal, ``409`` when a panel is seated or the deadline has
    not passed, ``422`` for an unknown outcome, and ``503`` without a signing
    key.
    """
    outcome, reasons = vote_fields(body)
    result = decide_without_panel(
        cid,
        principal.did,
        outcome,
        reasons,
        moderator_tier=int(principal.tier),
    )
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

