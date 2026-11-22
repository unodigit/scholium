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
  for notices: whoever signed the genesis, signed a version, or is listed on one
  *and accepted their co-author consent* -- a declined or never-consented
  co-author cannot speak for the paper;
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

Seating the panel
-----------------

Once the appeal is saved, :func:`seat_panel` draws its 3-member panel into
``appeal_panels`` (see :mod:`app.modules.appeals.panel` for who is eligible and
how the draw is seeded).  It is idempotent too, so the subscriber and the
endpoint cannot seat two panels.  Too few eligible members is not a reason to
refuse or unfile an appeal -- the appeal is already in the public log -- so
:func:`apply_appeal` leaves the panel undrawn and logs it; calling
:func:`seat_panel` again once the membership has grown draws it then.  The same
holds for a node with no usable signing key: the seed the draw needs is keyed by
a secret derived from that key, so without one the panel waits.

The seed is ``HMAC-SHA256(node secret, decision cid)`` and is stored on the
appeal's row before the panel is drawn.  It depends on the appealed decision
alone: the appellant chooses everything in the appeal (its cid, its grounds, its
``created``) and can predict the ledger head, so a seed that took any of those
in would let them vary a no-op field offline until the draw seated the panel they
wanted.

When a panel is drawn, every seated member is told (:func:`notify_panel_seated`):
a notification of kind :data:`PANEL_SEATED_KIND` whose payload names the paper,
the appeal, the deadline and the panel vote form (``/mod``).  Without it a seat
is invisible -- nothing else names the panel -- and nobody knows to vote.  The notice is sent
exactly once per seat: a panel that is already seated is returned untouched, so
the ledger subscriber and the endpoint applying the same appeal do not notify
twice.  A notification that cannot be stored is logged and never fails the
appeal.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import ledger, submissions
from app.modules.ingest import InvalidRecord
from app.modules.moderation import DECISION_TYPE, get_decision

from .errors import (
    AppealAlreadyFiled,
    AppealNotAuthorized,
    PanelSeedUnavailable,
    PanelUnavailable,
    UnknownAppealTarget,
)
from .models import Appeal, AppealPanelMember, ensure_tables
from .panel import derive_panel_seed, draw_panel, get_panel, panel_seed
from .subject import (
    AppealSubject,
    _quoted_excerpt,
    describe_subject,
    format_day,
    seat_summary,
)

logger = logging.getLogger(__name__)

__all__ = [
    "APPEAL_MIN_TIER",
    "APPEAL_TYPE",
    "PANEL_NOT_FORMED",
    "PANEL_NOT_FORMED_KIND",
    "PANEL_OVERDUE",
    "PANEL_OVERDUE_KIND",
    "PANEL_SEATED_KIND",
    "PANEL_STATUS_AWAITING",
    "PANEL_STATUS_DECIDED",
    "PANEL_STATUS_NOT_FORMED",
    "PANEL_VOTE_WINDOW",
    "PENDING",
    "AppealFields",
    "AppealedDecision",
    "apply_appeal",
    "appeal_fields",
    "get_appeal",
    "get_appeal_for_decision",
    "handle_appeal",
    "notify_panel_missing",
    "notify_panel_seated",
    "panel_exclusions",
    "panel_state",
    "persist_entry",
    "require_appellant",
    "resolve_decision",
    "retry_pending_panels",
    "seat_panel",
    "vote_deadline",
]

#: The record type this module owns.
APPEAL_TYPE = "appeal"

#: Lowest author tier the registry lets through.  Who may appeal is decided by
#: authorship of the paper (see :func:`require_appellant`), not by tier: an
#: author whose paper was rejected has no more standing at a higher tier.
APPEAL_MIN_TIER = 0

#: Status of an appeal no panel has decided yet.
PENDING = "pending"

#: Status of an appeal whose panel could not be drawn: fewer eligible members
#: than :data:`~.panel.PANEL_SIZE`.  The appeal stays open and is retried; see
#: :func:`retry_pending_panels`.
PANEL_NOT_FORMED = "panel_not_formed"

#: Status of a panel-less appeal whose vote deadline has passed.  A tier-4
#: moderator who is not involved in the decision may now decide it without a
#: panel; see :func:`~.votes.decide_without_panel`.
PANEL_OVERDUE = "panel_overdue"

