"""Conflict-of-interest check for the calling reviewer (plugin: reviews, feature 106).

``GET /v1/papers/{id}/coi-check`` answers one question for the caller: *may I
review this paper without a conflict?*  It runs three checks, in the order the
review form shows them (``docs/design.md`` 5.5):

``not_author``
    The caller is not an author of the paper -- not the signer of its genesis
    or of any version, and not listed on any version's byline.  Declined
    co-authors still count: they were named on the paper.

``no_recent_coauthorship``
    The caller has not co-authored anything with an author of this paper in the
    last :data:`COI_WINDOW_YEARS` years.  Two DIDs co-authored a version when
    both are on its ``authorship`` rows; a version whose author declined
    authorship, or that was rejected, is not a co-authored work.  The date of a
    co-authored version is when it was listed, else when this node received its
    record.  A co-authored version with no date at all counts as recent: an
    unprovable "no conflict" must not read as a pass.

``different_institution``
    The caller's saved affiliation differs from every author's.  Affiliations
    live in the encrypted ``profile`` blobs, so they are compared after
    normalisation (case, punctuation and spacing are ignored); abbreviations
    are *not* expanded.  A caller with no readable affiliation gets
    ``unknown``: the node cannot claim a difference it cannot see.  An author
    with no readable affiliation cannot be shown to share the caller's, so
    they do not fail the check.

Each check carries a ``status`` -- ``pass``, ``fail`` or ``unknown`` -- and a
short ``detail`` for the form.  ``passed`` is true only for ``pass``, and the
report is ``clear`` only when every check passed.  The report names no other
person and echoes no profile field: it says *whether* there is a conflict, not
whom with.

The check is advisory.  Refusing a co-author's commit is the commit endpoint's
job (feature 107); this module is the shared source for both.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from sqlalchemy import or_, select

from app import db
from app.modules import ledger, submissions
from app.modules.submissions.models import Authorship, PaperVersion, ensure_tables

from . import service

__all__ = [
    "COI_WINDOW_YEARS",
    "CoiCheck",
    "CoiReport",
    "check_conflicts",
    "coauthored_since",
    "different_institution",
    "normalise_institution",
    "paper_author_dids",
]

logger = logging.getLogger(__name__)

#: How far back a shared byline counts as a conflict.
COI_WINDOW_YEARS = 3

PASS = "pass"
FAIL = "fail"
UNKNOWN = "unknown"

NOT_AUTHOR = "not_author"
NO_RECENT_COAUTHORSHIP = "no_recent_coauthorship"
DIFFERENT_INSTITUTION = "different_institution"

#: A version in this state never became a published work, so it is not a
#: co-authored work either.
_REJECTED = "rejected"
#: ``authorship.consent_decision`` of a listed author who refused authorship.
_DECLINED = "decline"


@dataclass(frozen=True)
class CoiCheck:
    """The outcome of one check."""

    id: str
    label: str
    status: str
    detail: str

    @property
    def passed(self) -> bool:
        return self.status == PASS

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "passed": self.passed,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class CoiReport:
    """The three checks for one reviewer on one paper."""

    paper: str
    reviewer: str
    checked_at: datetime
    checks: tuple[CoiCheck, ...]

    @property
    def clear(self) -> bool:
        return all(check.passed for check in self.checks)

    def as_dict(self) -> dict[str, Any]:
        return {
            "paper": self.paper,
            "reviewer": self.reviewer,
            "window_years": COI_WINDOW_YEARS,
            "checked_at": self.checked_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "clear": self.clear,
            "checks": [check.as_dict() for check in self.checks],
        }


# --- who wrote the paper ------------------------------------------------------


def paper_author_dids(paper: Any) -> frozenset[str]:
    """DIDs that count as authors of ``paper``.

    The set :func:`app.modules.submissions.paper_authors` builds -- genesis and
    version signers plus every listed author.  A paper this node knows only
    from the event log (no ``papers`` row) is covered by the ledger scan
    :func:`service._paper_authors_from_ledger` does.
    """
    authors = set(submissions.paper_authors(paper.paper_cid))
    if isinstance(paper, service._PaperRef):
        authors |= {str(did) for did in service._paper_authors_from_ledger(paper.paper_cid)}
    return frozenset(authors)


# --- co-authorship ------------------------------------------------------------


def _years_before(moment: datetime, years: int) -> datetime:
    """``moment`` shifted back ``years`` calendar years (29 Feb becomes 28 Feb)."""
    try:
        return moment.replace(year=moment.year - years)
    except ValueError:
        return moment.replace(year=moment.year - years, day=28)


def _naive_utc(moment: datetime) -> datetime:
    """Timestamps are stored naive in UTC; compare like with like."""
    if moment.tzinfo is not None:
        return moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


def _version_date(version_cid: str, listed_at: Optional[datetime]) -> Optional[datetime]:
    """When ``version_cid`` was published: listed, else received by this node."""
    if listed_at is not None:
        return _naive_utc(listed_at)
    entry = ledger.entry_by_cid(version_cid)
    received = getattr(entry, "received_at", None) if entry is not None else None
    return _naive_utc(received) if received is not None else None


def _not_declined():
    return or_(Authorship.consent_decision.is_(None), Authorship.consent_decision != _DECLINED)


def coauthored_since(reviewer_did: str, author_dids: Iterable[str], since: datetime) -> bool:
    """True when ``reviewer_did`` shares a version byline with any of ``author_dids`` since ``since``."""
    others = {did for did in author_dids if did != reviewer_did}
    if not others:
        return False

    since = _naive_utc(since)
    ensure_tables()
    with db.SessionLocal() as session:
        reviewer_versions = select(Authorship.version_cid).where(
            Authorship.author_did == reviewer_did, _not_declined()
        )
        shared = session.execute(
            select(Authorship.version_cid, PaperVersion.listed_at)
            .join(PaperVersion, PaperVersion.version_cid == Authorship.version_cid)
            .where(
                Authorship.author_did.in_(others),
                _not_declined(),
                Authorship.version_cid.in_(reviewer_versions),
                PaperVersion.state != _REJECTED,
            )
            .distinct()
        ).all()

    for version_cid, listed_at in shared:
        dated = _version_date(version_cid, listed_at)
        if dated is None or dated >= since:
            return True
    return False


# --- institutions -------------------------------------------------------------


def normalise_institution(value: object) -> str:
    """Fold case, punctuation and spacing so ``"MIT."`` and ``" mit "`` compare equal."""
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


def _affiliation(did: str) -> str:
    """The normalised affiliation saved for ``did``; ``""`` when there is none to read.

    Never raises: a profile that cannot be read (never saved, erased, or its
    blob corrupt) must not take the whole check down, and the check treats it
    as "no affiliation on file".
    """
    from app.modules.profiles import read_profile

    try:
        profile = read_profile(did)
    except Exception:
        logger.warning("could not read the profile of %s for a COI check", did, exc_info=True)
        return ""
    return normalise_institution(profile.affiliation) if profile is not None else ""


def different_institution(reviewer_did: str, author_dids: Iterable[str]) -> str:
    """``pass``, ``fail`` or ``unknown`` for the institution check."""
    mine = _affiliation(reviewer_did)
    if not mine:
        return UNKNOWN
    for did in author_dids:
        if did != reviewer_did and _affiliation(did) == mine:
            return FAIL
    return PASS


# --- the report ---------------------------------------------------------------


def check_conflicts(paper: Any, reviewer_did: str, *, now: Optional[datetime] = None) -> CoiReport:
    """Run the three checks for ``reviewer_did`` on ``paper``."""
    moment = _naive_utc(now) if now is not None else datetime.now(timezone.utc).replace(tzinfo=None)
    authors = paper_author_dids(paper)
    since = _years_before(moment, COI_WINDOW_YEARS)

    is_author = reviewer_did in authors
    not_author = CoiCheck(
        id=NOT_AUTHOR,
        label="Not an author of this paper",
        status=FAIL if is_author else PASS,
        detail=(
            "You are an author of this paper."
            if is_author
            else "You are not an author of this paper."
        ),
    )

    coauthored = coauthored_since(reviewer_did, authors, since)
    recent = CoiCheck(
        id=NO_RECENT_COAUTHORSHIP,
        label=f"No co-authorship with any author in the last {COI_WINDOW_YEARS} years",
        status=FAIL if coauthored else PASS,
        detail=(
            f"You share a byline with an author of this paper within the last {COI_WINDOW_YEARS} years."
            if coauthored
            else f"You share no byline with any author of this paper in the last {COI_WINDOW_YEARS} years."
        ),
    )

    institution_status = different_institution(reviewer_did, authors)
    institution = CoiCheck(
        id=DIFFERENT_INSTITUTION,
        label="Different institution from all authors",
        status=institution_status,
        detail={
            PASS: "Your affiliation differs from every author's on file.",
            FAIL: "Your affiliation matches an author of this paper.",
            UNKNOWN: "Save an affiliation on your profile so the node can compare it with the authors'.",
        }[institution_status],
    )

    return CoiReport(
        paper=str(getattr(paper, "short_id", None) or paper.paper_cid),
        reviewer=reviewer_did,
        checked_at=moment,
        checks=(not_author, recent, institution),
    )
