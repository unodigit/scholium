"""Accepting signed ``moderation.decision`` records (plugin: moderation, feature 71).

A moderator's public, signed decision on a version::

    {"target": "bafyrei...",      # cid of the version being decided on
     "action": "list",            # list | hold | reclassify | reject | delist | tombstone | release
     "clause": "MOD-01",          # a clause served by GET /v1/moderation/policies
     "reason": "...",             # shown to the author; or ``reasonCid`` instead
     "category": "cs.CR"}         # reclassify only (or ``categories``)

The ingest pipeline has already verified the envelope, the body schema, the
cid and the signature -- and that the signer is tier 4 -- by the time
:func:`handle_moderation_decision` runs.  The handler adds the decisions the
generic pipeline cannot make, *before* anything is stored:

* **a known clause.**  ``body.clause`` must be one of the clauses
  :func:`~.policies.get_clauses` serves (``422``,
  :class:`~.errors.UnknownPolicyClause`).  A missing clause, or a decision with
  neither ``reason`` nor ``reasonCid``, is already a ``422`` from the body
  schema; a blank ``reason`` with no ``reasonCid`` is refused here;
* **a version.**  ``body.target`` must be a version this node holds (``422``,
  :class:`~.errors.UnknownDecisionTarget`); a ``tombstone`` may instead name a
  paper or a file id;
* **a reachable state.**  The state the action asks for must follow from the
  version's present one (``409``, :class:`~.errors.DecisionNotAllowed`), so a
  moderator cannot list a version that is still scanning or awaiting consent.
  A ``tombstone`` is exempt: a takedown must work whatever state the version is in.

What an action does
-------------------

==============  ================================================================
``list``        the version becomes ``listed`` -- the paper is then readable by
                its ``sch:`` id
``hold``        the version becomes ``held``
``reject``      the version becomes ``rejected``
``delist``      the version becomes ``rejected``: it leaves the catalog, and the
                version state has no separate "delisted" word
``reclassify``  the version's state is left alone; the paper's categories become
                ``body.category`` / ``body.categories`` (required)
``tombstone``   the target's cid(s) go to the ``denylist`` table and their bytes
                are deleted; a version (or every version of a paper) also becomes
                ``rejected``.  The envelopes and log entries stay, so history
                still verifies.  See :mod:`app.modules.moderation.tombstones`
``release``     the version becomes the state ``body.state`` names.  It is what
                an overturned appeal appends to put a version back where the
                appealed decision found it (``moderation`` stays ``moderation``,
                ``listed`` stays ``listed``), so it is not an approval: it never
                says ``list`` for a version nobody listed.  It is not in
                :data:`ACTION_STATES` -- the state is in the record, not implied
                by the action -- and :func:`decision_state` is the one place that
                reads a record's resulting state.  Only a version a decision has
                moved (``held`` or ``rejected``) can be released.
==============  ================================================================

This is the split :func:`app.modules.status.compute_status` assumes: ``list``,
``hold``, ``reject``, ``delist`` and ``tombstone`` set a version's state,
``reclassify`` does not.  The state change goes through
:func:`app.modules.submissions.transition_version`, so ``version.state_changed``
is published like for any other move (the author notification, the advisory AI
pre-review of a newly listed version).

Saving and acting
-----------------

:func:`apply_decision` acts on the version and then saves the
``moderation_decisions`` row, so a row means the decision was fully applied and
a repeat is a no-op instead of a second state change.  It is idempotent and
runs from two places: the ledger subscriber installed by this package (so a
decision takes effect whichever door it came through, ``POST
/v1/moderation/decisions`` or ``POST /v1/records``) and the endpoint itself,
because a ledger subscriber that raises is only logged -- the endpoint must not
answer ``201`` for a decision it did not apply.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import ledger, submissions
from app.modules.ingest import InvalidRecord
from app.modules.submissions.models import Paper
from app.security import Tier

from .errors import DecisionNotAllowed, UnknownDecisionTarget, UnknownPolicyClause
from .models import ModerationDecision, ensure_tables
from .policies import get_clause
from .tombstones import TOMBSTONE, TOMBSTONED, resolve_scope, tombstone_target

logger = logging.getLogger(__name__)

__all__ = [
    "ACTIONS",
    "ACTION_STATES",
    "DECISION_MIN_TIER",
    "DECISION_TYPE",
    "RELEASE",
    "RELEASE_STATES",
    "AUTHOR_NOTIFICATION_KIND",
    "DECISION_MADE_KIND",
    "DECISION_NOTIFICATION_KIND",
    "MODERATION_DECIDED_KIND",
    "MODERATION_DECISION_KIND",
    "MODERATION_OUTCOME_KIND",
    "DecisionFields",
    "apply_decision",
    "decision_fields",
    "decision_state",
    "get_decision",
    "handle_moderation_decision",
    "persist_entry",
    "require_known_clause",
]

#: The record type this module owns.
DECISION_TYPE = "moderation.decision"

#: Kind of the notification the submitting author receives for a moderation
#: decision.  Reuses the record type string so a decision and its notification
#: share one stable name.
MODERATION_DECISION_KIND = DECISION_TYPE
#: Aliases covering the names other modules use for the same concept.
MODERATION_DECIDED_KIND = DECISION_TYPE
MODERATION_OUTCOME_KIND = DECISION_TYPE
DECISION_MADE_KIND = DECISION_TYPE
DECISION_NOTIFICATION_KIND = DECISION_TYPE
AUTHOR_NOTIFICATION_KIND = DECISION_TYPE

#: Lowest trust tier whose signature the registry lets through (Moderator).
DECISION_MIN_TIER = int(Tier.MODERATOR)

#: The action an overturned appeal's restoration carries.  It names the state
#: it returns the version to in ``body.state`` instead of implying one, so a
#: restoration to ``moderation`` is never written as an approval.
RELEASE = "release"

#: The actions a ``moderation.decision`` may carry.  The record core's schema
#: must list every one of them, or ingest refuses the record before this plugin
#: sees it.
ACTIONS = ("list", "hold", "reclassify", "reject", "delist", TOMBSTONE, RELEASE)

#: The states a ``release`` may name.  ``moderation`` is the one no other action
#: can ask for; the others are what a decision itself can leave a version in.
RELEASE_STATES = (
    submissions.LISTED,
    submissions.MODERATION,
    submissions.HELD,
    submissions.REJECTED,
)

#: The version state each plain state-setting action asks for.  ``reclassify``
#: is not here: it leaves a version's state alone.  ``tombstone`` is not either:
#: it moves versions to ``rejected`` only where it can, and also acts on files
#: (see :mod:`app.modules.moderation.tombstones`).
ACTION_STATES: Mapping[str, str] = {
    "list": submissions.LISTED,
    "hold": submissions.HELD,
    "reject": submissions.REJECTED,
    "delist": submissions.REJECTED,
}

_RECLASSIFY = "reclassify"


def _invalid(loc: list[Any], message: str, error_type: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad field of a decision record, located at ``loc``."""
    shown = value if isinstance(value, (str, int, float, bool, type(None))) else None
    if isinstance(shown, str) and len(shown) > 64:
        shown = shown[:61] + "..."
    full = f"The moderation.decision {message}."
    return InvalidRecord(
        [{"loc": loc, "msg": full, "type": error_type, "input": shown}],
        detail=full,
    )


