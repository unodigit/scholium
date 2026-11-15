"""Problem-details refusals for appeals (RFC 9457).

An appeal that is not a well-formed ``appeal`` record (no ``target``, no
``grounds``) is refused by the ingest pipeline's own ``InvalidRecord`` before
any handler here runs.  These are the refusals only the appeals plugin can
make.
"""

from __future__ import annotations

from typing import Any

from app.errors import ProblemException

__all__ = [
    "APPEAL_ALREADY_FILED",
    "APPEAL_NOT_AUTHORIZED",
    "APPEAL_NOT_FOUND",
    "PANEL_NOT_DRAWN",
    "PANEL_UNAVAILABLE",
    "UNKNOWN_APPEAL_TARGET",
    "VOTE_NODE_KEY_UNAVAILABLE",
    "VOTE_NOT_AUTHORIZED",
    "AppealAlreadyFiled",
    "AppealNotAuthorized",
    "AppealNotFound",
    "PanelNotDrawn",
    "PanelUnavailable",
    "UnknownAppealTarget",
    "VoteNodeKeyUnavailable",
    "VoteNotAuthorized",
]

UNKNOWN_APPEAL_TARGET = "urn:scholium:problem:unknown-appeal-target"
APPEAL_NOT_AUTHORIZED = "urn:scholium:problem:appeal-not-authorized"
APPEAL_ALREADY_FILED = "urn:scholium:problem:appeal-already-filed"
PANEL_UNAVAILABLE = "urn:scholium:problem:appeal-panel-unavailable"
APPEAL_NOT_FOUND = "urn:scholium:problem:appeal-not-found"
PANEL_NOT_DRAWN = "urn:scholium:problem:appeal-panel-not-drawn"
VOTE_NOT_AUTHORIZED = "urn:scholium:problem:vote-not-authorized"
VOTE_NODE_KEY_UNAVAILABLE = "urn:scholium:problem:node-key-unavailable"

_MAX_ECHO = 64


