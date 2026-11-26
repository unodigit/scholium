"""Assemble the caller's dashboard (feature 126).

``GET /v1/me/dashboard`` answers one question the home screen asks in three
parts: what needs my attention, what have I written, and what have I reviewed?
This module builds that view from the projections the other plugins keep; it
owns no table of its own and never mutates anything.

Needs attention
---------------

The categories, in the order the dashboard shows them.  Each holds only work
that is *still open*: a notice about something finished is not an action.

``consents_to_sign``
    Every ``authorship`` row naming the caller whose ``coauthor.consent`` is
    still missing, on a version that is still ``awaiting_consent`` (features
    54-56).  A consent that has been accepted or declined is no longer owed,
    so both ``consent_cid`` and ``consent_decision`` must be NULL.

``review_invitations``
    Every ``review_invitations`` row addressed to the caller whose status is
    still ``pending`` (feature 105).

``author_replies``
    Every ``review.response`` the authors of a paper filed against one of the
    caller's own reviews (feature 114), unless the reviewer has since updated
    the review: the reply answered the earlier version and asks nothing more.
    "The caller's own reviews" are found without a plaintext reviewer column:
    the escrow's ``uniqueness_token`` is ``HMAC(reviewer_did || paper_cid)``
    (feature 108), so recomputing it for the caller and each paper identifies
    their review rows without the node ever storing the DID-to-review mapping.
    A review the reviewer signed with their name (``review.signed_by``,
    feature 111) counts too.

``moderation_outcomes``
    The appeals still open to the caller: the standing ``moderation.decision``
    about one of their papers or versions is a ``hold``, ``reject``,
    ``delist`` or ``hide``, and no appeal has been filed yet.  Hidden posts and
    reviews the caller wrote are found through the notice addressed to their
    author.  A decision that changed nothing (``dismiss``, ``list``,
    ``release``), and one already appealed, is Notifications only.  The
    moderator's reason is a field of its own, never repeated in the sentence.

``scan_holds``
    Every version of the caller's papers the *safety scan* held: the version is
    still in state ``held``, no ``moderation.decision`` is recorded against it,
    a manifest file's blob verdict is ``failed`` and no later version of the
    paper is listed.  The item names the file that failed and links to the
    version's status tracker; there is no decision, so there is no appeal
    wording.  A moderator's hold keeps its own ``moderation_outcomes`` item and
    never this one.  A version *waiting* for the node's antivirus is not held:
    it gets no attention item (the node re-scans it on its own and there is
    nothing for the author to do) -- its paper's row carries ``scanWaiting``
    instead.

``appeal_panels``
    Every seat on ``appeal_panels`` the caller holds that is still unvoted on
    an appeal no panel has decided (features 75-76).  The item asks them to
    vote and links to the vote form.

``email_verification``
    The caller's stored email address until it has been verified (feature
    178).

Every item names the paper and version it is about by every identity the
system gives them -- the ``sch:`` short id, the genesis cid, the version cid
and the title -- so a client can link to whichever route it has.

My papers
---------

A paper is the caller's when they are on the byline of any of its versions, or
when they signed its ``paper.genesis`` (a paper may exist before its first
version is accepted).  Each row reports the paper's stored lifecycle
``status``, its latest version's state, the number of versions, and how many
reviews the whole paper has drawn -- committed and revealed.  A latest version
waiting for the node's antivirus (still ``scanning`` with inconclusive
findings only) flags its row ``scanWaiting``: the node retries the scan on its
own, so it is news for the row, never an action.

My reviews
----------

Reviews the caller wrote, found with the escrow token above, plus any revealed
review carrying their name.  Each row is ``sealed`` (no ``review.formal`` yet)
or ``revealed``, and records whether the authors have replied.  The
pseudonymity material (``review_key`` and ``nullifier``) is never served.

Tables belonging to other plugins are created if a script or test never built
the app, exactly as those plugins do for themselves.  ``review_responses`` is
read by reflection because the feature that writes it may not be deployed on
every node; an absent table simply means there are no author replies.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any, Iterable, Mapping, Optional, Sequence

from sqlalchemy import MetaData, Table, inspect

from app import db
from app.modules import ledger
from app.modules.appeals.models import (
    Appeal,
    AppealPanelMember,
    ensure_tables as ensure_appeal_tables,
)
from app.modules.ledger.models import EventLog
from app.modules.moderation.decisions import (
    MODERATION_DECISION_KIND,
    RECORD_DECISION_KIND,
)
from app.modules.moderation.models import (
    ModerationDecision,
    ensure_tables as ensure_moderation_tables,
)
from app.modules.notifications.models import (
    Notification,
    ensure_table as ensure_notification_table,
)
from app.modules.reviews.escrow import uniqueness_token
from app.modules.reviews.models import (
    Review,
    ReviewEscrow,
    ReviewInvitation,
    ensure_tables as ensure_review_tables,
)
from app.modules.submissions import (
    AWAITING_CONSENT,
    HELD as VERSION_HELD,
    LISTED,
    SCANNING,
)
from app.modules.submissions.models import (
    Authorship,
    Paper,
    PaperVersion,
    ensure_tables as ensure_submission_tables,
)

__all__ = [
    "ATTENTION_KINDS",
    "INVITATION_PENDING",
    "build_dashboard",
]

logger = logging.getLogger(__name__)

#: The status an invitation has until the reviewer acts on it (feature 105).
INVITATION_PENDING = "pending"

#: The ``needs_attention`` groups, in dashboard order.
ATTENTION_KINDS = (
    "consents_to_sign",
    "review_invitations",
    "author_replies",
    "moderation_outcomes",
    "scan_holds",
    "appeal_panels",
    "email_verification",
)

#: Moderation actions an author may still appeal.  Every other action
#: (``list``, ``dismiss``, ``release``, ``reclassify``) is informational: it
#: belongs in Notifications, not in Needs your attention.
APPEALABLE_ACTIONS = frozenset({"hold", "reject", "delist", "hide"})

#: The words an appealable moderation action reads with.
_APPEAL_VERBS = {
    "hold": "hold on",
    "reject": "rejection of",
    "delist": "delisting of",
}

#: How each failing scanner check reads to the author.  The words mirror the
#: status tracker's ``fileProblem`` vocabulary (``FAILED_CHECK_WORDS`` in
#: ``apps/web/src/features/submit/checks.ts``), so /me and the tracker name the
#: same failure with the same words; an unknown check name is humanised, not
#: hidden, exactly as the tracker humanises it.
_SCAN_CHECK_WORDS = {
    "javascript": "JavaScript",
    "embedded_files": "embedded files",
    "launch": "a Launch action",
    "openaction": "an OpenAction entry",
    "hidden_text": "hidden or near-invisible text",
    "pdf_unreadable": "an unreadable PDF",
    "path_traversal": "a path that escapes the archive",
    "symlink": "a symbolic link",
    "absolute_path": "an absolute path",
    "malware": "malware",
    "av_unavailable": "a malware scan that could not run (the antivirus is unavailable)",
    "bundle_unreadable": "an archive that could not be read",
    "file_missing": "a file missing from this node",
    "file_unreadable": "a file that could not be read",
    "manifest_unreadable": "a manifest that could not be read",
}

#: The record type whose signer created a paper, listed on its byline or not.
PAPER_GENESIS_TYPE = "paper.genesis"

#: ``review_responses`` reflected once per engine.  A missing table is not
#: cached, so a later feature (or another worker) may create it mid-process.
_response_tables: dict[int, Table] = {}


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _iso(value: Any) -> Optional[str]:
    """``value`` as an ISO 8601 string when it is a datetime, else ``None``."""
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def _require_did(did: object) -> str:
    """Return ``did`` as a non-empty string, or raise ``ValueError``."""
    if not isinstance(did, str) or not did.strip():
        raise ValueError("a dashboard needs a non-empty did")
    return did


def _ensure_tables() -> None:
    """Create the projection tables this view reads, if they are absent."""
    ensure_submission_tables()
    ensure_review_tables()
    ensure_notification_table()
    ensure_moderation_tables()
    ensure_appeal_tables()


def _item(
    kind: str,
    summary: str,
    *,
    paper: Optional[Paper] = None,
    version: Optional[PaperVersion] = None,
    reason: Optional[str] = None,
    created_at: Any = None,
    link: Optional[str] = None,
    **extra: Any,
) -> dict[str, Any]:
    """One ``needs_attention`` entry, naming the paper and version it concerns.

    The paper and version identities are spelled twice (snake and camel) the
    way the sibling aggregate endpoints do, so a client written against
    either convention can use the item unchanged.
    """
    short_id = getattr(paper, "short_id", None) if paper is not None else None
    version_cid = getattr(version, "version_cid", None) if version is not None else None
    item: dict[str, Any] = {
        "kind": kind,
        "summary": summary,
        "reason": reason,
        "paper": short_id,
        "shortId": short_id,
        "paperCid": getattr(paper, "paper_cid", None) if paper is not None else None,
        "version": getattr(version, "n", None) if version is not None else None,
        "versionCid": version_cid,
        "version_cid": version_cid,
        "title": getattr(version, "title", None) if version is not None else None,
        "link": link if link is not None else (f"/p/{short_id}" if short_id else None),
        "createdAt": _iso(created_at),
    }
    item.update(extra)
    return item


# --------------------------------------------------------------------------- #
# Loading the projections
# --------------------------------------------------------------------------- #


def _load_catalog() -> tuple[
    dict[str, Paper], dict[str, PaperVersion], dict[str, list[PaperVersion]]
]:
    """Return every paper, every version by cid, and every version by paper."""
    with db.SessionLocal() as session:
        papers = list(session.query(Paper).all())
        versions = list(
            session.query(PaperVersion).order_by(PaperVersion.paper_cid, PaperVersion.n).all()
        )
        for row in papers:
            session.expunge(row)
        for row in versions:
            session.expunge(row)

    paper_by_cid = {paper.paper_cid: paper for paper in papers}
    version_by_cid = {version.version_cid: version for version in versions}
    versions_by_paper: dict[str, list[PaperVersion]] = {}
    for version in versions:
        versions_by_paper.setdefault(version.paper_cid, []).append(version)
    return paper_by_cid, version_by_cid, versions_by_paper


def _load_reviews() -> dict[str, Review]:
    """Return every committed review by its cid."""
    with db.SessionLocal() as session:
        rows = session.query(Review).all()
        for row in rows:
            session.expunge(row)
    return {row.review_cid: row for row in rows}


def _genesis_paper_cids(did: str) -> set[str]:
    """Every paper whose ``paper.genesis`` the caller signed."""
    try:
        ledger.ensure_table()
        with db.SessionLocal() as session:
            rows = (
                session.query(EventLog.record_cid)
                .filter(
                    EventLog.record_type == PAPER_GENESIS_TYPE,
                    EventLog.author_did == did,
                )
                .all()
            )
        return {row[0] for row in rows if isinstance(row[0], str) and row[0]}
    except Exception:  # pragma: no cover - a damaged log must not break the dashboard
        logger.exception("could not read the event log for %s's genesis papers", did)
        return set()


def _paper_cids_for(
    did: str,
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
) -> set[str]:
    """Every paper the caller authored, by byline or by ``paper.genesis``."""
    with db.SessionLocal() as session:
        rows = (
            session.query(Authorship.version_cid)
            .filter(Authorship.author_did == did)
            .distinct()
            .all()
        )
        authored_versions = {row[0] for row in rows if isinstance(row[0], str)}

    paper_cids: set[str] = set()
    for version_cid in authored_versions:
        version = version_by_cid.get(version_cid)
        if version is not None:
            paper_cids.add(version.paper_cid)
    # A genesis may be accepted before any version exists; its signer is still
    # the paper's author.  Only papers this node indexed count.
    paper_cids |= _genesis_paper_cids(did) & set(paper_by_cid)
    return paper_cids


def _my_review_cids(did: str, paper_cids: Iterable[str], reviews: Mapping[str, Review]) -> set[str]:
    """The cids of the reviews this caller wrote, without a plaintext mapping.

    Two independent links are honoured: the escrow token (the accountability
    link the node can compute but not invert, feature 108) and a review the
    caller revealed under their own name (``signed_by``, feature 111).
    """
    tokens: set[str] = set()
    for paper_cid in paper_cids:
        try:
            tokens.add(uniqueness_token(did, paper_cid))
        except ValueError:  # pragma: no cover - papers are never stored without a cid
            continue

    found: set[str] = set()
    if tokens:
        with db.SessionLocal() as session:
            rows = (
                session.query(ReviewEscrow.review_cid)
                .filter(ReviewEscrow.uniqueness_token.in_(sorted(tokens)))
                .all()
            )
            found |= {row[0] for row in rows if isinstance(row[0], str) and row[0]}

    found |= {
        review_cid
        for review_cid, review in reviews.items()
        if review.signed_by is not None and review.signed_by == did
    }
    return found


def _review_response_table() -> Optional[Table]:
    """The ``review_responses`` table, or ``None`` when this node has none."""
    engine = db.engine
    cached = _response_tables.get(id(engine))
    if cached is not None:
        return cached
    table: Optional[Table] = None
    try:
        if inspect(engine).has_table("review_responses"):
            table = Table("review_responses", MetaData(), autoload_with=engine)
    except Exception:  # pragma: no cover - a race with another worker's DDL
        logger.debug("review_responses is not readable yet", exc_info=True)
        return None
    if table is not None:
        _response_tables[id(engine)] = table
    return table


def _load_review_responses() -> list[dict[str, Any]]:
    """Every stored ``review.response`` row, or ``[]`` when the table is absent."""
    table = _review_response_table()
    if table is None:
        return []
    try:
        with db.SessionLocal() as session:
            return [dict(row) for row in session.execute(table.select()).mappings().all()]
    except Exception:  # pragma: no cover - the table vanished mid-request
        logger.exception("could not read review_responses")
        # Re-check next time instead of serving a stale reflection of a table
        # that has since been dropped or replaced.
        _response_tables.pop(id(db.engine), None)
        return []


# --------------------------------------------------------------------------- #
# needs_attention
# --------------------------------------------------------------------------- #


def _consents_to_sign(
    did: str,
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
) -> list[dict[str, Any]]:
    """Consents the caller still owes on versions waiting for them."""
    with db.SessionLocal() as session:
        rows = (
            session.query(Authorship.credit_roles, PaperVersion)
            .join(PaperVersion, PaperVersion.version_cid == Authorship.version_cid)
            .filter(
                Authorship.author_did == did,
                Authorship.consent_cid.is_(None),
                Authorship.consent_decision.is_(None),
                PaperVersion.state == AWAITING_CONSENT,
            )
            .order_by(PaperVersion.paper_cid, PaperVersion.n)
            .all()
        )
        pending = [
            {"version_cid": version.version_cid, "credit_roles": credit_roles}
            for credit_roles, version in rows
        ]

    items: list[dict[str, Any]] = []
    for row in pending:
        version = version_by_cid.get(row["version_cid"])
        if version is None:  # pragma: no cover - joined rows always resolve
            continue
        paper = paper_by_cid.get(version.paper_cid)
        short_id = getattr(paper, "short_id", None) or version.paper_cid
        title = getattr(version, "title", None)
        if title:
            summary = f'Sign your co-author consent for "{title}" (version {version.n}).'
        else:
            summary = f"Sign your co-author consent for {short_id}."
        items.append(
            _item(
                "consent_to_sign",
                summary,
                paper=paper,
                version=version,
                role=row["credit_roles"],
                creditRoles=row["credit_roles"],
                status="waiting",
                link=f"/consent/{version.version_cid}",
            )
        )
    return items


def _review_invitations(
    did: str,
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
) -> list[dict[str, Any]]:
    """Invitations the caller has been sent and not yet acted on."""
    with db.SessionLocal() as session:
        rows = (
            session.query(ReviewInvitation)
            .filter(
                ReviewInvitation.reviewer_did == did,
                ReviewInvitation.status == INVITATION_PENDING,
            )
            .order_by(ReviewInvitation.id)
            .all()
        )
        invitations = [
            {"id": row.id, "version_cid": row.version_cid, "status": row.status}
            for row in rows
        ]

    items: list[dict[str, Any]] = []
    for invitation in invitations:
        version = version_by_cid.get(invitation["version_cid"])
        paper = paper_by_cid.get(version.paper_cid) if version is not None else None
        short_id = getattr(paper, "short_id", None) or invitation["version_cid"]
        title = getattr(version, "title", None) if version is not None else None
        if title:
            summary = f'You are invited to review "{title}".'
        else:
            summary = f"You are invited to review {short_id}."
        items.append(
            _item(
                "review_invitation",
                summary,
                paper=paper,
                version=version,
                invitationId=invitation["id"],
                id=invitation["id"],
                status=invitation["status"],
                link=f"/review/{short_id}",
            )
        )
    return items


def _author_replies(
    my_review_cids: set[str],
    reviews: Mapping[str, Review],
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
) -> list[dict[str, Any]]:
    """The authors' point-by-point replies to the caller's own reviews."""
    if not my_review_cids:
        return []

    items: list[dict[str, Any]] = []
    for row in _load_review_responses():
        review_cid = row.get("review_cid")
        if not isinstance(review_cid, str) or review_cid not in my_review_cids:
            continue
        review = reviews.get(review_cid)
        if review is None:
            # The escrow knows about a review whose row is missing; there is
            # nothing to reply to.
            continue
        # The reviewer has updated the review: the author's reply answered the
        # earlier version and no longer asks them for anything.
        if _latest_review_version_cid(review, version_by_cid) != review.version_cid:
            continue
        version = version_by_cid.get(review.version_cid)
        paper = paper_by_cid.get(version.paper_cid) if version is not None else None
        short_id = getattr(paper, "short_id", None)
        title = getattr(version, "title", None) if version is not None else None
        if title:
            summary = f'The authors replied to your review of "{title}".'
        elif short_id:
            summary = f"The authors replied to your review of {short_id}."
        else:
            summary = "The authors replied to your review."
        items.append(
            _item(
                "author_reply",
                summary,
                paper=paper,
                version=version,
                reviewCid=review_cid,
                review_cid=review_cid,
                responseCid=row.get("response_cid"),
                responses=row.get("replies"),
                link=f"/review/{short_id}" if short_id else None,
            )
        )
    items.sort(key=lambda item: (item.get("paper") or "", item.get("responseCid") or ""))
    return items


def _decision_reason(decision_cid: str) -> Optional[str]:
    """The reason text of a decision record, if the ledger still serves it."""
    try:
        entry = ledger.entry_by_cid(decision_cid)
        body = getattr(entry, "body", None) if entry is not None else None
        if isinstance(body, Mapping):
            reason = body.get("reason")
            if isinstance(reason, str) and reason.strip():
                return reason.strip()
    except Exception:  # pragma: no cover - the ledger is a shipped plugin
        logger.debug("could not read decision %s from the ledger", decision_cid, exc_info=True)
    return None


def _safe_web_link(value: object) -> Optional[str]:
    """A payload link that is safe to put in an ``href``.

    A path on this site is accepted unless it is protocol-relative or an API
    route (the web origin would answer either with a 404); an absolute
    ``http(s)`` address is accepted.  Everything else is refused.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    link = value.strip()
    if link.startswith("/"):
        return None if link.startswith("//") or link.startswith("/v1/") else link
    if link.startswith("http://") or link.startswith("https://"):
        return link
    return None


