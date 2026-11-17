"""Problem-details refusals for moderation decisions (RFC 9457).

A decision that is not a well-formed ``moderation.decision`` (no clause, no
reason, an action outside the five) is refused by the ingest pipeline's own
``InvalidRecord`` before any handler here runs.  These are the refusals only
the moderation plugin can make.
"""

from __future__ import annotations

from typing import Any

from app.errors import ProblemException

__all__ = [
    "DECISION_ACTION_INVALID",
    "DECISION_NOT_ALLOWED",
    "UNKNOWN_DECISION_TARGET",
    "UNKNOWN_POLICY_CLAUSE",
    "DecisionActionInvalid",
    "DecisionNotAllowed",
    "UnknownDecisionTarget",
    "UnknownPolicyClause",
]

UNKNOWN_POLICY_CLAUSE = "urn:scholium:problem:unknown-policy-clause"
UNKNOWN_DECISION_TARGET = "urn:scholium:problem:unknown-decision-target"
DECISION_NOT_ALLOWED = "urn:scholium:problem:decision-not-allowed"
DECISION_ACTION_INVALID = "urn:scholium:problem:decision-action-invalid"

_MAX_ECHO = 64


def _clip(value: Any) -> Any:
    """Echo a client-supplied string clipped, so a huge one cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


class UnknownPolicyClause(ProblemException, LookupError):
    """A decision cites a clause that is not in the node's policy list: ``422``.

    The clause must be one served by ``GET /v1/moderation/policies``; a decision
    is a public record and a citation nobody can look up is no justification.
    """

    def __init__(self, clause: object) -> None:
        self.clause = clause
        shown = _clip(clause if isinstance(clause, str) else repr(clause))
        message = (
            f"The decision cites policy clause {shown!r}, which is not one of the "
            "clauses listed by GET /v1/moderation/policies."
        )
        super().__init__(
            422,
            message,
            type=UNKNOWN_POLICY_CLAUSE,
            errors=[
                {
                    "loc": ["body", "clause"],
                    "msg": message,
                    "type": "unknown_policy_clause",
                    "input": shown,
                }
            ],
        )


class UnknownDecisionTarget(ProblemException, LookupError):
    """A decision targets something that is not a paper version here: ``422``.

    ``body.target`` must be the cid of a version this node holds: a decision
    sets a version's state, and it cannot create the version it is about.  A
    ``tombstone`` may also name a paper or a file, so it passes ``expected`` to
    say what it takes instead.
    """

    def __init__(self, target: object, expected: str = "a paper version this node holds") -> None:
        self.target = target
        shown = _clip(target if isinstance(target, str) else repr(target))
        message = f"The decision targets {shown!r}, which is not {expected}."
        super().__init__(
            422,
            message,
            type=UNKNOWN_DECISION_TARGET,
            errors=[
                {
                    "loc": ["body", "target"],
                    "msg": message,
                    "type": "unknown_decision_target",
                    "input": shown,
                }
            ],
        )


class DecisionActionInvalid(ProblemException, ValueError):
    """An action the target's type cannot take: ``422``.

    A decision on a paper version may ``list``/``hold``/... it; a decision on a
    flagged post, annotation or review may only ``dismiss`` it or ``hide`` it.
    The message names the actions the target *does* accept, so a moderator (or
    a console) is told what to send instead of guessing.
    """

    def __init__(self, target: object, action: object, kind: str, valid: tuple[str, ...] | list[str]) -> None:
        self.target = target
        self.action = action
        self.target_kind = kind
        shown = _clip(action if isinstance(action, str) else repr(action))
        message = (
            f"Action {shown!r} is not a decision a moderator can make about {kind}; "
            f"the actions this target accepts are: {', '.join(valid)}."
        )
        super().__init__(
            422,
            message,
            type=DECISION_ACTION_INVALID,
            errors=[
                {
                    "loc": ["body", "action"],
                    "msg": message,
                    "type": "decision_action_invalid",
                    "input": shown,
                }
            ],
        )


class DecisionNotAllowed(ProblemException, ValueError):
    """The decision cannot be applied to the version in its current state: ``409``.

    The state the action asks for is not reachable from the version's present
    state -- listing a version that has not finished scanning or collected its
    co-author consents, for instance.  The version's ``state`` and the
    ``requested`` one are carried as extension members.
    """

    def __init__(self, target: object, action: str, current: str, requested: str) -> None:
        self.target = target
        self.action = action
        self.current_state = current
        self.requested_state = requested
        shown = _clip(target if isinstance(target, str) else repr(target))
        message = (
            f"Action {action!r} would move version {shown!r} from {current!r} to "
            f"{requested!r}, which is not a transition a moderator can make."
        )
        super().__init__(
            409,
            message,
            type=DECISION_NOT_ALLOWED,
            state=current,
            requested=requested,
        )