def _clip(value: Any) -> Any:
    """Echo a client-supplied string clipped, so a huge one cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


class UnknownAppealTarget(ProblemException, LookupError):
    """An appeal targets something that is not a moderation decision here: ``422``.

    ``body.target`` must be the cid of a ``moderation.decision`` this node
    holds, about a paper version this node holds: an appeal answers a decision,
    and it cannot create the decision it is about.
    """

    def __init__(self, target: object) -> None:
        self.target = target
        shown = _clip(target if isinstance(target, str) else repr(target))
        message = f"The appeal targets {shown!r}, which is not a moderation decision this node holds."
        super().__init__(
            422,
            message,
            type=UNKNOWN_APPEAL_TARGET,
            errors=[
                {
                    "loc": ["body", "target"],
                    "msg": message,
                    "type": "unknown_appeal_target",
                    "input": shown,
                }
            ],
        )


class AppealNotAuthorized(ProblemException, PermissionError):
    """The appeal is signed by someone who is not an author of the paper: ``403``.

    A decision may be appealed once, so only the people it affects -- the
    authors of the paper it was about -- may spend that appeal.  ``author`` is
    the DID the signature authenticates, which is not necessarily whoever
    relayed the record.
    """

    def __init__(self, author: object, decision_cid: object, paper_cid: object) -> None:
        self.author = author
        self.decision_cid = decision_cid
        self.paper_cid = paper_cid
        shown = _clip(author if isinstance(author, str) else repr(author))
        message = (
            "A moderation decision may be appealed only by an author of the paper "
            f"it was about; {shown} is not one."
        )
        super().__init__(
            403,
            message,
            type=APPEAL_NOT_AUTHORIZED,
            decision=decision_cid,
            paper_cid=paper_cid,
        )


class AppealAlreadyFiled(ProblemException, ValueError):
    """The decision has been appealed already: ``409``.

    A decision can be appealed once.  The cid of the appeal that holds the
    slot is carried as the ``appeal`` extension member; it is a public record,
    so naming it discloses nothing.
    """

    def __init__(self, decision_cid: object, appeal_cid: object) -> None:
        self.decision_cid = decision_cid
        self.appeal_cid = appeal_cid
        shown = _clip(decision_cid if isinstance(decision_cid, str) else repr(decision_cid))
        message = f"Moderation decision {shown!r} has already been appealed; a decision can be appealed once."
        super().__init__(
            409,
            message,
            type=APPEAL_ALREADY_FILED,
            decision=decision_cid,
            appeal=appeal_cid,
        )


class PanelUnavailable(ProblemException, LookupError):
    """Too few eligible members to seat a full panel: ``503``.

    A panel is exactly three members or it is not drawn at all -- a short panel
    could never reach two matching votes of three.  The shortfall is a state of
    the node's membership, not a fault in the appeal, so the appeal stays filed
    and the panel is drawn once :func:`~.service.seat_panel` finds enough
    tier-3 and tier-4 members who are not excluded.
    """

    def __init__(self, appeal_cid: object, *, eligible: int, needed: int) -> None:
        self.appeal_cid = appeal_cid
        self.eligible = eligible
        self.needed = needed
        message = (
            f"A panel needs {needed} eligible members and only {eligible} "
            f"{'is' if eligible == 1 else 'are'} available."
        )
        super().__init__(
            503,
            message,
            type=PANEL_UNAVAILABLE,
            appeal=appeal_cid,
            eligible=eligible,
            needed=needed,
        )


class AppealNotFound(ProblemException, LookupError):
    """No appeal this node holds has that cid: ``404``.

    A vote is cast *on* a filed appeal; the panel, and therefore the voters, are
    named by the appeal's row, so an unknown cid cannot be voted on.
    """

    def __init__(self, appeal_cid: object) -> None:
        self.appeal_cid = appeal_cid
        shown = _clip(appeal_cid if isinstance(appeal_cid, str) else repr(appeal_cid))
        message = f"No appeal with id {shown!r} is filed on this node."
        super().__init__(
            404,
            message,
            type=APPEAL_NOT_FOUND,
            appeal=appeal_cid,
        )


class PanelNotDrawn(ProblemException, LookupError):
    """The appeal has no panel seated yet: ``409``.

    An appeal filed while the node had too few eligible members has no
    ``appeal_panels`` rows, so nobody holds a seat to vote from.  The panel is
    drawn once enough tier-3 or tier-4 members exist (see
    :func:`~.service.seat_panel`).
    """

    def __init__(self, appeal_cid: object) -> None:
        self.appeal_cid = appeal_cid
        shown = _clip(appeal_cid if isinstance(appeal_cid, str) else repr(appeal_cid))
        message = (
            f"Appeal {shown!r} has no panel seated yet, so there are no members "
            "who may vote on it."
        )
        super().__init__(
            409,
            message,
            type=PANEL_NOT_DRAWN,
            appeal=appeal_cid,
        )


class VoteNotAuthorized(ProblemException, PermissionError):
    """The caller holds no seat on this appeal's panel: ``403``.

    Only the three members seated for the appeal may vote; being a moderator,
    the appellant or an eligible member who was not drawn is not enough.  The
    voter is the access token's DID, so a request cannot name somebody else.
    """

    def __init__(self, voter: object, appeal_cid: object) -> None:
        self.voter = voter
        self.appeal_cid = appeal_cid
        shown = _clip(voter if isinstance(voter, str) else repr(voter))
        message = (
            f"{shown} holds no seat on the panel for appeal "
            f"{_clip(appeal_cid if isinstance(appeal_cid, str) else repr(appeal_cid))!r}, "
            "so may not vote on it."
        )
        super().__init__(
            403,
            message,
            type=VOTE_NOT_AUTHORIZED,
            appeal=appeal_cid,
            voter=voter,
        )


class VoteNodeKeyUnavailable(ProblemException):
    """The node cannot sign the panel's decision: ``503``.

    A majority of the panel has agreed, but an ``appeal.decision`` must be
    node-signed, so without a usable Ed25519 key at ``NODE_KEY_PATH`` the
    decision cannot be made yet.  The votes are still recorded; the decision is
    made on the next successful vote once the key is available.
    """

    def __init__(self, appeal_cid: object) -> None:
        self.appeal_cid = appeal_cid
        message = (
            "This node has no usable Ed25519 signing key (NODE_KEY_PATH), so it "
            "cannot sign the panel's appeal.decision."
        )
        super().__init__(
            503,
            message,
            type=VOTE_NODE_KEY_UNAVAILABLE,
            appeal=appeal_cid,
        )
