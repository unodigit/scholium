"""The catalog listing behind ``GET /v1/papers`` (plugin: catalog, feature 82).

:func:`list_papers` answers one page of the public catalog: the papers that
have at least one *listed* version, narrowed by a ``tab`` and a ``category``
and put in the order a ``sort`` names.

Tabs
----

``latest``
    Every listed paper.
``reviewed``
    The listed papers whose stored status (``papers.status``) is ``reviewed``.
    The status plugin keeps that column current (feature 84); this module only
    reads it.

(``following`` belongs to the follows plugin, feature 179.)

Sorts
-----

Every sort is newest-first and breaks ties on the paper's cid, so the order is
total and a page boundary can never fall between two papers that tie.

``newest``
    By the instant the paper first appeared in the catalog: the earliest
    ``listed_at`` among its currently listed versions.
``recently_updated``
    By the instant a version of the paper was most recently listed: the latest
    ``listed_at`` among its listed versions.  A paper whose version 2 was
    listed yesterday outranks one first published an hour ago.
``recently_reviewed``
    By the instant the node received the paper's newest revealed review -- the
    newest ``review.formal`` record in the event log whose ``target`` is the
    paper, one of its versions, or its ``sch:`` id.  A sealed ``review.commit``
    is not a review a reader can read, so it does not count.  Papers with no
    revealed review follow the reviewed ones, newest-first.

Cursor pagination
-----------------

The cursor is *keyset*, not an offset: it names the sort key of the last paper
on the page (and the sort it belongs to), and the next page is every paper that
sorts strictly after that key.  A paper listed, held or reviewed between two
requests therefore shifts nothing -- no paper is repeated or skipped because of
a change elsewhere in the list -- and the cursor stays valid under any
``tab``/``category`` the client chooses.  It is opaque (URL-safe base64 of a
small JSON document); a client passes it back unchanged.

The page is computed from the lightweight columns of every candidate paper
(cid, short id, status, categories and two timestamps), then only the page's
own versions and authors are read in full.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import func, select

from app import db
from app.modules.ledger import EventLog, ensure_table as ensure_event_log
from app.modules.submissions import PaperVersion, ensure_tables
from app.modules.submissions.models import Paper
from app.modules.submissions.state import LISTED

from .service import pick_listed_version

__all__ = [
    "CatalogEntry",
    "CatalogPage",
    "DEFAULT_LIMIT",
    "InvalidCursor",
    "MAX_LIMIT",
    "REVIEWED_STATUS",
    "SORTS",
    "TABS",
    "list_papers",
]

#: A page holds this many papers when the client names no ``limit``.
DEFAULT_LIMIT = 20
#: The most papers one page may hold.
MAX_LIMIT = 100

#: The ``tab`` values this plugin serves.
TABS: tuple[str, ...] = ("latest", "reviewed")
#: The ``sort`` values this plugin serves.
SORTS: tuple[str, ...] = ("newest", "recently_reviewed", "recently_updated")

#: ``papers.status`` of a paper the ``reviewed`` tab lists.
REVIEWED_STATUS = "reviewed"
#: The ledger record type of a revealed review.
_REVIEW_FORMAL_TYPE = "review.formal"

#: Stands in for a missing timestamp so keys stay comparable strings.
_NEVER = datetime(1970, 1, 1)


class InvalidCursor(ValueError):
    """The ``cursor`` is not one this listing handed out for this ``sort``."""


@dataclass(frozen=True)
class CatalogEntry:
    """One paper of a page, with the listed version it is shown as."""

    paper: Paper
    #: The listed version shown (see :func:`~.service.pick_listed_version`).
    version: PaperVersion
    #: When the paper first appeared in the catalog.
    listed_at: Optional[datetime]
    #: When a version of the paper was most recently listed.
    updated_at: Optional[datetime]


@dataclass(frozen=True)
class CatalogPage:
    """One page of the catalog."""

    entries: list[CatalogEntry]
    #: Pass as ``cursor`` for the next page; ``None`` on the last page.
    next_cursor: Optional[str]


@dataclass(frozen=True)
class _Candidate:
    """A listed paper's light columns: all a sort and a filter need."""

    paper_cid: str
    first_listed: Optional[datetime]
    last_listed: Optional[datetime]
    reviewed_at: Optional[datetime] = None


