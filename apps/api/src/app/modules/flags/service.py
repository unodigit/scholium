"""Create, read and decide user-submitted flags (plugin: flags).

A flag names a target (paper, post, review or version) and a reason
category.  :func:`create_flag` stores it in the ``flags`` table with status
``pending``; a moderator later acts on it.

Deciding (feature 78)
---------------------
When a moderation decision resolves a flag, the moderation side calls
:func:`decide_flag` (one flag) or :func:`decide_flags_for_target` (every
pending flag against the decided target)::

    from app.modules import flags

    flags.decide_flags_for_target(decision.target_cid, decision.decision_cid)

Each call moves the flag from ``pending`` to a decided status, links the
decision cid, and notifies the reporter with a ``flag.decided`` notification.
The move is a compare-and-set on ``status = 'pending'``, so a flag is decided
(and its reporter told) exactly once however often the call is repeated or
raced.  The notification is a side effect of a decision that has already
been committed: if it cannot be delivered the failure is logged and the
decision stands.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from sqlalchemy import select, update

from app import db
from app.modules.notifications.service import notify

from .models import Flag, ensure_table, ensure_tables

__all__ = [
    "DECIDED",
    "FLAG_DECIDED_KIND",
    "PENDING",
    "create_flag",
    "decide_flag",
    "decide_flags_for_target",
    "flag_decided_payload",
    "get_flag",
    "list_flags",
    "save_flag",
]

logger = logging.getLogger(__name__)

#: Status of a flag nobody has acted on yet.
PENDING = "pending"

#: Default status of a flag a moderation decision has resolved.
DECIDED = "decided"

#: Kind of the notification the reporter receives once their flag is decided.
#:
#: It is named for the *outcome* rather than the old ``flag.decided``: the
#: notification carries the outcome in words and a link to the item, and a
#: client that does not know this kind renders those fields verbatim instead
#: of showing a bare status code.
FLAG_DECIDED_KIND = "flag.outcome"


def create_flag(
    *,
    target_cid: str,
    reporter_did: str,
    reason: str,
    flag_id: Optional[str] = None,
    status: str = PENDING,
) -> Flag:
    """Insert a new flag row and return it detached."""
    ensure_table()
    fid = flag_id or str(uuid.uuid4())
    row = Flag(
        id=fid,
        target_cid=target_cid,
        reporter_did=reporter_did,
        reason=reason,
        status=status,
        decision_cid=None,
    )
    with db.SessionLocal() as session:
        session.add(row)
        session.commit()
        session.refresh(row)
        session.expunge(row)
    return row


def get_flag(flag_id: str) -> Optional[Flag]:
    """Return the flag with ``flag_id`` or ``None``."""
    ensure_table()
    with db.SessionLocal() as session:
        row = session.get(Flag, flag_id)
        if row is not None:
            session.expunge(row)
        return row


#: ``state`` values that mean "not decided yet" (the stored status is ``pending``).
OPEN_STATES = ("open", PENDING)

#: ``state`` value for every flag a decision has settled, whatever its status.
DECIDED_STATE = DECIDED

#: ``state`` value that applies no status filter.
ALL_STATES = "all"


def list_flags(
    *,
    reporter_did: Optional[str] = None,
    target_cid: Optional[str] = None,
    state: Optional[str] = None,
) -> list[Flag]:
    """Return flags, optionally filtered.

    ``state`` narrows by lifecycle: ``open`` (or ``pending``) for flags nobody
    has acted on, ``decided`` for every flag a decision settled (whatever
    decided status it carries), ``all`` for both, and any other value for
    flags with exactly that status (``dismissed``, ...).  ``None`` applies no
    status filter.
    """
    ensure_table()
    wanted = state.strip().lower() if isinstance(state, str) else None
    with db.SessionLocal() as session:
        stmt = select(Flag)
        if reporter_did is not None:
            stmt = stmt.where(Flag.reporter_did == reporter_did)
        if target_cid is not None:
            stmt = stmt.where(Flag.target_cid == target_cid)
        if wanted and wanted != ALL_STATES:
            if wanted in OPEN_STATES:
                stmt = stmt.where(Flag.status == PENDING)
            elif wanted == DECIDED_STATE:
                stmt = stmt.where(Flag.status != PENDING)
            else:
                stmt = stmt.where(Flag.status == wanted)
        rows = list(session.execute(stmt).scalars().all())
        for row in rows:
            session.expunge(row)
        return rows


# --------------------------------------------------------------------------- #
# Deciding a flag
# --------------------------------------------------------------------------- #


def _decision_action(decision_cid: Optional[str]) -> Optional[str]:
    """The action of the decision that settled a flag, when the row is readable."""
    if not isinstance(decision_cid, str) or not decision_cid:
        return None
    try:
        from app.modules.moderation.models import (
            ModerationDecision,
            ensure_tables as ensure_moderation_tables,
        )

        ensure_moderation_tables()
        with db.SessionLocal() as session:
            row = session.get(ModerationDecision, decision_cid)
            return None if row is None else str(row.action)
    except Exception:  # pragma: no cover - moderation is a shipped plugin
        logger.exception("could not read decision %s for a flag outcome", decision_cid)
        return None


def flag_decided_payload(flag: Flag) -> dict[str, Any]:
    """The payload of the ``flag.outcome`` notification for ``flag``.

    ``flag_id`` and ``decision_cid`` let the reporter's client open the flag
    (``GET /v1/flags/{flag_id}``) and the public decision record; ``status``,
    ``reason`` and ``target_cid`` say what was decided and about what.

    ``summary`` (also ``outcome``) says what happened in words, naming the kind
    of item, and ``link`` opens the item -- the paper page, the Discussion tab
    (where a hidden post's placeholder is), or the reviews tab.  The inbox
    renders the words instead of a bare status code.
    """
    action = _decision_action(flag.decision_cid)
    try:
        from app.modules.moderation.outcomes import (
            item_link,
            reporter_summary,
            target_kind,
        )

        kind = target_kind(flag.target_cid)
        summary = reporter_summary(kind, action)
        link = item_link(flag.target_cid, kind)
    except Exception:  # pragma: no cover - moderation is a shipped plugin
        logger.exception("could not word the outcome of flag %s", flag.id)
        kind = "item"
        summary = "The item you reported was reviewed."
        link = None
    return {
        "flag_id": flag.id,
        "target_cid": flag.target_cid,
        "reason": flag.reason,
        "status": flag.status,
        "decision_cid": flag.decision_cid,
        "action": action,
        "target_kind": kind,
        "item_kind": kind,
        "summary": summary,
        "outcome": summary,
        "link": link,
    }


def _clean(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{what} must be a non-empty string")
    return value.strip()


def _clean_status(status: Any) -> str:
    status = _clean(status, "status")
    if status == PENDING:
        raise ValueError(f"a decided flag cannot have status {PENDING!r}")
    return status


def _notify_reporter(flag: Flag) -> None:
    """Tell the reporter their flag was decided; never raises.

    The decision is already committed, so a notification that cannot be
    stored must not turn into a failed decision for the moderator.
    """
    try:
        notify(flag.reporter_did, FLAG_DECIDED_KIND, flag_decided_payload(flag))
    except Exception:
        logger.exception(
            "could not notify %s that flag %s was decided", flag.reporter_did, flag.id
        )


def _decide(flag_id: str, decision_cid: str, status: str) -> Optional[Flag]:
    """Compare-and-set one pending flag to decided; ``None`` if it was not pending."""
    with db.SessionLocal() as session:
        result = session.execute(
            update(Flag)
            .where(Flag.id == flag_id, Flag.status == PENDING)
            .values(status=status, decision_cid=decision_cid)
        )
        session.commit()
        if result.rowcount != 1:
            return None
        row = session.get(Flag, flag_id)
        if row is None:  # pragma: no cover - deleted between UPDATE and read
            return None
        session.expunge(row)
    return row


def decide_flag(flag_id: str, decision_cid: str, *, status: str = DECIDED) -> Optional[Flag]:
    """Mark a pending flag decided, link ``decision_cid`` and notify its reporter.

    Returns the decided flag, or ``None`` when there is nothing to do: no such
    flag, or one that was decided already (its first decision, and its single
    notification, are kept).  ``status`` is the decided status to store --
    e.g. ``actioned`` or ``dismissed`` -- and may be anything but ``pending``.
    Raises ``ValueError`` for an empty ``decision_cid`` or an invalid
    ``status``.
    """
    decision_cid = _clean(decision_cid, "decision_cid")
    status = _clean_status(status)
    ensure_tables()
    flag = _decide(flag_id, decision_cid, status)
    if flag is not None:
        _notify_reporter(flag)
    return flag


def decide_flags_for_target(
    target_cid: str, decision_cid: str, *, status: str = DECIDED
) -> list[Flag]:
    """Decide every pending flag against ``target_cid`` with one decision.

    The bridge for moderation decisions, which name a target rather than a
    flag.  Each flag's reporter gets their own notification.  Returns the
    flags this call decided (empty when none were pending).  Raises
    ``ValueError`` as :func:`decide_flag` does.
    """
    target_cid = _clean(target_cid, "target_cid")
    decision_cid = _clean(decision_cid, "decision_cid")
    status = _clean_status(status)
    ensure_tables()
    with db.SessionLocal() as session:
        pending_ids = list(
            session.execute(
                select(Flag.id).where(Flag.target_cid == target_cid, Flag.status == PENDING)
            ).scalars()
        )
    decided: list[Flag] = []
    for flag_id in pending_ids:
        flag = _decide(flag_id, decision_cid, status)
        if flag is not None:
            _notify_reporter(flag)
            decided.append(flag)
    return decided


# Alias matching the naming used by sibling plugins (``save_paper``, ...).
save_flag = create_flag
