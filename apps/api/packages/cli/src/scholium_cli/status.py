"""A paper's status, computed independently of the node (feature 98).

``scholium rebuild`` writes a ``paper_status`` view next to the paper and
version views, and a third party's rebuild must be able to reproduce it from
the records alone -- with the node's own code imported nowhere.  This module
is that independent implementation of the status rules the product states
(the contract ``papers.status`` documents, feature 83):

    status_of(records).status    # "preprint" | "under_review" | "reviewed"
                                # | "contested" | "corrected" | "retracted"

Only moderation, review and notice records are read -- ``retraction``,
``correction``, ``moderation.decision``, ``review.commit`` and
``review.formal`` -- and ``ai.review`` is never read: the AI pre-review is
advisory and can never change a paper's status, whatever its body claims.
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
 7    ``default``             preprint
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

STATUS_PREPRINT = "preprint"
STATUS_UNDER_REVIEW = "under_review"
STATUS_REVIEWED = "reviewed"
STATUS_CONTESTED = "contested"
STATUS_CORRECTED = "corrected"
STATUS_RETRACTED = "retracted"

#: Every status, in the order the paper view documents them.
STATUSES: tuple[str, ...] = (
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
    "default",
)

#: The only record types the status rules read (never ``ai.review``).
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
_HOLD = "hold"
_RELEASE = "release"
_HELD = "held"

_RETRACTION = "retraction"
_CORRECTION = "correction"
_MODERATION = "moderation.decision"
_REVIEW_COMMIT = "review.commit"
_REVIEW_FORMAL = "review.formal"

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


def _holds_in_force(decisions: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Per target, the newest state-setting decision, kept when it is a hold.

    ``decisions`` is already in canonical (oldest first) order.
    """
    current: dict[str | None, tuple[str, Mapping[str, Any]]] = {}
    for decision in decisions:
        action = _token(_body(decision).get("action"))
        if action in _STATE_SETTING_ACTIONS:
            if action == _RELEASE and _token(_body(decision).get("state")) == _HELD:
                action = _HOLD  # released back into a hold: the hold is in force again
            current[_text(_body(decision).get("target"))] = (action, decision)
    return [d for action, d in current.values() if action == _HOLD]


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
    """Compute one paper's status from its status-bearing records.

    See the module docstring for the input, the precedence table and the
    review and moderation rules.  Records of types the rules do not read --
    ``ai.review`` included -- are ignored by construction.

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
        if isinstance(item, Mapping) and item.get("type") in STATUS_RECORD_TYPES:
            kept.append(item)
    kept.sort(key=_order)

    by_type: dict[str, list[Mapping[str, Any]]] = {kind: [] for kind in STATUS_RECORD_TYPES}
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

    return StatusResult(STATUS_PREPRINT, "default")
