"""Accepting signed ``appeal`` records (plugin: appeals, feature 74).

An author's public, signed appeal of a moderation decision::

    {"target": "bafyrei...",      # cid of the moderation.decision being appealed
     "grounds": "...",            # why the decision should be reconsidered
     "paper": "bafyrei..."}       # optional: the paper's genesis cid

The ingest pipeline has already verified the envelope, the body schema, the
cid and the signature by the time :func:`handle_appeal` runs.  The handler adds
the decisions the generic pipeline cannot make, *before* anything is stored:

* **what is appealed.**  ``body.target`` must be a ``moderation.decision`` this
  node holds (``422``, :class:`~.errors.UnknownAppealTarget`), found in
  ``moderation_decisions`` or, at minimum, in the event log, and the version it
  decided must be one this node holds.  ``body.decision`` and ``body.paper``,
  when given, must agree with it (``422``);
* **why.**  ``grounds`` must not be blank (``422``) -- the body schema only
  requires a non-empty string;
* **who may appeal.**  The signer -- the DID the signature authenticates, not
  whoever relays the record -- must be an author of the paper the decision was
  about (``403``, :class:`~.errors.AppealNotAuthorized`).  "An author of the
  paper" is the definition :func:`app.modules.submissions.paper_authors` gives
  for notices: whoever signed the genesis, signed a version, or is listed on one;
* **once.**  A decision that already has an appeal refuses a second one
  (``409``, :class:`~.errors.AppealAlreadyFiled`), whoever signs it: the appeal
  belongs to the decision, not to the author, so co-authors share one appeal.

Saving
------

:func:`apply_appeal` saves the ``appeals`` row.  It is idempotent per appeal
cid and runs from two places: the ledger subscriber installed by this package
(so an appeal is saved whichever door it came through, ``POST /v1/appeals`` or
``POST /v1/records``) and the endpoint itself, because a ledger subscriber that
raises is only logged -- the endpoint must not answer ``201`` for an appeal it
did not save.  It re-runs the checks above, so a row always means a valid
appeal, and the ``UNIQUE(decision_cid)`` constraint settles two appeals of the
same decision that race past the handler: one is saved, the other is a ``409``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import ledger, submissions
from app.modules.ingest import InvalidRecord
from app.modules.moderation import DECISION_TYPE, get_decision

from .errors import AppealAlreadyFiled, AppealNotAuthorized, UnknownAppealTarget
from .models import Appeal, ensure_tables

__all__ = [
    "APPEAL_MIN_TIER",
    "APPEAL_TYPE",
    "PENDING",
    "AppealFields",
    "AppealedDecision",
    "apply_appeal",
    "appeal_fields",
    "get_appeal",
    "get_appeal_for_decision",
    "handle_appeal",
    "persist_entry",
    "require_appellant",
    "resolve_decision",
]

#: The record type this module owns.
APPEAL_TYPE = "appeal"

#: Lowest author tier the registry lets through.  Who may appeal is decided by
#: authorship of the paper (see :func:`require_appellant`), not by tier: an
#: author whose paper was rejected has no more standing at a higher tier.
APPEAL_MIN_TIER = 0

#: Status of an appeal no panel has decided yet.
PENDING = "pending"


def _invalid(loc: list[Any], message: str, error_type: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad field of an appeal record, located at ``loc``."""
    shown = value if isinstance(value, (str, int, float, bool, type(None))) else None
    if isinstance(shown, str) and len(shown) > 64:
        shown = shown[:61] + "..."
    full = f"The appeal {message}."
    return InvalidRecord(
        [{"loc": loc, "msg": full, "type": error_type, "input": shown}],
        detail=full,
    )


# --------------------------------------------------------------------------- #
# Reading the record
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class AppealFields:
    """The parts of an appeal record this plugin acts on, shape-checked."""

    appeal_cid: str
    appellant_did: str
    #: cid of the ``moderation.decision`` being appealed (``body.target``).
    decision_cid: str
    grounds: str
    #: ``body.paper``, when the record names it.
    paper_cid: Optional[str]
    filed_at: datetime


def _optional_cid(body: Mapping[str, Any], field: str) -> Optional[str]:
    value = body.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise _invalid(
            ["body", field],
            f"field {field!r} must be a non-empty string",
            f"invalid_{field}",
            value,
        )
    return value