def _appealed_decision_cids() -> set[str]:
    """Every decision cid an appeal already answers."""
    try:
        with db.SessionLocal() as session:
            rows = session.query(Appeal.decision_cid).all()
        return {row[0] for row in rows if isinstance(row[0], str) and row[0]}
    except Exception:  # pragma: no cover - appeals is a shipped plugin
        logger.debug("could not read appeals", exc_info=True)
        return set()


def _latest_decisions(target_cids: Iterable[str]) -> dict[str, dict[str, Any]]:
    """The standing decision for each target, by target cid.

    "Standing" is the last decision saved for the target: a later ``release``
    puts a held paper back, so the older hold is no longer an open action.
    """
    targets = sorted({target for target in target_cids if isinstance(target, str) and target})
    if not targets:
        return {}
    with db.SessionLocal() as session:
        rows = (
            session.query(ModerationDecision)
            .filter(ModerationDecision.target_cid.in_(targets))
            .order_by(ModerationDecision.decided_at.asc(), ModerationDecision.decision_cid.asc())
            .all()
        )
        latest: dict[str, dict[str, Any]] = {}
        for row in rows:
            latest[row.target_cid] = {
                "decision_cid": row.decision_cid,
                "target_cid": row.target_cid,
                "action": row.action,
                "clause": row.clause,
                "decided_at": row.decided_at,
            }
        return latest


