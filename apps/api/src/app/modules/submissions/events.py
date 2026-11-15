"""The ``version.state_changed`` event (plugin: submissions, feature 52).

A version moves through a small, fixed vocabulary of states while it is being
published: it starts in :data:`~.versions.AWAITING_CONSENT`, is scanned and
moderated, and ends up *listed*, *held* or *rejected*.  Every time
``paper_versions.state`` advances, this module publishes one
:class:`VersionStateChanged` event::

    from app.modules.submissions import subscribe_version_state_changed

    @subscribe_version_state_changed
    def send_consent_links(event):
        if event.state == "awaiting_consent":
            ...

    transition_version(version_cid, "scanning", reason="all authors consented")

Subscribers run in-process, synchronously, once the new state has been
committed.  A subscriber that raises is logged and skipped: one broken
consumer never rolls back the transition or stops the other subscribers --
the same contract the ledger's record subscribers give (feature 12).
Subscribing the same function twice is a no-op, so re-importing a module is
harmless.

Why an in-process event and not an event-log record
---------------------------------------------------

The event log holds *signed, client-authored records* (``paper.version`` and
friends).  A state change is the node's decision about a version it already
holds, not a new signed record: it has no author signature and replaying the
log must not invent one.  The event is therefore delivered in-process, like
the ledger subscribers, and is only a notification -- the durable effect of a
transition is the ``paper_versions.state`` column (and, when a version is
listed, the ``listed_at`` bookkeeping).

``version.state_changed`` is the event's type: the ``state_changed`` half is
the name features 55 and 59 (consents, notifications) refer to, and the
``version.`` prefix keeps it apart from the record types the ledger carries.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

__all__ = [
    "VERSION_STATE_CHANGED",
    "VersionStateChanged",
    "clear_state_changed_subscribers",
    "emit_state_changed",
    "emit_version_state_changed",
    "state_changed_subscriber_count",
    "subscribe_state_changed",
    "subscribe_version_state_changed",
    "unsubscribe_state_changed",
    "unsubscribe_version_state_changed",
]

logger = logging.getLogger(__name__)

#: The event type every state change carries, as the spec names it
#: (``version.state_changed``).
VERSION_STATE_CHANGED = "version.state_changed"

StateChangedSubscriber = Callable[["VersionStateChanged"], Any]


def _utcnow() -> datetime:
    """Naive UTC "now": the project's tables and records store naive UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso(value: Optional[datetime]) -> Optional[str]:
    """``value`` as an ISO 8601 UTC instant with a ``Z`` suffix."""
    if value is None:
        return None
    moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class VersionStateChanged:
    """One advance of a version's state.

    ``version_cid``/``paper_cid``/``n`` identify the version, ``state`` is the
    state it has just entered and ``previous_state`` is the state it left
    (``None`` when the version is first saved).  ``actor`` is the DID that
    asked for the change, when the caller knew one -- a moderator, the node
    acting for a job, or an author -- and ``reason`` is free text for the log
    or a notification, never interpreted by this plugin.

    ``to_state``/``from_state`` are aliases for ``state``/``previous_state``
    so a subscriber can name the transition from either end, and
    ``event_type``/``record_type`` both return
    :data:`VERSION_STATE_CHANGED` (``record_type`` because most in-process
    events in this project are delivered through the ledger's subscriber
    registry, whose callbacks look for that attribute).
    """

    version_cid: str
    paper_cid: str
    n: int
    state: str
    previous_state: Optional[str] = None
    actor: Optional[str] = None
    reason: Optional[str] = None
    at: datetime = field(default_factory=_utcnow)

    # -- naming aliases ---------------------------------------------------- #

    @property
    def to_state(self) -> str:
        """The state the version has just entered."""
        return self.state

    @property
    def from_state(self) -> Optional[str]:
        """The state the version left, or ``None`` when it was just saved."""
        return self.previous_state

    @property
    def event_type(self) -> str:
        """The event's type: ``version.state_changed``."""
        return VERSION_STATE_CHANGED

    @property
    def record_type(self) -> str:
        """Alias for :attr:`event_type`, for ledger-style subscribers."""
        return VERSION_STATE_CHANGED

    # -- serialisation ----------------------------------------------------- #

    def as_dict(self) -> dict[str, Any]:
        """The event as a plain JSON-ready mapping."""
        return {
            "type": VERSION_STATE_CHANGED,
            "version_cid": self.version_cid,
            "paper_cid": self.paper_cid,
            "n": self.n,
            "state": self.state,
            "previous_state": self.previous_state,
            "actor": self.actor,
            "reason": self.reason,
            "at": _iso(self.at),
        }

    #: Alias for :meth:`as_dict`.
    to_dict = as_dict

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<VersionStateChanged {self.version_cid!r} "
            f"{self.previous_state!r} -> {self.state!r}>"
        )