def _filed_at(record: Mapping[str, Any]) -> datetime:
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


def appeal_fields(record: Mapping[str, Any]) -> AppealFields:
    """Shape-check an appeal envelope and return the fields this plugin acts on.

    The ingest pipeline's schema check normally runs first; this re-checks the
    shape so a direct caller gets ``422`` problem details rather than a
    ``TypeError`` or a half-written row.  Nothing is read from the database.

    Raises:
        InvalidRecord: ``422`` when the body is not an object, ``target`` is
            missing, ``grounds`` is missing or blank, ``decision`` names a
            different decision than ``target``, or ``created`` is not an
            ISO 8601 instant.
    """
    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the appeal body must be an object"],
            detail="The appeal body must be a JSON object.",
        )

    appeal_cid = record.get("id")
    if not isinstance(appeal_cid, str) or not appeal_cid:
        message = "The appeal record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )
    author = record.get("author")
    if not isinstance(author, str) or not author:
        raise _invalid(["author"], "field 'author' must be a non-empty string", "invalid_author", author)

    target = body.get("target")
    if not isinstance(target, str) or not target:
        raise _invalid(
            ["body", "target"],
            "field 'target' must be the cid of the moderation decision being appealed",
            "invalid_target",
            target,
        )

    grounds = body.get("grounds")
    if not isinstance(grounds, str) or not grounds.strip():
        raise _invalid(
            ["body", "grounds"],
            "needs grounds: a non-blank 'grounds' string saying why the decision should be reconsidered",
            "missing_grounds",
            grounds,
        )

    decision = _optional_cid(body, "decision")
    if decision is not None and decision != target:
        raise _invalid(
            ["body", "decision"],
            "field 'decision' names a different decision than 'target'",
            "decision_target_mismatch",
            decision,
        )

    return AppealFields(
        appeal_cid=appeal_cid,
        appellant_did=author,
        decision_cid=target,
        grounds=grounds.strip(),
        paper_cid=_optional_cid(body, "paper"),
        filed_at=_filed_at(record),
    )


# --------------------------------------------------------------------------- #
# What is appealed, and who may appeal it
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class AppealedDecision:
    """The moderation decision an appeal answers, and what it was about."""

    decision_cid: str
    moderator_did: str
    #: cid of the paper version the decision was about.
    version_cid: str
    #: cid of that version's paper (its genesis).
    paper_cid: str


def resolve_decision(target: str) -> AppealedDecision:
    """Find the moderation decision ``target`` and the version it decided, or ``422``.

    ``moderation_decisions`` is consulted first.  When it has no row the event
    log is, so a decision that was accepted while the moderation plugin's ledger
    subscription was not installed can still be appealed.  A cid the log holds
    for any other record type is not a decision.

    Raises:
        UnknownAppealTarget: ``422`` naming ``body.target``.
    """
    decision = get_decision(target)
    if decision is not None:
        version_cid: object = decision.target_cid
        moderator_did: object = decision.moderator_did
    else:
        entry = ledger.entry_by_cid(target)
        if entry is None or entry.record_type != DECISION_TYPE or not isinstance(entry.body, Mapping):
            raise UnknownAppealTarget(target)
        version_cid = entry.body.get("target")
        moderator_did = entry.author_did

    version = submissions.get_version(version_cid)
    if version is None:
        # A decision about a version this node does not hold has no paper whose
        # authors could appeal it.
        raise UnknownAppealTarget(target)
    return AppealedDecision(
        decision_cid=target,
        moderator_did=str(moderator_did),
        version_cid=str(version.version_cid),
        paper_cid=str(version.paper_cid),
    )


def require_appellant(author: object, decision: AppealedDecision) -> None:
    """Refuse unless ``author`` is an author of the decided paper (``403``).

    Moderators get no override: the appeal answers *their* decision, and the
    panel that hears it excludes the deciding moderator.

    Raises:
        AppealNotAuthorized: ``403``.
    """
    if isinstance(author, str) and author in submissions.paper_authors(decision.paper_cid):
        return
    raise AppealNotAuthorized(author, decision.decision_cid, decision.paper_cid)


