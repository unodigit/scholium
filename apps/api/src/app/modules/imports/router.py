"""``POST /v1/imports/arxiv``: mirror an arXiv paper (plugin: imports).

Feature 124: a moderator (trust tier 4) asks this node to import a paper from
arXiv.  The node fetches the paper's metadata (``ARXIV_MOCK=1`` serves
deterministic metadata instead, for tests), builds an ``external.mirror``
record from it, signs the record with the node's own key and appends it to the
event log -- marked *unclaimed* until an author claims it::

    POST /v1/imports/arxiv
    Authorization: Bearer <tier 4 access token>
    Content-Type: application/json

    {"arxiv_id": "2401.00001"}

    201 Created
    {"id": "bafyrei...", "type": "external.mirror", "source": "arXiv:2401.00001",
     "claimed": false, "state": "unclaimed", "author": "did:key:z6Mk...",
     "anchor": "pending", "metadata": {"title": "...", ...}}

``arxiv_id`` (also accepted as ``arxivId``) may be a bare id, ``arXiv:``-prefixed
or an ``arxiv.org/abs`` URL, with an optional version.  ``id`` is the cid of the
mirror record; ``GET /v1/records/{id}`` serves it.  ``author`` is this node's
``did:key``: the record is signed by the node, not by the caller.  See
:mod:`app.modules.imports.service` for the pipeline and the record's shape.

Refusals are RFC 9457 problem details:

* ``401`` / ``403`` -- no usable access token / a token below tier 4;
* ``404`` -- arXiv has no such paper (:class:`~.errors.ArxivNotFound`);
* ``409`` -- this node already mirrors the paper; the problem's ``detail``
  names the existing record (:class:`~.errors.AlreadyImported`);
* ``422`` -- the request is not an arXiv id (:class:`~.errors.InvalidArxivId`);
* ``502`` -- arXiv could not be reached or answered unusably
  (:class:`~.errors.ArxivUnavailable`);
* ``503`` -- this node has no signing key (:class:`~.errors.NodeKeyUnavailable`).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.security import require_tier

from .service import ANCHOR_PENDING, MIRROR_TYPE, STATE_UNCLAIMED, ImportResult, import_arxiv

__all__ = [
    "ArxivImportRequest",
    "MirrorCreated",
    "REQUIRED_TIER",
    "router",
]

#: Router the module loader mounts under ``/v1`` (serves ``POST /v1/imports/arxiv``).
router = APIRouter(prefix="/imports", tags=["imports"])

#: Trust tier that may import: 4, Moderator.
REQUIRED_TIER = 4


class ArxivImportRequest(BaseModel):
    """The request body: which arXiv paper to mirror."""

    model_config = ConfigDict(extra="forbid")

    #: The arXiv id (``2401.00001``, ``hep-th/9901001``, an ``arXiv:`` id or abs URL).
    arxiv_id: str = Field(
        ...,
        min_length=1,
        max_length=200,
        validation_alias=AliasChoices("arxiv_id", "arxivId"),
        description="The arXiv paper to mirror, e.g. '2401.00001'.",
    )


class MirrorCreated(BaseModel):
    """The ``201 Created`` body of ``POST /v1/imports/arxiv``."""

    model_config = ConfigDict(extra="forbid")

    #: The ``external.mirror`` record's cid.
    id: str
    type: Literal["external.mirror"] = MIRROR_TYPE
    #: ``arXiv:<id>``.
    source: str
    #: ``False``: nobody has claimed the import yet.
    claimed: bool = False
    #: ``"unclaimed"`` until an author claims the import.
    state: Literal["unclaimed"] = STATE_UNCLAIMED
    #: The node's ``did:key``, which signed the record.
    author: str
    #: Public-timestamp status; always ``"pending"`` until anchoring exists.
    anchor: Literal["pending"] = ANCHOR_PENDING
    #: The arXiv metadata the record mirrors.
    metadata: dict[str, Any]

    @classmethod
    def from_result(cls, result: ImportResult) -> "MirrorCreated":
        return cls(
            id=result.record_id,
            source=result.source,
            claimed=result.claimed,
            state=result.state,
            author=result.author,
            anchor=result.anchor,
            metadata=result.metadata,
        )


@router.post(
    "/arxiv",
    status_code=201,
    response_model=MirrorCreated,
    summary="Mirror an arXiv paper as a node-signed, unclaimed external.mirror record",
    dependencies=[Depends(require_tier(REQUIRED_TIER))],
)
def post_arxiv_import(request: ArxivImportRequest) -> MirrorCreated:
    """Fetch the paper's arXiv metadata, sign an ``external.mirror`` and append it."""
    return MirrorCreated.from_result(import_arxiv(request.arxiv_id))
