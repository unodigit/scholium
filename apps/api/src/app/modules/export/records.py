"""The records the OAI-PMH endpoint disseminates (plugin: export, feature 94).

One OAI-PMH *item* is one listed paper, described by the version
``GET /v1/papers/{id}`` would answer with -- the paper's latest listed version
(:func:`~app.modules.catalog.service.latest_listed_version`).  A version in
``draft``, ``awaiting_consent``, ``scanning``, ``moderation``, ``held`` or
``rejected`` is not part of the public catalog, so it is not part of the
harvest either: harvesting and reading expose the same papers.

Each :class:`ListedPaper` carries everything one Dublin Core record needs:

* the paper's ``sch:`` id and its OAI identifier (``oai:scholium:sch:...``);
* the latest listed version's number, title and abstract, and the version id
  (``sch:xxxx-xxxx-xxxx/vN``) the metadata describes;
* the authors in byline order and the paper's categories;
* the paper's stored status and its notices (a retracted paper says so);
* the version's licence and the instant it was listed, which is the record's
  OAI datestamp.

Only this module reads the database; :mod:`app.modules.export.oai` renders the
rows as XML.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from app import db
from app.modules.catalog.service import resolve
from app.modules.submissions import (
    LISTED,
    Notice,
    Paper,
    PaperVersion,
    authorship_for,
    ensure_tables,
    notices_for_paper,
)

__all__ = [
    "EPOCH",
    "OAI_IDENTIFIER_PREFIX",
    "ListedPaper",
    "find_listed",
    "listed_papers",
    "local_identifier",
]

#: Prefix of an OAI identifier minted by this repository.  The local part is the
#: paper's ``sch:`` id, which is already stable across nodes -- two nodes holding
#: the same paper mint the same identifier, as harvesting expects.
OAI_IDENTIFIER_PREFIX = "oai:scholium:"

#: Stand-in ``earliestDatestamp`` for a node that lists no paper yet.  OAI-PMH
#: requires the element; the epoch is the honest answer for an empty catalog.
EPOCH = datetime(1970, 1, 1)


@dataclass(frozen=True)
class ListedPaper:
    """One listed paper, as the OAI-PMH endpoint disseminates it."""

    paper: Paper
    version: PaperVersion
    authors: tuple[str, ...]
    notices: tuple[Notice, ...]

    @property
    def short_id(self) -> str:
        """The paper's canonical ``sch:xxxx-xxxx-xxxx`` id."""
        return self.paper.short_id

    @property
    def version_id(self) -> str:
        """The ``sch:xxxx-xxxx-xxxx/vN`` id of the version described."""
        return f"{self.paper.short_id}/v{int(self.version.n)}"

    @property
    def identifier(self) -> str:
        """The OAI identifier of the paper."""
        return f"{OAI_IDENTIFIER_PREFIX}{self.paper.short_id}"

    @property
    def datestamp(self) -> datetime:
        """When the paper was (last) listed, in naive UTC.

        A listed version always has ``listed_at`` set (feature 52); the paper's
        own column and the epoch are only fallbacks for rows written before
        that bookkeeping existed.
        """
        moment = self.version.listed_at or self.paper.listed_at or EPOCH
        if moment.tzinfo is not None:
            moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
        return moment


def _listed_paper(paper: Paper, version: PaperVersion) -> ListedPaper:
    authors: tuple[str, ...] = tuple(
        row.author_did for row in authorship_for(version.version_cid)
    )
    return ListedPaper(
        paper=paper,
        version=version,
        authors=authors,
        notices=tuple(notices_for_paper(paper.paper_cid)),
    )


def _latest_listed(paper: Paper, listed: list[PaperVersion]) -> PaperVersion:
    """The version a paper id answers with, given its listed versions.

    The same rule as :func:`~app.modules.catalog.service.latest_listed_version`:
    prefer ``papers.latest_version_cid`` when that version is listed, otherwise
    the highest-numbered listed version.  Applying it here lets one query serve
    the whole harvest instead of one per paper.
    """
    current = paper.latest_version_cid
    if current:
        for version in listed:
            if version.version_cid == current:
                return version
    return max(listed, key=lambda version: int(version.n))


def listed_papers() -> list[ListedPaper]:
    """Every paper with a listed version, newest listing first.

    A paper appears once, described by :func:`_latest_listed`.  The order is the
    paper's listing instant (descending), ties broken by ``sch:`` id, so the
    harvest is stable from one request to the next.
    """
    ensure_tables()
    with db.SessionLocal() as session:
        rows = session.execute(
            select(Paper, PaperVersion)
            .join(PaperVersion, PaperVersion.paper_cid == Paper.paper_cid)
            .where(PaperVersion.state == LISTED)
            .order_by(Paper.paper_cid, PaperVersion.n.desc())
        ).all()

    by_paper: dict[str, list[tuple[Paper, PaperVersion]]] = {}
    for paper, version in rows:
        by_paper.setdefault(paper.paper_cid, []).append((paper, version))

    records = [
        _listed_paper(entries[0][0], _latest_listed(entries[0][0], [v for _, v in entries]))
        for entries in by_paper.values()
    ]
    # Two stable passes: newest first, then ``sch:`` id ascending within a tie.
    records.sort(key=lambda record: record.short_id)
    records.sort(key=lambda record: record.datestamp, reverse=True)
    return records


def local_identifier(identifier: object) -> str:
    """``identifier`` without this repository's OAI prefix.

    ``oai:scholium:sch:...`` becomes ``sch:...`` so the catalog's own resolver
    can interpret it; any other spelling is returned unchanged.
    """
    if not isinstance(identifier, str):
        return ""
    if identifier.startswith(OAI_IDENTIFIER_PREFIX):
        return identifier[len(OAI_IDENTIFIER_PREFIX) :]
    return identifier


def find_listed(identifier: object) -> Optional[ListedPaper]:
    """The listed paper ``identifier`` names, or ``None``.

    Accepts the OAI identifier this endpoint mints and every spelling
    ``GET /v1/papers/{id}`` accepts (``sch:`` id, ``sch:`` version id, version
    cid).  An unlisted paper is indistinguishable from an unknown one, exactly
    as in the catalog: both answer ``None`` and the route reports
    ``idDoesNotExist``.
    """
    view = resolve(local_identifier(identifier))
    if view is None:
        return None
    return _listed_paper(view.paper, view.version)
