"""Appeals plugin: one appeal per moderation decision (feature 74).

``POST /v1/appeals`` accepts a signed ``appeal`` record -- ``target`` is the cid
of the ``moderation.decision`` being appealed and ``grounds`` says why -- saves
it to the ``appeals`` table with status ``pending`` and answers ``201``.  A
decision can be appealed once: a second appeal of the same decision is a
``409``.  Only an author of the paper the decision was about may appeal it.

Saving an appeal also seats its panel: three tier-3 or tier-4 members, never the
deciding moderator or an author of the paper, drawn deterministically from the
appeal cid and saved to ``appeal_panels`` (feature 75; see
:mod:`app.modules.appeals.panel`).

Importing this package registers the ``appeal`` record type with the ingest
pipeline and subscribes to the ledger, so an appeal is saved whether it arrives
here or through ``POST /v1/records``.  See :mod:`app.modules.appeals.service`.
"""

from .errors import (
    APPEAL_ALREADY_FILED,
    APPEAL_NOT_AUTHORIZED,
    PANEL_UNAVAILABLE,
    UNKNOWN_APPEAL_TARGET,
    AppealAlreadyFiled,
    AppealNotAuthorized,
    PanelUnavailable,
    UnknownAppealTarget,
)
from .models import Appeal, AppealPanelMember, ensure_table, ensure_tables
from .panel import (
    PANEL_SIZE,
    PANEL_TIERS,
    draw_panel,
    eligible_members,
    get_panel,
    select_panel,
)
from .router import router
from .service import (
    APPEAL_MIN_TIER,
    APPEAL_TYPE,
    PENDING,
    AppealedDecision,
    AppealFields,
    appeal_fields,
    apply_appeal,
    get_appeal,
    get_appeal_for_decision,
    handle_appeal,
    panel_exclusions,
    persist_entry,
    require_appellant,
    resolve_decision,
    seat_panel,
)

__all__ = [
    "APPEAL_ALREADY_FILED",
    "APPEAL_MIN_TIER",
    "APPEAL_NOT_AUTHORIZED",
    "APPEAL_TYPE",
    "Appeal",
    "AppealAlreadyFiled",
    "AppealFields",
    "AppealNotAuthorized",
    "AppealPanelMember",
    "AppealedDecision",
    "PANEL_SIZE",
    "PANEL_TIERS",
    "PANEL_UNAVAILABLE",
    "PENDING",
    "PanelUnavailable",
    "UNKNOWN_APPEAL_TARGET",
    "UnknownAppealTarget",
    "appeal_fields",
    "apply_appeal",
    "draw_panel",
    "eligible_members",
    "ensure_table",
    "ensure_tables",
    "get_appeal",
    "get_appeal_for_decision",
    "get_panel",
    "handle_appeal",
    "panel_exclusions",
    "persist_entry",
    "require_appellant",
    "resolve_decision",
    "router",
    "seat_panel",
    "select_panel",
]


def _install_ledger_subscriber() -> None:
    """Save every ``appeal`` once it is committed to the log."""
    from app.modules import ledger

    ledger.subscribe(APPEAL_TYPE, persist_entry)


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
