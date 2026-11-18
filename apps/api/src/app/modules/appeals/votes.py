"""Panel votes on an appeal (plugin: appeals, feature 76).

The three members seated for an appeal (feature 75) decide it by voting::

    POST /v1/appeals/{appeal cid}/votes
    Authorization: Bearer <the panel member's access token>

    {"vote": "overturned",          # or "outcome"; upheld | overturned | ...
     "reasons": "The paper is in scope of MOD-01."}

The voter is the access token's DID, never anything the body says, and only a
member with a seat on *this* appeal's panel may vote -- anyone else is refused
with ``403``.  A member's vote is saved to ``appeal_panels.vote`` (one ``vote``
per seat), the reasons they give alongside it to ``appeal_vote_reasons``, and
the vote is counted with the panel's other votes.

When two of the three seats carry the same outcome the panel has decided, and
the node appends a **node-signed** ``appeal.decision`` record to the public log
(``GET /v1/records/{cid}``; found by replaying ``GET /v1/sync/range``).  The
record's ``author`` -- and therefore its signer -- is the node's own ``did:key``,
and its body carries the appeal it decides (``target``), the agreed ``outcome``
and the agreeing members' ``reasons``, plus the votes themselves for
provenance::

    {"target": "<appeal cid>", "appeal": "<appeal cid>",
     "outcome": "overturned", "reasons": ["...", "..."],
     "votes": [{"did": "...", "outcome": "overturned", "reasons": "..."}, ...]}

The record is signed with the key at ``NODE_KEY_PATH``
(:func:`app.modules.ledger.origin.node_signing_key`).  A node without a usable
key cannot make the decision and answers ``503``; the votes already cast are
kept, so the decision is made once a key is provisioned and a vote is cast
again.

What an overturn does
---------------------

An ``appeal.decision`` alone is a verdict: it does not by itself lift the
appealed ``moderation.decision``, so an overturned hold would leave the paper
``contested`` until a moderator relisted it by hand.  When the panel's outcome
is one of :data:`RESTORING_OUTCOMES` (``overturned``, and the grant/allow
spellings), the node therefore appends a **node-signed ``moderation.decision``
with the dedicated action** ``release`` that puts the appealed target back in
the state the appealed decision found it in (:func:`restore_target`):

* the state before the appealed decision is read from the log -- the newest
  ``moderation.decision`` on the same target dated before the appealed one that
  sets a state (:func:`app.modules.moderation.decision_state`) -- falling back
  to ``listed`` for a version that had been in the catalog
  (:attr:`PaperVersion.listed_at`) and ``moderation`` for one that was still
  being moderated;
* the restoring record is a ``release`` whose ``state`` *names* that prior
  state.  It is never a ``list`` (or any other approving action) for a version
  that was not listed: the public log must not say a moderator approved
  something they never saw, and whoever replays it -- rebuild, a sync peer, the
  status rules -- must land in the state the live node is in.  A ``release``
  puts the version in exactly the state it names: ``moderation`` stays
  ``moderation`` and ``listed`` stays ``listed``;
* the record takes the appealed decision's clause and points at the appeal
  (``appeal``/``appeal_restoration``) so the restoration is auditable and is
  made once, however many votes follow;
* the version is moved to that state and the paper's status is recomputed from
  the log, so the hold is no longer in force.

A restoration is made only while the appealed decision is still the newest
state-setting decision on the target and the version is still in the state it
set, and only to a state a ``release`` can name; otherwise nothing is appended
and the moderator is told (fail closed).

The restoration is best effort after the ``appeal.decision`` is public: it is
logged if it fails and retried by a later vote, but it never turns a made
decision into a failed vote.

Voting twice is harmless: a member's latest vote replaces their earlier one,
and a vote cast after the decision is recorded without producing a second
decision.  The whole cast is serialised within the process, so two votes that
race cannot both see one vote each (and miss the majority) or both append a
decision.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select

from scholium_record_core import did_key_from_signing_key, sign_record, validate_body

from app import db
from app.modules import ledger, submissions
from app.modules.ingest import InvalidRecord
from app.modules.ledger.models import EventLog
from app.modules.moderation import (
    ACTION_STATES as MODERATION_ACTION_STATES,
    DECISION_TYPE as MODERATION_DECISION_TYPE,
    RELEASE as RELEASE_ACTION,
    RELEASE_STATES,
    decision_state,
    get_decision as get_moderation_decision,
)

from .errors import (
    AppealNotFound,
    FallbackNotAuthorized,
    PanelDecisionNotDue,
    PanelNotDrawn,
    PanelSeated,
    VoteNodeKeyUnavailable,
    VoteNotAuthorized,
)
from .models import Appeal, AppealPanelMember, AppealVoteReasons, ensure_tables
from .panel import get_panel
from .service import get_appeal, panel_exclusions, resolve_decision, vote_deadline

logger = logging.getLogger(__name__)

__all__ = [
    "DECIDING_VOTES",
    "DECISION_TYPE",
    "RESTORING_OUTCOMES",
    "VOTE_OUTCOMES",
    "VoteCast",
    "cast_vote",
    "decide_without_panel",
    "decision_for_appeal",
    "restore_target",
    "vote_fields",
]

#: The record type the panel's decision has.
DECISION_TYPE = "appeal.decision"

#: Votes of the three that decide an appeal.  Kept in step with
#: :data:`app.modules.appeals.panel.PANEL_SIZE` in spirit: two of three.
DECIDING_VOTES = 2

#: Outcomes a member may back.  Every one is an ``appeal.decision`` outcome
#: (``schemas/appeal.decision.json``), so the vote vocabulary cannot drift from
#: the record the panel's decision becomes.
VOTE_OUTCOMES = (
    "upheld",
    "overturned",
    "modified",
    "remanded",
    "granted",
    "grant",
    "denied",
    "deny",
    "allowed",
    "dismissed",
)

#: Outcomes that mean the appealed decision no longer stands.  The panel's vote
#: vocabulary draws them from the ``appeal.decision`` schema; the grant/allow
#: spellings all mean the appellant won, so the target is restored as for an
#: ``overturned``.  ``modified`` and ``remanded`` leave the appeal's outcome to
#: a new moderation decision and change no state here.
RESTORING_OUTCOMES = frozenset({"overturned", "granted", "grant", "allowed"})

#: Serialises casting within this process.  The panel read, the vote write and
#: the majority check are one step, so two concurrent votes cannot both miss a
#: majority (or append two decisions).
_vote_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# The request
# --------------------------------------------------------------------------- #


def _invalid(loc: list[Any], message: str, error_type: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad part of a vote request, located at ``loc``."""
    shown = value if isinstance(value, (str, int, float, bool, type(None))) else None
    if isinstance(shown, str) and len(shown) > 64:
        shown = shown[:61] + "..."
    full = f"The vote is invalid: {message}."
    return InvalidRecord(
        [{"loc": loc, "msg": full, "type": error_type, "input": shown}],
        detail=full,
    )


