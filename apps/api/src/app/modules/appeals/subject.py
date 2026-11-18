"""What an appealed decision was about, in the words a member reads.

An appeal answers a ``moderation.decision`` whose target is a paper version, a
discussion post, an inline annotation or a revealed review.  Every place that
tells somebody about an appeal -- the panel's seat notice, the dashboard's
"needs your attention" item, the appeal view the moderation console reads --
used to name only a version's title, so an appeal against a hidden post read
"Vote on an appeal panel" and the card could not say what had been hidden.

:func:`describe_subject` reads the target once and every one of those places
uses the answer.  Whatever the node cannot read is ``None``, never a
placeholder, so a sentence leaves the clause out instead of inventing one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping, Optional

from app.modules import ledger

__all__ = ["AppealSubject", "describe_subject", "format_day", "seat_summary"]

logger = logging.getLogger(__name__)

#: English month abbreviations, fixed so a sentence never depends on the server's locale.
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_HIDE_ACTION = "hide"


def format_day(moment: datetime) -> str:
    """``2026-12-02`` as ``2 Dec 2026`` -- the day the web's date formatter writes."""
    return f"{moment.day} {_MONTHS[moment.month - 1]} {moment.year}"


@dataclass(frozen=True)
class AppealSubject:
    """The record an appealed decision was about."""

    #: cid of the record the decision named.
    target_cid: str
    #: ``paper``, ``post``, ``annotation``, ``review`` or ``item``.
    kind: str
    #: The signed record type (``discussion.post``, ``paper.version``, ...).
    record_type: Optional[str] = None
    #: The title of the paper the record is, or belongs to.
    title: Optional[str] = None
    #: The first words of a post or review; a paper has none.
    excerpt: Optional[str] = None
    #: Where the record can be read (the paper, or the thread a post is in).
    link: Optional[str] = None
    #: The appealed decision's action (``hide``, ``dismiss``, ...), when it can be read.
    action: Optional[str] = None

    @property
    def hidden(self) -> bool:
        """Whether the appealed decision hid the record."""
        return self.action == _HIDE_ACTION

    @property
    def is_record(self) -> bool:
        """True for a post, annotation or review, as opposed to a paper."""
        return self.kind != "paper"

    def phrase(self) -> str:
        """What the appeal is about, to follow "the appeal": ``for "T"`` or ``of a hidden post on "T"``."""
        if not self.is_record:
            return f'for "{self.title}"'
        noun = "record" if self.kind == "item" else self.kind
        article = "an" if noun[0] in "aeiou" else "a"
        what = f"{article} hidden {noun}" if self.hidden else f"a decision on {article} {noun}"
        return f'of {what} on "{self.title}"' if self.title else f"of {what}"


def describe_subject(target_cid: str, decision_cid: Optional[str] = None) -> AppealSubject:
    """Read what the decision on ``target_cid`` was about; never raises.

    ``decision_cid`` names the decision itself, so the subject knows whether it
    hid the record.
    """
    kind = "item"
    record_type: Optional[str] = None
    title: Optional[str] = None
    excerpt: Optional[str] = None
    link: Optional[str] = None
    action: Optional[str] = None
    try:
        from app.modules.moderation import outcomes

        kind = outcomes.target_kind(target_cid)
        entry = ledger.entry_by_cid(target_cid)
        record_type = getattr(entry, "record_type", None)
        if record_type is None and kind == "paper":
            record_type = "paper.version"
        title = outcomes.paper_title(target_cid)
        excerpt = outcomes.excerpt(target_cid)
        link = outcomes.item_link(target_cid, kind)
    except Exception:  # pragma: no cover - a description is never worth failing an appeal view
        logger.debug("could not describe appeal target %s", target_cid, exc_info=True)
    if decision_cid:
        try:
            decision = ledger.entry_by_cid(decision_cid)
            body = decision.body if decision is not None else None
            value = body.get("action") if isinstance(body, Mapping) else None
            action = value if isinstance(value, str) else None
        except Exception:  # pragma: no cover
            logger.debug("could not read appealed decision %s", decision_cid, exc_info=True)
    return AppealSubject(
        target_cid=target_cid,
        kind=kind,
        record_type=record_type,
        title=title,
        excerpt=excerpt,
        link=link,
        action=action,
    )


def seat_summary(subject: Optional[AppealSubject], deadline: Optional[datetime]) -> str:
    """The sentence asking a seated member to vote, naming the appeal and the due day.

    ``Vote on the appeal for "T" by 2 Dec 2026.`` for a paper;
    ``Vote on the appeal of a hidden post on "T" by 2 Dec 2026.`` for a post.
    """
    # A paper whose title this node cannot read has nothing to name.
    named = subject is not None and (subject.is_record or subject.title is not None)
    summary = f"Vote on the appeal {subject.phrase()}" if named else "Vote on an appeal panel"
    if deadline is not None:
        summary += f" by {format_day(deadline)}"
    return f"{summary}."
