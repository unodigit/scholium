"""An author's notice that an appeal brought their hidden record back says so.

When a panel overturns the hiding of a post, annotation or review, the appeals
module signs a ``release`` and the moderation module notifies the record's
author of it.  The moderation module words that notice for a decision a
moderator made -- "A moderator made a decision on your post." -- and appends
the decision's own reason, which for a restoration is the node's boilerplate.
The author is then told a moderator did something, with no hint that the panel
sided with them, no paper and a sentence of machinery after it.

The release names the appeal it answers (``appeal`` in its body), which is what
tells a restoration from a release a moderator signed on their own.  So, like a
panel seat's notice (:mod:`~app.modules.notifications.panel`), the notice is
settled against the record whenever the inbox is read:

* a release that answers an appeal reads
  ``The appeal panel overturned the decision to hide your post ("{excerpt}...")
  on "Title"; it is visible again.`` (the quote is what tells two appeals on
  one paper apart) and carries no separate reason line (the sentence is the
  reason);
* a release a moderator signed on their own keeps the moderation module's words
  and its reason: no panel decided it, so none is credited.

Both ``summary`` and ``outcome`` are rewritten, as the moderation notice sets
both, and the settled payload names the appeal it answers (``appeal``).  The
row keeps the moderation kind -- it is still a moderation decision -- but the
dashboard reads that marker and labels it "Appeal outcome", like the notice an
upheld appeal sends.  A release no appeal answers carries no marker and stays
"Moderation outcome".

Settling is idempotent.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

from app import db

from .models import Notification, ensure_table

__all__ = ["settle_restoration_notices"]

logger = logging.getLogger(__name__)

#: What the notice calls each kind of record a release can bring back.
_NOUNS = {"post": "post", "annotation": "annotation", "review": "review"}


def settle_restoration_notices(did: str) -> None:
    """Reword ``did``'s notices of appeal restorations; never raises.

    A notice that cannot be settled is shown as it was sent, and the inbox
    still loads.
    """
    try:
        _settle(did)
    except Exception:  # pragma: no cover - the inbox must load whatever the ledger holds
        logger.debug("could not settle the restoration notices of %s", did, exc_info=True)


def _appeal_it_answers(decision_cid: object) -> Optional[str]:
    """The appeal whose overturn the release ``decision_cid`` answers, if any."""
    from app.modules import ledger

    if not isinstance(decision_cid, str) or not decision_cid:
        return None
    entry = ledger.entry_by_cid(decision_cid)
    body = getattr(entry, "body", None)
    if not isinstance(body, Mapping):
        return None
    appeal = body.get("appeal") or body.get("appeal_restoration")
    return appeal if isinstance(appeal, str) and appeal else None


def _excerpt(payload: Mapping[str, Any], target: Optional[str]) -> Optional[str]:
    """The quoted opening of the record the appeal brought back, if it is one.

    The notice goes to the record's own author, who may read what they wrote
    (the notice itself was sent to them); without the quote two appeals on one
    paper would read alike.
    """
    if not isinstance(target, str) or not target:
        return None
    if payload.get("target_kind") not in ("post", "annotation", "review"):
        return None
    try:
        from app.modules.appeals.subject import _quoted_excerpt
        from app.modules.moderation import outcomes

        excerpt = outcomes.excerpt(target)
        return _quoted_excerpt(excerpt) if excerpt else None
    except Exception:  # pragma: no cover - a quote is never worth failing a notice
        logger.debug("could not read the excerpt of %s", target, exc_info=True)
        return None


def _sentence(payload: Mapping[str, Any]) -> str:
    from app.modules.moderation import outcomes

    noun = _NOUNS.get(str(payload.get("target_kind") or ""), "record")
    target = payload.get("target_cid")
    title: Optional[str] = outcomes.paper_title(target) if isinstance(target, str) and target else None
    excerpt = _excerpt(payload, target)
    quoted = f' ("{excerpt}")' if excerpt else ""
    if title:
        subject = f'your {noun}{quoted} on "{title}"'
    else:
        subject = f"your {noun}{quoted}"
    return f"The appeal panel overturned the decision to hide {subject}; it is visible again."


def _settle(did: str) -> None:
    ensure_table()
    from app.modules.moderation.decisions import RECORD_DECISION_KIND

    session = db.SessionLocal()
    try:
        rows = (
            session.query(Notification)
            .filter(Notification.did == did, Notification.kind == RECORD_DECISION_KIND)
            .order_by(Notification.id)
            .all()
        )
        changed = False
        for row in rows:
            payload = row.payload
            if not isinstance(payload, Mapping) or payload.get("action") != "release":
                continue
            appeal = _appeal_it_answers(payload.get("decision_cid"))
            if appeal is None:
                continue
            sentence = _sentence(payload)
            settled = {key: value for key, value in payload.items() if key != "reason"}
            settled["summary"] = sentence
            settled["outcome"] = sentence
            # The dashboard reads this marker to label the notice "Appeal
            # outcome"; the moderation kind itself stays as the API sent it.
            settled["appeal"] = appeal
            if settled != dict(payload):
                row.payload = settled
                changed = True
        if changed:
            session.commit()
    finally:
        session.close()