# --------------------------------------------------------------------------- #
# Reading the record
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class DecisionFields:
    """The parts of a decision record this plugin acts on, shape-checked."""

    decision_cid: str
    moderator_did: str
    target: str
    action: str
    clause: str
    #: The reason text the record carries; ``None`` when it names only a ``reasonCid``.
    reason: Optional[str]
    reason_cid: Optional[str]
    #: The new categories of a ``reclassify``; empty for every other action.
    categories: tuple[str, ...]
    decided_at: datetime
    #: The state a ``release`` returns the version to; ``None`` for every other action.
    state: Optional[str] = None


def _text(body: Mapping[str, Any], field: str, *, required: bool) -> Optional[str]:
    """``body[field]`` as a non-empty string; ``None`` when optional and absent."""
    value = body.get(field)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value:
        raise _invalid(
            ["body", field],
            f"field {field!r} must be a non-empty string",
            f"invalid_{field}",
            value,
        )
    return value


def _decided_at(record: Mapping[str, Any]) -> datetime:
    """The record's ``created`` as naive UTC (a bare timestamp is read as UTC), or ``422``."""
    value = record.get("created")
    try:
        moment = datetime.fromisoformat(value.strip()) if isinstance(value, str) else None
    except ValueError:
        moment = None
    if moment is None:
        raise _invalid(
            ["created"],
            "field 'created' must be an ISO 8601 instant",
            "invalid_created",
            value,
        )
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).replace(tzinfo=None)


