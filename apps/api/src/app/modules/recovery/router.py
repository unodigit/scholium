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

The first set may be saved with the access token alone, as onboarding does.
*Replacing* an existing set is a recovery-critical change, so it also needs a
detached Ed25519 signature by the account's active key over
:func:`~.service.guardian_change_message`::

    PUT /v1/me/guardians
    Authorization: Bearer <access token>
    {"guardians": [...], "signature": "<unpadded base64url>"}

Every change is announced to the account owner with a
:data:`~.service.GUARDIANS_CHANGED_KIND` notification, so a change made with a
stolen session is visible to them.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``401`` -- no usable access token. Nothing is saved.
* ``403`` -- an existing set is being replaced without a valid signature by the
  account's active key (type
  :data:`~app.modules.recovery.problems.UNSIGNED_GUARDIAN_CHANGE_TYPE`).
  Nothing is saved.
* ``422`` -- the body is not an object with a list of strings (the standard
  validation problem), or the list is not a valid guardian set (type
  :data:`~app.modules.recovery.problems.INVALID_GUARDIANS_TYPE`, one ``errors``
  entry per fault; see :mod:`app.modules.recovery.service`). Nothing is saved
  and the account's previous guardians are kept.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import AliasChoices, BaseModel, Field

from app.modules.notifications import notify
from app import db
from app.security import Principal, get_current_principal

from . import problems, signatures
from sqlalchemy import select

from .models import RecoveryRequest, ensure_requests_table
from .service import (
    GUARDIANS_CHANGED_KIND,
    InvalidGuardians,
    get_guardians,
    guardian_change_preimages,
    set_guardians,
    validate_guardians,
)

__all__ = ["GUARDIANS_CHANGED_KIND", "GuardiansRequest", "GuardiansResponse", "router"]

logger = logging.getLogger(__name__)

#: Router mounted under ``/v1`` by the module loader.
router = APIRouter(prefix="/me", tags=["recovery"])


class GuardiansRequest(BaseModel):
    """Body of ``PUT /v1/me/guardians``.

    ``signature`` (or ``sig``/``proof``) carries the account's detached
    Ed25519 signature over :func:`~.service.guardian_change_message`.  It is
    required when an existing guardian set is being replaced.
    """

    guardians: list[str] = Field(validation_alias=AliasChoices("guardians", "guardian_dids"))
    signature: Any = Field(
        default=None,
        validation_alias=AliasChoices("signature", "sig", "proof", "proofValue", "signed_record"),
    )


class GuardiansResponse(BaseModel):
    """The guardians as saved."""

    guardians: list[str]


def _signature_text(value: Any) -> Any:
    """The signature carried by ``value``, whether it is a string or an object."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("signature", "sig", "proofValue", "proof"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate
    return None


def _notify_owner(did: str, previous: list[str], guardians: list[str]) -> None:
    """Tell the account owner their guardian set changed.

    The caller *is* the owner, but the notice is proof trail they will see even
    if the change was made with a stolen session, and it is delivered by email
    as well as in the inbox.  A notification failure must not undo the save.
    """
    try:
        notify(
            did,
            GUARDIANS_CHANGED_KIND,
            {"previous_guardians": previous, "guardians": guardians},
        )
    except Exception:
        logger.exception("could not notify %s that their guardians changed", did)


@router.get(
    "/guardians",
    response_model=GuardiansResponse,
    summary="Read the signed-in account's recovery guardians",
)
def get_my_guardians(
    principal: Principal = Depends(get_current_principal),
) -> GuardiansResponse:
    return GuardiansResponse(guardians=get_guardians(principal.did))



@router.get("/recovery/requests")
def list_my_recovery_requests(
    principal: Principal = Depends(get_current_principal),
):
    ensure_requests_table()
    result = []
    with db.SessionLocal() as session:
        rows = session.scalars(select(RecoveryRequest)).all()
        for row in rows:
            guardians = get_guardians(row.did)
            if principal.did not in guardians:
                continue
            if row.status not in ("pending", "contest"):
                continue
            approvals = list(row.approvals or [])
            count = len(approvals)
            contest_until = (
                row.contest_until.isoformat() + "Z" if row.contest_until is not None else None
            )
            result.append(
                {
                    "request_id": row.id,
                    "id": row.id,
                    "status": row.status,
                    "did": row.did,
                    "account_did": row.did,
                    "accountDid": row.did,
                    "new_public_key": row.new_public_key,
                    "newPublicKey": row.new_public_key,
                    "new_key": row.new_public_key,
                    "newKey": row.new_public_key,
                    "approvals": approvals,
                    "approval_count": count,
                    "approvals_count": count,
                    "count": count,
                    "contest_until": contest_until,
                    "contestUntil": contest_until,
                    "threshold": 3,
                }
            )
    return result


@router.get("/recovery-requests")
def list_my_recovery_requests_alias(
    principal: Principal = Depends(get_current_principal),
):
    return list_my_recovery_requests(principal)


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
        wanted = validate_guardians(principal.did, body.guardians)
    except InvalidGuardians as exc:
        raise problems.invalid_guardians(exc.problems) from exc

    previous = get_guardians(principal.did)
    # Onboarding may set the first list with the access token alone.  Replacing
    # an existing set is a recovery-critical change, so it needs the account's
    # own signature: a stolen access token must not redirect the guardians.
    if previous and wanted != previous:
        if not signatures.verify_detached(
            principal.did,
            guardian_change_preimages(principal.did, wanted),
            _signature_text(body.signature),
        ):
            raise problems.unsigned_guardian_change()

    saved = set_guardians(principal.did, wanted)
    if saved != previous:
        _notify_owner(principal.did, previous, saved)
    return GuardiansResponse(guardians=saved)
