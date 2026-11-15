"""A reviewer's history of one paper (plugin: reviews, feature 112).

A reviewer reviews a paper once, but may revise the review against each newer
version: a ``review.formal`` whose ``prev`` is their earlier ``review.formal``
and whose ``target`` is the newer version (see :mod:`app.modules.reviews.reveal`).
``GET /v1/papers/{id}/reviews`` serves the reviewer's reviews as a ``history``,
oldest version first, with the latest as the review's own scores and
recommendation.

The history is read from the signed ``review.formal`` records, not from a table
of its own: the ``review`` row keeps what the commit and first reveal left, and
an update writes nothing.  Every ``review.formal`` signed by one review key on
one paper is one reviewer's chain; ordering it by the version it targets (then
by when it was logged) is the same order the ``prev`` links give, since an
update must target a newer version than the review it names.

The listing is a view *as of* the version it is asked for: a review of a newer
version is not part of the history of an older one, and a version that is not
listed is left out so a reader cannot tell it ever existed.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from app.errors import ProblemException

from .models import Review
from .reveal import review_reveal_fields
from .service import formal_entries

__all__ = ["Revision", "paper_revisions", "review_history"]


@dataclass(frozen=True)
class Revision:
    """One ``review.formal`` of a reviewer's chain, as the log holds it."""

    #: cid of the ``review.formal`` record.
    formal_cid: str
    #: cid of the ``paper.version`` the review is of.
    version_cid: str
    #: That version's number.
    n: int
    #: cid of the review this one updates, or ``None`` for the first.
    prev: Optional[str]
    #: Log position, to order two reviews of the same version.
    seq: int
    #: The record body, as signed.
    body: Mapping[str, Any]
    #: The stored envelope, for reading the review the way a reveal is read.
    record: Mapping[str, Any]


def paper_revisions(versions: Mapping[str, int]) -> dict[str, list[Revision]]:
    """Every ``review.formal`` of ``versions``, grouped by review key.

    ``versions`` maps the cids of the paper versions to look at to their
    numbers.  Each key's chain is ordered oldest version first.
    """
    from app.modules import ledger

    chains: dict[str, list[Revision]] = {}
    for entry in formal_entries():
        body = entry.body if isinstance(entry.body, Mapping) else {}
        target = body.get("target")
        n = versions.get(target) if isinstance(target, str) else None
        if n is None:
            continue
        try:
            record = ledger.stored_envelope(entry).model_dump()
        except Exception:  # an entry that will not decode is not a review to show
            continue
        prev = record.get("prev")
        chains.setdefault(entry.author_did, []).append(
            Revision(
                formal_cid=entry.record_cid,
                version_cid=target,
                n=n,
                prev=prev if isinstance(prev, str) and prev else None,
                seq=entry.seq,
                body=body,
                record=record,
            )
        )
    for chain in chains.values():
        chain.sort(key=lambda revision: (revision.n, revision.seq))
    return chains


def _read(row: Review, revision: Revision) -> Optional[dict[str, Any]]:
    """The review ``revision`` says, as the columns the listing serves, or ``None``.

    The first review is what the ``review`` row holds.  An update is read from
    its record the way a reveal is, so the scores, the verdict and the
    confidence mean the same in both; a record that no longer reads is skipped.
    """
    if revision.prev is None and row.revealed_at is not None and revision.version_cid == row.version_cid:
        return {
            "scores": row.scores,
            "recommendation": row.recommendation,
            "confidence": row.confidence,
            "report_cid": row.report_cid,
            "revealed_at": row.revealed_at,
        }
    try:
        fields = review_reveal_fields(revision.record)
    except ProblemException:
        return None
    return {
        "scores": fields.scores,
        "recommendation": fields.recommendation,
        "confidence": fields.confidence,
        "report_cid": fields.report_cid,
        "revealed_at": fields.revealed_at,
    }


def review_history(
    row: Review, chain: list[Revision], *, report_allowed: bool
) -> list[dict[str, Any]]:
    """``row``'s reviewer's reviews, oldest version first, as the listing serves them.

    ``chain`` is that reviewer's :func:`paper_revisions` entry; ``report_allowed``
    is whether the listing's report gate is open, so a sealed report stays out.
    """
    history: list[dict[str, Any]] = []
    for revision in chain:
        read = _read(row, revision)
        if read is None:
            continue
        revealed_at = read["revealed_at"]
        item: dict[str, Any] = {
            "formal_cid": revision.formal_cid,
            "reveal_cid": revision.formal_cid,
            "id": revision.formal_cid,
            "prev": revision.prev,
            "version_cid": revision.version_cid,
            "versionCid": revision.version_cid,
            "version": revision.n,
            "n": revision.n,
            "revealed_at": revealed_at.isoformat() if revealed_at is not None else None,
            "scores": read["scores"],
            "recommendation": read["recommendation"],
            "confidence": read["confidence"],
            "report_cid": (
                read["report_cid"]
                or revision.body.get("reportCid")
                or revision.body.get("report_cid")
            ),
        }
        report = revision.body.get("report")
        if report_allowed and revealed_at is not None and isinstance(report, str):
            item["report"] = report
        history.append(item)
    return history