#: The ``status`` values that mean "still open": no decision has been made.
OPEN_STATUSES = (PENDING, PANEL_NOT_FORMED, PANEL_OVERDUE)

#: How a reader sees the panel's state, independent of the raw status above.
PANEL_STATUS_AWAITING = "awaiting_panel"
PANEL_STATUS_NOT_FORMED = "not_formed"
PANEL_STATUS_DECIDED = "decided"

#: How long a drawn panel has to vote, counted from the appeal's ``filed_at``.
#: The record schema fixes no deadline; the dashboard and the seat notice both
#: state this one so a panellist knows when the vote is due.
PANEL_VOTE_WINDOW = timedelta(days=14)

#: Kind of the notification a seated panel member receives.  It names the seat,
#: not the appeal's progress: the panel member is the audience.
PANEL_SEATED_KIND = "appeal.panel"
#: Aliases covering the names a caller might reach for.
PANEL_NOTIFICATION_KIND = PANEL_SEATED_KIND
PANEL_SEAT_KIND = PANEL_SEATED_KIND

#: Kind of the notice that no full panel could be drawn (tier-4 moderators and
#: the appellant).  The appeal stays open; the draw is retried.
PANEL_NOT_FORMED_KIND = "appeal.panel_missing"
#: Kind of the notice that the deadline passed with no panel, so a tier-4
#: moderator not involved in the decision may decide it without one.
PANEL_OVERDUE_KIND = "appeal.panel_overdue"


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
    #: cid of the record the decision was about (a version, post, annotation or review).
    target_cid: str
    #: cid of the paper version the decision was about, when it was a version.
    version_cid: Optional[str]
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
        target_cid: object = decision.target_cid
        moderator_did: object = decision.moderator_did
    else:
        entry = ledger.entry_by_cid(target)
        if entry is None or entry.record_type != DECISION_TYPE or not isinstance(entry.body, Mapping):
            raise UnknownAppealTarget(target)
        target_cid = entry.body.get("target")
        moderator_did = entry.author_did

    if not isinstance(target_cid, str) or not target_cid:
        raise UnknownAppealTarget(target)

    from app.modules import moderation as _moderation
    from app.modules.moderation import outcomes as _outcomes

    resolved = _moderation.resolve_decision_target(str(target_cid))
    version_cid: Optional[str] = None
    paper_cid: Optional[str] = None
    if resolved is None:
        if submissions.get_paper(str(target_cid)) is not None:
            paper_cid = str(target_cid)
        else:
            raise UnknownAppealTarget(target)
    else:
        kind, record = resolved
        if kind == _moderation.VERSION_TARGET:
            version = record
            version_cid = str(version.version_cid)
            paper_cid = str(version.paper_cid)
        elif kind == _moderation.POST_TARGET:
            paper_cid = _outcomes._paper_cid(str(target_cid))
        elif kind == _moderation.REVIEW_TARGET:
            paper_cid = _outcomes._paper_cid(str(target_cid))

    if not isinstance(paper_cid, str) or not paper_cid:
        raise UnknownAppealTarget(target)

    return AppealedDecision(
        decision_cid=target,
        moderator_did=str(moderator_did),
        target_cid=str(target_cid),
        version_cid=version_cid,
        paper_cid=paper_cid,
    )


def require_appellant(author: object, decision: AppealedDecision) -> None:
    """Refuse unless ``author`` may speak for the decided paper (``403``).

    The paper's genesis signer and every version's signer always may.  A DID
    merely listed as a co-author may only once it has accepted its
    ``coauthor.consent``: a co-author who never consented, or who declined,
    cannot appeal on the paper's behalf -- the same rule notices use.

    Moderators get no override: the appeal answers *their* decision, and the
    panel that hears it excludes the deciding moderator.

    Raises:
        AppealNotAuthorized: ``403``.
    """
    if not isinstance(author, str):
        raise AppealNotAuthorized(author, decision.decision_cid, decision.paper_cid)

    if decision.version_cid is not None:
        if author in submissions.paper_authors(decision.paper_cid):
            return
    else:
        # A decision on a post, annotation or review may be appealed by the
        # member who signed that record (and, for a paper-level dismiss, by
        # any author of the paper).
        try:
            from app.modules.moderation.decisions import _submitting_author_dids
        except Exception:  # pragma: no cover - moderation is a shipped plugin
            _submitting_author_dids = None
        allowed: set[str] = set()
        if _submitting_author_dids is not None:
            allowed.update(_submitting_author_dids(decision.target_cid))
        allowed.update(submissions.paper_authors(decision.paper_cid))
        if author in allowed:
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


