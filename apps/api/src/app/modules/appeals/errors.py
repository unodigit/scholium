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
    "UNKNOWN_APPEAL_TARGET",
    "AppealAlreadyFiled",
    "AppealNotAuthorized",
    "UnknownAppealTarget",
]

UNKNOWN_APPEAL_TARGET = "urn:scholium:problem:unknown-appeal-target"
APPEAL_NOT_AUTHORIZED = "urn:scholium:problem:appeal-not-authorized"
APPEAL_ALREADY_FILED = "urn:scholium:problem:appeal-already-filed"

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
