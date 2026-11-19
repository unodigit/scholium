"""A paper's status, computed independently of the node (feature 98).

``scholium rebuild`` writes a ``paper_status`` view next to the paper and
version views, and a third party's rebuild must be able to reproduce it from
the records alone -- with the node's own code imported nowhere.  This module
is that independent implementation of the status rules the product states
(the contract ``papers.status`` documents, feature 83):

    status_of(records).status    # "awaiting_moderation" | "preprint"
                                # | "under_review" | "reviewed"
                                # | "contested" | "corrected" | "retracted"

Only moderation, review and notice records are read -- ``retraction``,
``correction``, ``moderation.decision``, ``review.commit`` and
``review.formal`` -- and ``ai.review`` is never read: the AI pre-review is
advisory and can never change a paper's status, whatever its body claims.
``paper.version`` records are read for one thing only: which version is the
newest, so the queue rule can ask whether a moderator has listed it.
The first matching rule decides:

====  ======================  ============
 #    rule                    status
====  ======================  ============
 1    ``retraction``          retracted
 2    ``moderation_hold``     contested
 3    ``review_rejection``    contested
 4    ``correction``          corrected
 5    ``reviews_supportive``  reviewed
 6    ``review_activity``     under_review
 7    ``awaiting_moderation`` awaiting_moderation
 8    ``default``             preprint
====  ======================  ============

Reading the records
-------------------

``records`` are the status-bearing records of **one paper** -- rebuild picks
them by target (see :mod:`scholium_cli.rebuild`) -- as record envelopes
(mappings with ``type``, ``body``, ``id``, ``author``, ``created`` and
``prev``).  Signatures are not checked here: the rebuild has already
authenticated every record in the archive before any view is written.

* A **hold in force**: per ``body.target``, the newest
  ``moderation.decision`` whose ``body.action`` is one of *list, hold,
  reject, delist, tombstone, release* is the one in force; the paper is
  contested while any target's decision in force is a hold.  A *release*
  (an overturned appeal's restoration) puts the target in the state
  ``body.state`` names, so it is a hold only when it names ``held``.
* A paper is **awaiting moderation** when its newest ``paper.version`` is not
  listed: per target, the newest state-setting decision is the one in force,
  and only a *list* (or a *release* naming ``listed``) puts a version in the
  catalog.  A version no moderator has decided on, or one held, rejected,
  delisted or tombstoned, is not listed.  This is the same classification
  ``scholium verify`` shows, and it is reached only when the records include
  the paper's version records -- a caller that supplies the status records
  alone cannot tell, and keeps the old default.
* A reviewer's **current review** is the head of their ``prev`` chain: a
  ``review.formal`` that another review by the same reviewer names as
  ``prev`` has been replaced.  A ``prev`` naming somebody else's review
  replaces nothing, so one reviewer cannot hide another's review.
* A recommendation is compared lower-cased with every run of
  non-alphanumeric characters collapsed to ``_``.  *Supportive*: accept,
  approve, sound, minor revisions (and their spellings).  *Rejecting*:
  reject, rejected, fundamentally flawed.  Anything else is neutral: it
  stops the paper being ``reviewed`` but never contests it.

Determinism
-----------

The result depends only on the *set* of records: every ordering decision
sorts by ``(created, id, canonical body)`` first, so shuffling the input
never changes the answer, and nothing reads a clock, a database or the
network.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

__all__ = [
    "MIN_REVIEWS_FOR_REVIEWED",
    "RULES",
    "STATUSES",
    "STATUS_AWAITING_MODERATION",
    "STATUS_CONTESTED",
    "STATUS_CORRECTED",
    "STATUS_PREPRINT",
    "STATUS_RETRACTED",
    "STATUS_REVIEWED",
    "STATUS_UNDER_REVIEW",
    "STATUS_RECORD_TYPES",
    "StatusResult",
    "status_of",
]

# --- statuses and rules -----------------------------------------------------

STATUS_AWAITING_MODERATION = "awaiting_moderation"
STATUS_PREPRINT = "preprint"
STATUS_UNDER_REVIEW = "under_review"
STATUS_REVIEWED = "reviewed"
STATUS_CONTESTED = "contested"
STATUS_CORRECTED = "corrected"
STATUS_RETRACTED = "retracted"

#: Every status, in the order the paper view documents them.
STATUSES: tuple[str, ...] = (
    STATUS_AWAITING_MODERATION,
    STATUS_PREPRINT,
    STATUS_UNDER_REVIEW,
    STATUS_REVIEWED,
    STATUS_CONTESTED,
    STATUS_CORRECTED,
    STATUS_RETRACTED,
)

#: Rule ids in the order they are tried.
RULES: tuple[str, ...] = (
    "retraction",
    "moderation_hold",
    "review_rejection",
    "correction",
    "reviews_supportive",
    "review_activity",
    "awaiting_moderation",
    "default",
)

#: The status-bearing record types the status rules read (never ``ai.review``).
STATUS_RECORD_TYPES: frozenset[str] = frozenset(
    {
        "retraction",
        "correction",
        "moderation.decision",
        "review.commit",
        "review.formal",
    }
)

#: Reviewers needed before unanimous support reads as ``reviewed``.
MIN_REVIEWS_FOR_REVIEWED = 2

#: ``moderation.decision`` actions that set a target's state.
_STATE_SETTING_ACTIONS: frozenset[str] = frozenset(
    {"list", "hold", "reject", "delist", "tombstone", "release"}
)
_RELEASE = "release"
_HELD = "held"
_LISTED = "listed"

#: The state a plain state-setting action asks for, as the node maps them.
#: A ``release`` names its state in the record, so it is read separately.
_ACTION_STATES: dict[str, str] = {
    "list": _LISTED,
    "hold": _HELD,
    "reject": "rejected",
    "delist": "rejected",
    "tombstone": "rejected",
}

#: The states a ``release`` may name.
_RELEASE_STATES: frozenset[str] = frozenset(
    {_LISTED, "moderation", _HELD, "rejected"}
)

_RETRACTION = "retraction"
_CORRECTION = "correction"
_MODERATION = "moderation.decision"
_REVIEW_COMMIT = "review.commit"
_REVIEW_FORMAL = "review.formal"
_VERSION = "paper.version"

#: Everything :func:`status_of` may look at.  ``paper.version`` decides only
#: which version is the newest, for the queue rule; ``ai.review`` is never here.
_STATUS_INPUT_TYPES: frozenset[str] = STATUS_RECORD_TYPES | {_VERSION}

#: Normalised recommendations (see "Reading the records").
_SUPPORTIVE: frozenset[str] = frozenset(
    {
        "accept",
        "accept_as_is",
        "accept_with_minor_revisions",
        "approve",
        "minor",
        "minor_revision",
        "minor_revisions",
        "sound",
        "sound_as_is",
        "sound_with_minor_revisions",
    }
)
_REJECTING: frozenset[str] = frozenset(
    {"fundamentally_flawed", "reject", "rejected"}
)


@dataclass(frozen=True)
class StatusResult:
    """A computed status and what decided it."""

    status: str
    rule: str
    evidence: tuple[str, ...] = ()
    """Ids of the records that decided it, sorted; empty for ``default``."""


# --- reading records --------------------------------------------------------


_EPOCH = datetime.min.replace(tzinfo=timezone.utc)
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _created(value: Any) -> datetime:
    """Parse ``created``; anything unreadable sorts before every real time."""
    if not isinstance(value, str):
        return _EPOCH
    try:
        when = datetime.fromisoformat(value.strip())
    except ValueError:
        return _EPOCH
    return when if when.tzinfo is not None else when.replace(tzinfo=timezone.utc)


def _token(value: Any) -> str | None:
    """Lower-case ``value`` and collapse non-alphanumeric runs to ``_``."""
    text = _text(value)
    if text is None:
        return None
    return _NON_ALNUM.sub("_", text.lower()).strip("_") or None


def _order(record: Mapping[str, Any]) -> tuple[datetime, str, str]:
    """Canonical sort key: time, then record id, then the body itself."""
    body = record.get("body")
    return (
        _created(record.get("created")),
        _text(record.get("id")) or "",
        json.dumps(body if isinstance(body, Mapping) else {}, sort_keys=True, default=repr),
    )


def _body(record: Mapping[str, Any]) -> Mapping[str, Any]:
    body = record.get("body")
    return body if isinstance(body, Mapping) else {}


def _ids(records: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    return tuple(sorted({r["id"] for r in records if _text(r.get("id"))}))


# --- the rules --------------------------------------------------------------


def _state_of_decision(decision: Mapping[str, Any]) -> str | None:
    """The state the decision asks for, or ``None`` when it sets none."""
    action = _token(_body(decision).get("action"))
    if action not in _STATE_SETTING_ACTIONS:
        return None
    if action == _RELEASE:
        state = _token(_body(decision).get("state"))
        return state if state in _RELEASE_STATES else None
    return _ACTION_STATES.get(action)


def _states_in_force(
    decisions: list[Mapping[str, Any]],
) -> dict[str | None, tuple[str, Mapping[str, Any]]]:
    """Per target, the newest state-setting decision and the state it sets.

    ``decisions`` is already in canonical (oldest first) order.
    """
    current: dict[str | None, tuple[str, Mapping[str, Any]]] = {}
    for decision in decisions:
        state = _state_of_decision(decision)
        if state is not None:
            current[_text(_body(decision).get("target"))] = (state, decision)
    return current


def _holds_in_force(decisions: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Per target, the newest state-setting decision, kept when it is a hold.

    ``decisions`` is already in canonical (oldest first) order.
    """
    return [
        decision
        for state, decision in _states_in_force(decisions).values()
        if state == _HELD
    ]