def _first(body: Mapping[str, Any], *names: str) -> Any:
    """The first of ``names`` the body carries with a non-null value."""
    for name in names:
        if name in body and body[name] is not None:
            return body[name]
    return None


def vote_fields(body: Mapping[str, Any]) -> tuple[str, tuple[str, ...]]:
    """Read an outcome and reasons out of a vote body.

    The body may spell the outcome ``outcome`` (the ``appeal.decision`` field)
    or ``vote`` (the ``appeal_panels`` column), and the reasons ``reasons`` or
    ``reason``.  Reasons may be one string or a list of strings.

    Raises:
        InvalidRecord: ``422`` when the outcome is missing or not one of
            :data:`VOTE_OUTCOMES`, or the reasons are not text.
    """
    if not isinstance(body, Mapping):
        raise _invalid(["body"], "the request body must be a JSON object", "invalid_body")

    outcome = _first(body, "outcome", "vote")
    if not isinstance(outcome, str) or not outcome.strip():
        raise _invalid(
            ["body", "outcome"],
            "needs the outcome being backed in 'outcome' (or 'vote')",
            "missing_outcome",
            outcome,
        )
    outcome = outcome.strip()
    if outcome not in VOTE_OUTCOMES:
        raise _invalid(
            ["body", "outcome"],
            f"'outcome' must be one of {', '.join(VOTE_OUTCOMES)}",
            "invalid_outcome",
            outcome,
        )

    raw_reasons = _first(body, "reasons", "reason")
    if raw_reasons is None:
        return outcome, ()
    if isinstance(raw_reasons, str):
        text = raw_reasons.strip()
        return outcome, (text,) if text else ()
    if isinstance(raw_reasons, (list, tuple)) and all(isinstance(item, str) for item in raw_reasons):
        return outcome, tuple(item.strip() for item in raw_reasons if item.strip())
    raise _invalid(
        ["body", "reasons"],
        "'reasons' (or 'reason') must be a string or a list of strings",
        "invalid_reasons",
    )


