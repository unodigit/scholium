"""HTTP routes for the reading plugin.

The module loader mounts ``router`` under ``/v1``, so this package serves:

* ``GET /v1/papers/{id}/v/{n}/text`` -- return version ``n`` of paper ``id``'s
  paragraphs (``paragraph_id``, ``position`` and ``text``) for the HTML
  reading view.
* ``GET /v1/papers/{id}/compare?from=1&to=2`` -- paragraph-level diff between
  two versions, with added, removed and changed paragraphs plus both change
  notes.

Both answer ``451`` when moderation has tombstoned a version's manuscript PDF
(NET-5), as ``GET /v1/content/{cid}`` does for the file itself; for
``compare``, either side being taken down withholds the diff.

A version that is not ``listed`` yet -- in ``moderation``, say, where the
checks pipeline has already extracted its paragraphs -- is pre-listing
content: the text (and, on ``compare``, either side's text) is served only to
that version's authors and to moderators (tier 4), the rule
``GET /v1/content/{cid}`` applies to the unlisted bytes themselves.  Everyone
else, anonymous callers included, gets the unknown-version ``404``.  The rule
lives in :mod:`app.modules.reading.visibility`.

An ``Authorization: Bearer`` access token is optional: it is read only to
widen access to an unlisted version (the caller's authorship or moderator
tier).  A token that is missing or unusable simply leaves the caller
anonymous.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from app.security import InvalidAccessToken, Principal, decode_access_token

from . import service

__all__ = ["ParagraphOut", "VersionText", "router"]

#: Router the module loader mounts under ``/v1``.
router = APIRouter(tags=["reading"])


class ParagraphOut(BaseModel):
    """One paragraph of a version's text, on the wire."""

    model_config = ConfigDict(extra="allow")

    #: Stable paragraph id (sha256 of the normalized text).
    paragraph_id: str
    #: Alias of ``paragraph_id`` for clients using the camel-case spelling.
    paragraphId: str
    #: 0-based position in reading order.
    position: int
    #: The stored paragraph text.
    text: str


class VersionText(BaseModel):
    """The response body of ``GET /v1/papers/{id}/v/{n}/text``."""

    model_config = ConfigDict(extra="forbid")

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: The version number from the URL.
    version: int
    #: cid of the ``paper.version`` record for that version.
    versionCid: str
    #: Total number of paragraphs returned.
    count: int
    #: The version's paragraphs in reading order.
    paragraphs: list[ParagraphOut]


def _not_found(paper_id: str, n: int):
    """A 404 problem response for a paper/version this node does not hold."""
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No paper {paper_id!r} has a version {n} on this node.",
    )



def _not_found_compare(paper_id: str, from_n: int, to_n: int):
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No paper {paper_id!r} has both versions {from_n} and {to_n} on this node.",
    )


def _taken_down(paper_id: str, n: Any):
    """The ``451`` problem for a version whose manuscript moderation tombstoned.

    The same status ``GET /v1/content/{cid}`` gives the tombstoned file itself.
    """
    from app.errors import ProblemException

    return ProblemException(
        451,
        f"Version {n} of paper {paper_id!r} is unavailable: its content has been "
        "removed by moderation.",
    )


#: Bearer credentials, read only to widen access to an unlisted version.
_bearer = HTTPBearer(auto_error=False)


def _optional_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """The caller when the request carries a usable token, otherwise ``None``.

    Reading is public; a token matters only for a version that is not listed
    yet, where it carries the caller's authorship or moderator tier.  A token
    that is present but unusable is ignored rather than turning a readable
    page into a ``401`` (the same courtesy ``content.router`` pays its
    readers).
    """
    if credentials is None:
        return None
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken:
        return None


@router.get(
    "/papers/{paper_id}/v/{n}/text",
    response_model=VersionText,
    summary="Return a paper version's paragraphs for the HTML reading view",
)
def get_paper_text(
    paper_id: str,
    n: int,
    principal: Optional[Principal] = Depends(_optional_principal),
) -> VersionText:
    """Return version ``n``'s paragraphs, each carrying ``paragraph_id``, ``position`` and ``text``."""
    try:
        version = service.resolve_version(paper_id, n)
    except ValueError:
        version = None
    if version is None:
        raise _not_found(paper_id, n)
    try:
        service.require_available(version, n)
    except service.VersionTakenDown:
        raise _taken_down(paper_id, n) from None
    try:
        service.require_readable(version, principal)
    except service.VersionUnlisted:
        # Pre-listing text the caller may not see.  The unknown-version 404,
        # so the answer never reveals that the unlisted version exists --
        # and after the takedown gate above, which still answers 451.
        raise _not_found(paper_id, n) from None

    paragraphs = service.paragraphs_for_version(version.version_cid)
    items = [
        ParagraphOut(
            paragraph_id=getattr(p, "paragraph_id", None) or getattr(p, "paragraphId", ""),
            paragraphId=getattr(p, "paragraph_id", None) or getattr(p, "paragraphId", ""),
            position=getattr(p, "position", 0),
            text=getattr(p, "text", ""),
        )
        for p in paragraphs
    ]
    return VersionText(
        paper=version.paper,
        version=n,
        versionCid=version.version_cid,
        count=len(items),
        paragraphs=items,
    )


@router.get(
    "/papers/{paper_id}/compare",
    summary="Compare two versions of a paper paragraph by paragraph",
)
def compare_papers(
    paper_id: str,
    from_: int = Query(..., alias="from"),
    to: int = Query(..., alias="to"),
    principal: Optional[Principal] = Depends(_optional_principal),
) -> dict[str, Any]:
    """Return a paragraph-level diff between versions ``from`` and ``to``."""
    try:
        result = service.compare_versions(paper_id, from_, to, principal)
    except service.VersionTakenDown as exc:
        raise _taken_down(paper_id, exc.n) from None
    except ValueError:
        # A missing version -- or :class:`service.VersionUnlisted`, raised
        # when either side is not listed and the caller may not read it: the
        # same 404, so the answer never reveals the unlisted version exists.
        result = None
    if result is None:
        # Distinguish missing paper vs missing version with the same 404.
        raise _not_found_compare(paper_id, from_, to)
    return result
