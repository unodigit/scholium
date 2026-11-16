"""``GET /v1/export/paper/{id}.car`` -- one paper as a CARv1 archive (feature 91).

The module loader mounts this package's ``router`` under ``/v1``, so a reader
downloads a paper's archive with::

    GET /v1/export/paper/sch:xxxx-xxxx-xxxx.car

    200 OK
    Content-Type: application/vnd.ipld.car
    Content-Disposition: attachment; filename="sch-xxxx-xxxx-xxxx.car"

    <CARv1 bytes>

What the archive holds, and which of the paper's records it carries, is
described in :mod:`app.modules.export.paper`: every record the paper's signed
history references, the bytes of every file those records name, and the
``event_log`` row of each included record (the hash-chain links).  The blocks
are written by :mod:`app.modules.export.car`.

``{id}`` is any of the spellings ``GET /v1/papers/{id}`` accepts -- a paper
``sch:`` id, a version id, or a version cid -- plus the paper's genesis cid
and the OAI identifier ``oai:scholium:sch:...``.  Exporting is public, like
reading a record.

An unknown paper, a malformed id, or a paper whose genesis record this node
does not hold answers ``404`` RFC 9457 problem details (via the app-wide
handlers), never an empty or partial archive presented as complete.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Response

from app.security import Principal

from .auth import optional_principal
from .paper import collect_paper, collect_paper_records

__all__ = [
    "CAR_MEDIA_TYPE",
    "PAPER_NOT_FOUND_TYPE",
    "papers_router",
    "router",
]

#: The registered media type for a CARv1 archive.
CAR_MEDIA_TYPE = "application/vnd.ipld.car"

#: Problem-details type URN for an id that names no exportable paper.
PAPER_NOT_FOUND_TYPE = "urn:scholium:problem:paper-not-found"

#: Router the module loader mounts under ``/v1`` (serves the export routes).
router = APIRouter(prefix="/export", tags=["export"])

#: Router the module loader mounts under ``/v1`` (serves per-paper record routes).
papers_router = APIRouter(prefix="/papers", tags=["papers"])


def _not_found(identifier: str):
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and doing that while the module loader imports packages would
    # leave this package half-initialized without a `router` attribute (the
    # same care the other plugins take).
    from app.errors import ProblemException

    shown = identifier if len(identifier) <= 60 else identifier[:57] + "..."
    return ProblemException(
        404,
        f"No paper {shown!r} is available to export from this node.",
        type=PAPER_NOT_FOUND_TYPE,
    )


def _filename(archive, identifier: str) -> str:
    """A safe download filename ending in ``.car``."""
    stem = archive.short_id or archive.paper_cid or identifier
    safe = "".join(
        character if character.isalnum() or character in "-._" else "-"
        for character in stem
    )
    return (safe or "paper") + ".car"


@router.get(
    "/paper/{paper_id}.car",
    response_class=Response,
    summary="Export one paper as a CARv1 archive (records, files and log entries)",
)
def export_paper(
    paper_id: str,
    principal: Optional[Principal] = Depends(optional_principal),
) -> Response:
    """Return the CARv1 archive of the paper ``paper_id`` names.

    Exporting is public.  A caller that sends an access token may additionally
    receive the file bytes of a paper not listed yet (its authors and
    moderators); everyone else gets the records and log entries only, which is
    exactly what ``GET /v1/content/{cid}`` would let them read.
    """
    archive = collect_paper(paper_id, principal)
    if archive is None:
        raise _not_found(paper_id)

    return Response(
        content=archive.to_car(),
        media_type=CAR_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{_filename(archive, paper_id)}"',
        },
    )


@papers_router.get(
    "/{paper_id}/records",
    summary="The event-log entries of one paper (records with signatures and proofs)",
)
@router.get(
    "/paper/{paper_id}/records",
    summary="The event-log entries of one paper (records with signatures and proofs)",
)
def paper_records(paper_id: str):
    '''Return the event-log entries for the paper paper_id names.'''
    entries = collect_paper_records(paper_id)
    if entries is None:
        raise _not_found(paper_id)
    return entries
