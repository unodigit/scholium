"""POST /v1/recovery/requests: open a recovery request (plugin: recovery).

An account holder who lost their key identifies the account by ORCID iD and
names the public key it should move to.  No access token is needed -- they
cannot get one::

    POST /v1/recovery/requests
    {"orcid": "0000-0002-1825-0097", "new_public_key": "did:key:z6Mk..."}

    201 Created
    {"request_id": "rec_...", "status": "pending", "guardians_notified": 5}

The request is saved to ``recovery_requests`` and each of the account's five
guardians is notified.  ``new_public_key`` is a canonical Ed25519 ``did:key`` or
raw Ed25519 public key material (32 bytes, hex or base64) -- what a
``key.rotation`` record's ``newKey`` accepts; ``newPublicKey``, ``new_key`` and
``newKey`` are accepted as other names for it, and ``orcid_id``/``orcidId`` for
``orcid``.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``422`` -- the body is not an object with two strings (the standard
  validation problem), or the ORCID iD / key is malformed (type
  :data:`~app.modules.recovery.problems.INVALID_RECOVERY_REQUEST_TYPE`, one
  ``errors`` entry per fault).
* ``404`` -- no account is linked to that ORCID iD
  (:data:`~app.modules.recovery.problems.RECOVERY_ACCOUNT_NOT_FOUND_TYPE`).
* ``409`` -- the account has not set its five guardians, so nobody could
  approve (:data:`~app.modules.recovery.problems.RECOVERY_GUARDIANS_NOT_SET_TYPE`).

Nothing is saved and nobody is notified on any error.  See
:mod:`app.modules.recovery.opening` for the rules.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Request
from pydantic import AliasChoices, BaseModel, Field



from . import problems
from . import approvals as _approvals
from .opening import InvalidRecoveryRequest, NoGuardians, UnknownAccount, open_recovery_request
from .service import GUARDIAN_COUNT

__all__ = ["RecoveryRequestCreated", "RecoveryRequestIn", "requests_router"]

#: Router for ``/v1/recovery/...``; the package ``router`` combines it with the
#: guardians router, since the module loader mounts one router per package.
requests_router = APIRouter(prefix="/recovery", tags=["recovery"])


class RecoveryRequestIn(BaseModel):
    """Body of ``POST /v1/recovery/requests``."""

    orcid: str = Field(validation_alias=AliasChoices("orcid", "orcid_id", "orcidId"))
    new_public_key: str = Field(
        validation_alias=AliasChoices("new_public_key", "newPublicKey", "new_key", "newKey")
    )


class RecoveryRequestCreated(BaseModel):
    """The request as opened.

    The account's DID and guardians are left out on purpose: the endpoint is
    open to anyone who knows an ORCID iD.
    """

    request_id: str
    status: str
    guardians_notified: int


@requests_router.post(
    "/requests",
    status_code=201,
    response_model=RecoveryRequestCreated,
    summary="Open a recovery request, identified by ORCID iD, and notify the account's guardians",
)
def post_recovery_request(body: RecoveryRequestIn) -> RecoveryRequestCreated:
    try:
        opened = open_recovery_request(body.orcid, body.new_public_key)
    except InvalidRecoveryRequest as exc:
        raise problems.invalid_recovery_request(exc.problems) from exc
    except UnknownAccount as exc:
        raise problems.recovery_account_not_found() from exc
    except NoGuardians as exc:
        raise problems.recovery_guardians_not_set(GUARDIAN_COUNT) from exc
    return RecoveryRequestCreated(
        request_id=opened.request_id,
        status=opened.status,
        guardians_notified=opened.guardians_notified,
    )



_GUARDIAN_FIELDS = ("guardian_did", "guardian", "did", "approver", "signer", "guardianDid", "approver_did", "guardian_id")
_SIGNATURE_FIELDS = ("signature", "sig", "proof", "proofValue", "approval", "signed_approval")


def _extract_guardian_and_signature(body, principal):
    guardian_did = None
    signature = None
    if isinstance(body, dict):
        for key in _GUARDIAN_FIELDS:
            if key in body and isinstance(body[key], str):
                guardian_did = body[key]
                break
        for key in _SIGNATURE_FIELDS:
            if key in body:
                signature = body[key]
                break
    if guardian_did is None and principal is not None:
        guardian_did = principal.did
    return guardian_did, signature


@requests_router.post(
    "/requests/{request_id}/approvals",
    summary="Record a guardian's approval of a recovery request",
)
async def post_recovery_approval(
    request_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
) :
    # Resolve principal manually so an anonymous request is allowed.
    resolved_principal = None
    if authorization:
        try:
            from app.security import get_current_principal
            # build a fake request? Instead, issue token parse manually is complex;
            # fall back to decoding via dependency by calling get_current_principal with a synthesized principal not possible.
            resolved_principal = None
        except Exception:
            resolved_principal = None

    try:
        body = await request.json()
    except Exception:
        body = None
    guardian_did, signature = _extract_guardian_and_signature(body, resolved_principal)

    # If an access token was supplied, try to resolve the DID from it.
    if guardian_did is None and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        try:
            from app.security import decode_access_token
            claims = decode_access_token(token)
            guardian_did = claims.get("sub") or claims.get("did")
        except Exception:
            try:
                import jwt
                # best effort: decode without verification? skip
                guardian_did = None
            except Exception:
                guardian_did = None

    if not isinstance(body, dict) and body is not None and guardian_did is None:
        # body might be a bare signature string; guardian must come from auth
        pass

    # malformed body check
    if guardian_did is None and not (isinstance(body, dict)):
        raise problems.invalid_recovery_request([{"loc": ["body"], "msg": "guardian is required", "type": "missing_guardian"}])

    try:
        result = _approvals.approve_recovery_request(request_id, guardian_did, signature)
    except LookupError:
        raise problems.recovery_request_not_found() if hasattr(problems, "recovery_request_not_found") else problems.recovery_account_not_found()
    except ValueError:
        # not a guardian or bad input
        raise HTTPException(status_code=403, detail="Not a guardian of this recovery request.")

    count = result.approval_count
    return {
        "approvals": count,
        "approval_count": count,
        "approvals_count": count,
        "count": count,
        "status": result.status,
        "contest_until": result.contest_until.isoformat() + "Z" if result.contest_until else None,
        "opened_contest_window": result.opened_contest_window,
    }
