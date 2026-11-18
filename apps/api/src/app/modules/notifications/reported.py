"""A reporter's outcome notice for a paper names the paper's title.

The moderation module words a reporter's outcome without the paper's title
for a reported paper (the paper is the item itself, so it was not appended the
way a post's or a review's paper title is).  This module settles that notice
against the paper's title whenever the inbox is read, the same way panel and
restoration notices are settled.

Both ``summary`` and ``outcome`` are rewritten.  Settling is idempotent.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Mapping, Optional

from app import db

from .models import Notification, ensure_table

__all__ = ["settle_reported_paper_notices"]

logger = logging.getLogger(__name__)

#: The kind the flags module notifies a reporter with.
_FLAG_DECIDED_KIND = "flag.outcome"


def settle_reported_paper_notices(did: str) -> None:
    """Bring ``did``'s reported-paper outcome notices in line with the paper title."""
    try:
        _settle(did)
    except Exception:  # pragma: no cover - the inbox must load whatever the ledger holds
        logger.debug("could not settle reported-paper notices of %s", did, exc_info=True)


def _settle(did: str) -> None:
    ensure_table()
    session = db.SessionLocal()
    try:
        rows = (
            session.query(Notification)
            .filter(Notification.did == did, Notification.kind == _FLAG_DECIDED_KIND)
            .order_by(Notification.id)
            .all()
        )
        changed = False
        for row in rows:
            payload = row.payload
            if not isinstance(payload, Mapping):
                continue
            kind = payload.get("target_kind") or payload.get("item_kind")
            if kind != "paper":
                continue
            target = payload.get("target_cid")
            if not isinstance(target, str) or not target.strip():
                continue
            try:
                from app.modules.moderation import outcomes

                title = outcomes.paper_title(target)
            except Exception:
                title = None
            if not isinstance(title, str) or not title.strip():
                continue
            summary = payload.get("summary")
            outcome = payload.get("outcome")
            new_summary = _with_title(summary, title)
            new_outcome = _with_title(outcome, title) if outcome is not None else new_summary
            if new_summary is None:
                continue
            if new_summary == summary and (new_outcome == outcome or outcome is None):
                continue
            settled = {key: value for key, value in payload.items()}
            settled["summary"] = new_summary
            settled["outcome"] = new_outcome if new_outcome is not None else new_summary
            row.payload = settled
            changed = True
        if changed:
            session.commit()
    finally:
        session.close()


def _with_title(value: Any, title: str) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        return None
    if f' on "{title}"' in value:
        return value
    # Insert the paper's title before the outcome verb: "... reported as "Cat""
    # or "... reported" followed by " was ...".
    match = re.search(r"(The paper you reported(?: as \"[^\"]*\")?) (was .*)", value)
    if not match:
        return value
    return f'{match.group(1)} on "{title}" {match.group(2)}'