def _newest_version_id(versions: list[Mapping[str, Any]]) -> str | None:
    """The record id of the newest posted version, if any is supplied.

    ``body.n`` is the version number; a fork may hold two records with the same
    number, so ``created`` and the record id break the tie, as ``verify`` orders
    the rest of its summary.
    """
    newest: str | None = None
    newest_key: tuple[int, datetime, str] | None = None
    for version in versions:
        record_id = _text(version.get("id"))
        if record_id is None:
            continue
        number = _body(version).get("n")
        if isinstance(number, bool) or not isinstance(number, int):
            number = 0
        key = (number, _created(version.get("created")), record_id)
        if newest_key is None or key > newest_key:
            newest, newest_key = record_id, key
    return newest


def _newest_version_listed(
    versions: list[Mapping[str, Any]], decisions: list[Mapping[str, Any]]
) -> bool | None:
    """Whether the newest version is listed; ``None`` when it cannot be told.

    Only a ``list`` decision (or a ``release`` naming ``listed``) puts a
    version in the catalog, the classification ``scholium verify`` uses.  With
    no version records supplied there is no newest version to ask about, so the
    caller gets ``None`` and the default rule keeps its old answer.
    """
    newest = _newest_version_id(versions)
    if newest is None:
        return None
    entry = _states_in_force(decisions).get(newest)
    return entry is not None and entry[0] == _LISTED