def _naive_utc(moment: Optional[datetime] = None) -> datetime:
    """``moment`` (default: now) as the naive UTC the columns store."""
    value = datetime.now(timezone.utc) if moment is None else moment
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def vote_deadline(appeal: Appeal) -> Optional[datetime]:
    """When the panel's vote on ``appeal`` is due, or ``None`` for a bad date."""
    filed = getattr(appeal, "filed_at", None)
    if not isinstance(filed, datetime):
        return None
    return _naive_utc(filed) + PANEL_VOTE_WINDOW


def panel_state(appeal: Appeal, *, decided: bool = False) -> str:
    """How a reader sees the appeal's panel: awaiting, not formed, or decided."""
    status = str(getattr(appeal, "status", "") or "")
    if decided or status not in OPEN_STATUSES:
        return PANEL_STATUS_DECIDED
    if status in (PANEL_NOT_FORMED, PANEL_OVERDUE):
        return PANEL_STATUS_NOT_FORMED
    return PANEL_STATUS_AWAITING


def _set_status(appeal_cid: str, status: str) -> bool:
    """Set the appeal's status; return whether it changed."""
    with db.SessionLocal() as session:
        row = session.get(Appeal, appeal_cid)
        if row is None or str(row.status) == status:
            return False
        row.status = status
        session.commit()
        return True


def _open_undecided_appeals() -> list[Appeal]:
    """Every appeal that is still open, detached, oldest first."""
    ensure_tables()
    with db.SessionLocal() as session:
        rows = (
            session.query(Appeal)
            .filter(Appeal.status.in_(OPEN_STATUSES))
            .order_by(Appeal.filed_at)
            .all()
        )
        session.expunge_all()
    return list(rows)


def _tier_four_dids() -> list[str]:
    """Every account at tier 4 (Moderator)."""
    from app.modules.identity.models import Account, ensure_account_table

    ensure_account_table()
    with db.SessionLocal() as session:
        return [
            str(did)
            for (did,) in session.query(Account.did).filter(Account.tier == 4).all()
        ]


def notify_panel_missing(
    appeal: Appeal,
    decision: Optional[AppealedDecision] = None,
    *,
    eligible: int,
    needed: int,
    overdue: bool = False,
) -> int:
    """Tell every tier-4 moderator and the appellant no full panel was formed.

    The notice names the appeal and the reason, so a moderator knows there is
    nothing to vote on yet and the appellant is not left wondering.  Best
    effort, like every other notice: one recipient failing is logged and does
    not stop the others or fail the appeal.
    """
    try:
        from app.modules.notifications.service import notify
    except Exception:  # pragma: no cover - notifications is a shipped plugin
        logger.exception("notifications plugin unavailable; short panel not reported")
        return 0

    if decision is None:
        try:
            decision = resolve_decision(str(appeal.decision_cid))
        except Exception:  # pragma: no cover - a decision this node no longer holds
            decision = None

    title: Optional[str] = None
    paper_cid: Optional[str] = None
    subject: Optional[AppealSubject] = None
    if decision is not None:
        paper_cid = decision.paper_cid
        subject = describe_subject(decision.target_cid, decision.decision_cid)
        title = subject.title
    phrase = subject.phrase() if subject is not None else "an appeal panel"
    if subject is not None and subject.is_record and subject.excerpt:
        # Several appeals about posts on one paper read alike without it; the
        # notice goes to tier-4 moderators and the appellant, who may read it.
        phrase += f' ("{_quoted_excerpt(subject.excerpt)}")'
    deadline = vote_deadline(appeal)
    when = f" on {format_day(deadline)}" if deadline is not None else ""

    if overdue:
        kind = PANEL_OVERDUE_KIND
        reason = (
            f"the {needed}-member panel could not be formed and the deadline{when} "
            "has passed; a tier-4 moderator who is not involved in the decision "
            "may decide it without a panel"
        )
        summary = f"No panel has decided the appeal {phrase} yet: {reason}."
    else:
        kind = PANEL_NOT_FORMED_KIND
        # ``eligible`` counts the members who exist, ``needed`` is the panel's
        # size: two eligible members for a panel of three is "only 2 ... a panel
        # needs 3", not "2 of the 3 eligible".
        if eligible == 0:
            available = "No eligible members are available"
        elif eligible == 1:
            available = "Only 1 eligible member is available"
        else:
            available = f"Only {eligible} eligible members are available"
        summary = (
            f"No panel has decided the appeal {phrase} yet. "
            f"{available}; a panel needs {needed}. "
            "The draw is retried as members become available."
        )

    payload = {
        "appeal_cid": str(appeal.appeal_cid),
        "appeal": str(appeal.appeal_cid),
        "decision_cid": str(appeal.decision_cid),
        "appellant_did": str(appeal.appellant_did),
        "title": title,
        "paper_cid": paper_cid,
        "eligible": eligible,
        "needed": needed,
        "deadline": deadline.isoformat() if deadline is not None else None,
        "overdue": overdue,
        "summary": summary,
        "outcome": summary,
        "link": f"/mod#appeal-{appeal.appeal_cid}-title",
    }

    audience = set(_tier_four_dids())
    audience.add(str(appeal.appellant_did))
    notified = 0
    for did in sorted(audience):
        try:
            notify(did, kind, dict(payload))
        except Exception:
            logger.exception(
                "could not tell %s the appeal %s has no panel", did, appeal.appeal_cid
            )
        else:
            notified += 1
    return notified


