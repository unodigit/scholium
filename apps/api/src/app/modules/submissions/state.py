"""Advancing ``paper_versions.state`` and emitting ``version.state_changed``
(plugin: submissions, feature 52).

Feature 50 stores a newly accepted version in ``awaiting_consent``.  From
there the version advances through the states the spec names -- *scanning*,
*moderation*, then *listed*, or *held*/*rejected* when something stops it::

    from app.modules.submissions import transition_version

    transition_version(version_cid, "scanning")
    transition_version(version_cid, "moderation")
    transition_version(version_cid, "listed")

Each call

1. refuses an unknown version (:class:`~.errors.UnknownVersion`) or an
   unknown state (:class:`~.errors.InvalidVersionState`) -- nothing is
   written or emitted;
2. writes the new state to ``paper_versions.state`` and commits it;
3. keeps the paper's listed bookkeeping in step: entering *listed* fills in
   ``paper_versions.listed_at`` and points ``papers.latest_version_cid`` /
   ``papers.listed_at`` at the version, while *held*/*rejected* clear those
   paper fields if they named this version;
4. publishes one :class:`~.events.VersionStateChanged` event, after the commit
   (a subscriber never sees a state the database does not have).

A transition to the state the version already has is a no-op: no write, no
event.  That keeps a retried consent/moderation step idempotent instead of
notifying co-authors twice.

Which transitions are allowed
-----------------------------

The spec names the vocabulary, not a single path: moderation, appeals and the
sanitizer can each move a version, and a version can be held after being
listed or listed again after an appeal.  :func:`transition_version` therefore
accepts any *known* state for an existing version and leaves the ordering
rules to the plugin that owns them (features 55 and 79).  :data:`ALLOWED_TRANSITIONS`
and :func:`can_transition` expose the natural graph for callers that want to
refuse an implausible jump themselves, and :func:`advance_version` walks the
happy path (``awaiting_consent -> scanning -> moderation -> listed``).

The extra ``draft`` state
-------------------------

Feature 55 returns a version to *draft* when a co-author declines.  That word
is part of the consent feature's story but not of the six-state vocabulary
feature 52 publishes, so :data:`DRAFT` is accepted as a state while
:data:`~.versions.VERSION_STATES` stays exactly the six the spec lists.  A
transition into ``draft`` emits ``version.state_changed`` like any other.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Optional

from app import db

from .errors import InvalidVersionState, UnknownVersion
from .events import VersionStateChanged, emit_state_changed
from .models import Paper, PaperVersion, ensure_tables
from .versions import AWAITING_CONSENT, VERSION_STATES

__all__ = [
    "ALLOWED_TRANSITIONS",
    "DRAFT",
    "HELD",
    "KNOWN_STATES",
    "LISTED",
    "MODERATION",
    "REJECTED",
    "SCANNING",
    "advance_version",
    "can_transition",
    "is_known_state",
    "next_state",
    "set_version_state",
    "transition_version",
]

#: The six states from the spec, by name, so callers need not import the tuple.
SCANNING = "scanning"
MODERATION = "moderation"
LISTED = "listed"
HELD = "held"
REJECTED = "rejected"

#: The consent plugin's "a co-author declined" state (feature 55).  It is
#: accepted here but deliberately not added to ``VERSION_STATES``, which is
#: the six-state vocabulary feature 52 publishes.
DRAFT = "draft"

#: Every state a version may be put in: the spec's six plus ``draft``.
KNOWN_STATES: frozenset[str] = frozenset(VERSION_STATES) | {DRAFT}

#: The natural order a version follows when nothing intervenes.  ``listed``,
#: ``held`` and ``rejected`` are outcomes, not a line, so this is only the
#: happy path :func:`advance_version` walks.
_HAPPY_PATH: tuple[str, ...] = (
    AWAITING_CONSENT,
    SCANNING,
    MODERATION,
    LISTED,
)

#: The state graph, for callers that want to refuse an implausible jump.
#: ``None`` is a version that does not exist yet (creation).  The graph is
#: deliberately not enforced by :func:`transition_version` -- a moderation
#: appeal, for example, may relist a rejected version -- but it records the
#: edges the workflow is expected to use.
ALLOWED_TRANSITIONS: Mapping[Optional[str], frozenset[str]] = {
    None: frozenset({AWAITING_CONSENT, DRAFT}),
    DRAFT: frozenset({AWAITING_CONSENT, SCANNING}),
    AWAITING_CONSENT: frozenset({SCANNING, DRAFT, HELD, REJECTED}),
    SCANNING: frozenset({MODERATION, HELD, REJECTED}),
    MODERATION: frozenset({LISTED, HELD, REJECTED}),
    LISTED: frozenset({HELD, REJECTED}),
    HELD: frozenset({LISTED, MODERATION, REJECTED}),
    REJECTED: frozenset({LISTED}),
}


def _utcnow() -> datetime:
    """Naive UTC "now": SQLite stores naive timestamps."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_known_state(state: object) -> bool:
    """Whether ``state`` is a state a version may be put in."""
    return isinstance(state, str) and state in KNOWN_STATES