# --------------------------------------------------------------------------- #
# Reading votes and decisions
# --------------------------------------------------------------------------- #


def _reasons(appeal_cid: str) -> dict[str, tuple[str, ...]]:
    """The reasons each seated member gave with their vote, by DID."""
    with db.SessionLocal() as session:
        rows = (
            session.query(AppealVoteReasons)
            .filter(AppealVoteReasons.appeal_cid == appeal_cid)
            .all()
        )
        return {
            str(row.member_did): tuple(item for item in (row.reasons or ()) if isinstance(item, str))
            for row in rows
        }


def _majority(votes: list[AppealPanelMember]) -> Optional[str]:
    """The outcome backed by at least :data:`DECIDING_VOTES` seats, if any."""
    counts: dict[str, int] = {}
    for row in votes:
        outcome = row.vote
        if isinstance(outcome, str) and outcome:
            counts[outcome] = counts.get(outcome, 0) + 1
            if counts[outcome] >= DECIDING_VOTES:
                return outcome
    return None


def decision_for_appeal(appeal_cid: object) -> Optional[EventLog]:
    """The ``appeal.decision`` appended for ``appeal_cid``, or ``None``.

    A panel decides an appeal once: the first decision that targets it is its
    decision, and every later vote reports that same record.
    """
    if not isinstance(appeal_cid, str) or not appeal_cid:
        return None
    ledger.ensure_table()
    statement = select(EventLog).where(EventLog.record_type == DECISION_TYPE).order_by(EventLog.seq)
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        for entry in session.execute(statement).scalars():
            body = entry.body
            if isinstance(body, Mapping) and body.get("target") == appeal_cid:
                session.expunge(entry)
                return entry
    return None


# --------------------------------------------------------------------------- #
# Casting a vote
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class VoteCast:
    """What one accepted vote did."""

    appeal_cid: str
    member_did: str
    #: The outcome the member backed.
    outcome: str
    #: How many of the panel's seats now carry a vote.
    votes_cast: int
    #: The decision's cid when the panel has decided the appeal, else ``None``.
    decision_cid: Optional[str]
    #: The outcome the panel agreed on, when a decision was made (now or before).
    decided_outcome: Optional[str]


def _timestamp() -> str:
    """Now as the ``created`` field of a record envelope."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _created_after(reference: Optional[str]) -> str:
    """Now, but unambiguously later than ``reference``.

    The status rules compare decisions by ``created`` and break a tie by record
    id, which is a hash: two decisions signed in the same second would order by
    accident.  A restoration must follow the decision it undoes, so when the
    clock has not yet moved past that second it is moved to the next one.
    """
    now = datetime.now(timezone.utc)
    if isinstance(reference, str):
        try:
            prior = datetime.fromisoformat(reference.strip().replace("Z", "+00:00"))
        except ValueError:
            prior = None
        if prior is not None:
            if prior.tzinfo is None:
                prior = prior.replace(tzinfo=timezone.utc)
            now = max(now, prior.replace(microsecond=0) + timedelta(seconds=1))
    return now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _store_vote(appeal_cid: str, member_did: str, outcome: str, reasons: tuple[str, ...]) -> None:
    """Save (or replace) ``member_did``'s vote and reasons on ``appeal_cid``."""
    with db.SessionLocal() as session:
        row = session.get(AppealPanelMember, (appeal_cid, member_did))
        if row is None:
            raise VoteNotAuthorized(member_did, appeal_cid)
        row.vote = outcome
        # Naive UTC, like ``appeals.filed_at``: the detail re-attaches UTC when
        # it reads the time back, so a reload can say when the vote was cast.
        row.voted_at = datetime.now(timezone.utc).replace(tzinfo=None)
        detail = session.get(AppealVoteReasons, (appeal_cid, member_did))
        if reasons:
            if detail is None:
                session.add(
                    AppealVoteReasons(
                        appeal_cid=appeal_cid,
                        member_did=member_did,
                        reasons=list(reasons),
                    )
                )
            else:
                detail.reasons = list(reasons)
        elif detail is not None:
            session.delete(detail)
        session.commit()


