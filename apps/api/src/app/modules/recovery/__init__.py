"""Key recovery module (plugin: recovery).

Feature 36: an account sets its five recovery guardians, and may not submit
until it has.

* ``PUT /v1/me/guardians`` -- save the caller's five guardian DIDs to the
  ``guardians`` table (:mod:`.router`, :mod:`.service`).
* :func:`require_guardians` / :func:`ensure_guardians_set` -- the gate that
  submission routes apply: ``403`` problem details until guardians are set
  (:mod:`.gate`).

The module loader discovers this package under ``app.modules`` and mounts
:data:`router` under ``/v1``. Importing it registers the ``guardians`` model on
``db.Base`` before ``create_all`` runs.
"""

from __future__ import annotations

from .gate import ensure_guardians_set, require_guardians
from .models import Guardian, ensure_table
from .problems import GUARDIANS_REQUIRED_TYPE, INVALID_GUARDIANS_TYPE
from .router import GuardiansRequest, GuardiansResponse, router
from .service import (
    GUARDIAN_COUNT,
    InvalidGuardians,
    get_guardians,
    has_guardians,
    set_guardians,
    validate_guardians,
)

__all__ = [
    "GUARDIANS_REQUIRED_TYPE",
    "GUARDIAN_COUNT",
    "Guardian",
    "GuardiansRequest",
    "GuardiansResponse",
    "INVALID_GUARDIANS_TYPE",
    "InvalidGuardians",
    "ensure_guardians_set",
    "ensure_table",
    "get_guardians",
    "has_guardians",
    "require_guardians",
    "router",
    "set_guardians",
    "validate_guardians",
]
