"""HTTP routes for reading one paper (plugin: catalog, features 79 and 81).

The module loader mounts ``router`` under ``/v1``, so this package serves::

    GET /v1/papers/{id}
    GET /v1/papers/{id}/v/{n}/manifest

``{id}`` is any of the spellings a reader may hold for a paper:

* ``sch:xxxx-xxxx-xxxx`` -- the paper's short id; the response describes its
  latest listed version;
* ``sch:xxxx-xxxx-xxxx/vN`` -- version ``N`` of that paper;
* a version cid -- the ``paper.version`` record whose content that cid names.

The response carries what a reader sees on the paper page::

    {
      "paper": "sch:xxxx-xxxx-xxxx",
      "shortId": "sch:xxxx-xxxx-xxxx",
      "paperCid": "bafyrei...",          # cid of the paper.genesis record
      "versionCid": "bafyrei...",        # cid of the version described
      "cid": "bafyrei...",
      "n": 2,
      "version": 2,
      "title": "...",
      "abstract": "...",
      "authors": [
        {"did": "did:key:z6Mk...", "author": "did:key:z6Mk...",
         "position": 1, "creditRoles": ["Conceptualization"]}
      ],
      "categories": ["cs.CR"],
      "licence": "CC-BY-4.0",
      "status": "preprint",
      "notices": [
        {"id": "bafyrei...", "kind": "correction", "reason": "...",
         "createdAt": "2026-01-01T00:00:00"}
      ]
    }

``authors`` is in byline order and ``notices`` is oldest first, the same
order :mod:`app.modules.submissions` serves them in.  ``status`` is the
paper's stored status (feature 84 keeps it current); ``licence`` is the
licence the *signed version* names, so a revised version can change it.

An unlisted version is not in the public catalog: a malformed id, an id this
node does not hold, a version in draft/awaiting_consent/scanning/moderation/
held/rejected, and a paper with no listed version all answer ``404`` problem
details with the same message.  Reading is public, like reading a record.

Feature 81 -- the file manifest of one version
----------------------------------------------

``GET /v1/papers/{id}/v/{n}/manifest`` lists the files of version ``n`` of the
paper ``{id}`` (a paper ``sch:`` id, or the cid of its ``paper.genesis``
record), in the order the signed ``manifest`` record lists them::

    {
      "paper": "sch:xxxx-xxxx-xxxx",
      "shortId": "sch:xxxx-xxxx-xxxx",
      "versionCid": "bafyrei...",
      "n": 2,
      "version": 2,
      "manifestCid": "bafyrei...",       # cid of the signed manifest record
      "licence": "CC-BY-4.0",
      "files": [
        {"path": "paper.pdf", "cid": "bafkrei...", "size": 1048576,
         "mediaType": "application/pdf", "role": "manuscript",
         "licence": "CC-BY-4.0", "scanStatus": "passed", "scan_status": "passed"}
      ]
    }

``path``, ``cid``, ``size``, ``mediaType`` and ``role`` are the signed values.
A file carries no licence of its own: ``licence`` is the licence the signed
*version* names, repeated on each file so a client can show or filter it
there.  ``scanStatus`` (also spelled ``scan_status``, the name of the
``blobs`` column) is the sanitizer's verdict on the file's bytes
(``scanning``, ``passed`` or ``failed``), read live from the content store, so
it changes as scanning completes; a listed version's files have normally all
passed.  A file the content store holds no row for reads ``missing``.  Only
``passed`` bytes are served by ``GET /v1/content/{cid}``.

The same visibility rule as feature 79 applies: a malformed id or version
number, an id this node does not hold, a version that does not exist and a
version that is not listed all answer ``404`` with the same message.  So does
a listed version whose ``manifest`` record this node does not hold.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from app.modules import content
from app.modules.submissions import (
    Authorship,
    Notice,
    authorship_for,
    notices_for_paper,
)

from . import service

__all__ = [
    "AuthorOut",
    "ManifestFileOut",
    "ManifestOut",
    "NoticeOut",
    "PaperOut",
    "SCAN_MISSING",
    "router",
]

#: ``scanStatus`` of a manifest file the content store holds no ``blobs`` row for.
SCAN_MISSING = "missing"

#: Router the module loader mounts under ``/v1``.
router = APIRouter(tags=["catalog"])


class AuthorOut(BaseModel):
    """One author of the version, in byline order."""

    model_config = ConfigDict(extra="allow")

    #: The author's ``did:`` identifier.
    did: str
    #: Alias of ``did`` for clients that name the author ``author``.
    author: str
    #: 1-based byline position.
    position: int
    #: CRediT roles the signed version names, or ``null`` when it names none.
    creditRoles: Optional[list[str]] = None


class NoticeOut(BaseModel):
    """One withdrawal, correction or retraction notice shown on the paper."""

    model_config = ConfigDict(extra="allow")

    #: cid of the notice record.
    id: str
    #: ``withdrawal``, ``correction`` or ``retraction``.
    kind: str
    #: The reason readers are shown.
    reason: str
    #: The instant the signed record is dated (UTC).
    createdAt: Optional[datetime] = None


class PaperOut(BaseModel):
    """The response body of ``GET /v1/papers/{id}``."""

    model_config = ConfigDict(extra="forbid")

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: Alias of ``paper``.
    shortId: str
    #: cid of the paper's ``paper.genesis`` record.
    paperCid: str
    #: cid of the ``paper.version`` record described.
    versionCid: str
    #: Alias of ``versionCid``.
    cid: str
    #: Version number (1-based).
    n: int
    #: Alias of ``n``; the version number the response describes.
    version: int
    #: The version's title.
    title: str
    #: The version's abstract.
    abstract: str
    #: The version's authors, in byline order.
    authors: list[AuthorOut]
    #: The paper's categories.
    categories: list[str]
    #: The licence the signed version names.
    licence: str
    #: The paper's stored status (``preprint``, ``reviewed``, ``retracted``, ...).
    status: str
    #: Notices on the paper, oldest first; empty when there are none.
    notices: list[NoticeOut]


def _not_found(identifier: str):
    """A ``404`` problem response for an id with no listed paper behind it.

    Imported at raise time, not module load: importing ``app.errors`` pulls in
    ``app.main``, and doing that while the module loader is importing packages
    would leave this package half-initialized without a ``router`` attribute
    (the same care ``content.router``, ``annotations.router`` and
    ``ledger.records`` take).
    """
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No listed paper {identifier!r} is on this node.",
    )


def _author_out(row: Authorship) -> AuthorOut:
    roles = list(row.credit_roles) if row.credit_roles is not None else None
    return AuthorOut(
        did=row.author_did,
        author=row.author_did,
        position=int(row.position),
        creditRoles=roles,
    )


def _notice_out(row: Notice) -> NoticeOut:
    return NoticeOut(
        id=row.record_cid,
        kind=row.kind,
        reason=row.reason,
        createdAt=row.created_at,
    )


def _paper_out(view: service.PaperView) -> PaperOut:
    """Render the paper/version pair as the wire response."""
    paper = view.paper
    version = view.version
    return PaperOut(
        paper=paper.short_id,
        shortId=paper.short_id,
        paperCid=paper.paper_cid,
        versionCid=version.version_cid,
        cid=version.version_cid,
        n=int(version.n),
        version=int(version.n),
        title=version.title,
        abstract=version.abstract,
        authors=[_author_out(row) for row in authorship_for(version.version_cid)],
        categories=list(paper.categories or []),
        licence=version.licence,
        status=paper.status or "preprint",
        notices=[_notice_out(row) for row in notices_for_paper(paper.paper_cid)],
    )


@router.get(
    "/papers/{paper_id}/v{n}",
    response_model=PaperOut,
    summary="Read one listed version of a paper by its version id",
)
def get_paper_version(paper_id: str, n: str) -> PaperOut:
    """Return version ``n`` of paper ``paper_id`` when it is listed."""
    return _get(f"{paper_id}/v{n}")


@router.get(
    "/papers/{paper_id}",
    response_model=PaperOut,
    summary="Read a listed paper (or one version of it) by id",
)
def get_paper(paper_id: str) -> PaperOut:
    """Return the paper's latest listed version, or the one the id names."""
    return _get(paper_id)


