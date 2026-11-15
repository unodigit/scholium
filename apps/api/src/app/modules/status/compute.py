"""Compute a paper's status from its records (plugin: status).

:func:`compute_status` is a pure function of the records it is given::

    compute_status(records)   # "preprint" | "under_review" | "reviewed"
                              # | "contested" | "corrected" | "retracted"

It reads **moderation, review and notice records only**.  ``ai.review`` is
never read: the AI pre-review is advisory and, by product rule, can never
change a paper's status, listing or reputation.  The function reads an
explicit allowlist of record types (:data:`STATUS_RECORD_TYPES`), so a record
of any other type -- ``ai.review`` included, whatever its body claims -- is
invisible to it by construction rather than by a filter someone could forget.

Input
-----

``records`` is the records of **one paper**, as record envelopes (mappings
with ``type``, ``body``, ``id``, ``author``, ``created`` and ``prev``, such as
``GET /v1/records/{cid}`` serves them; an object with ``model_dump()``, like
the ledger's ``RecordEnvelope``, is accepted too).  ``event_log`` rows are not
envelopes -- they lack ``type``, ``created`` and ``prev`` -- so a caller holding
rows rebuilds the envelope first (``ledger.stored_envelope(row)``); a mapping
without ``type`` is a record of no known type and is ignored.  The records may
come in any order and may be mixed with records the status does not read.
Records of other papers are *not* filtered out: choosing which records belong
to the paper is the caller's job.

``compute_status`` does not verify signatures or check who may sign what.
The node's ingest has already done that for every record it appended, and
:func:`scholium_record_core.verify_paper` is the independent verifier.  A
record handed to this function is taken to be an accepted one.

Precedence
----------

The first rule that matches decides; later rules are not consulted.  This
table is the contract (:data:`STATUS_PRECEDENCE` lists the statuses in the
same order, :data:`RULES` the rule ids).

====  ======================  ============  ================================
 #    rule                    status        matches when
====  ======================  ============  ================================
 1    ``retraction``          retracted     a ``retraction`` notice is on
                                            record
 2    ``moderation_hold``     contested     a moderation ``hold`` is in
                                            force
 3    ``review_rejection``    contested     a reviewer's current review
                                            recommends rejection
 4    ``correction``          corrected     a ``correction`` notice is on
                                            record
 5    ``reviews_supportive``  reviewed      at least
                                            :data:`MIN_REVIEWS_FOR_REVIEWED`
                                            reviewers have a revealed
                                            review and every one is
                                            supportive
 6    ``review_activity``     under_review  any ``review.commit`` or
                                            ``review.formal`` is on record
 7    ``default``             preprint      nothing above matched
====  ======================  ============  ================================

Why this order:

* A retraction is final and outranks everything, as in
  :func:`scholium_record_core.verify_paper`.
* An open dispute outranks a correction.  A correction is an author's (or the
  integrity committee's) public notice; it does not by itself settle a hold or
  a reviewer's rejection, so the paper stays *contested* until a moderator
  lifts the hold or the reviewer updates their review.  Once nothing is open,
  the correction shows.
* A correction outranks review standing: it is a durable notice every reader
  should see, and the review state remains visible on the review tab.
* ``reviewed`` needs agreement; anything short of it that has review activity
  is ``under_review``; no activity at all is ``preprint``.

Reviews
-------

Status counts *reviewers*, not review records.  A reviewer is the ``author``
of a ``review.formal`` (the per-paper review key).  A reviewer's **current**
review is the head of their ``prev`` chain: a review that another review *by
the same reviewer* names as its ``prev`` has been replaced.  If a reviewer
has several unreplaced reviews (a fork, or updates that never set ``prev``)
the newest by ``created`` wins.  A ``prev`` pointing at someone else's review
replaces nothing, so one reviewer cannot hide another's review.

A reviewer's current review counts whichever version it targets: after v2 is
posted, reviewers who have not yet updated still stand on their v1 review, and
the paper becomes ``reviewed`` as soon as the disagreeing reviewer updates.

Only ``review.formal`` records are *revealed* reviews, and only they carry a
recommendation (``body.recommendation``).  It is compared after lower-casing
and collapsing every run of non-alphanumeric characters to ``_``, so
``"Minor revisions"``, ``"minor-revisions"`` and ``"minor_revisions"`` agree:

* supportive: :data:`SUPPORTIVE_RECOMMENDATIONS` (accept, minor revisions)
* concern: :data:`CONCERN_RECOMMENDATIONS` (major revisions or concerns)
* rejecting: :data:`REJECTING_RECOMMENDATIONS` (reject, fundamentally flawed)

A missing or unrecognised recommendation is neutral: it stops the paper being
``reviewed`` (nobody earns *Reviewed* from data we cannot read) but does not
contest it.  A sealed ``review.commit`` is review activity and nothing more.

Moderation
----------

Of the ``moderation.decision`` actions, those that set a version's state --
``list``, ``hold``, ``reject``, ``delist`` and ``tombstone`` -- are tracked
per ``body.target``; the newest decision on a target is the one in force.  A
**hold in force** on any target makes the paper contested.  A later ``list``,
``reject``, ``delist`` or ``tombstone`` on the *same target* ends it.
``reclassify`` leaves a version's state alone, so it neither starts nor ends
a hold.  Decisions are compared by ``created`` (ISO 8601; offsets honoured),
ties broken by record id.  ``created`` is the signer's own clock, so lifting a
hold must be a later-dated decision on the same target.

Reject, delist and tombstone govern whether a version can be seen; the
version state carries that.  They do not describe the paper's scholarly
standing, so they change no status except by ending a hold.

Records that never change status
--------------------------------

Everything outside :data:`STATUS_RECORD_TYPES`, notably ``ai.review``,
``withdrawal`` (a notice shown on every version, but a withdrawal is not a
retraction and the six statuses have no *withdrawn*), ``appeal`` and
``appeal.decision`` (an upheld appeal acts through a new
``moderation.decision``), ``review.response``, ``review.rating``,
``discussion.post``, ``flag``, and the paper and version records themselves.

Determinism
-----------

The result depends only on the *set* of records.  Every ordering decision
sorts by ``(created, id, canonical body)`` first, so shuffling the input never
changes the answer, and nothing reads the clock, the database or the network.
The input is never modified.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .errors import InvalidRecordError

__all__ = [
    "CONCERN_RECOMMENDATIONS",
    "CORRECTION_TYPE",
    "MIN_REVIEWS_FOR_REVIEWED",
    "MODERATION_DECISION_TYPE",
    "REJECTING_RECOMMENDATIONS",
    "RETRACTION_TYPE",
    "REVIEW_COMMIT_TYPE",
    "REVIEW_FORMAL_TYPE",
    "RULES",
    "STATE_SETTING_ACTIONS",
    "STATUSES",
    "STATUS_CONTESTED",
    "STATUS_CORRECTED",
    "STATUS_PRECEDENCE",
    "STATUS_PREPRINT",
    "STATUS_RECORD_TYPES",
    "STATUS_RETRACTED",
    "STATUS_REVIEWED",
    "STATUS_UNDER_REVIEW",
    "SUPPORTIVE_RECOMMENDATIONS",
    "StatusResult",
    "compute_status",
    "explain_status",
]

# --- statuses -------------------------------------------------------------

STATUS_PREPRINT = "preprint"
STATUS_UNDER_REVIEW = "under_review"
STATUS_REVIEWED = "reviewed"
STATUS_CONTESTED = "contested"
STATUS_CORRECTED = "corrected"
STATUS_RETRACTED = "retracted"

#: Every status, in the order ``papers.status`` documents them.
STATUSES: tuple[str, ...] = (
    STATUS_PREPRINT,
    STATUS_UNDER_REVIEW,
    STATUS_REVIEWED,
    STATUS_CONTESTED,
    STATUS_CORRECTED,
    STATUS_RETRACTED,
)

#: Statuses from the one that wins every conflict to the one that wins none.
STATUS_PRECEDENCE: tuple[str, ...] = (
    STATUS_RETRACTED,
    STATUS_CONTESTED,
    STATUS_CORRECTED,
    STATUS_REVIEWED,
    STATUS_UNDER_REVIEW,
    STATUS_PREPRINT,
)

# --- rules (see the precedence table in the module docstring) --------------

RULE_RETRACTION = "retraction"
RULE_MODERATION_HOLD = "moderation_hold"
RULE_REVIEW_REJECTION = "review_rejection"
RULE_CORRECTION = "correction"
RULE_REVIEWS_SUPPORTIVE = "reviews_supportive"
RULE_REVIEW_ACTIVITY = "review_activity"
RULE_DEFAULT = "default"

#: Rule ids in the order they are tried.
RULES: tuple[str, ...] = (
    RULE_RETRACTION,
    RULE_MODERATION_HOLD,
    RULE_REVIEW_REJECTION,
    RULE_CORRECTION,
    RULE_REVIEWS_SUPPORTIVE,
    RULE_REVIEW_ACTIVITY,
    RULE_DEFAULT,
)

# --- the records that may decide a status ---------------------------------

REVIEW_COMMIT_TYPE = "review.commit"
REVIEW_FORMAL_TYPE = "review.formal"
MODERATION_DECISION_TYPE = "moderation.decision"
RETRACTION_TYPE = "retraction"
CORRECTION_TYPE = "correction"

#: The only record types :func:`compute_status` reads.  ``ai.review`` is
#: deliberately not here; see the module docstring.
STATUS_RECORD_TYPES: frozenset[str] = frozenset(
    {
        REVIEW_COMMIT_TYPE,
        REVIEW_FORMAL_TYPE,
        MODERATION_DECISION_TYPE,
        RETRACTION_TYPE,
        CORRECTION_TYPE,
    }
)

#: Reviewers needed before unanimous support reads as ``reviewed``.
MIN_REVIEWS_FOR_REVIEWED = 2

#: ``moderation.decision`` actions that set a version's state.
STATE_SETTING_ACTIONS: frozenset[str] = frozenset(
    {"list", "hold", "reject", "delist", "tombstone"}
)
_HOLD = "hold"

#: Normalised ``review.formal`` recommendations (see "Reviews").
SUPPORTIVE_RECOMMENDATIONS: frozenset[str] = frozenset(
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
CONCERN_RECOMMENDATIONS: frozenset[str] = frozenset(
    {"major", "major_concerns", "major_revision", "major_revisions"}
)
REJECTING_RECOMMENDATIONS: frozenset[str] = frozenset(
    {"fundamentally_flawed", "reject", "rejected"}
)

# --- result ---------------------------------------------------------------


@dataclass(frozen=True)
class StatusResult:
    """A computed status and what decided it."""

    #: One of :data:`STATUSES`.
    status: str
    #: The id (one of :data:`RULES`) of the precedence rule that matched.
    rule: str
    #: Ids of the records that decided it, sorted; empty for ``default``.
    evidence: tuple[str, ...] = ()


# --- reading records ------------------------------------------------------

_EPOCH = datetime.min.replace(tzinfo=timezone.utc)
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class _Record:
    """The few fields of an envelope the status rules look at."""

    type: str
    id: str | None
    author: str | None
    prev: str | None
    created: datetime
    body: Mapping[str, Any]

    def order(self) -> tuple[datetime, str, str]:
        """Canonical sort key: time, then record id, then the body itself."""
        return (
            self.created,
            self.id or "",
            json.dumps(self.body, sort_keys=True, default=repr),
        )


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


def _as_mapping(record: Any) -> Mapping[str, Any]:
    if isinstance(record, Mapping):
        return record
    dump = getattr(record, "model_dump", None)
    if callable(dump):
        data = dump()
        if isinstance(data, Mapping):
            return data
    raise InvalidRecordError(
        "each record must be a mapping (or have model_dump()), "
        f"got {type(record).__name__}"
    )


def _load(records: Iterable[Any]) -> list[_Record]:
    """Validate ``records`` and keep the ones the status rules may read."""
    if isinstance(records, (str, bytes, Mapping)):
        raise InvalidRecordError(
            "records must be an iterable of record envelopes, "
            f"got a single {type(records).__name__}"
        )
    try:
        items = list(records)
    except TypeError:
        raise InvalidRecordError(
            f"records must be an iterable of record envelopes, got {type(records).__name__}"
        ) from None

    loaded: list[_Record] = []
    for item in items:
        envelope = _as_mapping(item)
        kind = envelope.get("type")
        if kind not in STATUS_RECORD_TYPES:
            continue  # includes ai.review, and anything without a usable type
        body = envelope.get("body")
        loaded.append(
            _Record(
                type=kind,
                id=_text(envelope.get("id")),
                author=_text(envelope.get("author")),
                prev=_text(envelope.get("prev")),
                created=_created(envelope.get("created")),
                body=body if isinstance(body, Mapping) else {},
            )
        )
    loaded.sort(key=_Record.order)
    return loaded


def _ids(records: Iterable[_Record]) -> tuple[str, ...]:
    return tuple(sorted({r.id for r in records if r.id is not None}))


# --- rules ----------------------------------------------------------------


def _holds_in_force(decisions: list[_Record]) -> list[_Record]:
    """Per target, the newest state-setting decision, kept when it is a hold.

    ``decisions`` is already in canonical (oldest first) order.
    """
    current: dict[str | None, tuple[str, _Record]] = {}
    for decision in decisions:
        action = _token(decision.body.get("action"))
        if action in STATE_SETTING_ACTIONS:
            current[_text(decision.body.get("target"))] = (action, decision)
    return [d for action, d in current.values() if action == _HOLD]


def _current_reviews(formal: list[_Record]) -> list[_Record]:
    """One review per reviewer: the head of their ``prev`` chain.

    ``formal`` is already in canonical (oldest first) order.
    """
    by_reviewer: dict[tuple[str, Any], list[_Record]] = {}
    for position, review in enumerate(formal):
        if review.author is not None:
            key: tuple[str, Any] = ("author", review.author)
        elif review.id is not None:
            key = ("id", review.id)
        else:
            key = ("position", position)
        by_reviewer.setdefault(key, []).append(review)

    current: list[_Record] = []
    for reviews in by_reviewer.values():
        replaced = {r.prev for r in reviews if r.prev is not None}
        heads = [r for r in reviews if r.id not in replaced] or reviews
        current.append(heads[-1])  # newest, as the list is oldest first
    return current


def _recommendation(review: _Record) -> str | None:
    return _token(review.body.get("recommendation"))


def explain_status(records: Iterable[Any]) -> StatusResult:
    """Compute a paper's status and report which rule decided it.

    See the module docstring for the input, the precedence table and the
    review and moderation rules.

    Raises:
        InvalidRecordError: if ``records`` is not an iterable of record
            envelopes.  Nothing a well-formed record can contain raises.
    """
    loaded = _load(records)
    by_type: dict[str, list[_Record]] = {kind: [] for kind in STATUS_RECORD_TYPES}
    for record in loaded:
        by_type[record.type].append(record)

    retractions = by_type[RETRACTION_TYPE]
    if retractions:
        return StatusResult(STATUS_RETRACTED, RULE_RETRACTION, _ids(retractions))

    holds = _holds_in_force(by_type[MODERATION_DECISION_TYPE])
    if holds:
        return StatusResult(STATUS_CONTESTED, RULE_MODERATION_HOLD, _ids(holds))

    reviews = _current_reviews(by_type[REVIEW_FORMAL_TYPE])
    rejecting = [r for r in reviews if _recommendation(r) in REJECTING_RECOMMENDATIONS]
    if rejecting:
        return StatusResult(STATUS_CONTESTED, RULE_REVIEW_REJECTION, _ids(rejecting))

    corrections = by_type[CORRECTION_TYPE]
    if corrections:
        return StatusResult(STATUS_CORRECTED, RULE_CORRECTION, _ids(corrections))

    if len(reviews) >= MIN_REVIEWS_FOR_REVIEWED and all(
        _recommendation(r) in SUPPORTIVE_RECOMMENDATIONS for r in reviews
    ):
        return StatusResult(STATUS_REVIEWED, RULE_REVIEWS_SUPPORTIVE, _ids(reviews))

    activity = by_type[REVIEW_COMMIT_TYPE] + by_type[REVIEW_FORMAL_TYPE]
    if activity:
        return StatusResult(STATUS_UNDER_REVIEW, RULE_REVIEW_ACTIVITY, _ids(activity))

    return StatusResult(STATUS_PREPRINT, RULE_DEFAULT)


def compute_status(records: Iterable[Any]) -> str:
    """Return a paper's status: one of :data:`STATUSES`.

    Deterministic, from moderation, review and notice records only (never
    ``ai.review``), with the precedence documented in this module.  Use
    :func:`explain_status` to also learn which rule decided and on which
    records.

    Raises:
        InvalidRecordError: if ``records`` is not an iterable of record
            envelopes.
    """
    return explain_status(records).status