def _current_reviews(formal: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """One review per reviewer: the head of their ``prev`` chain.

    ``formal`` is already in canonical (oldest first) order.
    """
    by_reviewer: dict[tuple[str, Any], list[Mapping[str, Any]]] = {}
    for position, review in enumerate(formal):
        author = _text(review.get("author"))
        if author is not None:
            key: tuple[str, Any] = ("author", author)
        elif _text(review.get("id")) is not None:
            key = ("id", _text(review.get("id")))
        else:
            key = ("position", position)
        by_reviewer.setdefault(key, []).append(review)

    current: list[Mapping[str, Any]] = []
    for reviews in by_reviewer.values():
        replaced = {r.get("prev") for r in reviews if _text(r.get("prev"))}
        heads = [r for r in reviews if r.get("id") not in replaced] or reviews
        current.append(heads[-1])  # newest, as the list is oldest first
    return current


def status_of(records: Iterable[Any]) -> StatusResult:
    """Compute one paper's status from its records.

    ``records`` must hold the paper's status-bearing records; include its
    ``paper.version`` records too, or the queue rule cannot tell whether the
    newest version is listed and the default is ``preprint``.  See the module
    docstring for the input, the precedence table and the review and moderation
    rules.  Records of types the rules do not read -- ``ai.review`` included --
    are ignored by construction.

    Raises:
        ValueError: if ``records`` is not an iterable of record mappings.
    """
    if isinstance(records, (str, bytes, Mapping)):
        raise ValueError(
            "records must be an iterable of record envelopes, "
            f"got a single {type(records).__name__}"
        )
    try:
        items = list(records)
    except TypeError:
        raise ValueError(
            f"records must be an iterable of record envelopes, got {type(records).__name__}"
        ) from None

    kept: list[Mapping[str, Any]] = []
    for item in items:
        if isinstance(item, Mapping) and item.get("type") in _STATUS_INPUT_TYPES:
            kept.append(item)
    kept.sort(key=_order)

    by_type: dict[str, list[Mapping[str, Any]]] = {kind: [] for kind in _STATUS_INPUT_TYPES}
    for record in kept:
        by_type[str(record["type"])].append(record)

    if by_type[_RETRACTION]:
        return StatusResult(STATUS_RETRACTED, "retraction", _ids(by_type[_RETRACTION]))

    holds = _holds_in_force(by_type[_MODERATION])
    if holds:
        return StatusResult(STATUS_CONTESTED, "moderation_hold", _ids(holds))

    reviews = _current_reviews(by_type[_REVIEW_FORMAL])
    rejecting = [
        r for r in reviews if _token(_body(r).get("recommendation")) in _REJECTING
    ]
    if rejecting:
        return StatusResult(STATUS_CONTESTED, "review_rejection", _ids(rejecting))

    if by_type[_CORRECTION]:
        return StatusResult(STATUS_CORRECTED, "correction", _ids(by_type[_CORRECTION]))

    if len(reviews) >= MIN_REVIEWS_FOR_REVIEWED and all(
        _token(_body(r).get("recommendation")) in _SUPPORTIVE for r in reviews
    ):
        return StatusResult(STATUS_REVIEWED, "reviews_supportive", _ids(reviews))

    activity = by_type[_REVIEW_COMMIT] + by_type[_REVIEW_FORMAL]
    if activity:
        return StatusResult(STATUS_UNDER_REVIEW, "review_activity", _ids(activity))

    listed = _newest_version_listed(by_type[_VERSION], by_type[_MODERATION])
    if listed is False:
        return StatusResult(STATUS_AWAITING_MODERATION, "awaiting_moderation")

    return StatusResult(STATUS_PREPRINT, "default")