def _appeal_available_item(
    decision_cid: str,
    target_cid: str,
    action: str,
    *,
    paper: Optional[Paper] = None,
    version: Optional[PaperVersion] = None,
    title: Optional[str] = None,
    reason: Optional[str] = None,
    created_at: Any = None,
    target_kind: Optional[str] = None,
    link: Optional[str] = None,
    clause: Optional[str] = None,
    source: str = "decision",
    notification_id: Optional[int] = None,
    notified: bool = False,
) -> dict[str, Any]:
    """One open appeal action, naming the paper and linking to where it is filed."""
    short_id = getattr(paper, "short_id", None)
    if title is None and version is not None:
        title = getattr(version, "title", None)
    if title is None:
        try:
            from app.modules.moderation.outcomes import paper_title

            title = paper_title(target_cid)
        except Exception:  # pragma: no cover - outcomes is a shipped plugin
            title = None

    if action == "hide":
        noun = {"post": "post", "annotation": "annotation", "review": "review"}.get(
            target_kind or "", "post"
        )
        # The author's own item may quote their own record: two hidden posts on
        # one paper are otherwise told apart only by the moderator's reason.
        quote = None
        try:
            from app.modules.appeals.subject import _quoted_excerpt
            from app.modules.moderation.outcomes import excerpt

            found = excerpt(target_cid)
            if found:
                quote = _quoted_excerpt(found)
        except Exception:  # pragma: no cover - outcomes is a shipped plugin
            quote = None
        if quote and title:
            summary = f'Appeal the removal of your {noun} ("{quote}") on "{title}".'
        elif quote:
            summary = f'Appeal the removal of your {noun} ("{quote}").'
        elif title:
            summary = f'Appeal the removal of your {noun} on "{title}".'
        else:
            summary = f"Appeal the removal of your {noun}."
        if link is None:
            try:
                from app.modules.moderation.outcomes import item_link

                link = item_link(target_cid, target_kind)
            except Exception:  # pragma: no cover - outcomes is a shipped plugin
                link = None
    else:
        verb = _APPEAL_VERBS.get(action, "decision on")
        if title:
            summary = f'Appeal the {verb} "{title}".'
        elif short_id:
            summary = f"Appeal the {verb} {short_id}."
        else:
            summary = f"Appeal the {verb} your paper."
        if link is None and short_id:
            link = f"/p/{short_id}"

    item = _item(
        "appeal_available",
        summary,
        paper=paper,
        version=version,
        reason=reason,
        created_at=created_at,
        link=link,
        decisionCid=decision_cid,
        decision_cid=decision_cid,
        action=action,
        clause=clause,
        targetCid=target_cid,
        target_cid=target_cid,
        source=source,
        notified=notified,
        status="open",
    )
    if notification_id is not None:
        item["notificationId"] = notification_id
    return item


