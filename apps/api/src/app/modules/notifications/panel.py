"""An appeal-panel seat's notification follows what the member did.

A seat is announced with ``Vote on the appeal for "..." by 2 Dec 2026.`` (or
``Vote on the appeal of a hidden post on "..." by 2 Dec 2026.``) and a link to
the vote form.  The vote itself is recorded in ``appeal_panels.vote``
by the appeals module, which does not know about notifications, so the notice
is settled against that record whenever the inbox is read:

* the member's vote is recorded -- the notice becomes
  ``You voted to uphold the decision on the appeal for "{title}".`` (the vote
  as a verb, never the raw outcome word) and is read, because it no longer asks
  for anything;
* the panel decided and the member never voted -- it says
  ``The panel upheld the decision on "{title}".`` (still unread: it is news to
  them, and there is nothing left to vote on);
* otherwise it is untouched and still asks for the vote.

An appeal about a post, annotation or review keeps the ``("{excerpt}...")``
quote the seat notice carried, so two appeals on one paper do not settle to the
same sentence.

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


_VOTE_VERBS: dict[str, str] = {
    "upheld": "uphold",
    "overturned": "overturn",
    "modified": "modify",
    "remanded": "remand",
    "granted": "grant",
    "grant": "grant",
    "denied": "deny",
    "deny": "deny",
    "allowed": "allow",
    "dismissed": "dismiss",
}


def _excerpt_of(payload: Any) -> Optional[str]:
    """The quoted opening of the appealed record, when the notice is about one.

    The seat notice already quotes the record the appeal is about in the
    sentence that asks for the vote (:func:`app.modules.appeals.subject.seat_summary`),
    and the member reading the settled notice is that same seated member.  So
    the quote is kept when the sentence is rewritten; without it two appeals on
    one paper would read alike.
    """
    if not isinstance(payload, Mapping):
        return None
    if payload.get("target_kind") not in ("post", "annotation", "review"):
        return None
    target = payload.get("target_cid")
    if not isinstance(target, str) or not target:
        return None
    try:
        from app.modules.appeals.subject import _quoted_excerpt
        from app.modules.moderation import outcomes

        excerpt = outcomes.excerpt(target)
        return _quoted_excerpt(excerpt) if excerpt else None
    except Exception:  # pragma: no cover - a quote is never worth failing a notice
        logger.debug("could not read the excerpt of %s", target, exc_info=True)
        return None


def _sentence(
    title: Optional[str],
    excerpt: Optional[str],
    vote: Optional[str],
    decided: Optional[str],
) -> Optional[str]:
    """The notice's sentence for the recorded facts, or ``None`` when nothing changed."""
    quoted = f' ("{excerpt}")' if excerpt else ""
    if vote:
        verb = _VOTE_VERBS.get(vote, vote)
        if title:
            return f'You voted to {verb} the decision on the appeal for "{title}"{quoted}.'
        return f"You voted to {verb} the decision on an appeal panel."
    if decided:
        if title:
            return f'The panel {decided} the decision on "{title}"{quoted}.'
        return f"The panel {decided} the decision."
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
            sentence = _sentence(
                payload.get("title"),
                _excerpt_of(payload),
                vote,
                None if vote else decided,
            )
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