# --------------------------------------------------------------------------- #
# Cursor
# --------------------------------------------------------------------------- #

#: Characters of cursor text accepted before decoding is even attempted.
_MAX_CURSOR_CHARS = 512
#: How many parts the sort key of each sort has (see :func:`_sort_key`).
_KEY_PARTS = {"newest": 2, "recently_updated": 2, "recently_reviewed": 3}


def _stamp(moment: Optional[datetime]) -> str:
    """``moment`` as a fixed-width UTC string that sorts like the instant."""
    if moment is None:
        moment = _NEVER
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment.isoformat(timespec="microseconds")


def _sort_key(sort: str, candidate: _Candidate) -> tuple[str, ...]:
    """The key ``candidate`` sorts under; larger keys come first."""
    cid = candidate.paper_cid
    if sort == "recently_updated":
        return (_stamp(candidate.last_listed), cid)
    if sort == "recently_reviewed":
        # Unreviewed papers carry the empty stamp, so every reviewed paper
        # outranks them, and they fall back to newest-first among themselves.
        reviewed = (
            "" if candidate.reviewed_at is None else _stamp(candidate.reviewed_at)
        )
        return (reviewed, _stamp(candidate.first_listed), cid)
    return (_stamp(candidate.first_listed), cid)


def _encode_cursor(sort: str, key: tuple[str, ...]) -> str:
    raw = json.dumps({"v": 1, "sort": sort, "key": list(key)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str, sort: str) -> tuple[str, ...]:
    """The sort key ``cursor`` names, or :class:`InvalidCursor`."""
    if len(cursor) > _MAX_CURSOR_CHARS:
        raise InvalidCursor("The cursor is not valid.")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, binascii.Error, UnicodeError):
        raise InvalidCursor("The cursor is not valid.") from None
    key = payload.get("key") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("v") != 1
        or not isinstance(key, list)
        or not key
        or not all(isinstance(part, str) for part in key)
    ):
        raise InvalidCursor("The cursor is not valid.")
    if payload.get("sort") != sort:
        raise InvalidCursor(f"The cursor was issued for another sort than {sort!r}.")
    if len(key) != _KEY_PARTS[sort]:
        raise InvalidCursor("The cursor is not valid.")
    return tuple(key)


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def _as_datetime(value: Any) -> Optional[datetime]:
    """A database timestamp as a ``datetime`` (raw aggregates may be strings)."""
    if value is None or isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _category_list(value: Any) -> list[str]:
    """``papers.categories`` as a list of strings, whatever way it was stored."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _candidates(tab: str, category: Optional[str]) -> list[_Candidate]:
    """Every listed paper the ``tab`` and ``category`` admit, in no order."""
    ensure_tables()
    listed = (
        select(
            PaperVersion.paper_cid.label("paper_cid"),
            func.min(PaperVersion.listed_at).label("first_listed"),
            func.max(PaperVersion.listed_at).label("last_listed"),
        )
        .where(PaperVersion.state == LISTED)
        .group_by(PaperVersion.paper_cid)
        .subquery()
    )
    statement = select(
        Paper.paper_cid,
        Paper.categories,
        listed.c.first_listed,
        listed.c.last_listed,
    ).join(listed, listed.c.paper_cid == Paper.paper_cid)
    if tab == "reviewed":
        statement = statement.where(Paper.status == REVIEWED_STATUS)

    with db.SessionLocal() as session:
        rows = session.execute(statement).all()
    return [
        _Candidate(
            paper_cid=row.paper_cid,
            first_listed=_as_datetime(row.first_listed),
            last_listed=_as_datetime(row.last_listed),
        )
        for row in rows
        if category is None or category in _category_list(row.categories)
    ]


def _review_instants(candidates: Iterable[_Candidate]) -> dict[str, datetime]:
    """``{paper_cid: when the node received its newest revealed review}``."""
    wanted = {candidate.paper_cid for candidate in candidates}
    if not wanted:
        return {}

    # A review names its target by version cid, paper cid, ``sch:`` id or
    # ``sch:`` version id; resolve every spelling to the paper.
    # (Filtered here rather than with ``IN (...)``: every candidate may be
    # wanted, which would exceed the database's bound-parameter limit.)
    owner: dict[str, str] = {cid: cid for cid in wanted}
    with db.SessionLocal() as session:
        for paper_cid, short_id in session.execute(
            select(Paper.paper_cid, Paper.short_id)
        ):
            if paper_cid in wanted:
                owner[short_id] = paper_cid
        for version_cid, paper_cid in session.execute(
            select(PaperVersion.version_cid, PaperVersion.paper_cid)
        ):
            if paper_cid in wanted:
                owner[version_cid] = paper_cid

    ensure_event_log()
    newest: dict[str, datetime] = {}
    with db.SessionLocal() as session:
        reviews = session.execute(
            select(EventLog.body, EventLog.received_at).where(
                EventLog.record_type == _REVIEW_FORMAL_TYPE
            )
        )
        for body, received_at in reviews:
            target = body.get("target") if isinstance(body, Mapping) else None
            if not isinstance(target, str):
                continue
            paper_cid = owner.get(target) or owner.get(target.split("/", 1)[0])
            if paper_cid is None or received_at is None:
                continue
            if paper_cid not in newest or received_at > newest[paper_cid]:
                newest[paper_cid] = received_at
    return newest


def _entries(page: list[_Candidate]) -> list[CatalogEntry]:
    """Read the papers and listed versions of one page of candidates."""
    if not page:
        return []
    cids = [candidate.paper_cid for candidate in page]
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        papers = {
            paper.paper_cid: paper
            for paper in session.execute(
                select(Paper).where(Paper.paper_cid.in_(cids))
            ).scalars()
        }
        listed: dict[str, list[PaperVersion]] = {}
        for version in session.execute(
            select(PaperVersion).where(
                PaperVersion.paper_cid.in_(cids), PaperVersion.state == LISTED
            )
        ).scalars():
            listed.setdefault(version.paper_cid, []).append(version)
        session.expunge_all()

    entries: list[CatalogEntry] = []
    for candidate in page:
        paper = papers.get(candidate.paper_cid)
        version = (
            None
            if paper is None
            else pick_listed_version(
                paper.latest_version_cid, listed.get(candidate.paper_cid, ())
            )
        )
        if paper is None or version is None:
            # Held or deleted between the candidate query and this read.
            continue
        entries.append(
            CatalogEntry(
                paper=paper,
                version=version,
                listed_at=candidate.first_listed,
                updated_at=candidate.last_listed,
            )
        )
    return entries


def list_papers(
    *,
    tab: str = "latest",
    category: Optional[str] = None,
    sort: str = "newest",
    cursor: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
) -> CatalogPage:
    """One page of the public catalog.

    ``tab`` is one of :data:`TABS`, ``sort`` one of :data:`SORTS`, ``category``
    an exact category (``cs.AI``) or ``None``, ``cursor`` a ``next_cursor`` an
    earlier page of the *same sort* returned, and ``limit`` the page size
    (clamped to ``1..MAX_LIMIT``).

    Raises:
        ValueError: ``tab`` or ``sort`` is not one of the served values.
        InvalidCursor: ``cursor`` was not issued by this listing for ``sort``.
    """
    if tab not in TABS:
        raise ValueError(f"unknown tab {tab!r}")
    if sort not in SORTS:
        raise ValueError(f"unknown sort {sort!r}")
    after = _decode_cursor(cursor, sort) if cursor else None
    limit = max(1, min(int(limit), MAX_LIMIT))

    candidates = _candidates(tab, category)
    if sort == "recently_reviewed":
        reviewed = _review_instants(candidates)
        candidates = [
            _Candidate(
                c.paper_cid, c.first_listed, c.last_listed, reviewed.get(c.paper_cid)
            )
            for c in candidates
        ]

    keyed = sorted(
        ((_sort_key(sort, candidate), candidate) for candidate in candidates),
        key=lambda pair: pair[0],
        reverse=True,
    )
    if after is not None:
        keyed = [pair for pair in keyed if pair[0] < after]

    window = keyed[:limit]
    more = len(keyed) > limit
    next_cursor = _encode_cursor(sort, window[-1][0]) if more and window else None
    return CatalogPage(
        entries=_entries([candidate for _, candidate in window]),
        next_cursor=next_cursor,
    )