def _mark_panel_missing(
    appeal: Appeal,
    decision: Optional[AppealedDecision],
    *,
    eligible: int,
    needed: int,
    overdue: bool,
) -> None:
    """Record (once) that no panel was formed, or that its deadline has passed."""
    status = PANEL_OVERDUE if overdue else PANEL_NOT_FORMED
    current = str(getattr(appeal, "status", "") or "")
    if not overdue and current == PANEL_OVERDUE:
        # Overdue is the later state; a retry must not move it back.
        return
    if not _set_status(str(appeal.appeal_cid), status):
        # Already in that state (or decided): the audience was told once.
        return
    notify_panel_missing(
        appeal,
        decision,
        eligible=eligible,
        needed=needed,
        overdue=overdue,
    )


def retry_pending_panels(now: Optional[datetime] = None) -> int:
    """Draw the panels of open appeals that have none; return how many were seated.

    Called when a member becomes eligible (:mod:`app.modules.appeals` subscribes
    to ``endorsement`` records) and by a daily job, so a filed appeal never
    waits silently for members who have since arrived.  An appeal that is still
    short at its deadline is marked overdue and its moderators are told a
    tier-4 moderator may decide it without a panel.
    """
    current = _naive_utc(now)
    seated = 0
    for appeal in _open_undecided_appeals():
        if get_panel(str(appeal.appeal_cid)):
            if str(appeal.status) != PENDING:
                _set_status(str(appeal.appeal_cid), PENDING)
            continue
        try:
            decision = resolve_decision(str(appeal.decision_cid))
        except Exception:
            logger.warning(
                "cannot retry the panel of appeal %s: its decision is gone",
                appeal.appeal_cid,
            )
            continue
        try:
            seat_panel(appeal, decision)
        except PanelSeedUnavailable:
            logger.warning(
                "appeal %s still has no panel: the node has no signing key",
                appeal.appeal_cid,
            )
            continue
        except PanelUnavailable as exc:
            deadline = vote_deadline(appeal)
            overdue = deadline is not None and current >= deadline
            _mark_panel_missing(
                appeal,
                decision,
                eligible=exc.eligible,
                needed=exc.needed,
                overdue=overdue,
            )
            continue
        _set_status(str(appeal.appeal_cid), PENDING)
        seated += 1
    return seated



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
        raise AppealAlreadyFiled(decision.decision_cid, existing.appeal_cid, existing.filed_at)
    return PENDING


# --------------------------------------------------------------------------- #
# Saving the appeal
# --------------------------------------------------------------------------- #


