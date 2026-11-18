"""An appeal-panel seat's notification follows what the member did.

A seat is announced with ``Vote on the appeal for "..." by 2026-12-02.`` and a
link to the vote form.  The vote itself is recorded in ``appeal_panels.vote``
by the appeals module, which does not know about notifications, so the notice
is settled against that record whenever the inbox is read:

* the member's vote is recorded -- the notice becomes
  ``You voted {choice} on the appeal for "{title}".`` and is read, because it
  no longer asks for anything;
* the panel decided and the member never voted -- it says
  ``The panel decided: {outcome}.`` (still unread: it is news to them, and
  there is nothing left to vote on);
* otherwise it is untouched and still asks for the vote.

Both ``summary`` and ``outcome`` are rewritten (the seat notice set them to the
same request for a vote), and the facts are kept beside them: ``answer`` is the
member's vote and ``decided`` the panel's outcome.  Settling is idempotent.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

from app import db

from .models import Notification, ensure_table

__all__ = ["PANEL_SEATED_KIND", "settle_panel_notices"]

logger = logging.getLogger(__name__)

#: The kind the appeals module notifies a seated member with.
PANEL_SEATED_KIND = "appeal.panel"

#: ``appeals.status`` until a panel decides; afterwards the outcome itself.
_UNDECIDED = "pending"


def _sentence(title: Optional[str], vote: Optional[str], decided: Optional[str]) -> Optional[str]:
    """The notice's sentence for the recorded facts, or ``None`` when nothing changed."""
    if vote:
        if title:
            return f'You voted {vote} on the appeal for "{title}".'
        return f"You voted {vote} on an appeal panel."
    if decided:
        return f"The panel decided: {decided}."
    return None


def _appeal_of(payload: Any) -> Optional[str]:
    if not isinstance(payload, Mapping):
        return None
    value = payload.get("appeal_cid")
    return value.strip() if isinstance(value, str) and value.strip() else None


def settle_panel_notices(did: str) -> None:
    """Bring ``did``'s appeal-panel notices in line with their seats' recorded votes.

    Never raises: a notice that cannot be settled is shown as it was sent, and
    the inbox still loads.
    """
    try:
        _settle(did)
    except Exception:  # pragma: no cover - the inbox must load whatever the appeals tables hold
        logger.debug("could not settle the panel notices of %s", did, exc_info=True)


def _settle(did: str) -> None:
    ensure_table()
    from app.modules.appeals.models import Appeal, AppealPanelMember, ensure_tables

    session = db.SessionLocal()
    try:
        rows = (
            session.query(Notification)
            .filter(Notification.did == did, Notification.kind == PANEL_SEATED_KIND)
            .order_by(Notification.id)
            .all()
        )
        appeal_cids = {cid for cid in (_appeal_of(row.payload) for row in rows) if cid}
        if not appeal_cids:
            return
        ensure_tables()
        votes = {
            str(seat.appeal_cid): seat.vote
            for seat in session.query(AppealPanelMember).filter(
                AppealPanelMember.member_did == did,
                AppealPanelMember.appeal_cid.in_(appeal_cids),
            )
        }
        statuses = {
            str(appeal.appeal_cid): appeal.status
            for appeal in session.query(Appeal).filter(Appeal.appeal_cid.in_(appeal_cids))
        }

        changed = False
        for row in rows:
            appeal_cid = _appeal_of(row.payload)
            if appeal_cid is None:
                continue
            vote = votes.get(appeal_cid) or None
            status = statuses.get(appeal_cid)
            decided = status if status and status != _UNDECIDED else None
            payload = dict(row.payload)
            sentence = _sentence(payload.get("title"), vote, None if vote else decided)
            if sentence is None:
                continue
            facts: dict[str, Any] = {"summary": sentence, "outcome": sentence}
            if vote:
                facts["answer"] = vote
            if decided:
                facts["decided"] = decided
            settled = {**payload, **facts}
            # A member who voted is done; one who only learned the outcome keeps
            # the notice unread for them to see.
            read = True if vote else row.read
            if settled != payload or read != row.read:
                row.payload = settled
                row.read = read
                changed = True
        if changed:
            session.commit()
    finally:
        session.close()
