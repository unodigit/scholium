"""Keep ``papers.status`` current from the ledger (plugin: status).

Feature 84: whenever a review, notice or moderation record is appended to the
event log, the status of the paper it is about is recomputed with
:func:`~app.modules.status.compute.compute_status` and saved to
``papers.status``::

    ledger.subscribe("review.formal", on_status_record)       # and the other four
    ...
    recompute_paper_status(paper_cid)                         # what the handler does

The subscription
----------------

:func:`install` subscribes :func:`on_status_record` to each type in
:data:`~app.modules.status.compute.STATUS_RECORD_TYPES` -- ``review.commit``,
``review.formal``, ``retraction``, ``correction`` and ``moderation.decision``
-- the records :func:`compute_status` reads, and no others.  A record outside
that set (``ai.review``, ``withdrawal``, ``discussion.post``...) cannot change
a status, so it is not subscribed to; in particular the advisory AI review never
causes a recompute.  The ledger calls subscribers synchronously, after the
record's row has been committed, so the recompute always sees the record that
triggered it.

Which paper a record is about
-----------------------------

A record belongs to a paper when it says so (``body.paper``) or when its
``body.target`` is the paper (its genesis cid) or one of its versions.  This is
what :func:`record_paper_cid` resolves, and the same rule picks the records a
recompute reads (:func:`paper_records`), so the record that triggers a recompute
is always among the records it reads.  ``body.target`` is consulted first -- the
target is the part the node has already resolved against its own tables -- and
``body.paper`` is the fallback for a record whose target the node cannot place.
A record for no paper this node holds changes nothing.

Notices and moderation decisions that name a *version* still belong to the
paper: status is a property of the paper, so a retraction of version 2 reads the
same through every version id.

Recomputing
-----------

:func:`recompute_paper_status` reads *every* status-relevant record of the paper
from the event log (never just the one that arrived), computes the status and
writes it only when it differs from what ``papers.status`` holds.  Recomputing
from the log, rather than patching the old status with the new record, is what
keeps the saved value a pure function of the records: replaying the log, or
recomputing twice, gives the same answer.  Recomputes are serialised inside the
process, so two records for one paper appended at once cannot leave the older
answer saved.

A handler that fails is logged and skipped by the ledger, and it never rolls
back the log entry; the next record for that paper recomputes from the whole log
and repairs the value.

The subscriber registry is process-global and tests clear it, so :func:`install`
is idempotent and runs both when this package is imported and from its
``on_startup`` hook.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from typing import Any, Optional

from sqlalchemy import or_, select, update

from app import db
from app.modules import ledger
from app.modules.ledger import EventLog
from app.modules.submissions import Paper, PaperVersion

from .compute import STATUS_RECORD_TYPES, StatusResult, explain_status

__all__ = [
    "install",
    "on_status_record",
    "paper_records",
    "record_paper_cid",
    "recompute_paper_status",
    "uninstall",
]

logger = logging.getLogger(__name__)

_PAPER_GENESIS_TYPE = "paper.genesis"
_PAPER_VERSION_TYPE = "paper.version"

#: One recompute at a time: the read of the log and the write of the status are
#: a single step, so the last recompute to run has seen every committed record.
_recompute_lock = threading.RLock()


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


# --------------------------------------------------------------------------- #
# Which paper a record is about
# --------------------------------------------------------------------------- #


def _paper_of_cid(session: Any, cid: Optional[str]) -> Optional[str]:
    """The paper ``cid`` is -- or is a version of -- when this node holds it.

    The tables are consulted first (``papers``, then ``paper_versions``) and the
    event log second, so a node that stores a paper's records without having
    derived its rows still places them.
    """
    if cid is None:
        return None
    if session.get(Paper, cid) is not None:
        return cid
    version = session.get(PaperVersion, cid)
    if version is not None:
        return str(version.paper_cid)

    entry = session.execute(
        select(EventLog.record_type, EventLog.body).where(EventLog.record_cid == cid)
    ).first()
    if entry is None:
        return None
    record_type, body = entry
    if record_type == _PAPER_GENESIS_TYPE:
        return cid
    if record_type == _PAPER_VERSION_TYPE and isinstance(body, Mapping):
        return _text(body.get("paper"))
    return None


def _record_paper_cid(session: Any, body: Any) -> Optional[str]:
    """The cid of the paper a record body is about, or ``None``; see the module docs."""
    if not isinstance(body, Mapping):
        return None
    placed = _paper_of_cid(session, _text(body.get("target")))
    if placed is not None:
        return placed
    named = _text(body.get("paper"))
    if named is not None and session.get(Paper, named) is not None:
        return named
    return None


def record_paper_cid(body: Any) -> Optional[str]:
    """The paper the record whose body is ``body`` is about, or ``None``.

    ``None`` when the body names no paper, or names one this node does not hold.
    """
    with db.SessionLocal() as session:
        return _record_paper_cid(session, body)


# --------------------------------------------------------------------------- #
# The records of one paper
# --------------------------------------------------------------------------- #


def _version_cids(session: Any, paper_cid: str) -> set[str]:
    """Every version of the paper: the ``paper_versions`` rows and the logged records."""
    cids = {
        str(cid)
        for cid in session.execute(
            select(PaperVersion.version_cid).where(PaperVersion.paper_cid == paper_cid)
        ).scalars()
    }
    logged = session.execute(
        select(EventLog.record_cid).where(
            EventLog.record_type == _PAPER_VERSION_TYPE,
            EventLog.body["paper"].as_string() == paper_cid,
        )
    ).scalars()
    cids.update(str(cid) for cid in logged)
    return cids


def paper_records(paper_cid: str) -> list[Any]:
    """The envelopes of every status-relevant record of the paper, oldest first.

    Reads the event log: the review, notice and moderation records whose
    ``body.target`` is the paper or one of its versions, or whose ``body.paper``
    is the paper.  Records of other papers are not returned.
    """
    ledger.ensure_table()
    with db.SessionLocal() as session:
        targets = {paper_cid} | _version_cids(session, paper_cid)
        rows = (
            session.execute(
                select(EventLog)
                .where(
                    EventLog.record_type.in_(sorted(STATUS_RECORD_TYPES)),
                    or_(
                        EventLog.body["target"].as_string().in_(sorted(targets)),
                        EventLog.body["paper"].as_string() == paper_cid,
                    ),
                )
                .order_by(EventLog.seq)
            )
            .scalars()
            .all()
        )
        # ``body.paper`` is a claim; the target, when the node can place it, wins
        # (see the module docs), so keep only what resolves to this paper.
        mine = [row for row in rows if _record_paper_cid(session, row.body) == paper_cid]
        return [ledger.stored_envelope(row) for row in mine]


# --------------------------------------------------------------------------- #
# Recomputing and saving
# --------------------------------------------------------------------------- #


def _save_status(session: Any, paper_cid: str, status: str) -> bool:
    """Set ``papers.status``; ``True`` when the row changed."""
    result = session.execute(
        update(Paper)
        .where(Paper.paper_cid == paper_cid, Paper.status != status)
        .values(status=status)
    )
    session.commit()
    return bool(result.rowcount)


def recompute_paper_status(paper_cid: str) -> Optional[StatusResult]:
    """Recompute a paper's status from its records and save it to ``papers.status``.

    Returns the :class:`~app.modules.status.compute.StatusResult` that was
    saved, or ``None`` when this node holds no paper ``paper_cid`` (there is no
    row to save to).  The status is written only when it changed.
    """
    with _recompute_lock:
        with db.SessionLocal() as session:
            if session.get(Paper, paper_cid) is None:
                return None
        result = explain_status(paper_records(paper_cid))
        with db.SessionLocal() as session:
            changed = _save_status(session, paper_cid, result.status)
        if changed:
            logger.info(
                "paper %s status is now %s (rule %s)", paper_cid, result.status, result.rule
            )
        return result


# --------------------------------------------------------------------------- #
# The subscription
# --------------------------------------------------------------------------- #


def on_status_record(entry: Any) -> None:
    """Ledger subscriber: recompute the status of the paper ``entry`` is about."""
    with db.SessionLocal() as session:
        paper_cid = _record_paper_cid(session, entry.body)
    if paper_cid is None:
        logger.debug(
            "%s %s names no paper this node holds; no status to recompute",
            entry.record_type,
            entry.record_cid,
        )
        return
    recompute_paper_status(paper_cid)


def install() -> None:
    """Subscribe :func:`on_status_record` to every status-relevant record type (idempotent)."""
    for record_type in sorted(STATUS_RECORD_TYPES):
        ledger.subscribe(record_type, on_status_record)


def uninstall() -> None:
    """Remove the subscriptions.  Intended for tests."""
    for record_type in sorted(STATUS_RECORD_TYPES):
        ledger.unsubscribe(record_type, on_status_record)