def panel_exclusions(appeal: Appeal, decision: AppealedDecision) -> frozenset[str]:
    """DIDs that may not sit on this appeal's panel.

    The deciding moderator, every author of the paper the decision was about,
    the appellant (an author already, but the saved appeal is the authority on
    who filed it), the author of the record the decision was about (a post,
    annotation or review is not always authored by a paper author), and every
    reporter whose flag the decision settled.
    """
    excluded: set[str] = {decision.moderator_did, str(appeal.appellant_did)}
    excluded |= set(submissions.all_paper_authors(decision.paper_cid))
    try:
        from app.modules.moderation.decisions import _submitting_author_dids

        excluded |= set(_submitting_author_dids(decision.target_cid))
    except Exception:  # pragma: no cover - moderation is a shipped plugin
        pass
    try:
        from app.modules.flags.models import Flag, ensure_table as ensure_flag_table

        ensure_flag_table()
        with db.SessionLocal() as session:
            rows = (
                session.query(Flag.reporter_did)
                .filter(Flag.decision_cid == decision.decision_cid)
                .all()
            )
            excluded |= {str(row[0]) for row in rows if row and row[0]}
    except Exception:  # pragma: no cover - flags is a shipped plugin
        pass
    return frozenset(excluded)


def notify_panel_seated(
    appeal: Appeal,
    seats: list[AppealPanelMember],
    decision: Optional[AppealedDecision] = None,
) -> int:
    """Tell every member in ``seats`` they were drawn; return how many were told.

    The payload names the appeal (the cid a vote is cast on), the decision it
    answers, the paper and when the vote is due, and links to the panel vote
    form in the moderation console (``/mod``).  A notice with no paper and no
    working link leaves the member unable to act, so the title and deadline
    travel with the seat.  The notifications plugin is imported at call time so
    this module stays loadable without it.  One member's notification failing
    must not stop the others or undo the panel: it is logged and skipped, like
    every other best-effort notification in the project.
    """
    try:
        from app.modules.notifications.service import notify
    except Exception:  # pragma: no cover - notifications is a shipped plugin
        logger.exception("notifications plugin unavailable; appeal panel not notified")
        return 0

    if decision is None:
        try:
            decision = resolve_decision(str(appeal.decision_cid))
        except Exception:  # pragma: no cover - a decision this node no longer holds
            logger.debug("could not resolve appeal %s for its notice", appeal.appeal_cid)
            decision = None

    title: Optional[str] = None
    short_id: Optional[str] = None
    version_cid: Optional[str] = None
    paper_cid: Optional[str] = None
    subject: Optional[AppealSubject] = None
    if decision is not None:
        version_cid = decision.version_cid
        paper_cid = decision.paper_cid
        subject = describe_subject(decision.target_cid, decision.decision_cid)
        title = subject.title
        paper = submissions.get_paper(decision.paper_cid)
        short_id = getattr(paper, "short_id", None) if paper is not None else None

    filed_at = appeal.filed_at
    deadline = filed_at + PANEL_VOTE_WINDOW if isinstance(filed_at, datetime) else None
    link = f"/mod#appeal-{appeal.appeal_cid}-title"
    summary = seat_summary(subject, deadline)

    payload = {
        "appeal_cid": str(appeal.appeal_cid),
        "appeal": str(appeal.appeal_cid),
        "decision_cid": str(appeal.decision_cid),
        "target": str(appeal.decision_cid),
        "appellant_did": str(appeal.appellant_did),
        "grounds": str(appeal.grounds),
        "title": title,
        "paper": short_id,
        "paper_cid": paper_cid,
        "version_cid": version_cid,
        "target_cid": subject.target_cid if subject is not None else None,
        "target_kind": subject.kind if subject is not None else None,
        "deadline": deadline.isoformat() if deadline is not None else None,
        "due_at": deadline.date().isoformat() if deadline is not None else None,
        "summary": summary,
        "outcome": summary,
        # The web inbox must open the form a panellist votes from, not an API
        # route (which the web origin answers with a 404).
        "link": link,
    }
    notified = 0
    for seat in seats:
        did = str(seat.member_did)
        try:
            notify(did, PANEL_SEATED_KIND, dict(payload))
        except Exception:
            logger.exception("could not notify %s of their seat on appeal %s", did, appeal.appeal_cid)
        else:
            notified += 1
    return notified


