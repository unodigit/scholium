"""Resolve a catalog id to a listed paper version.

Feature 79's ``GET /v1/papers/{id}`` accepts three spellings of a paper:

* a paper ``sch:`` id -- ``sch:xxxx-xxxx-xxxx`` -- answered with the paper's
  latest *listed* version;
* a version id -- ``sch:xxxx-xxxx-xxxx/vN`` -- answered with version ``N``;
* a version cid -- the ``paper.version`` record's content id -- answered with
  that record's version.

Only *listed* versions are readable.  A version in ``draft``,
``awaiting_consent``, ``scanning``, ``moderation``, ``held`` or ``rejected``
is not part of the public catalog, so resolving it yields ``None`` and the
router answers ``404`` -- the same answer as an id this node never held, which
is what keeps an unlisted draft indistinguishable from a nonexistent one.

A paper ``sch:`` id is answered with ``papers.latest_version_cid`` (the
version listing last pointed the paper at) when that version is listed, and
otherwise with the highest-numbered listed version.  A paper with no listed
version -- one started but never published, or one whose only version is in
consent -- resolves to ``None``.

The lookups reuse the submissions plugin's own readers
(:func:`~app.modules.submissions.get_paper_by_short_id`,
:func:`~app.modules.submissions.get_version`,
:func:`~app.modules.submissions.versions_for_paper`, ...), so the catalog
reads exactly the rows the submission handlers wrote and never duplicates
their query logic.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Optional

from scholium_record_core import MANIFEST_TYPE, parse_short_id, parse_version_id

from app.modules import ledger
from app.modules.submissions import (
    Paper,
    PaperVersion,
    get_paper,
    get_paper_by_short_id,
    get_version,
    versions_for_paper,
)
from app.modules.submissions.state import LISTED

__all__ = [
    "PaperView",
    "VersionTimeline",
    "latest_listed_version",
    "listed_version_n",
    "listed_versions",
    "manifest_entries",
    "pick_listed_version",
    "resolve",
    "resolve_timeline",
    "resolve_version",
]


@dataclass(frozen=True)
class PaperView:
    """A listed paper and the version a response describes."""

    paper: Paper
    version: PaperVersion


@dataclass(frozen=True)
class VersionTimeline:
    """A paper and its listed versions, oldest first (never empty)."""

    paper: Paper
    versions: list[PaperVersion]


def listed_version_n(paper_cid: object, n: int) -> Optional[PaperVersion]:
    """Return version ``n`` of ``paper_cid`` when it is listed, else ``None``."""
    if not isinstance(paper_cid, str) or not paper_cid or isinstance(n, bool):
        return None
    for version in versions_for_paper(paper_cid):
        if int(version.n) == n:
            return version if version.state == LISTED else None
    return None


def pick_listed_version(
    latest_version_cid: Optional[str], listed: Sequence[PaperVersion]
) -> Optional[PaperVersion]:
    """Pick the version a paper is shown as from its *listed* versions.

    Prefers ``latest_version_cid`` (``papers.latest_version_cid``, the
    bookkeeping listing maintains) when that version is among ``listed``, then
    falls back to the highest-numbered one -- so a paper whose newest version
    was held still shows its most recent published one.  ``None`` when
    ``listed`` is empty.

    Both ``GET /v1/papers/{id}`` and the ``GET /v1/papers`` listing choose
    through this one rule, so a paper is the same version in both.
    """
    if not listed:
        return None
    if latest_version_cid:
        for version in listed:
            if version.version_cid == latest_version_cid:
                return version
    return max(listed, key=lambda version: int(version.n))


def latest_listed_version(paper: Paper) -> Optional[PaperVersion]:
    """Return the version a paper id should answer with, or ``None``.

    See :func:`pick_listed_version` for the rule.
    """
    if paper is None:
        return None
    listed = [
        version
        for version in versions_for_paper(paper.paper_cid)
        if version.state == LISTED
    ]
    return pick_listed_version(paper.latest_version_cid, listed)


def _resolve_version_id(identifier: str) -> Optional[PaperView]:
    """Resolve ``sch:xxxx-xxxx-xxxx/vN`` to its listed version, or ``None``."""
    version_id = parse_version_id(identifier)  # ValueError when malformed
    paper = get_paper_by_short_id(version_id.short_id)
    if paper is None:
        return None
    version = listed_version_n(paper.paper_cid, version_id.version)
    return None if version is None else PaperView(paper, version)


def _resolve_short_id(identifier: str) -> Optional[PaperView]:
    """Resolve a paper ``sch:`` id to its latest listed version, or ``None``."""
    short_id = parse_short_id(identifier)  # ValueError when malformed
    paper = get_paper_by_short_id(short_id)
    if paper is None:
        return None
    version = latest_listed_version(paper)
    return None if version is None else PaperView(paper, version)


def _resolve_cid(identifier: str) -> Optional[PaperView]:
    """Resolve a version cid (or paper genesis cid) to a listed version, or ``None``."""
    version = get_version(identifier)
    if version is not None:
        if version.state != LISTED:
            return None
        paper = get_paper(version.paper_cid)
        return None if paper is None else PaperView(paper, version)

    # A paper genesis cid is not required by feature 79, but reading a paper by
    # the cid that created it is the same lookup by another name.
    paper = get_paper(identifier)
    if paper is None:
        return None
    latest = latest_listed_version(paper)
    return None if latest is None else PaperView(paper, latest)


def resolve(identifier: object) -> Optional[PaperView]:
    """Resolve any of the ids feature 79 accepts to a listed paper version.

    Returns ``None`` for a malformed id, an id this node does not hold, an
    unlisted version, or a paper with no listed version -- every case the
    route answers with ``404``.
    """
    if not isinstance(identifier, str) or not identifier:
        return None

    # The /vN suffix is only valid on a sch: id, so try the more specific
    # version id first; a failed parse means this spelling is not in play.
    try:
        return _resolve_version_id(identifier)
    except ValueError:
        pass

    try:
        return _resolve_short_id(identifier)
    except ValueError:
        pass

    return _resolve_cid(identifier)


#: A version number as it may appear in ``/v/{n}/``: canonical decimal, no sign,
#: no leading zero, and short enough that no database or parser trips on it.
_VERSION_NUMBER = re.compile(r"[1-9][0-9]{0,8}")


def resolve_version(paper_id: object, n: object) -> Optional[PaperView]:
    """Resolve ``/papers/{paper_id}/v/{n}`` to a listed version, or ``None``.

    ``paper_id`` is a paper ``sch:`` id or the cid of the paper's
    ``paper.genesis`` record; ``n`` is the version number as written in the
    URL.  ``None`` covers every case the route answers with ``404``: a
    malformed id or number, a paper this node does not hold, a version that
    does not exist, and a version that is not listed.
    """
    if not isinstance(paper_id, str) or not paper_id:
        return None
    if not isinstance(n, str) or _VERSION_NUMBER.fullmatch(n) is None:
        return None

    try:
        return _resolve_version_id(f"{paper_id}/v{n}")
    except ValueError:
        pass

    # Not a ``sch:`` id; the genesis cid names the same paper.
    paper = get_paper(paper_id)
    if paper is None:
        return None
    version = listed_version_n(paper.paper_cid, int(n))
    return None if version is None else PaperView(paper, version)


def listed_versions(paper: Paper) -> list[PaperVersion]:
    """Every *listed* version of ``paper``, oldest first.

    A version that is not (or is no longer) listed -- awaiting consent,
    scanning, in moderation, held or rejected -- is not part of the public
    catalog and is left out, so a reader cannot tell it ever existed.
    """
    return [
        version
        for version in versions_for_paper(paper.paper_cid)
        if version.state == LISTED
    ]


def resolve_timeline(paper_id: object) -> Optional[VersionTimeline]:
    """Resolve ``/papers/{paper_id}/versions`` to a paper's listed versions.

    ``paper_id`` is a paper ``sch:`` id or the cid of the paper's
    ``paper.genesis`` record, the two spellings that name a *paper* rather
    than one of its versions.  ``None`` covers every case the route answers
    with ``404``: a malformed id, a paper this node does not hold, and a paper
    with no listed version (an unlisted paper is invisible, exactly like one
    that never existed).
    """
    if not isinstance(paper_id, str) or not paper_id:
        return None

    try:
        paper = get_paper_by_short_id(parse_short_id(paper_id))
    except ValueError:
        # Not a ``sch:`` id; the genesis cid names the same paper.
        paper = get_paper(paper_id)
    if paper is None:
        return None

    versions = listed_versions(paper)
    return VersionTimeline(paper, versions) if versions else None


def manifest_entries(version: PaperVersion) -> Optional[list[Mapping[str, Any]]]:
    """The file entries of ``version``'s signed ``manifest`` record.

    The entries are returned exactly as signed, in manifest order.  ``None``
    means this node holds no usable manifest record for the version: its cid
    is not in the event log, or the record there is not a ``manifest`` whose
    ``files`` is a list of objects.
    """
    entry = ledger.entry_by_cid(version.manifest_cid)
    if entry is None or entry.record_type != MANIFEST_TYPE:
        return None
    body = entry.body
    files = body.get("files") if isinstance(body, Mapping) else None
    if not isinstance(files, list) or not all(isinstance(f, Mapping) for f in files):
        return None
    return list(files)
