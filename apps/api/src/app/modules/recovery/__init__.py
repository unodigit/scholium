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

The module loader discovers this package under ``app.modules`` and mounts
:data:`router` under ``/v1``. Importing it registers the ``guardians`` model on
``db.Base`` before ``create_all`` runs, and the ``key.rotation`` handler in the
ingest registry.
"""

from __future__ import annotations

from app.modules.ingest import register

from .gate import ensure_guardians_set, require_guardians
from .models import Guardian, ensure_table
from .problems import GUARDIANS_REQUIRED_TYPE, INVALID_GUARDIANS_TYPE, INVALID_KEY_ROTATION_TYPE
from .rotation import KEY_ROTATION_TYPE, InvalidNewKey, apply_rotation, handle_key_rotation, validate_new_key
from .router import GuardiansRequest, GuardiansResponse, router
from .service import (
    GUARDIAN_COUNT,
    InvalidGuardians,
    get_guardians,
    has_guardians,
    set_guardians,
    validate_guardians,
)

#: The record type whose handler this package owns (feature 37).
register(KEY_ROTATION_TYPE, handle_key_rotation, min_tier=0)

__all__ = [
    "GUARDIANS_REQUIRED_TYPE",
    "GUARDIAN_COUNT",
    "Guardian",
    "GuardiansRequest",
    "GuardiansResponse",
    "INVALID_GUARDIANS_TYPE",
    "INVALID_KEY_ROTATION_TYPE",
    "InvalidGuardians",
    "InvalidNewKey",
    "KEY_ROTATION_TYPE",
    "apply_rotation",
    "ensure_guardians_set",
    "ensure_table",
    "get_guardians",
    "handle_key_rotation",
    "has_guardians",
    "require_guardians",
    "router",
    "set_guardians",
    "validate_guardians",
    "validate_new_key",
]