def _check_named_paper(fields: AppealFields, decision: AppealedDecision) -> None:
    """``body.paper``, when given, must be the paper the decision was about (``422``)."""
    if fields.paper_cid is not None and fields.paper_cid != decision.paper_cid:
        raise _invalid(
            ["body", "paper"],
            "field 'paper' is not the paper the decision was about",
            "paper_target_mismatch",
            fields.paper_cid,
        )


def _validated(record: Mapping[str, Any]) -> tuple[AppealFields, AppealedDecision]:
    """Everything about an appeal that does not depend on other appeals."""
    fields = appeal_fields(record)
    decision = resolve_decision(fields.decision_cid)
    _check_named_paper(fields, decision)
    require_appellant(fields.appellant_did, decision)
    return fields, decision


# --------------------------------------------------------------------------- #
# Reading saved appeals
# --------------------------------------------------------------------------- #


def get_appeal(appeal_cid: object) -> Optional[Appeal]:
    """The saved appeal with this cid, or ``None``."""
    if not isinstance(appeal_cid, str) or not appeal_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Appeal, appeal_cid)
        if row is not None:
            session.expunge(row)
        return row


def get_appeal_for_decision(decision_cid: object) -> Optional[Appeal]:
    """The appeal that holds the single appeal slot of this decision, or ``None``."""
    if not isinstance(decision_cid, str) or not decision_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.query(Appeal).filter(Appeal.decision_cid == decision_cid).one_or_none()
        if row is not None:
            session.expunge(row)
        return row


# --------------------------------------------------------------------------- #
# The ingest handler
# --------------------------------------------------------------------------- #


def handle_appeal(record: Mapping[str, Any]) -> str:
    """Validate an ``appeal``; return the status it will be saved with.

    Runs before the record is appended to the ledger, so a refusal stores
    nothing.  Nothing is saved here either: the ``appeals`` row is written by
    :func:`apply_appeal` once the record is in the log.

    Raises:
        InvalidRecord, UnknownAppealTarget: ``422``.
        AppealNotAuthorized: ``403``.
        AppealAlreadyFiled: ``409``.
    """
    _, decision = _validated(record)
    existing = get_appeal_for_decision(decision.decision_cid)
    if existing is not None:
        raise AppealAlreadyFiled(decision.decision_cid, existing.appeal_cid)
    return PENDING


# --------------------------------------------------------------------------- #
# Saving the appeal
# --------------------------------------------------------------------------- #


def apply_appeal(record: Mapping[str, Any]) -> Appeal:
    """Save the appeal to ``appeals``; return its row.

    Idempotent per appeal cid: an appeal that already has its row is returned as
    it is, so the ledger subscriber and the endpoint may both call this for the
    same record.  The record is validated again first, so no row exists for an
    appeal the handler would have refused (a record appended to the log by some
    other path, say).

    Raises:
        InvalidRecord, UnknownAppealTarget: ``422``.
        AppealNotAuthorized: ``403``.
        AppealAlreadyFiled: ``409`` -- a different appeal holds the decision's
            single slot.
    """
    fields, decision = _validated(record)

    existing = get_appeal(fields.appeal_cid)
    if existing is not None:
        return existing

    row = Appeal(
        appeal_cid=fields.appeal_cid,
        decision_cid=decision.decision_cid,
        appellant_did=fields.appellant_did,
        grounds=fields.grounds,
        status=PENDING,
        filed_at=fields.filed_at,
    )
    with db.SessionLocal() as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            # Either this very record was saved by another writer between the
            # check above and now (its row is this record's row), or a different
            # appeal took the decision's single slot first.
            saved = session.get(Appeal, fields.appeal_cid)
            if saved is not None:
                session.expunge(saved)
                return saved
            holder = (
                session.query(Appeal)
                .filter(Appeal.decision_cid == decision.decision_cid)
                .one_or_none()
            )
            if holder is None:
                raise
            raise AppealAlreadyFiled(decision.decision_cid, holder.appeal_cid) from None
        session.refresh(row)
        session.expunge(row)
    return row


def persist_entry(entry: Any) -> None:
    """Ledger subscriber: save every ``appeal`` once it is in the log.

    Failures are logged by the ledger and do not undo the append; the endpoint
    applies the appeal again and reports a real failure to its caller.
    """
    if getattr(entry, "record_type", None) != APPEAL_TYPE:
        return
    apply_appeal(ledger.stored_envelope(entry).model_dump())
