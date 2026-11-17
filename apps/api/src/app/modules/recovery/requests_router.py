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

from typing import Any, Optional

from sqlalchemy import select
from fastapi import APIRouter, Depends, Header, Request
from pydantic import AliasChoices, BaseModel, Field



from app import db
from app.security import Principal, get_current_principal
from . import problems
from . import approvals as _approvals
from .opening import InvalidRecoveryRequest, NoGuardians, UnknownAccount, open_recovery_request
from .models import RecoveryRequest, ensure_requests_table
from .service import GUARDIAN_COUNT, get_guardians

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


def _extract_approval(body: Any) -> tuple[Optional[str], Any]:
    """The guardian DID a body *claims* and the signature it carries.

    The claimed DID is only ever compared against the authenticated caller: it
    can never select somebody else's identity.  A bare string body is taken as
    the detached signature, so a client that has nobody to name can still
    approve with its token alone.
    """
    if isinstance(body, str):
        text = body.strip()
        return None, (text or None)
    if not isinstance(body, dict):
        return None, None
    claimed = None
    for key in _GUARDIAN_FIELDS:
        if isinstance(body.get(key), str):
            claimed = body[key]
            break
    signature = None
    for key in _SIGNATURE_FIELDS:
        if isinstance(body.get(key), str):
            signature = body[key]
            break
    return claimed, signature


@requests_router.post(
    "/requests/{request_id}/approvals",
    summary="Record a guardian's approval of a recovery request",
)
async def post_recovery_approval(
    request_id: str,
    request: Request,
    principal: Principal = Depends(get_current_principal),
):
    """Record the authenticated caller's signed approval.

    An approval is accepted only when the caller's access token names a current
    guardian *and* the body carries a valid Ed25519 signature by that
    guardian's active key over the request id, the account DID and the new key.
    A ``guardian_did`` in the body may repeat the caller's own DID (some
    clients do), but naming any other DID is refused: the token decides who is
    approving, never the body.
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    claimed_did, signature = _extract_approval(body)
    if claimed_did is not None and claimed_did != principal.did:
        raise problems.not_a_guardian()

    try:
        result = _approvals.approve_recovery_request(request_id, principal.did, signature)
    except LookupError:
        raise problems.recovery_request_not_found()
    except _approvals.NotAGuardian:
        raise problems.not_a_guardian()
    except _approvals.InvalidApprovalSignature:
        raise problems.invalid_approval_signature()

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


@requests_router.get("/requests/{request_id}")
def get_recovery_request(request_id: str):
    ensure_requests_table()
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        if row is None:
            raise problems.recovery_request_not_found()
        approvals = list(row.approvals or [])
        count = len(approvals)
        contest_until = (
            row.contest_until.isoformat() + "Z" if row.contest_until is not None else None
        )
        return {
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
            "threshold": _approvals.APPROVAL_THRESHOLD,
        }


@requests_router.get("/requests")
def list_recovery_requests(principal: Principal = Depends(get_current_principal)):
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
                    "threshold": _approvals.APPROVAL_THRESHOLD,
                }
            )
    return result


_SIGNATURE_FIELDS_CANCEL = ("signature", "sig", "proof", "proofValue")


def _extract_signature(body):
    if not isinstance(body, dict):
        return None, None
    signature = None
    for key in _SIGNATURE_FIELDS_CANCEL:
        if key in body and isinstance(body[key], str):
            signature = body[key]
            break
    signer = None
    for key in ("did", "signer", "author", "account_did"):
        if key in body and isinstance(body[key], str):
            signer = body[key]
            break
    return signer, signature


def _verify_detached(did: str, message: str, signature: str) -> bool:
    try:
        from scholium_record_core import decode_signature, public_key_from_did_key
        from nacl.exceptions import BadSignatureError
        from nacl.signing import VerifyKey

        raw = decode_signature(signature)
        pk = public_key_from_did_key(did)
        VerifyKey(pk).verify(message.encode("utf-8"), raw)
        return True
    except Exception:
        return False


@requests_router.post("/requests/{request_id}/cancel", status_code=200)
async def cancel_recovery_request(request_id: str, request: Request, authorization: str | None = Header(default=None)):
    ensure_requests_table()
    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, request_id)
        if row is None:
            raise problems.recovery_request_not_found()
        did = row.did
        row_id = row.id

    authorized = False
    # Bearer access token signed by the old key.
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        try:
            from app.security import decode_access_token

            principal = decode_access_token(token)
            if principal.did == did:
                authorized = True
        except Exception:
            authorized = False

    # Detached signature by the old key over the request id.
    try:
        body = await request.json()
    except Exception:
        body = None
    signer, signature = _extract_signature(body)
    if not authorized and signature is not None:
        if signer is None:
            signer = did
        if signer == did and _verify_detached(did, request_id, signature):
            authorized = True

    if not authorized:
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="Not authorized to cancel this recovery request.")

    with db.SessionLocal() as session:
        row = session.get(RecoveryRequest, row_id)
        if row is not None:
            row.status = "cancelled"
            session.commit()

    return {"status": "cancelled"}
