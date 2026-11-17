"""What a stored blob is called, and which listed versions sign it.

``GET /v1/content/{cid}`` serves the bytes of a file, but the bytes alone do
not say what the file *is*: a browser asked for a bare cid saves it under that
cid with no extension, and the ``blobs`` row only carries the uploader's media
type hint, which may be absent.  The signed ``manifest`` record is the source
of truth: it names the file's ``path``, its ``mediaType`` and its ``role``.

This module reads that answer from the content-reference index
(:mod:`app.modules.content.refs`), which already records which manifests list
a cid, and from the submissions tables, which record the versions that name a
manifest.  Two callers use it:

* :func:`download_reference` -- the best file entry for a download: prefer a
  version that is ``listed`` (public), otherwise any referencing version the
  caller was already allowed to read.  Its file name and media type are what
  the download response declares;
* :func:`listed_versions` -- the public versions whose manifest names the
  blob, for ``GET /v1/content/{cid}/versions`` and the ``/verify`` page.  Only
  listed versions are returned, so an unlisted paper is exactly as invisible
  here as it is in the catalog.

Nothing in this module decides *whether* a caller may read the bytes; that is
:func:`app.modules.content.visibility.may_read`, applied by the router before
either function is consulted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy import or_

from app import db

from . import refs
from .errors import InvalidMediaType
from .refs import ContentRef
from .service import normalize_media_type

__all__ = [
    "ContentVersion",
    "download_reference",
    "listed_versions",
    "references",
]


@dataclass(frozen=True)
class ContentVersion:
    """One version whose manifest names a blob, and the entry that names it."""

    #: Canonical paper id (``sch:xxxx-xxxx-xxxx``).
    paper_short_id: str
    #: cid of the paper's ``paper.genesis`` record.
    paper_cid: str
    #: cid of the ``paper.version`` record.
    version_cid: str
    #: 1-based version number.
    n: int
    #: The version's title.
    title: str
    #: The file's signed path inside the bundle (``figures/fig1.svg``).
    path: str
    #: The last path segment: what a browser saves the file as.
    file_name: str
    #: The signed bare ``type/subtype``, when the manifest names one.
    media_type: Optional[str]
    #: What the file is for: ``manuscript``, ``source``, ``code``, ``data``…
    role: str
    #: Whether this version is ``listed`` (public).
    listed: bool


def _file_name(path: str) -> str:
    """The last path segment of a manifest path (never empty)."""
    name = path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return name or "download"


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() != "" else None


def _media_type(value: Any) -> Optional[str]:
    """A stored signed media type, reduced to the bare form the store keeps."""
    declared = _text(value)
    if declared is None:
        return None
    try:
        return normalize_media_type(declared)
    except InvalidMediaType:
        # A malformed signed hint is no hint; the store's own value or the
        # octet-stream fallback is safer than echoing it back as a header.
        return None


def references(cid: str) -> list[ContentVersion]:
    """Every version whose manifest names ``cid``, newest listing first.

    The answer is ordered for presentation: listed versions first, then by
    paper id and version number, so a caller that only shows the first row
    shows a public one whenever a public one exists.

    The reference index carries the entry's ``path``, ``mediaType`` and
    ``role`` (see :mod:`app.modules.content.refs`), so this reads no ledger
    body: a download costs the same however large the node's log is.
    """
    if not isinstance(cid, str) or not cid:
        return []

    # Imports at call time: submissions imports this package.
    from app.modules.submissions.models import Paper, PaperVersion
    from app.modules.submissions.state import LISTED

    refs.sync()
    with db.SessionLocal() as session:
        by_manifest: dict[str, dict[str, Any]] = {}
        for row in session.query(ContentRef).filter(ContentRef.content_cid == cid):
            by_manifest.setdefault(
                row.manifest_cid,
                {
                    "path": row.path,
                    "media_type": row.media_type,
                    "role": row.role,
                },
            )
        if not by_manifest:
            return []

        manifest_cids = list(by_manifest)
        rows = (
            session.query(PaperVersion, Paper)
            .join(Paper, Paper.paper_cid == PaperVersion.paper_cid)
            .filter(
                or_(
                    PaperVersion.manifest_cid.in_(manifest_cids),
                    PaperVersion.version_cid.in_(manifest_cids),
                )
            )
            .all()
        )

    found: list[ContentVersion] = []
    for version, paper in rows:
        # A separate manifest record, or the version record itself when the
        # manifest is inline; both are keys in the reference index.
        entry = by_manifest.get(version.manifest_cid) or by_manifest.get(
            version.version_cid
        )
        if entry is None:
            continue
        path = _text(entry["path"])
        if path is None:
            continue
        found.append(
            ContentVersion(
                paper_short_id=paper.short_id,
                paper_cid=paper.paper_cid,
                version_cid=version.version_cid,
                n=int(version.n),
                title=version.title,
                path=path,
                file_name=_file_name(path),
                media_type=_media_type(entry["media_type"]),
                role=_text(entry["role"]) or "other",
                listed=version.state == LISTED,
            )
        )

    found.sort(key=lambda row: (not row.listed, row.paper_short_id, row.n))
    return found


def listed_versions(cid: str) -> list[ContentVersion]:
    """The public (listed) versions whose manifest names ``cid``."""
    return [row for row in references(cid) if row.listed]


def download_reference(cid: str) -> Optional[ContentVersion]:
    """The file entry a download of ``cid`` should be named and typed from.

    A listed version wins (its manifest is public); otherwise the first
    referencing version is used, which the router has already checked the
    caller may read.  ``None`` when no manifest names the blob at all.
    """
    rows = references(cid)
    return rows[0] if rows else None
