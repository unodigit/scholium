"""HTTP routes for the endorsements plugin (feature 42).

The module loader mounts this router under ``/v1``, so the route below serves
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
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.security import Principal, get_current_principal

from .schemas import EndorsementOut
from .service import active_endorsements

__all__ = ["router"]

#: Router mounted under ``/v1`` by the module loader (serves ``/v1/me/...``).
router = APIRouter(prefix="/me", tags=["endorsements"])


@router.get(
    "/endorsements",
    response_model=list[EndorsementOut],
    summary="List the signed-in account's active endorsements",
)
def my_endorsements(
    principal: Principal = Depends(get_current_principal),
) -> list[EndorsementOut]:
    """Return the caller's unexpired endorsements, ordered by category."""
    return [EndorsementOut.from_row(row) for row in active_endorsements(principal.did)]
