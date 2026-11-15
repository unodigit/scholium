"""PUT /v1/me/guardians: set the account's five recovery guardians (plugin: recovery).

The caller sends the DIDs of the five people (or devices) who can later approve
a recovery of their account::

    PUT /v1/me/guardians
    Authorization: Bearer <access token>
    {"guardians": ["did:key:z6Mk...", ... five of them ...]}

    200 OK
    {"guardians": ["did:key:z6Mk...", ...]}      # as saved, in the order sent

The list is saved to the ``guardians`` table, replacing whatever the account had
before (the call is idempotent), and the order sent is each guardian's
``position``. ``guardian_dids`` is accepted as another name for ``guardians``.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no usable access token. Nothing is saved.
* ``422`` -- the body is not an object with a list of strings (the standard
  validation problem), or the list is not a valid guardian set (type
  :data:`~app.modules.recovery.problems.INVALID_GUARDIANS_TYPE`, one ``errors``
  entry per fault; see :mod:`app.modules.recovery.service`). Nothing is saved
  and the account's previous guardians are kept.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import AliasChoices, BaseModel, Field

from app.security import Principal, get_current_principal

from . import problems
from .service import InvalidGuardians, set_guardians

__all__ = ["GuardiansRequest", "GuardiansResponse", "router"]

#: Router mounted under ``/v1`` by the module loader.
router = APIRouter(prefix="/me", tags=["recovery"])


class GuardiansRequest(BaseModel):
    """Body of ``PUT /v1/me/guardians``."""

    guardians: list[str] = Field(validation_alias=AliasChoices("guardians", "guardian_dids"))


class GuardiansResponse(BaseModel):
    """The guardians as saved."""

    guardians: list[str]


@router.put(
    "/guardians",
    response_model=GuardiansResponse,
    summary="Set the five recovery guardians of the signed-in account",
)
def put_guardians(
    body: GuardiansRequest,
    principal: Principal = Depends(get_current_principal),
) -> GuardiansResponse:
    try:
        saved = set_guardians(principal.did, body.guardians)
    except InvalidGuardians as exc:
        raise problems.invalid_guardians(exc.problems) from exc
    return GuardiansResponse(guardians=saved)