def _new_categories(body: Mapping[str, Any]) -> tuple[str, ...]:
    """The categories a ``reclassify`` moves the paper to, in order, without repeats."""
    listed = body.get("categories")
    if listed is not None:
        if not isinstance(listed, list) or not all(isinstance(c, str) and c.strip() for c in listed):
            raise _invalid(
                ["body", "categories"],
                "field 'categories' must be a list of non-empty strings",
                "invalid_categories",
            )
        names = [c.strip() for c in listed]
    else:
        single = body.get("category")
        if single is not None and (not isinstance(single, str) or not single.strip()):
            raise _invalid(
                ["body", "category"],
                "field 'category' must be a non-empty string",
                "invalid_category",
                single,
            )
        names = [single.strip()] if single is not None else []
    return tuple(dict.fromkeys(names))


def decision_fields(record: Mapping[str, Any]) -> DecisionFields:
    """Shape-check a decision envelope and return the fields this plugin acts on.

    The ingest pipeline's schema check normally runs first; this re-checks the
    shape so a direct caller gets ``422`` problem details rather than a
    ``TypeError`` or a half-written row.  Nothing is read from the database and
    the clause is not looked up (see :func:`require_known_clause`), so this is
    also safe to run on a decision that was accepted under an older policy list.

    Raises:
        InvalidRecord: ``422`` when the body is not an object, ``target`` or
            ``clause`` is missing, the action is not one of :data:`ACTIONS`,
            neither a non-blank ``reason`` nor a ``reasonCid`` is given, a
            ``reclassify`` names no category, or ``created`` is not an
            ISO 8601 instant.
    """
    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the moderation.decision body must be an object"],
            detail="The moderation.decision body must be a JSON object.",
        )

    decision_cid = record.get("id")
    if not isinstance(decision_cid, str) or not decision_cid:
        message = "The moderation.decision record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )
    author = record.get("author")
    if not isinstance(author, str) or not author:
        raise _invalid(["author"], "field 'author' must be a non-empty string", "invalid_author", author)

    target = _text(body, "target", required=True)
    clause = _text(body, "clause", required=True)
    assert target is not None and clause is not None

    action = body.get("action")
    if not isinstance(action, str) or action not in ACTIONS:
        raise _invalid(
            ["body", "action"],
            f"field 'action' must be one of {', '.join(ACTIONS)}",
            "invalid_action",
            action,
        )

    reason_value = body.get("reason")
    if reason_value is not None and not isinstance(reason_value, str):
        raise _invalid(["body", "reason"], "field 'reason' must be a string", "invalid_reason", reason_value)
    reason = reason_value.strip() if isinstance(reason_value, str) else ""
    reason_cid = _text(body, "reasonCid", required=False)
    if not reason and reason_cid is None:
        raise _invalid(
            ["body", "reason"],
            "needs a reason: a non-blank 'reason' or a 'reasonCid'",
            "missing_reason",
            reason_value,
        )

    categories: tuple[str, ...] = ()
    if action == _RECLASSIFY:
        categories = _new_categories(body)
        if not categories:
            raise _invalid(
                ["body", "category"],
                "needs the category to move the paper to: 'category' or 'categories'",
                "missing_category",
            )

    state: Optional[str] = None
    if action == RELEASE:
        state = body.get("state")
        if not isinstance(state, str) or state not in RELEASE_STATES:
            raise _invalid(
                ["body", "state"],
                f"needs the state a release returns the version to: one of {', '.join(RELEASE_STATES)}",
                "missing_state" if state is None else "invalid_state",
                state,
            )

    return DecisionFields(
        decision_cid=decision_cid,
        moderator_did=author,
        target=target,
        action=action,
        clause=clause,
        reason=reason or None,
        reason_cid=reason_cid,
        categories=categories,
        decided_at=_decided_at(record),
        state=state,
    )


def decision_state(body: object) -> Optional[str]:
    """The version state a ``moderation.decision`` body leaves its target in.

    ``None`` for a body that sets no state (``reclassify``, a ``tombstone`` --
    which acts on more than a version's state -- or anything unreadable).  This
    is how a log is replayed into states: a state-setting action puts the version
    in its :data:`ACTION_STATES` state, and a ``release`` in the state it names,
    so a restoration to ``moderation`` replays to ``moderation`` and a restoration
    to ``listed`` to ``listed``.
    """
    if not isinstance(body, Mapping):
        return None
    action = body.get("action")
    if not isinstance(action, str):
        return None
    if action == RELEASE:
        state = body.get("state")
        return state if isinstance(state, str) and state in RELEASE_STATES else None
    return ACTION_STATES.get(action)


def require_known_clause(clause: str) -> None:
    """Refuse a clause that ``GET /v1/moderation/policies`` does not serve (``422``).

    A policies file that cannot be read is not the moderator's mistake and
    surfaces as the ``500`` the policies endpoint answers.
    """
    if get_clause(clause) is None:
        raise UnknownPolicyClause(clause)


