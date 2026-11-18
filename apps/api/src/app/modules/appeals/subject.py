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

from app import db
from app.modules import ledger

__all__ = [
    "AppealSubject",
    "describe_subject",
    "format_day",
    "readable_content",
    "report_is_sealed",
    "seat_summary",
]

logger = logging.getLogger(__name__)

#: The signed record type of a revealed review, whose report its gate seals.
_REVIEW_FORMAL = "review.formal"

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


def report_is_sealed(target_cid: str) -> bool:
    """Whether ``target_cid`` is a formal review whose version's report gate is closed.

    The gate is the one the reviews listing applies (REV-4,
    :func:`app.modules.reviews.history.report_gate_open`): open once two reviews
    are counted on the version the review is of, or 21 days after the first.
    Anything but a formal review has no report to seal.

    Fails closed: when the gate cannot be worked out, the report counts as sealed.
    """
    try:
        entry = ledger.entry_by_cid(target_cid)
        if getattr(entry, "record_type", None) != _REVIEW_FORMAL:
            return False
        body = entry.body if isinstance(entry.body, Mapping) else {}
        version_cid = body.get("target")
        if not isinstance(version_cid, str) or not version_cid:
            return True
        return not _report_gate_open(version_cid)
    except Exception:
        logger.debug("could not read the report gate of %s", target_cid, exc_info=True)
        return True


def _report_gate_open(version_cid: str) -> bool:
    """Whether the report gate of paper version ``version_cid`` is open."""
    from sqlalchemy import or_

    from app.modules import submissions
    from app.modules.reviews import history
    from app.modules.reviews.models import Review, ensure_tables

    ensure_tables()
    version = submissions.get_version(version_cid)
    number = int(version.n) if version is not None else 0
    # The reviewers who revised their review to this version are counted on it,
    # whichever version they first committed on; so are the reviews committed on it.
    chains = history.paper_revisions({version_cid: number})
    wanted = [Review.version_cid == version_cid]
    if chains:
        wanted.append(Review.review_key.in_(list(chains)))
    with db.SessionLocal() as session:
        rows = (
            session.query(Review)
            .filter(or_(*wanted))
            .order_by(Review.committed_at, Review.review_cid)
            .all()
        )
        for row in rows:
            session.expunge(row)
    return history.report_gate_open(version_cid, rows, chains)


def _is_review_author(target_cid: str, viewer_did: Optional[str]) -> bool:
    """Whether ``viewer_did`` is the reviewer who took public credit for review ``target_cid``.

    A formal review is signed by a pseudonymous review key; the reviewer's own
    DID is on record only when they signed it with their name, so an anonymous
    review has no author this node can name.
    """
    if not viewer_did:
        return False
    try:
        from app.modules.moderation.decisions import _review_signer

        return _review_signer(ledger.entry_by_cid(target_cid)) == viewer_did
    except Exception:
        logger.debug("could not read the author of review %s", target_cid, exc_info=True)
        return False


def readable_content(
    subject: AppealSubject,
    *,
    may_judge: bool,
    is_moderator: bool,
    viewer_did: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    """The ``(excerpt, link)`` of ``subject`` that this viewer may read.

    The appeal is public; the record it is about may be hidden, and a formal
    review's report may still be sealed, so the opening of either is not.  Both
    are for someone who may judge or contest the decision -- ``may_judge``: a
    member seated on the panel, a tier-4 moderator (``is_moderator``) or the
    appellant -- and everybody else gets ``(None, None)``.

    Whoever it is, a formal review's report is held back while its version's
    report gate is closed, unless the viewer is a tier-4 moderator or the
    review's own author.
    """
    if not may_judge:
        return None, None
    excerpt = subject.excerpt
    if (
        excerpt is not None
        and not is_moderator
        and report_is_sealed(subject.target_cid)
        and not _is_review_author(subject.target_cid, viewer_did)
    ):
        excerpt = None
    return excerpt, subject.link


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