# --------------------------------------------------------------------------- #
# Subscribers
# --------------------------------------------------------------------------- #

_subscribers: list[StateChangedSubscriber] = []
_subscribers_lock = threading.Lock()


def subscribe_state_changed(
    fn: Optional[StateChangedSubscriber] = None,
) -> Any:
    """Register ``fn`` to receive every :class:`VersionStateChanged` event.

    Works as ``subscribe_state_changed(fn)`` (returning ``fn``) or as a
    decorator, ``@subscribe_state_changed``.  Registering the same function
    twice is a no-op.  Raises ``TypeError`` when ``fn`` is not callable.
    """

    def _add(callback: StateChangedSubscriber) -> StateChangedSubscriber:
        if not callable(callback):
            raise TypeError(
                f"a version state-changed subscriber must be callable, got "
                f"{type(callback).__name__}"
            )
        with _subscribers_lock:
            if callback not in _subscribers:
                _subscribers.append(callback)
        return callback

    return _add if fn is None else _add(fn)


#: ``subscribe_state_changed`` under the name that says which event it is.
subscribe_version_state_changed = subscribe_state_changed


def unsubscribe_state_changed(fn: Optional[StateChangedSubscriber] = None) -> None:
    """Remove ``fn`` (or every subscriber when ``fn`` is ``None``)."""
    with _subscribers_lock:
        if fn is None:
            _subscribers.clear()
            return
        _subscribers[:] = [callback for callback in _subscribers if callback != fn]


#: ``unsubscribe_state_changed`` under the name that says which event it is.
unsubscribe_version_state_changed = unsubscribe_state_changed


def clear_state_changed_subscribers() -> None:
    """Remove every subscriber.  Intended for tests and process teardown."""
    unsubscribe_state_changed()


def state_changed_subscriber_count() -> int:
    """How many subscribers are registered for ``version.state_changed``."""
    with _subscribers_lock:
        return len(_subscribers)


def emit_state_changed(event: VersionStateChanged) -> VersionStateChanged:
    """Deliver ``event`` to every subscriber; return it unchanged.

    A subscriber that raises is logged and skipped, so one broken consumer
    neither rolls back the state change that was already committed nor stops
    the remaining subscribers.  A non-:class:`VersionStateChanged` mapping is
    accepted too, so a caller holding a plain ``dict`` can publish it.
    """
    if isinstance(event, Mapping):
        when = event.get("at")
        if when is not None and not isinstance(when, datetime):
            when = None
        event = VersionStateChanged(
            version_cid=event["version_cid"],
            paper_cid=event["paper_cid"],
            n=int(event["n"]),
            state=event["state"],
            previous_state=event.get("previous_state"),
            actor=event.get("actor"),
            reason=event.get("reason"),
            at=when if when is not None else _utcnow(),
        )
    if not isinstance(event, VersionStateChanged):
        raise TypeError(
            "emit_state_changed needs a VersionStateChanged or a mapping, got "
            f"{type(event).__name__}"
        )

    with _subscribers_lock:
        callbacks = list(_subscribers)

    for callback in callbacks:
        try:
            callback(event)
        except Exception:
            logger.exception(
                "version.state_changed subscriber %r failed for %s",
                callback,
                event.version_cid,
            )
    return event


#: ``emit_state_changed`` under the name that says which event it is.
emit_version_state_changed = emit_state_changed