# --------------------------------------------------------------------------- #
# The ingest handler
# --------------------------------------------------------------------------- #


def _requested_state(fields: DecisionFields, current: str) -> str:
    """The state the version ends in; refuse (``409``) one it cannot reach.

    Asking for the state the version already has is allowed -- the decision is
    still recorded, and :func:`~app.modules.submissions.transition_version`
    treats it as a no-op.  Anything else must be an edge of the natural graph.
    """
    if fields.action == RELEASE:
        # A release undoes a decision: it returns a held or rejected version to
        # the state it was in before.  It is not another way to list, or to move
        # a version that no decision has touched.
        requested = fields.state or current
        if requested != current and current not in (submissions.HELD, submissions.REJECTED):
            raise DecisionNotAllowed(fields.target, fields.action, current, requested)
        return requested
    requested = ACTION_STATES.get(fields.action)
    if requested is None:
        return current
    if requested != current and not submissions.can_transition(current, requested):
        raise DecisionNotAllowed(fields.target, fields.action, current, requested)
    return requested


def handle_moderation_decision(record: Mapping[str, Any]) -> str:
    """Validate a ``moderation.decision``; return the state its version will be in.

    A ``tombstone`` reports ``"tombstoned"``: its target may be a file, which
    has no version state.

    Runs before the record is appended to the ledger, so a refusal stores
    nothing and leaves the version alone.  Nothing is changed here either: the
    state change and the ``moderation_decisions`` row are made by
    :func:`apply_decision` once the record is in the log.
    """
    fields = decision_fields(record)
    require_known_clause(fields.clause)

    if fields.reason_cid is not None:
        # The signer may publish a reasonCid only when they may read the file
        # under the content visibility rule.
        from app.modules.ingest import author_tier
        from app.modules.submissions.notices import _may_read
        from app.security import Principal

        principal = Principal(did=fields.moderator_did, tier=author_tier(fields.moderator_did))
        if not _may_read(fields.reason_cid, principal):
            raise _invalid(
                ["body", "reasonCid"],
                f"names a reasonCid that the signer may not read",
                "reason_not_readable",
                fields.reason_cid,
            )

    if fields.action == TOMBSTONE:
        resolve_scope(fields.target)  # refuses (422) a target it cannot take down
        return TOMBSTONED

    version = submissions.get_version(fields.target)
    if version is None:
        raise UnknownDecisionTarget(fields.target)

    if fields.action == _RECLASSIFY and submissions.get_paper(version.paper_cid) is None:
        # Categories live on the paper row; a version whose paper this node has
        # not indexed has nothing to reclassify.
        raise UnknownDecisionTarget(fields.target)

    return _requested_state(fields, str(version.state))


# --------------------------------------------------------------------------- #
# Acting on the version and saving the decision
# --------------------------------------------------------------------------- #


def _reclassify(fields: DecisionFields) -> None:
    """Move the target version's paper to the decision's categories."""
    version = submissions.get_version(fields.target)
    if version is None:
        raise UnknownDecisionTarget(fields.target)
    with db.SessionLocal() as session:
        paper = session.get(Paper, version.paper_cid)
        if paper is None:
            raise UnknownDecisionTarget(fields.target)
        if list(paper.categories or []) == list(fields.categories):
            return
        paper.categories = list(fields.categories)
        session.commit()


def get_decision(decision_cid: object) -> Optional[ModerationDecision]:
    """The saved decision with this cid, or ``None``."""
    if not isinstance(decision_cid, str) or not decision_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(ModerationDecision, decision_cid)
        if row is not None:
            session.expunge(row)
        return row


def _submitting_author_dids(target: str) -> list[str]:
    '''The submitting author DID(s) affected by a decision on ``target``.

    A version names one submitting author (its first byline entry); a paper
    names one per version.  A bare file id has no author.
    '''
    version = submissions.get_version(target)
    if version is not None:
        rows = submissions.authorship_for(target)
        if not rows:
            return []
        first = min(rows, key=lambda r: (getattr(r, "position", 0) or 0, getattr(r, "author_did", "")))
        did = getattr(first, "author_did", None)
        return [did] if isinstance(did, str) and did else []

    paper = submissions.get_paper(target)
    if paper is not None:
        try:
            versions = submissions.versions_for_paper(target)
        except Exception:
            versions = []
        result: list[str] = []
        seen: set[str] = set()
        for item in versions:
            vid = getattr(item, "version_cid", None)
            if not isinstance(vid, str) or not vid:
                continue
            rows = submissions.authorship_for(vid)
            if not rows:
                continue
            first = min(rows, key=lambda r: (getattr(r, "position", 0) or 0, getattr(r, "author_did", "")))
            did = getattr(first, "author_did", None)
            if isinstance(did, str) and did and did not in seen:
                seen.add(did)
                result.append(did)
        return result

    return []


