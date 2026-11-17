"""HTTP routes for the endorsements plugin (feature 42).

The module loader mounts this router under ``/v1``.  It serves two reads of
the same table: the caller's own endorsements (``/me/endorsements``) and the
public list a profile shows (``/profiles/{did}/endorsements``).

``GET /v1/me/endorsements`` -- the endorsements of the signed-in account that
are still active, as a bare JSON array::

    GET /v1/me/endorsements
    Authorization: Bearer <access token>

    200 OK
    [
      {
        "record_cid": "bafyrei...",
        "endorser_did": "did:key:z6Mk...",
        "endorsee_did": "did:key:z6Mk...",
        "category": "cs.AI",
        "expires_at": "2030-01-02T03:04:05Z",
        "expiry": "2030-01-02T03:04:05Z"
      }
    ]

Only the caller's own endorsements are listed, and only unexpired ones: an
endorsement whose ``expires_at`` has passed is not returned.  An account with
no active endorsements gets ``[]``.  Any trust tier may read its own list.

Failures are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no usable access token.

``GET /v1/profiles/{did}/endorsements`` -- the active endorsements ``{did}``
holds, as a bare JSON array ordered by category, for the profile page to list
(see :class:`~.schemas.ProfileEndorsementOut`).  It is a public read like
``GET /v1/profiles/{did}``: no token is needed, and it carries only what a
profile already shows -- the endorser's DID and the name they made public.  A
DID that holds none answers ``200`` with ``[]``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.security import Principal, get_current_principal

from .schemas import EndorsementOut, ProfileEndorsementOut
from .service import active_endorsements, public_endorsements

__all__ = ["router"]

_me_router = APIRouter(prefix="/me", tags=["endorsements"])
_profiles_router = APIRouter(prefix="/profiles", tags=["endorsements"])


@_me_router.get(
    "/endorsements",
    response_model=list[EndorsementOut],
    summary="List the signed-in account's active endorsements",
)
def my_endorsements(
    principal: Principal = Depends(get_current_principal),
) -> list[EndorsementOut]:
    """Return the caller's unexpired endorsements, ordered by category."""
    return [EndorsementOut.from_row(row) for row in active_endorsements(principal.did)]


@_profiles_router.get(
    "/{did}/endorsements",
    response_model=list[ProfileEndorsementOut],
    summary="List the active endorsements a DID holds",
)
def profile_endorsements(did: str) -> list[ProfileEndorsementOut]:
    """Return the unexpired endorsements ``did`` holds, ordered by category."""
    return [ProfileEndorsementOut.from_view(view) for view in public_endorsements(did)]


#: Router mounted under ``/v1`` by the module loader (serves ``/v1/me/...`` and
#: ``/v1/profiles/{did}/endorsements``).  Both sub-routers are complete above,
#: so ``include_router`` copies every route.
router = APIRouter()
router.include_router(_me_router)
router.include_router(_profiles_router)
