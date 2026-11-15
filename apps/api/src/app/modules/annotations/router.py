"""HTTP routes for the annotations plugin.

The module loader mounts ``router`` under ``/v1``, so this package serves:

* ``POST /v1/annotations`` (feature 103) -- accept a signed
  ``discussion.post`` whose anchor names a version cid, a ``paragraph_id``, a
  ``quote`` and an ``offset``; answers ``201 Created`` with the record cid.
* ``GET /v1/papers/{id}/v/{n}/annotations`` (feature 104) -- return the
  annotations of version ``n`` of paper ``id`` grouped by ``paragraph_id``,
  so a client can re-attach each one to the same paragraph on reload::

      {
        "paper": "sch:xxxx-xxxx-xxxx",
        "version": 2,
        "versionCid": "bafyrei...",
        "count": 3,
        "annotations": {
          "<paragraph_id>": [{"id": "bafyrei...", "quote": "...", ...}],
          "<paragraph_id>": [...]
        }
      }

  ``{id}`` is the paper's ``sch:`` short id and ``{n}`` its version number.
  An unknown short id, or a paper that has no such version, answers ``404``
  problem details; a malformed short id is simply not a paper this node has
  and answers ``404`` too.  Reading is public, like reading a record.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.security import require_tier

from app.modules.ingest.router import RecordAccepted
from app.modules.ingest.service import ingest

from . import service

__all__ = ["AnnotationOut", "PaperAnnotations", "router"]

#: The annotation-creating route (``POST /v1/annotations``).
annotations_router = APIRouter(prefix="/annotations", tags=["annotations"])

#: The paper-scoped annotation route (``GET /v1/papers/{id}/v/{n}/annotations``).
papers_router = APIRouter(tags=["annotations"])


class AnnotationOut(BaseModel):
    """One annotation in the wire response."""

    model_config = ConfigDict(extra="allow")

    #: The record's cid.
    id: str
    #: The author's DID.
    author: str
    #: The signer's timestamp, decoded from the stored envelope.
    created: Optional[str] = None
    #: The record type (always ``discussion.post`` for an annotation).
    type: str = service.DISCUSSION_POST_TYPE
    #: The record the post targets (normally the version cid).
    target: Optional[str] = None
    #: The paragraph the annotation is anchored to.
    paragraph_id: str
    #: Alias of ``paragraph_id`` for clients using the camel-case anchor key.
    paragraphId: str
    #: The quoted text the annotation refers to.
    quote: Optional[str] = None
    #: Where in the paragraph the quote starts (an integer or a start/end object).
    offset: Any = None
    #: The inline annotation text, when carried inline.
    text: Optional[str] = None
    #: The content id of the annotation text, when carried as content.
    textCid: Optional[str] = None
    #: The parent post cid for a reply, or ``null`` for a new thread.
    parent: Optional[str] = None


class PaperAnnotations(BaseModel):
    """The response body of ``GET /v1/papers/{id}/v/{n}/annotations``."""

    model_config = ConfigDict(extra="forbid")

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: The version number from the URL.
    version: int
    #: cid of the ``paper.version`` record for that version.
    versionCid: str
    #: Total number of annotations returned.
    count: int
    #: Annotations grouped by ``paragraph_id``.
    annotations: dict[str, list[AnnotationOut]]


def _not_found(paper_id: str, n: int) -> HTTPException:
    """A 404 problem response for a paper/version this node does not hold.

    Imported at raise time, not module load: importing ``app.errors`` pulls in
    ``app.main``, and doing that while the module loader is importing packages
    would leave this package half-initialized without a ``router`` attribute
    (the same care ``content.router`` and ``ledger.records`` take).
    """
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No paper {paper_id!r} has a version {n} on this node.",
    )


@annotations_router.post(
    "",
    status_code=201,
    response_model=RecordAccepted,
    summary="Submit a signed annotation",
    dependencies=[Depends(require_tier(0))],
)
def post_annotation(
    record: dict[str, Any] = Body(..., description="The signed discussion.post envelope."),
) -> RecordAccepted:
    """Validate, verify and append one signed annotation; return its cid and state."""
    return RecordAccepted.from_result(ingest(record))


@papers_router.get(
    "/papers/{paper_id}/v/{n}/annotations",
    response_model=PaperAnnotations,
    summary="List a paper version's annotations grouped by paragraph",
)
def get_paper_annotations(paper_id: str, n: int) -> PaperAnnotations:
    """Return version ``n``'s annotations, grouped under their paragraph ids."""
    try:
        version = service.resolve_version(paper_id, n)
    except ValueError:
        # Not a well-formed sch: id: nothing can be stored under it.
        version = None
    if version is None:
        raise _not_found(paper_id, n)

    groups = service.annotations_for_version(version.version_cid)
    return PaperAnnotations(
        paper=version.paper,
        version=n,
        versionCid=version.version_cid,
        count=sum(len(items) for items in groups.values()),
        annotations=groups,
    )


#: Router the module loader mounts under ``/v1``.  Assembled after both
#: sub-routers have their routes: ``include_router`` copies the routes it
#: finds at call time.
router = APIRouter()
router.include_router(annotations_router)
router.include_router(papers_router)