def _notify_submitting_author(fields: DecisionFields, reason_text: str) -> None:
    '''Notify the submitting author about ``fields``; never raises.'''
    try:
        from app.modules.notifications.service import notify
    except Exception:  # pragma: no cover - notifications is a shipped plugin
        logger.exception("notifications plugin unavailable; moderation decision not notified")
        return

    dids = _submitting_author_dids(fields.target)
    if not dids:
        return
    payload = {
        "decision_cid": fields.decision_cid,
        "target_cid": fields.target,
        "action": fields.action,
        "clause": fields.clause,
        "reason": reason_text,
    }
    for did in dids:
        try:
            notify(did, MODERATION_DECISION_KIND, payload)
        except Exception:
            logger.exception(
                "could not notify %s about moderation decision %s",
                did,
                fields.decision_cid,
            )


def apply_decision(record: Mapping[str, Any]) -> ModerationDecision:
    """Act on the decision's version and save it to ``moderation_decisions``.

    Idempotent per decision cid: a decision that already has its row was fully
    applied, and is returned as it is -- so the ledger subscriber and the
    endpoint may both call this for the same record without the second call
    undoing a later decision made in between.

    The version is acted on first and the row written last, so a failure
    between the two is repaired by a retry rather than leaving a saved decision
    whose effect never happened.

    Raises:
        InvalidRecord: the record is not a well-formed decision.
        UnknownDecisionTarget: the target is not a version (or, for a
            ``reclassify``, its paper is not indexed) on this node; for a
            ``tombstone``, not a paper, a version or a file id either.
        OSError: a ``tombstone`` could not delete a file's bytes.  Its cids are
            denylisted by then, and nothing is saved, so a retry finishes.
    """
    fields = decision_fields(record)

    existing = get_decision(fields.decision_cid)
    if existing is not None:
        return existing

    state = fields.state if fields.action == RELEASE else ACTION_STATES.get(fields.action)
    if fields.action == TOMBSTONE:
        # Denylist the cid(s), delete the bytes, take the version(s) out of the
        # catalog.  The envelopes and log entries are not touched.
        tombstone_target(
            fields.target,
            fields.decision_cid,
            actor=fields.moderator_did,
            reason=fields.reason,
        )
    elif state is not None:
        try:
            submissions.transition_version(
                fields.target,
                state,
                actor=fields.moderator_did,
                reason=fields.reason,
            )
        except submissions.UnknownVersion as exc:
            raise UnknownDecisionTarget(fields.target) from exc
    else:
        _reclassify(fields)

    reason_text = fields.reason
    if not reason_text and fields.reason_cid:
        try:
            from app.modules.submissions.notices import read_reason_file

            reason_text = read_reason_file(DECISION_TYPE, fields.reason_cid, fields.moderator_did)
        except Exception:
            reason_text = fields.reason_cid
    if reason_text is None:
        reason_text = ""

    row = ModerationDecision(
        decision_cid=fields.decision_cid,
        target_cid=fields.target,
        action=fields.action,
        clause=fields.clause,
        moderator_did=fields.moderator_did,
        decided_at=fields.decided_at,
    )
    with db.SessionLocal() as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            # Another writer saved the same record between the check above and
            # now; its row is this record's row.
            session.rollback()
            saved = session.get(ModerationDecision, fields.decision_cid)
            if saved is None:
                raise
            row = saved
        else:
            session.refresh(row)
            session.expunge(row)
            # Tell the submitting author about this decision.  The decision is
            # already committed, so a notification that cannot be stored must
            # not turn into a failed decision for the moderator.
            _notify_submitting_author(fields, reason_text)
    # Detach in case the IntegrityError branch returned an attached row.
    try:
        session.expunge(row)
    except Exception:
        pass
    return row


def persist_entry(entry: Any) -> None:
    """Ledger subscriber: apply every ``moderation.decision`` once it is in the log.

    Failures are logged by the ledger and do not undo the append; the endpoint
    applies the decision again and reports a real failure to its caller.
    """
    if getattr(entry, "record_type", None) != DECISION_TYPE:
        return
    apply_decision(ledger.stored_envelope(entry).model_dump())