def _moderation_outcomes(
    did: str,
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
    paper_cids: Iterable[str],
) -> list[dict[str, Any]]:
    """The appeals still open to the caller: a hold or a hidden record.

    A decision that changed nothing (``dismiss``, ``list``, ``release``) or
    that has already been appealed is not something left to do, so it appears
    in Notifications only.  The reason lives in its own field, exactly once.
    """
    paper_cids = set(paper_cids)
    targets = set(paper_cids)
    targets |= {
        version_cid
        for version_cid, version in version_by_cid.items()
        if version.paper_cid in paper_cids
    }
    appealed = _appealed_decision_cids()
    merged: dict[str, dict[str, Any]] = {}

    # The standing decision about each of the caller's papers or versions.
    for target_cid, decision in _latest_decisions(targets).items():
        action = decision["action"]
        decision_cid = decision["decision_cid"]
        if action not in APPEALABLE_ACTIONS or decision_cid in appealed:
            continue
        version = version_by_cid.get(target_cid)
        paper = paper_by_cid.get(version.paper_cid) if version is not None else None
        if paper is None:
            paper = paper_by_cid.get(target_cid)
        merged[decision_cid] = _appeal_available_item(
            decision_cid,
            target_cid,
            action,
            paper=paper,
            version=version,
            reason=_decision_reason(decision_cid),
            created_at=decision["decided_at"],
            clause=decision["clause"],
            source="decision",
        )

    # Hidden posts and reviews the caller wrote have no place in the paper
    # catalog above; the notice addressed to their author is the link.  Read
    # and unread alike: reading the notice is not filing the appeal.
    with db.SessionLocal() as session:
        rows = (
            session.query(Notification)
            .filter(
                Notification.did == did,
                Notification.kind.in_([MODERATION_DECISION_KIND, RECORD_DECISION_KIND]),
            )
            .order_by(Notification.id.desc())
            .all()
        )
        notices = [(row.id, row.kind, row.payload) for row in rows]

    notice_targets = [
        payload.get("target_cid") or payload.get("targetCid")
        for _id, _kind, payload in notices
        if isinstance(payload, Mapping)
    ]
    latest_for_notice_target = _latest_decisions(notice_targets)

    for notification_id, _kind, payload in notices:
        payload = payload if isinstance(payload, Mapping) else {}
        action = payload.get("action")
        if action not in APPEALABLE_ACTIONS:
            continue
        decision_cid = payload.get("decision_cid") or payload.get("decisionCid")
        target_cid = payload.get("target_cid") or payload.get("targetCid")
        if not isinstance(decision_cid, str) or not decision_cid:
            continue
        if decision_cid in appealed:
            continue
        if not isinstance(target_cid, str) or not target_cid:
            continue
        standing = latest_for_notice_target.get(target_cid)
        if standing is not None and standing["decision_cid"] != decision_cid:
            # A later decision (a release, another hold) superseded this one.
            continue

        existing = merged.get(decision_cid)
        if existing is not None:
            # The stored decision is the richer view; note that it was notified.
            existing["notificationId"] = notification_id
            existing["notified"] = True
            continue

        version = version_by_cid.get(target_cid)
        paper = paper_by_cid.get(version.paper_cid) if version is not None else None
        if paper is None:
            paper = paper_by_cid.get(target_cid)
        target_kind = payload.get("target_kind") or payload.get("item_kind")
        reason = payload.get("reason")
        merged[decision_cid] = _appeal_available_item(
            decision_cid,
            target_cid,
            action,
            paper=paper,
            version=version,
            reason=reason if isinstance(reason, str) and reason.strip() else None,
            target_kind=target_kind if isinstance(target_kind, str) else None,
            link=_safe_web_link(payload.get("link")),
            clause=payload.get("clause") if isinstance(payload.get("clause"), str) else None,
            source="notification",
            notification_id=notification_id,
            notified=True,
        )

    return list(merged.values())


