"""Key recovery module (plugin: recovery).

Feature 36: an account sets its five recovery guardians, and may not submit
until it has.

* ``PUT /v1/me/guardians`` -- save the caller's five guardian DIDs to the
  ``guardians`` table (:mod:`.router`, :mod:`.service`).
* :func:`require_guardians` / :func:`ensure_guardians_set` -- the gate that
  submission routes apply: ``403`` problem details until guardians are set
  (:mod:`.gate`).

Feature 37: an account rotates its signing key with a ``key.rotation``
record signed by the old key.

* :func:`handle_key_rotation` -- the ingest handler this package registers
  for ``key.rotation``: it records the body's ``newKey`` as the active key in
  the identity plugin's ``account_keys`` table, closing the old key's window,
  so records signed by the old key are refused ``401`` from then on
  (:mod:`.rotation`).

Feature 38: an account holder who lost their key opens a recovery request.

* ``POST /v1/recovery/requests`` -- identified by ORCID iD, with the new public
  key; saves the request to the ``recovery_requests`` table, notifies each of
  the account's guardians and answers ``201`` with the ``request_id``
  (:mod:`.requests_router`, :mod:`.opening`).

The module loader discovers this package under ``app.modules`` and mounts
:data:`router` under ``/v1``. Importing it registers the ``guardians`` and
``recovery_requests`` models on ``db.Base`` before ``create_all`` runs, and the
``key.rotation`` handler in the ingest registry.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.modules.ingest import register

from .gate import ensure_guardians_set, require_guardians
from .models import Guardian, RecoveryRequest, ensure_requests_table, ensure_table
from .opening import (
    InvalidOrcid,
    InvalidRecoveryRequest,
    NoGuardians,
    OpenedRequest,
    UnknownAccount,
    find_account_by_orcid,
    normalize_orcid,
    open_recovery_request,
)
from .approvals import (
    APPROVAL_THRESHOLD,
    CONTEST_WINDOW,
    ApprovalResult,
    InvalidApprovalSignature,
    NotAGuardian,
    approval_message,
    approve_recovery_request,
    get_approval_count,
)
from .finalize import (
    JOB_KIND,
    finalize_due_requests,
    finalize_recovery_request,
    finalize_job,
)
from .problems import (
    GUARDIANS_REQUIRED_TYPE,
    INVALID_APPROVAL_SIGNATURE_TYPE,
    INVALID_GUARDIANS_TYPE,
    INVALID_KEY_ROTATION_TYPE,
    INVALID_RECOVERY_REQUEST_TYPE,
    NOT_A_GUARDIAN_TYPE,
    RECOVERY_ACCOUNT_NOT_FOUND_TYPE,
    RECOVERY_GUARDIANS_NOT_SET_TYPE,
    UNSIGNED_GUARDIAN_CHANGE_TYPE,
)
from .requests_router import RecoveryRequestCreated, RecoveryRequestIn, requests_router
from .rotation import KEY_ROTATION_TYPE, InvalidNewKey, apply_rotation, handle_key_rotation, validate_new_key
from .router import GuardiansRequest, GuardiansResponse
from .router import router as guardians_router
from .service import (
    GUARDIAN_COUNT,
    GUARDIANS_CHANGED_KIND,
    InvalidGuardians,
    get_guardians,
    guardian_change_message,
    has_guardians,
    set_guardians,
    validate_guardians,
)

#: Everything this package serves, as the one router the module loader mounts
#: under ``/v1``: ``PUT /me/guardians`` and ``POST /recovery/requests``.
router = APIRouter()
router.include_router(guardians_router)
router.include_router(requests_router)

#: The record type whose handler this package owns (feature 37).
register(KEY_ROTATION_TYPE, handle_key_rotation, min_tier=0)

__all__ = [
    "APPROVAL_THRESHOLD",
    "JOB_KIND",
    "CONTEST_WINDOW",
    "ApprovalResult",
    "GUARDIANS_CHANGED_KIND",
    "GUARDIANS_REQUIRED_TYPE",
    "GUARDIAN_COUNT",
    "Guardian",
    "GuardiansRequest",
    "GuardiansResponse",
    "INVALID_APPROVAL_SIGNATURE_TYPE",
    "INVALID_GUARDIANS_TYPE",
    "INVALID_KEY_ROTATION_TYPE",
    "INVALID_RECOVERY_REQUEST_TYPE",
    "InvalidApprovalSignature",
    "InvalidGuardians",
    "InvalidNewKey",
    "InvalidOrcid",
    "InvalidRecoveryRequest",
    "KEY_ROTATION_TYPE",
    "NoGuardians",
    "NOT_A_GUARDIAN_TYPE",
    "NotAGuardian",
    "OpenedRequest",
    "RECOVERY_ACCOUNT_NOT_FOUND_TYPE",
    "RECOVERY_GUARDIANS_NOT_SET_TYPE",
    "RecoveryRequest",
    "RecoveryRequestCreated",
    "RecoveryRequestIn",
    "UNSIGNED_GUARDIAN_CHANGE_TYPE",
    "UnknownAccount",
    "apply_rotation",
    "approval_message",
    "approve_recovery_request",
    "get_approval_count",
    "ensure_guardians_set",
    "ensure_requests_table",
    "ensure_table",
    "find_account_by_orcid",
    "get_guardians",
    "guardian_change_message",
    "handle_key_rotation",
    "has_guardians",
    "normalize_orcid",
    "open_recovery_request",
    "require_guardians",
    "router",
    "set_guardians",
    "validate_guardians",
    "validate_new_key",
]