def _get(identifier: str) -> PaperOut:
    """Resolve ``identifier`` and render it, or raise ``404``."""
    view = service.resolve(identifier)
    if view is None:
        raise _not_found(identifier)
    return _paper_out(view)


class ManifestFileOut(BaseModel):
    """One file of a version, as the signed manifest lists it."""

    model_config = ConfigDict(extra="forbid")

    #: The file's path inside the bundle.
    path: str
    #: The file's raw-codec cid (``GET /v1/content/{cid}`` serves its bytes).
    cid: str
    #: The file's exact length in bytes.
    size: int
    #: The bare ``type/subtype`` the signed manifest declares.
    mediaType: str
    #: What the file is for: ``manuscript``, ``source``, ``figure``, ...
    role: str
    #: The licence the signed version names (files carry none of their own).
    licence: str
    #: The sanitizer's verdict: ``scanning``, ``passed``, ``failed`` or ``missing``.
    scanStatus: str
    #: Alias of ``scanStatus`` under the stored column's name.
    scan_status: str


class ManifestOut(BaseModel):
    """The response body of ``GET /v1/papers/{id}/v/{n}/manifest``."""

    model_config = ConfigDict(extra="forbid")

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: Alias of ``paper``.
    shortId: str
    #: cid of the ``paper.version`` record whose files these are.
    versionCid: str
    #: Version number (1-based).
    n: int
    #: Alias of ``n``.
    version: int
    #: cid of the signed ``manifest`` record.
    manifestCid: str
    #: The licence the signed version names.
    licence: str
    #: The version's files, in signed manifest order.
    files: list[ManifestFileOut]