def seat_panel(
    appeal: Appeal,
    decision: Optional[AppealedDecision] = None,
) -> list[AppealPanelMember]:
    """Draw ``appeal``'s panel into ``appeal_panels`` if it has none; return its seats.

    Idempotent: a drawn panel is returned as it is.  ``decision`` is looked up
    from the appeal when the caller does not already hold it.  A panel drawn
    here notifies its members (see :func:`notify_panel_seated`); a panel that
    was already drawn is returned without a second notice.

    The seed is stored on the appeal before the panel is drawn from it, and the
    panel is drawn from that stored seed only.

    Raises:
        UnknownAppealTarget: ``422`` -- the decision can no longer be resolved.
        PanelSeedUnavailable: ``503`` -- the node has no usable signing key to
            key the seed with; nothing is saved.
        PanelUnavailable: ``503`` -- fewer than three eligible members; nothing
            but the seed is saved.
    """
    seated = get_panel(appeal.appeal_cid)
    if seated:
        return seated
    if decision is None:
        decision = resolve_decision(str(appeal.decision_cid))
    _store_panel_seed(str(appeal.appeal_cid), str(appeal.decision_cid))
    seats = draw_panel(
        str(appeal.appeal_cid),
        excluded=panel_exclusions(appeal, decision),
        seed=panel_seed(str(appeal.appeal_cid)),
    )
    notify_panel_seated(appeal, seats, decision)
    return seats


def _seat_or_defer(appeal: Appeal, decision: AppealedDecision) -> None:
    """Seat the panel, tolerating a membership too small -- or a node too unkeyed -- to draw one yet."""
    try:
        seat_panel(appeal, decision)
    except PanelSeedUnavailable:
        logger.warning(
            "appeal %s has no panel yet: the node has no signing key to key the draw with",
            appeal.appeal_cid,
        )
    except PanelUnavailable as exc:
        logger.warning(
            "appeal %s has no panel yet: %d eligible member(s), %d needed",
            appeal.appeal_cid,
            exc.eligible,
            exc.needed,
        )
        deadline = vote_deadline(appeal)
        overdue = deadline is not None and _naive_utc() >= deadline
        _mark_panel_missing(
            appeal,
            decision,
            eligible=exc.eligible,
            needed=exc.needed,
            overdue=overdue,
        )
    else:
        _set_status(str(appeal.appeal_cid), PENDING)




def _store_panel_seed(appeal_cid: str, decision_cid: str) -> str:
    """Compute and persist the panel seed for ``appeal_cid``; return it.

    The seed is :func:`~.panel.derive_panel_seed` of ``decision_cid`` under the
    node's signing key: an HMAC over the decision cid alone, so nothing the
    appellant writes and nothing about the ledger enters it.  It is stored on the
    appeal's row (every column that carries it) before the panel is drawn, and
    only a panel that has not been drawn is ever seated from it, so a seed
    stored by an earlier scheme is replaced before it can decide anything.

    Raises:
        PanelSeedUnavailable: ``503`` -- the node has no usable signing key.
    """
    key = ledger.node_signing_key()
    if key is None:
        raise PanelSeedUnavailable(appeal_cid)
    seed = derive_panel_seed(decision_cid, key)
    with db.SessionLocal() as session:
        row = session.get(Appeal, appeal_cid)
        if row is None:
            return seed
        changed = False
        for attr in ("panel_seed", "seed", "draw_seed"):
            if getattr(row, attr, None) != seed:
                setattr(row, attr, seed)
                changed = True
        if changed:
            session.commit()
    return seed


def apply_appeal(record: Mapping[str, Any]) -> Appeal:
    """Save the appeal to ``appeals`` and draw its panel; return its row.

    Idempotent per appeal cid: an appeal that already has its row is returned as
    it is, so the ledger subscriber and the endpoint may both call this for the
    same record.  The record is validated again first, so no row exists for an
    appeal the handler would have refused (a record appended to the log by some
    other path, say).

    The panel is seated on every call that finds the appeal saved, so a call
    that follows a failed draw repairs it.  A membership too small for a panel
    is not a failure here (see the module docstring).

    Raises:
        InvalidRecord, UnknownAppealTarget: ``422``.
        AppealNotAuthorized: ``403``.
        AppealAlreadyFiled: ``409`` -- a different appeal holds the decision's
            single slot.
    """
    fields, decision = _validated(record)
    row = get_appeal(fields.appeal_cid) or _save_appeal(fields, decision)
    _seat_or_defer(row, decision)
    return get_appeal(fields.appeal_cid) or row


def _save_appeal(fields: AppealFields, decision: AppealedDecision) -> Appeal:
    """Insert the ``appeals`` row for a validated appeal; return it."""
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
            # check in apply_appeal and now (its row is this record's row), or a different
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
            raise AppealAlreadyFiled(decision.decision_cid, holder.appeal_cid, holder.filed_at) from None
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