def _build_decision_body(
    appeal_cid: str,
    outcome: str,
    votes: list[AppealPanelMember],
    reasons: dict[str, tuple[str, ...]],
    *,
    decided_without_panel: bool = False,
    note_reasons: tuple[str, ...] = (),
) -> dict[str, Any]:
    """The ``appeal.decision`` body for an agreed outcome, with its reasons."""
    agreed = [row for row in votes if row.vote == outcome]
    agreed_reasons = [reason for row in agreed for reason in reasons.get(str(row.member_did), ())]
    if note_reasons:
        agreed_reasons = list(note_reasons)
    body: dict[str, Any] = {
        "target": appeal_cid,
        "appeal": appeal_cid,
        "outcome": outcome,
        "reasons": agreed_reasons or [f"A majority of the panel agreed to {outcome} the appeal."],
        "votes": [
            {
                "did": str(row.member_did),
                "outcome": str(row.vote),
                "reasons": list(reasons.get(str(row.member_did), ())),
            }
            for row in votes
            if isinstance(row.vote, str) and row.vote
        ],
    }
    if decided_without_panel:
        # The console and every other reader can tell this decision from a
        # panel's: no members were drawn, so nobody voted.
        body["decided_without_panel"] = True
        body["panel"] = None
    return body


def _save_decision(
    appeal_cid: str,
    outcome: str,
    votes: list[AppealPanelMember],
    reasons: dict[str, tuple[str, ...]],
    *,
    decided_without_panel: bool = False,
    note_reasons: tuple[str, ...] = (),
) -> str:
    """Sign and append the panel's ``appeal.decision``; return its cid.

    An outcome in :data:`RESTORING_OUTCOMES` also restores the appealed target
    (:func:`restore_target`).  That happens after the decision is public, so a
    restoration that fails is logged, not raised: the panel's decision stands.
    """
    key = ledger.node_signing_key()
    if key is None:
        raise VoteNodeKeyUnavailable(appeal_cid)

    body = _build_decision_body(
        appeal_cid,
        outcome,
        votes,
        reasons,
        decided_without_panel=decided_without_panel,
        note_reasons=note_reasons,
    )
    errors = validate_body(DECISION_TYPE, body)
    if errors:  # pragma: no cover - the body is built from the record's own schema
        raise _invalid(["body"], errors[0], "invalid_appeal_decision")

    record = sign_record(
        {
            "v": 1,
            "type": DECISION_TYPE,
            "author": did_key_from_signing_key(key),
            "created": _timestamp(),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        key,
    )
    ledger.append(record)

    _mark_decided(appeal_cid, outcome)
    _restore_after_overturn(appeal_cid, outcome, key)
    return str(record["id"])


# --------------------------------------------------------------------------- #
# Restoring the target of an overturned decision
# --------------------------------------------------------------------------- #


def _node_authored(entry: EventLog) -> bool:
    """Whether ``entry`` was authored by this node (only such records count)."""
    try:
        key = ledger.node_signing_key()
        if key is not None:
            from scholium_record_core import did_key_from_signing_key

            return str(entry.author_did) == did_key_from_signing_key(key)
    except Exception:
        pass
    try:
        return str(entry.author_did) == str(ledger.origin.node_did())
    except Exception:
        return False


def _restoration_aliases() -> tuple[str, ...]:
    return ("restoration_cid", "restoration_record_cid", "restoration_decision_cid", "restoration_id")


def _store_restoration_cid(appeal_cid: str, cid: str) -> None:
    """Persist ``cid`` as the restoration record on the appeal row (once)."""
    try:
        with db.SessionLocal() as session:
            row = session.get(Appeal, appeal_cid)
            if row is None:
                return
            for attr in _restoration_aliases():
                if getattr(row, attr, None) is None:
                    setattr(row, attr, cid)
            session.commit()
    except Exception:
        logger.exception("could not store restoration cid for appeal %s", appeal_cid)


def _restoration_for(appeal_cid: str) -> Optional[EventLog]:
    """The node-authored ``moderation.decision`` already appended to restore this appeal."""
    # Idempotency by the column first: a forged body field cannot stand in for it.
    appeal = get_appeal(appeal_cid)
    if appeal is not None:
        for attr in _restoration_aliases():
            value = getattr(appeal, attr, None)
            if isinstance(value, str) and value:
                entry = ledger.entry_by_cid(value)
                if entry is not None and _node_authored(entry):
                    body = entry.body if isinstance(entry.body, Mapping) else {}
                    if body.get("appeal") == appeal_cid or body.get("appeal_restoration") == appeal_cid:
                        return entry
    ledger.ensure_table()
    statement = (
        select(EventLog)
        .where(EventLog.record_type == MODERATION_DECISION_TYPE)
        .order_by(EventLog.seq)
    )
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        for entry in session.execute(statement).scalars():
            if not _node_authored(entry):
                continue
            body = entry.body
            if not isinstance(body, Mapping):
                continue
            if body.get("appeal") == appeal_cid or body.get("appeal_restoration") == appeal_cid:
                _store_restoration_cid(appeal_cid, str(entry.record_cid))
                session.expunge(entry)
                return entry
    return None


def _appealed_decision_body(decision_cid: str) -> Mapping[str, Any]:
    """The appealed decision's body, from its saved row or, failing that, the log."""
    row = get_moderation_decision(decision_cid)
    if row is not None:
        return {"target": row.target_cid, "action": row.action, "clause": row.clause}
    entry = ledger.entry_by_cid(decision_cid)
    body = entry.body if entry is not None else None
    return body if isinstance(body, Mapping) else {}


def _prior_version_state(version_cid: str, decision_cid: str) -> str:
    """The state ``version_cid`` had before ``decision_cid`` was made.

    The newest ``moderation.decision`` on the same target that is older in the
    log and sets a state (a ``release`` sets the state it names) is the
    authority.  With none, a version that had been in the catalog (:attr:`~app.modules.submissions.models.PaperVersion.listed_at`
    is kept when it is held or rejected) was ``listed``; otherwise it was still
    being moderated.
    """
    appealed = ledger.entry_by_cid(decision_cid)
    before = appealed.seq if appealed is not None else None

    prior: Optional[str] = None
    with db.SessionLocal() as session:
        statement = (
            select(EventLog)
            .where(EventLog.record_type == MODERATION_DECISION_TYPE)
            .order_by(EventLog.seq)
        )
        if before is not None:
            statement = statement.where(EventLog.seq < before)
        for entry in session.execute(statement).scalars():
            body = entry.body
            if not isinstance(body, Mapping) or body.get("target") != version_cid:
                continue
            state = decision_state(body)
            if state is not None:
                prior = state
    if prior is not None:
        return prior

    version = submissions.get_version(version_cid)
    if version is not None and getattr(version, "listed_at", None) is not None:
        return submissions.LISTED
    return submissions.MODERATION


def restore_target(appeal_cid: str, outcome: str, key: Any = None) -> Optional[str]:
    """Append the decision that restores an overturned appeal's target.

    Returns the cid of the restoring ``moderation.decision`` -- a ``release``
    naming the state the version is returned to -- or ``None`` when the outcome
    restores nothing, the restoration was already made, or it is skipped (stale
    target, a prior state a release cannot name).  The record carries the
    appeal's cid in ``appeal``/``appeal_restoration``, which is what makes the
    restoration auditable; idempotency keys off the appeal row's column.

    Raises:
        VoteNodeKeyUnavailable: ``503`` -- no usable node key and the outcome
            needs a signed record.  The caller treats this as best effort.
        UnknownAppealTarget: the appealed decision can no longer be resolved.
    """
    if outcome not in RESTORING_OUTCOMES:
        return None
    existing = _restoration_for(appeal_cid)
    if existing is not None:
        return str(existing.record_cid)

    appeal = get_appeal(appeal_cid)
    if appeal is None:
        return None
    decision = resolve_decision(str(appeal.decision_cid))
    if key is None:
        key = ledger.node_signing_key()
    if key is None:
        raise VoteNodeKeyUnavailable(appeal_cid)

    appealed_body = _appealed_decision_body(str(appeal.decision_cid))
    appealed_action = appealed_body.get("action") if isinstance(appealed_body, Mapping) else None

    # A decision on a hidden record (post, annotation or review): restoration
    # is an unhide, not a version-state change.
    if decision.version_cid is None:
        if appealed_action != "hide":
            return None
        from app.modules.moderation.hides import get_hidden_entry

        if get_hidden_entry(decision.target_cid) is None:
            return None

        clause = appealed_body.get("clause") if isinstance(appealed_body, Mapping) else None
        if not isinstance(clause, str) or not clause:
            clause = "MOD-01"

        body = {
            "target": decision.target_cid,
            "action": RELEASE_ACTION,
            "state": submissions.LISTED,
            "clause": clause,
            "reason": (
                "The appeal panel overturned the decision; "
                "this decision restores the hidden record."
            ),
            "paper": decision.paper_cid,
            "appeal": appeal_cid,
            "appeal_restoration": appeal_cid,
        }
        errors = validate_body(MODERATION_DECISION_TYPE, body)
        if errors:  # pragma: no cover - the body is built from the record's own schema
            raise _invalid(["body"], errors[0], "invalid_restoration")

        appealed_entry = ledger.entry_by_cid(str(appeal.decision_cid))
        appealed_created = (
            ledger.stored_envelope(appealed_entry).created if appealed_entry is not None else None
        )
        record = sign_record(
            {
                "v": 1,
                "type": MODERATION_DECISION_TYPE,
                "author": did_key_from_signing_key(key),
                "created": _created_after(appealed_created),
                "prev": None,
                "body": body,
                "proofs": [],
            },
            key,
        )
        ledger.append(record)

        _store_restoration_cid(appeal_cid, str(record["id"]))

        try:
            from app.modules import moderation as _moderation

            _moderation.apply_decision(record)
        except Exception:  # pragma: no cover - a projection, not the decision
            logger.exception("could not apply the restoration of appeal %s", appeal_cid)
        return str(record["id"])

    prior = _prior_version_state(decision.version_cid, str(appeal.decision_cid))
    appealed_set_state = MODERATION_ACTION_STATES.get(appealed_action) if isinstance(appealed_action, str) else None

    # Guard: restoration only if the appealed decision is still the newest
    # state-setting decision on the target, and the version is still in the
    # state that decision set.
    appealed_entry = ledger.entry_by_cid(str(appeal.decision_cid))
    if appealed_entry is not None:
        for entry in ledger.entries():
            if entry.record_type != MODERATION_DECISION_TYPE:
                continue
            body = entry.body if isinstance(entry.body, Mapping) else {}
            if body.get("target") != decision.version_cid:
                continue
            if decision_state(body) is None:
                continue
            if entry.seq > appealed_entry.seq:
                logger.info(
                    "skipping restoration of appeal %s: a newer state-setting decision exists",
                    appeal_cid,
                )
                return None
    version = submissions.get_version(decision.version_cid)
    current_state = getattr(version, "state", None) if version is not None else None
    if appealed_set_state is not None and current_state != appealed_set_state:
        logger.info(
            "skipping restoration of appeal %s: version state %r != %r",
            appeal_cid,
            current_state,
            appealed_set_state,
        )
        return None

    clause = appealed_body.get("clause") if isinstance(appealed_body, Mapping) else None
    if not isinstance(clause, str) or not clause:
        clause = "MOD-01"

    if prior not in RELEASE_STATES:
        # A prior state a release cannot name: fail closed -- no restoration,
        # moderator notified.
        try:
            from app.modules.notifications.service import notify

            notify(
                str(decision.moderator_did),
                "appeal.restoration_failed",
                {
                    "appeal_cid": appeal_cid,
                    "appeal": appeal_cid,
                    "decision_cid": str(appeal.decision_cid),
                    "target": decision.version_cid,
                    "prior_state": prior,
                    "link": f"/v1/appeals/{appeal_cid}",
                },
            )
        except Exception:
            logger.exception("could not notify moderator of failed restoration for %s", appeal_cid)
        return None

    body = {
        "target": decision.version_cid,
        "action": RELEASE_ACTION,
        "state": prior,
        "clause": clause,
        "reason": (
            "The appeal panel overturned the decision; "
            "this decision restores the version's state."
        ),
        "paper": decision.paper_cid,
        "appeal": appeal_cid,
        "appeal_restoration": appeal_cid,
    }
    errors = validate_body(MODERATION_DECISION_TYPE, body)
    if errors:  # pragma: no cover - the body is built from the record's own schema
        raise _invalid(["body"], errors[0], "invalid_restoration")

    appealed_entry = ledger.entry_by_cid(str(appeal.decision_cid))
    appealed_created = (
        ledger.stored_envelope(appealed_entry).created if appealed_entry is not None else None
    )
    record = sign_record(
        {
            "v": 1,
            "type": MODERATION_DECISION_TYPE,
            "author": did_key_from_signing_key(key),
            "created": _created_after(appealed_created),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        key,
    )
    ledger.append(record)

    _store_restoration_cid(appeal_cid, str(record["id"]))

    submissions.transition_version(
        decision.version_cid,
        prior,
        actor=did_key_from_signing_key(key),
        reason=f"Appeal {appeal_cid} was {outcome}.",
    )

    try:
        from app.modules import status

        status.recompute_paper_status(decision.paper_cid)
    except Exception:  # pragma: no cover - a projection, not the decision
        logger.exception("could not recompute the status of paper %s", decision.paper_cid)
    return str(record["id"])

def _restore_after_overturn(appeal_cid: str, outcome: str, key: Any = None) -> None:
    """Run :func:`restore_target` best-effort: a failure never fails the vote."""
    try:
        restore_target(appeal_cid, outcome, key)
    except Exception:
        logger.exception("could not restore the target of appeal %s after %s", appeal_cid, outcome)


def _mark_decided(appeal_cid: str, outcome: str) -> None:
    """Record the panel's outcome on the appeal's ``status``; never raises.

    The decision is already in the log -- the source of truth -- so a status
    update that fails must not turn a made decision into a failed vote.
    """
    try:
        with db.SessionLocal() as session:
            row = session.get(Appeal, appeal_cid)
            if row is not None:
                row.status = outcome
                session.commit()
    except Exception:  # pragma: no cover - a projection, not the decision
        pass


def cast_vote(
    appeal_cid: str,
    member_did: str,
    outcome: str,
    reasons: tuple[str, ...] = (),
) -> VoteCast:
    """Record ``member_did``'s vote on ``appeal_cid`` and decide if two seats agree.

    ``member_did`` is the access token's DID.  The caller must hold a seat on
    this appeal's panel; the vote replaces any earlier vote by the same member.

    When :data:`DECIDING_VOTES` seats carry the same outcome, and the appeal has
    no decision yet, a node-signed ``appeal.decision`` is appended to the log.

    Raises:
        AppealNotFound: ``404`` -- no such appeal is filed here.
        PanelNotDrawn: ``409`` -- the appeal has no panel seated.
        VoteNotAuthorized: ``403`` -- ``member_did`` holds no seat on it.
        VoteNodeKeyUnavailable: ``503`` -- a majority agreed but the node has no
            signing key.
    """
    ensure_tables()
    with _vote_lock:
        if get_appeal(appeal_cid) is None:
            raise AppealNotFound(appeal_cid)

        votes = get_panel(appeal_cid)
        if not votes:
            raise PanelNotDrawn(appeal_cid)
        if member_did not in {str(row.member_did) for row in votes}:
            raise VoteNotAuthorized(member_did, appeal_cid)

        _store_vote(appeal_cid, member_did, outcome, reasons)
        votes = get_panel(appeal_cid)
        reasons_by_member = _reasons(appeal_cid)

        existing = decision_for_appeal(appeal_cid)
        if existing is not None:
            existing_body = existing.body if isinstance(existing.body, Mapping) else {}
            decided = existing_body.get("outcome")
            if isinstance(decided, str):
                # A restoration the deciding vote could not finish is retried
                # here; it is a no-op when one was already appended.
                _restore_after_overturn(appeal_cid, decided, ledger.node_signing_key())
            return VoteCast(
                appeal_cid=appeal_cid,
                member_did=member_did,
                outcome=outcome,
                votes_cast=sum(1 for row in votes if row.vote),
                decision_cid=str(existing.record_cid),
                decided_outcome=decided if isinstance(decided, str) else None,
            )

        agreed = _majority(votes)
        decision_cid: Optional[str] = None
        if agreed is not None:
            decision_cid = _save_decision(appeal_cid, agreed, votes, reasons_by_member)

        return VoteCast(
            appeal_cid=appeal_cid,
            member_did=member_did,
            outcome=outcome,
            votes_cast=sum(1 for row in votes if row.vote),
            decision_cid=decision_cid,
            decided_outcome=agreed,
        )


def decide_without_panel(
    appeal_cid: str,
    moderator_did: str,
    outcome: str,
    reasons: tuple[str, ...] = (),
    *,
    moderator_tier: int = 4,
    now: Optional[datetime] = None,
) -> VoteCast:
    """A tier-4 moderator decides a panel-less appeal after its deadline.

    This is the fallback for an appeal that could never draw a panel: the
    decision is recorded like a panel's, carrying ``decided_without_panel``,
    and an overturn restores the target exactly as a panel's would.  Nobody
    involved in the decision may take it (the same exclusions that keep them
    off a panel), and it is possible only once the vote deadline has passed.

    Raises:
        AppealNotFound: ``404`` -- no such appeal is filed here.
        FallbackNotAuthorized: ``403`` -- ``moderator_did`` took part in the
            decision or is otherwise excluded from it.
        PanelSeated: ``409`` -- the appeal has a panel; its members vote.
        PanelDecisionNotDue: ``409`` -- the deadline has not passed.
        VoteNodeKeyUnavailable: ``503`` -- the node cannot sign the decision.
    """
    ensure_tables()
    with _vote_lock:
        appeal = get_appeal(appeal_cid)
        if appeal is None:
            raise AppealNotFound(appeal_cid)
        if moderator_tier < 4:
            raise FallbackNotAuthorized(moderator_did, appeal_cid)

        existing = decision_for_appeal(appeal_cid)
        if existing is not None:
            existing_body = existing.body if isinstance(existing.body, Mapping) else {}
            decided = existing_body.get("outcome")
            return VoteCast(
                appeal_cid=appeal_cid,
                member_did=moderator_did,
                outcome=outcome,
                votes_cast=0,
                decision_cid=str(existing.record_cid),
                decided_outcome=decided if isinstance(decided, str) else None,
            )

        if get_panel(appeal_cid):
            raise PanelSeated(appeal_cid)

        decision = resolve_decision(str(appeal.decision_cid))
        if moderator_did in panel_exclusions(appeal, decision):
            raise FallbackNotAuthorized(moderator_did, appeal_cid)

        deadline = vote_deadline(appeal)
        current = now if now is not None else datetime.now(timezone.utc)
        if current.tzinfo is not None:
            current = current.astimezone(timezone.utc).replace(tzinfo=None)
        if deadline is not None and current < deadline:
            raise PanelDecisionNotDue(appeal_cid, deadline)

        decision_cid = _save_decision(
            appeal_cid,
            outcome,
            [],
            {},
            decided_without_panel=True,
            note_reasons=reasons,
        )
        return VoteCast(
            appeal_cid=appeal_cid,
            member_did=moderator_did,
            outcome=outcome,
            votes_cast=0,
            decision_cid=decision_cid,
            decided_outcome=outcome,
        )