def _scan_check_words(name: str) -> str:
    """The plain words the failing check ``name`` reads with."""
    words = _SCAN_CHECK_WORDS.get(name)
    if words is not None:
        return words
    return re.sub(r"[_-]+", " ", name).strip() or name


def _join_check_words(words: Sequence[str]) -> str:
    """``"a and b"`` / ``"a, b and c"``, the way the tracker joins them."""
    if not words:
        return ""
    if len(words) == 1:
        return words[0]
    return f"{', '.join(words[:-1])} and {words[-1]}"


def _first_failed_manifest_file(version_cid: str) -> Optional[dict[str, Any]]:
    """The first manifest file of ``version_cid`` whose scan failed, or ``None``.

    "Failed" is the blob verdict the scan saved (``blobs.scan_status``), the
    same rule the checks report reads, so the two never disagree.  The file
    carries its manifest path and the names of the checks it failed.
    """
    from app.modules import content, sanitizer
    from app.modules.checks.pipeline import manifest_entries

    for entry in manifest_entries(version_cid):
        cid = entry.get("cid")
        if not isinstance(cid, str) or not cid:
            continue
        try:
            blob = content.get_blob(cid)
        except Exception:  # pragma: no cover - a damaged store must not break the dashboard
            logger.debug("could not read the blob row for %s", cid, exc_info=True)
            continue
        if blob is None or getattr(blob, "scan_status", None) != content.SCAN_FAILED:
            continue
        path = entry.get("path")
        failed = [
            str(report.check_name)
            for report in sanitizer.reports_for(cid)
            if getattr(report, "result", None) == sanitizer.RESULT_FAILED
        ]
        return {
            "cid": cid,
            "path": path if isinstance(path, str) and path else cid,
            "failed_checks": failed,
        }
    return None


