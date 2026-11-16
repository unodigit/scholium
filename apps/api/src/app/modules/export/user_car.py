"""``GET /v1/export/user/{did}.car`` -- one user's records as a CARv1 archive (feature 92)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Response

from app.security import Principal

from .auth import optional_principal
from .paper_car import CAR_MEDIA_TYPE
from .user import USER_NOT_FOUND_TYPE, collect_user

__all__ = [
    "USER_NOT_FOUND_TYPE",
    "router",
]

router = APIRouter(prefix="/export", tags=["export"])


def _not_found(identifier: str):
    from app.errors import ProblemException

    shown = identifier if len(identifier) <= 60 else identifier[:57] + "..."
    return ProblemException(
        404,
        f"No records authored by {shown!r} are available to export from this node.",
        type=USER_NOT_FOUND_TYPE,
    )


def _filename(archive, identifier: str) -> str:
    stem = archive.did or identifier
    safe = "".join(
        character if character.isalnum() or character in "-._" else "-"
        for character in stem
    )
    return (safe or "user") + ".car"


@router.get(
    "/user/{did}.car",
    response_class=Response,
    summary="Export every record authored by a DID as a CARv1 archive",
)
def export_user(
    did: str,
    principal: Optional[Principal] = Depends(optional_principal),
) -> Response:
    """Return the CARv1 archive of every record authored by ``did``."""
    archive = collect_user(did, principal)
    if archive is None:
        raise _not_found(did)

    return Response(
        content=archive.to_car(),
        media_type=CAR_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{_filename(archive, did)}"',
        },
    )
