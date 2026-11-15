"""HTTP routes for the reading plugin.

The module loader mounts ``router`` under ``/v1``, so this package serves:

* ``GET /v1/papers/{id}/v/{n}/text`` -- return version ``n`` of paper ``id``'s
  paragraphs (``paragraph_id``, ``position`` and ``text``) for the HTML
  reading view.
* ``GET /v1/papers/{id}/compare?from=1&to=2`` -- paragraph-level diff between
  two versions, with added, removed and changed paragraphs plus both change
  notes.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict

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

@router.get(
    "/papers/{paper_id}/v/{n}/text",
    response_model=VersionText,
    summary="Return a paper version's paragraphs for the HTML reading view",
)
def get_paper_text(paper_id: str, n: int) -> VersionText:
    """Return version ``n``'s paragraphs, each carrying ``paragraph_id``, ``position`` and ``text``."""
    try:
        version = service.resolve_version(paper_id, n)
    except ValueError:
        version = None
    if version is None:
        raise _not_found(paper_id, n)

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
) -> dict[str, Any]:
    """Return a paragraph-level diff between versions ``from`` and ``to``."""
    try:
        result = service.compare_versions(paper_id, from_, to)
    except ValueError:
        result = None
    if result is None:
        # Distinguish missing paper vs missing version with the same 404.
        raise _not_found_compare(paper_id, from_, to)
    return result