def _version_waits_for_antivirus(version: PaperVersion) -> bool:
    """Whether ``version`` waits in ``scanning`` for the node's antivirus.

    True when the version is still in ``scanning`` and its files' latest
    findings are inconclusive only: at least one ``av_unavailable`` (the
    antivirus could not run) and no conclusive check anywhere.  The node
    re-scans such a version on its own, so there is nothing for the author to
    do: the row carries the news (``scanWaiting``), and no attention item is
    filed for it.
    """
    if getattr(version, "state", None) != SCANNING:
        return False
    from app.modules import sanitizer
    from app.modules.checks.pipeline import manifest_entries

    waiting = False
    for entry in manifest_entries(version.version_cid):
        cid = entry.get("cid")
        if not isinstance(cid, str) or not cid:
            continue
        for report in sanitizer.reports_for(cid):
            if getattr(report, "result", None) != sanitizer.RESULT_FAILED:
                # A check that passed is a verdict, not a finding.
                continue
            if getattr(report, "check_name", None) != sanitizer.CHECK_AV_UNAVAILABLE:
                # A conclusive finding is the scan's verdict, not a wait.
                return False
            waiting = True
    return waiting


def _scan_holds(
    paper_by_cid: Mapping[str, Paper],
    versions_by_paper: Mapping[str, list[PaperVersion]],
    paper_cids: Iterable[str],
) -> list[dict[str, Any]]:
    """The versions of the caller's papers the safety scan holds, one item each.

    A scan hold records no decision, so without this item the author learns of
    it only by opening the paper.  The item names the file that failed and
    links to the version's status tracker, which says what to do about it;
    there is no decision, so there is no appeal to invite them to.  It stops
    once a later version of the paper is listed, the version leaves ``held``,
    or a moderator decides -- their hold keeps its own appeal item.
    """
    items: list[dict[str, Any]] = []
    for paper_cid in sorted(set(paper_cids)):
        paper = paper_by_cid.get(paper_cid)
        if paper is None:
            continue
        versions = versions_by_paper.get(paper_cid, [])
        for version in versions:
            if version.state != VERSION_HELD:
                continue
            # A listed later version says the paper moved on; the held one is
            # history nobody needs to act on any more.
            if any(later.state == LISTED and later.n > version.n for later in versions):
                continue
            if _latest_decisions([version.version_cid]):
                # A moderator decided this version: their appeal item, not the
                # scan's, tells the author about it.
                continue
            failed = _first_failed_manifest_file(version.version_cid)
            if failed is None:
                # A hold whose files all passed is a moderator's, not the
                # scan's; the appeal item (or nothing) speaks for it.
                continue
            title = getattr(version, "title", None)
            short_id = getattr(paper, "short_id", None)
            if title:
                summary = f'A file in "{title}" failed the safety scan.'
            elif short_id:
                summary = f"A file in {short_id} failed the safety scan."
            else:
                summary = "A file in your paper failed the safety scan."
            words = _join_check_words(
                [_scan_check_words(name) for name in failed["failed_checks"]]
            )
            reason = (
                f"{failed['path']}: {words}"
                if words
                else f"{failed['path']}: the safety scan failed."
            )
            items.append(
                _item(
                    "scan_hold",
                    summary,
                    paper=paper,
                    version=version,
                    reason=reason,
                    link=f"/p/{short_id}/v{version.n}" if short_id else None,
                    status="open",
                    path=failed["path"],
                    fileCid=failed["cid"],
                    failedChecks=failed["failed_checks"],
                )
            )
    return items