def can_transition(from_state: Optional[str], to_state: str) -> bool:
    """Whether ``from_state -> to_state`` is part of the natural graph.

    This is advisory: :func:`transition_version` accepts any known target
    state (see the module docstring), while a plugin that owns one edge of
    the workflow can use this to refuse a jump it knows is impossible.
    """
    if not is_known_state(to_state):
        return False
    return to_state in ALLOWED_TRANSITIONS.get(from_state, frozenset())


def next_state(state: str) -> Optional[str]:
    """The state after ``state`` on the happy path, or ``None`` at its end."""
    try:
        index = _HAPPY_PATH.index(state)
    except ValueError:
        return None
    if index + 1 >= len(_HAPPY_PATH):
        return None
    return _HAPPY_PATH[index + 1]


def _require_known_state(state: object) -> str:
    """Return ``state`` or raise :class:`~.errors.InvalidVersionState`."""
    if not is_known_state(state):
        raise InvalidVersionState(state)
    return state  # type: ignore[return-value]


def _mark_paper_listed(session, version: PaperVersion, at: datetime) -> None:
    """Point the paper's listed bookkeeping at ``version``."""
    paper = session.get(Paper, version.paper_cid)
    if paper is None:
        # A version without its paper row: the genesis may live only in the
        # event log (``require_known_paper`` allows that), so there is no row
        # to update.  The version's own ``listed_at`` is still set.
        return
    paper.latest_version_cid = version.version_cid
    paper.listed_at = at


def _unmark_paper_listed(session, version: PaperVersion) -> None:
    """Clear the paper's listed bookkeeping when it names ``version``."""
    paper = session.get(Paper, version.paper_cid)
    if paper is None or paper.latest_version_cid != version.version_cid:
        return
    paper.latest_version_cid = None
    paper.listed_at = None


def transition_version(
    version_cid: object,
    to_state: object,
    *,
    actor: Optional[str] = None,
    reason: Optional[str] = None,
    at: Optional[datetime] = None,
) -> PaperVersion:
    """Move one version to ``to_state`` and emit ``version.state_changed``.

    ``actor`` is the DID that asked for the change (a moderator, the author,
    the node itself) and ``reason`` free text; both are carried on the event
    for notifications and audit output and neither is interpreted here.
    ``at`` overrides the event/``listed_at`` timestamp -- tests and jobs that
    replay a decision use it.

    Returns the updated :class:`~.models.PaperVersion` row.  A transition to
    the version's current state returns the row unchanged and emits nothing.

    Raises:
        UnknownVersion: ``version_cid`` names no stored version.
        InvalidVersionState: ``to_state`` is not one of the states this plugin
            publishes (the spec's six, or ``draft``).
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise UnknownVersion(version_cid)
    state = _require_known_state(to_state)
    moment = at if at is not None else _utcnow()
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)

    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(PaperVersion, version_cid)
        if row is None:
            raise UnknownVersion(version_cid)

        previous = row.state
        if previous == state:
            # Already there.  Detach so the caller can read the row after the
            # session closes; no write and no event.
            session.expunge(row)
            return row

        row.state = state
        if state == LISTED:
            if row.listed_at is None:
                row.listed_at = moment
            _mark_paper_listed(session, row, moment)
        elif state in (HELD, REJECTED):
            _unmark_paper_listed(session, row)

        try:
            session.commit()
        except Exception:
            session.rollback()
            raise
        session.refresh(row)
        paper_cid = row.paper_cid
        version_n = int(row.n)
        session.expunge(row)

    emit_state_changed(
        VersionStateChanged(
            version_cid=version_cid,
            paper_cid=paper_cid,
            n=version_n,
            state=state,
            previous_state=previous,
            actor=actor,
            reason=reason,
            at=moment,
        )
    )
    return row


#: ``transition_version`` under the name that reads as a setter.
set_version_state = transition_version


def advance_version(
    version_cid: object,
    *,
    actor: Optional[str] = None,
    reason: Optional[str] = None,
) -> PaperVersion:
    """Move a version one step along the happy path.

    ``awaiting_consent -> scanning -> moderation -> listed``.  A version that
    is ``held``, ``rejected`` or ``draft`` has no single next step, so this
    raises :class:`~.errors.InvalidVersionState`; call
    :func:`transition_version` with an explicit state for those.

    Raises:
        UnknownVersion: ``version_cid`` names no stored version.
        InvalidVersionState: the version is not on the happy path, or is
            already ``listed``.
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise UnknownVersion(version_cid)
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(PaperVersion, version_cid)
        if row is None:
            raise UnknownVersion(version_cid)
        current = row.state
    target = next_state(current)
    if target is None:
        raise InvalidVersionState(current)
    return transition_version(
        version_cid, target, actor=actor, reason=reason
    )
