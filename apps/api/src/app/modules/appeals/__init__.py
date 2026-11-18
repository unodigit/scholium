"""Appeals plugin: one appeal per moderation decision (feature 74).

``POST /v1/appeals`` accepts a signed ``appeal`` record -- ``target`` is the cid
of the ``moderation.decision`` being appealed and ``grounds`` says why -- saves
it to the ``appeals`` table with status ``pending`` and answers ``201``.  A
decision can be appealed once: a second appeal of the same decision is a
``409``.  Only an author of the paper the decision was about may appeal it.

Saving an appeal also seats its panel: three tier-3 or tier-4 members, never the
deciding moderator or an author of the paper, drawn deterministically from the
appealed decision's cid and saved to ``appeal_panels`` (feature 75; see
:mod:`app.modules.appeals.panel`).  Every seated member is notified -- naming
the paper, the deadline and the panel vote form in ``/mod`` -- so a seat is not
invisible; ``GET /v1/appeals/{cid}`` shows the panel to its members and to
tier 4.

The seated panel decides the appeal by voting: ``POST
/v1/appeals/{cid}/votes`` records each member's vote, and once two of the three
agree the node signs and appends an ``appeal.decision`` carrying the outcome
and reasons (feature 76; see :mod:`app.modules.appeals.votes`).  An outcome that
overturns the appealed decision also restores its target and lifts the hold.

Importing this package registers the ``appeal`` record type with the ingest
pipeline and subscribes to the ledger, so an appeal is saved whether it arrives
here or through ``POST /v1/records``.  See :mod:`app.modules.appeals.service`.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .errors import (
    APPEAL_ALREADY_FILED,
    APPEAL_NOT_AUTHORIZED,
    APPEAL_NOT_FOUND,
    FALLBACK_NOT_AUTHORIZED,
    PANEL_DECISION_NOT_DUE,
    PANEL_NOT_DRAWN,
    PANEL_SEATED,
    PANEL_SEED_UNAVAILABLE,
    PANEL_UNAVAILABLE,
    UNKNOWN_APPEAL_TARGET,
    VOTE_NODE_KEY_UNAVAILABLE,
    VOTE_NOT_AUTHORIZED,
    AppealAlreadyFiled,
    AppealNotAuthorized,
    AppealNotFound,
    FallbackNotAuthorized,
    PanelDecisionNotDue,
    PanelNotDrawn,
    PanelSeated,
    PanelSeedUnavailable,
    PanelUnavailable,
    UnknownAppealTarget,
    VoteNodeKeyUnavailable,
    VoteNotAuthorized,
)
from .models import Appeal, AppealPanelMember, AppealVoteReasons, ensure_table, ensure_tables
from .panel import (
    PANEL_SIZE,
    PANEL_TIERS,
    derive_panel_seed,
    draw_panel,
    eligible_members,
    get_panel,
    panel_seed,
    panel_seed_secret,
    select_panel,
)
from .router import AppealDetailOut, PanelSeatOut, router
from .service import (
    APPEAL_MIN_TIER,
    APPEAL_TYPE,
    PANEL_NOTIFICATION_KIND,
    PANEL_NOT_FORMED,
    PANEL_NOT_FORMED_KIND,
    PANEL_OVERDUE,
    PANEL_OVERDUE_KIND,
    PANEL_SEATED_KIND,
    PANEL_SEAT_KIND,
    PANEL_STATUS_AWAITING,
    PANEL_STATUS_DECIDED,
    PANEL_STATUS_NOT_FORMED,
    PENDING,
    AppealedDecision,
    AppealFields,
    appeal_fields,
    apply_appeal,
    get_appeal,
    get_appeal_for_decision,
    handle_appeal,
    notify_panel_missing,
    notify_panel_seated,
    panel_exclusions,
    panel_state,
    persist_entry,
    require_appellant,
    resolve_decision,
    retry_pending_panels,
    seat_panel,
    vote_deadline,
)
from .votes import (
    DECIDING_VOTES,
    DECISION_TYPE,
    RESTORING_OUTCOMES,
    VOTE_OUTCOMES,
    VoteCast,
    cast_vote,
    decide_without_panel,
    decision_for_appeal,
    restore_target,
    vote_fields,
)

logger = logging.getLogger(__name__)

__all__ = [
    "APPEAL_ALREADY_FILED",
    "APPEAL_MIN_TIER",
    "APPEAL_NOT_AUTHORIZED",
    "APPEAL_NOT_FOUND",
    "APPEAL_TYPE",
    "Appeal",
    "AppealAlreadyFiled",
    "AppealDetailOut",
    "AppealFields",
    "AppealNotAuthorized",
    "AppealNotFound",
    "AppealPanelMember",
    "AppealVoteReasons",
    "AppealedDecision",
    "DECIDING_VOTES",
    "DECISION_TYPE",
    "FALLBACK_NOT_AUTHORIZED",
    "FallbackNotAuthorized",
    "PANEL_DECISION_NOT_DUE",
    "PANEL_NOTIFICATION_KIND",
    "PANEL_NOT_DRAWN",
    "PANEL_NOT_FORMED",
    "PANEL_NOT_FORMED_KIND",
    "PANEL_OVERDUE",
    "PANEL_OVERDUE_KIND",
    "PANEL_SEATED",
    "PANEL_SEATED_KIND",
    "PANEL_SEAT_KIND",
    "PANEL_SEED_UNAVAILABLE",
    "PANEL_STATUS_AWAITING",
    "PANEL_STATUS_DECIDED",
    "PANEL_STATUS_NOT_FORMED",
    "PANEL_SIZE",
    "PANEL_TIERS",
    "PANEL_UNAVAILABLE",
    "PENDING",
    "PanelDecisionNotDue",
    "PanelSeatOut",
    "PanelSeated",
    "PanelNotDrawn",
    "PanelSeedUnavailable",
    "PanelUnavailable",
    "RESTORING_OUTCOMES",
    "UNKNOWN_APPEAL_TARGET",
    "UnknownAppealTarget",
    "VOTE_NODE_KEY_UNAVAILABLE",
    "VOTE_NOT_AUTHORIZED",
    "VOTE_OUTCOMES",
    "VoteCast",
    "VoteNodeKeyUnavailable",
    "VoteNotAuthorized",
    "appeal_fields",
    "apply_appeal",
    "cast_vote",
    "decide_without_panel",
    "decision_for_appeal",
    "derive_panel_seed",
    "draw_panel",
    "eligible_members",
    "ensure_table",
    "ensure_tables",
    "get_appeal",
    "get_appeal_for_decision",
    "get_panel",
    "handle_appeal",
    "notify_panel_missing",
    "notify_panel_seated",
    "panel_exclusions",
    "panel_seed",
    "panel_seed_secret",
    "panel_state",
    "persist_entry",
    "require_appellant",
    "resolve_decision",
    "restore_target",
    "retry_pending_panels",
    "router",
    "seat_panel",
    "select_panel",
    "vote_deadline",
    "vote_fields",
]


def _install_ledger_subscriber() -> None:
    """Save every ``appeal`` once it is committed to the log.

    Also retries panel-less appeals whenever an ``endorsement`` reaches the
    log: an endorsement can make a member available to sit, which is exactly
    when a short panel may become drawable.
    """
    from app.modules import ledger

    ledger.subscribe(APPEAL_TYPE, persist_entry)
    ledger.subscribe(ENDORSEMENT_TYPE, _retry_after_endorsement)


def _retry_after_endorsement(entry: Any) -> None:
    """Retry every panel-less appeal; never fail the append that caused it."""
    if getattr(entry, "record_type", None) != ENDORSEMENT_TYPE:
        return
    try:
        retry_pending_panels()
    except Exception:  # pragma: no cover - a retry is best effort
        logger.exception("could not retry the panels after an endorsement")


#: Record type whose arrival can make another panel candidate available.
ENDORSEMENT_TYPE = "endorsement"

#: The daily job that retries panel-less appeals.
PANEL_RETRY_JOB = "appeals.panels"


def run_panel_retry_job(payload: Any = None) -> None:
    """The ``appeals.panels`` job: retry every panel-less appeal."""
    retry_pending_panels()


def _register_panel_retry_job() -> None:
    """Register the daily retry handler and schedule (idempotent)."""
    try:
        from datetime import timedelta

        from app import jobs

        jobs.register(PANEL_RETRY_JOB, run_panel_retry_job)
        jobs.schedule_registry.register(PANEL_RETRY_JOB, timedelta(days=1))
    except Exception:  # pragma: no cover - jobs is a shipped module
        logger.exception("could not register the appeal panel retry job")


def on_startup(app: Optional[Any] = None) -> None:
    """Queue the first daily panel retry when jobs run on a worker.

    In eager mode no worker ever picks up a deferred job, so nothing is
    queued; the daily worker creates it from the schedule registry instead.
    Failing to queue it is logged and never keeps the app from starting.
    """
    try:
        from app import jobs

        if jobs.is_eager():
            return
        jobs.schedule_registry.tick()
    except Exception:  # pragma: no cover - starting the app must not depend on jobs
        logger.exception("could not queue the appeal panel retry")


def _register_record_type() -> None:
    """Register ``appeal`` with the ingest pipeline.

    An existing registration is left alone rather than conflicted with, so
    re-importing the package is harmless.
    """
    from app.modules import ingest

    if ingest.get(APPEAL_TYPE) is None:
        ingest.register(APPEAL_TYPE, handle_appeal, min_tier=APPEAL_MIN_TIER)


_install_ledger_subscriber()
_register_record_type()
_register_panel_retry_job()