def _appeal_panels(
    did: str,
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
) -> list[dict[str, Any]]:
    """Open seats the caller holds, each asking for their vote.

    A seat is open while its ``appeal_panels.vote`` is NULL and the appeal is
    still ``pending``; voting or a panel decision drops it.  The link opens the
    vote form in the moderation console.
    """
    try:
        with db.SessionLocal() as session:
            rows = (
                session.query(AppealPanelMember, Appeal)
                .join(Appeal, Appeal.appeal_cid == AppealPanelMember.appeal_cid)
                .filter(
                    AppealPanelMember.member_did == did,
                    AppealPanelMember.vote.is_(None),
                    Appeal.status == "pending",
                )
                .order_by(Appeal.filed_at)
                .all()
            )
            seats = [
                {
                    "appeal_cid": str(appeal.appeal_cid),
                    "decision_cid": str(appeal.decision_cid),
                    "filed_at": appeal.filed_at,
                }
                for _seat, appeal in rows
            ]
    except Exception:  # pragma: no cover - appeals is a shipped plugin
        logger.debug("could not read the caller's appeal seats", exc_info=True)
        return []

    if not seats:
        return []

    from app.modules.appeals.service import PANEL_VOTE_WINDOW, resolve_decision
    from app.modules.appeals.subject import describe_subject, seat_summary

    items: list[dict[str, Any]] = []
    for seat in seats:
        paper = None
        version = None
        decision = None
        try:
            decision = resolve_decision(seat["decision_cid"])
            version = version_by_cid.get(decision.version_cid)
            paper = paper_by_cid.get(decision.paper_cid)
            if paper is None and version is not None:
                paper = paper_by_cid.get(version.paper_cid)
        except Exception:  # pragma: no cover - a decision this node no longer holds
            logger.debug("could not resolve appeal %s", seat["appeal_cid"], exc_info=True)

        filed_at = seat["filed_at"]
        deadline = filed_at + PANEL_VOTE_WINDOW if isinstance(filed_at, datetime) else None
        due_day = deadline.date().isoformat() if deadline is not None else None
        subject = describe_subject(decision.target_cid, decision.decision_cid) if decision is not None else None
        summary = seat_summary(subject, deadline)

        items.append(
            _item(
                "appeal_panel",
                summary,
                paper=paper,
                version=version,
                created_at=filed_at,
                link=f"/mod#appeal-{seat['appeal_cid']}-title",
                appealCid=seat["appeal_cid"],
                appeal_cid=seat["appeal_cid"],
                decisionCid=seat["decision_cid"],
                deadline=deadline.isoformat() if deadline is not None else None,
                dueAt=due_day,
                status="waiting",
            )
        )
    return items


def _email_verification(did: str) -> list[dict[str, Any]]:
    """Ask the caller to confirm their email address until they have."""
    try:
        from app.modules.profiles import email_verified, read_profile
    except Exception:  # pragma: no cover - profiles is a shipped plugin
        return []
    try:
        profile = read_profile(did)
        if profile is None or not getattr(profile, "email", None):
            return []
        if email_verified(did):
            return []
    except Exception:  # pragma: no cover - a damaged profile must not break the dashboard
        logger.debug("could not read %s's profile verification state", did, exc_info=True)
        return []

    link = "/verify-email"
    try:
        with db.SessionLocal() as session:
            row = (
                session.query(Notification)
                .filter(Notification.did == did, Notification.kind == "email.verify")
                .order_by(Notification.id.desc())
                .first()
            )
            payload = row.payload if row is not None and isinstance(row.payload, Mapping) else {}
        link = _safe_web_link(payload.get("link")) or link
    except Exception:  # pragma: no cover - the notification is best-effort
        logger.debug("could not read %s's verification notice", did, exc_info=True)

    return [
        _item(
            "email_verification",
            "Confirm your email address.",
            link=link,
            status="waiting",
        )
    ]


# --------------------------------------------------------------------------- #
# my_papers / my_reviews
# --------------------------------------------------------------------------- #


def _paper_title(paper_cid: str, latest: Optional[PaperVersion]) -> Optional[str]:
    """The latest version's title, or the genesis record's when there is none."""
    if latest is not None:
        return latest.title
    try:
        entry = ledger.entry_by_cid(paper_cid)
        body = getattr(entry, "body", None) if entry is not None else None
        if isinstance(body, Mapping):
            title = body.get("title")
            if isinstance(title, str) and title:
                return title
    except Exception:  # pragma: no cover - the ledger is a shipped plugin
        logger.debug("could not read the genesis record %s", paper_cid, exc_info=True)
    return None


def _my_papers(
    paper_cids: Iterable[str],
    paper_by_cid: Mapping[str, Paper],
    versions_by_paper: Mapping[str, list[PaperVersion]],
    reviews_by_version: Mapping[str, list[Review]],
) -> list[dict[str, Any]]:
    """One row per paper the caller authored, with its status and review counts.

    A paper whose latest version waits for the node's antivirus carries
    ``scanWaiting`` (and ``scan_waiting``): the scan is not finishing because
    the node's malware scanner cannot run, and the node retries it on its own.
    """
    papers: list[dict[str, Any]] = []
    for paper_cid in paper_cids:
        paper = paper_by_cid.get(paper_cid)
        if paper is None:
            continue
        versions = versions_by_paper.get(paper_cid, [])
        latest = max(versions, key=lambda version: version.n) if versions else None
        scan_waiting = (
            _version_waits_for_antivirus(latest) if latest is not None else False
        )
        paper_reviews = [
            review
            for version in versions
            for review in reviews_by_version.get(version.version_cid, [])
        ]
        short_id = paper.short_id
        papers.append(
            {
                "paper": short_id,
                "shortId": short_id,
                "paperCid": paper_cid,
                "paper_cid": paper_cid,
                "title": _paper_title(paper_cid, latest),
                "status": paper.status,
                "categories": list(paper.categories or []),
                "role": "author",
                "versionCount": len(versions),
                "versions": len(versions),
                "latestVersion": latest.n if latest is not None else None,
                "latestVersionCid": latest.version_cid if latest is not None else None,
                "state": latest.state if latest is not None else None,
                "scanWaiting": scan_waiting,
                "scan_waiting": scan_waiting,
                "reviewCount": len(paper_reviews),
                "reviews": len(paper_reviews),
                "revealedCount": sum(
                    1 for review in paper_reviews if review.revealed_at is not None
                ),
                "listedAt": _iso(paper.listed_at),
                "claimed": bool(paper.claimed),
                "link": f"/p/{short_id}",
            }
        )

    papers.sort(
        key=lambda row: (row.get("listedAt") or "", row.get("paper") or ""),
        reverse=True,
    )
    return papers