def _scan_status(cid: str) -> str:
    """The sanitizer's verdict on ``cid``'s bytes, or ``missing`` without a row."""
    blob = content.get_blob(cid)
    return SCAN_MISSING if blob is None else blob.scan_status


def _file_out(entry: Mapping[str, Any], licence: str) -> ManifestFileOut:
    """Render one signed manifest entry with the version's licence and live scan."""
    scan_status = _scan_status(entry["cid"])
    return ManifestFileOut(
        path=entry["path"],
        cid=entry["cid"],
        size=entry["size"],
        mediaType=entry["mediaType"],
        role=entry["role"],
        licence=licence,
        scanStatus=scan_status,
        scan_status=scan_status,
    )


def _manifest_out(view: service.PaperView, files: list) -> ManifestOut:
    """Render the version and its signed file entries as the wire response."""
    paper = view.paper
    version = view.version
    return ManifestOut(
        paper=paper.short_id,
        shortId=paper.short_id,
        versionCid=version.version_cid,
        n=int(version.n),
        version=int(version.n),
        manifestCid=version.manifest_cid,
        licence=version.licence,
        files=[_file_out(entry, version.licence) for entry in files],
    )


@router.get(
    "/papers/{paper_id}/v/{n}/manifest",
    response_model=ManifestOut,
    summary="List the files of one listed version of a paper",
)
def get_version_manifest(paper_id: str, n: str) -> ManifestOut:
    """Return the files of version ``n`` of paper ``paper_id`` when it is listed."""
    view = service.resolve_version(paper_id, n)
    files = None if view is None else service.manifest_entries(view.version)
    if view is None or files is None:
        raise _not_found(f"{paper_id}/v/{n}")
    return _manifest_out(view, files)