def _latest_review_version_cid(review: Any, version_by_cid: Mapping[str, PaperVersion]) -> str:
    """The version cid of the reviewer's latest review, following update chains."""
    base_version = version_by_cid.get(review.version_cid)
    paper_cid = getattr(base_version, "paper_cid", None) if base_version is not None else None
    best_cid = review.version_cid
    best_n = getattr(base_version, "n", None) if base_version is not None else None
    try:
        from app.modules.reviews.service import formal_entries
        entries = formal_entries(getattr(review, "review_key", None))
    except Exception:
        entries = []
    for entry in entries or []:
        body = getattr(entry, "body", None)
        if not isinstance(body, Mapping):
            try:
                body = entry["body"]
            except Exception:
                body = None
        if not isinstance(body, Mapping):
            continue
        target = body.get("target") or body.get("versionCid") or body.get("version_cid")
        if not isinstance(target, str):
            continue
        version = version_by_cid.get(target)
        if version is None:
            continue
        if paper_cid is not None and getattr(version, "paper_cid", None) != paper_cid:
            continue
        n = getattr(version, "n", None)
        if not isinstance(n, int):
            continue
        if best_n is None or n > best_n:
            best_n = n
            best_cid = target
    return best_cid


def _my_reviews(
    my_review_cids: Iterable[str],
    reviews: Mapping[str, Review],
    responses_by_review: Mapping[str, int],
    paper_by_cid: Mapping[str, Paper],
    version_by_cid: Mapping[str, PaperVersion],
) -> list[dict[str, Any]]:
    """The caller's own reviews and whether each is still sealed."""
    rows: list[dict[str, Any]] = []
    for review_cid in my_review_cids:
        review = reviews.get(review_cid)
        if review is None:
            # The escrow knows about a review whose row is missing; nothing to show.
            continue
        latest_version_cid = _latest_review_version_cid(review, version_by_cid)
        version = version_by_cid.get(latest_version_cid)
        paper = paper_by_cid.get(version.paper_cid) if version is not None else None
        short_id = getattr(paper, "short_id", None)
        revealed = review.revealed_at is not None
        response_count = responses_by_review.get(review_cid, 0)
        rows.append(
            {
                "reviewCid": review.review_cid,
                "review_cid": review.review_cid,
                "state": "revealed" if revealed else "sealed",
                "sealed": not revealed,
                "revealed": revealed,
                "paper": short_id,
                "shortId": short_id,
                "paperCid": getattr(paper, "paper_cid", None),
                "version": getattr(version, "n", None),
                "versionCid": latest_version_cid,
                "version_cid": latest_version_cid,
                "title": getattr(version, "title", None),
                "committedAt": _iso(review.committed_at),
                "revealedAt": _iso(review.revealed_at),
                "recommendation": review.recommendation if revealed else None,
                "confidence": review.confidence if revealed else None,
                "scores": review.scores if revealed else None,
                "signedBy": review.signed_by,
                "authorReplied": response_count > 0,
                "awaitingAuthor": revealed and response_count == 0,
                "responseCount": response_count,
                "link": f"/review/{short_id}" if short_id else None,
            }
        )

    rows.sort(key=lambda row: (row.get("committedAt") or "", row.get("reviewCid") or ""), reverse=True)
    return rows


# --------------------------------------------------------------------------- #
# The dashboard
# --------------------------------------------------------------------------- #


def build_dashboard(did: str) -> dict[str, Any]:
    """Assemble ``GET /v1/me/dashboard`` for the authenticated ``did``."""
    did = _require_did(did)
    _ensure_tables()

    paper_by_cid, version_by_cid, versions_by_paper = _load_catalog()
    reviews = _load_reviews()
    reviews_by_version: dict[str, list[Review]] = {}
    for review in reviews.values():
        reviews_by_version.setdefault(review.version_cid, []).append(review)

    paper_cids = _paper_cids_for(did, paper_by_cid, version_by_cid)
    my_review_cids = _my_review_cids(did, paper_by_cid, reviews)

    responses_by_review: dict[str, int] = {}
    for row in _load_review_responses():
        review_cid = row.get("review_cid")
        if isinstance(review_cid, str) and review_cid in my_review_cids:
            responses_by_review[review_cid] = responses_by_review.get(review_cid, 0) + 1

    consents = _consents_to_sign(did, paper_by_cid, version_by_cid)
    invitations = _review_invitations(did, paper_by_cid, version_by_cid)
    replies = _author_replies(my_review_cids, reviews, paper_by_cid, version_by_cid)
    outcomes = _moderation_outcomes(did, paper_by_cid, version_by_cid, paper_cids)
    scan_holds = _scan_holds(paper_by_cid, versions_by_paper, paper_cids)
    panels = _appeal_panels(did, paper_by_cid, version_by_cid)
    verification = _email_verification(did)

    groups = {
        "consents_to_sign": consents,
        "review_invitations": invitations,
        "author_replies": replies,
        "moderation_outcomes": outcomes,
        "scan_holds": scan_holds,
        "appeal_panels": panels,
        "email_verification": verification,
    }
    flat = [item for kind in ATTENTION_KINDS for item in groups[kind]]

    return {
        "did": did,
        "needs_attention": {
            "count": len(flat),
            **groups,
            "items": flat,
        },
        "my_papers": _my_papers(
            paper_cids, paper_by_cid, versions_by_paper, reviews_by_version
        ),
        "my_reviews": _my_reviews(
            my_review_cids, reviews, responses_by_review, paper_by_cid, version_by_cid
        ),
    }
