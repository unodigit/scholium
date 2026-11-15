"""Identity & access module (plugin: identity).

Feature 23: ``POST /v1/auth/challenge`` issues a single-use nonce, valid for
five minutes, to a did:key and saves it in the ``auth_challenges`` table.
Signing in is challenge-response: the client signs that nonce with the key
behind its did:key (``POST /v1/auth/verify``, a later feature, checks the
signature and consumes the nonce)::

    from app.modules import identity

    challenge = identity.issue_challenge("did:key:z6Mk...")
    challenge.nonce, challenge.expires_at, challenge.used

The module loader discovers packages under ``app.modules`` automatically and
mounts this package's ``router`` under ``/v1``; importing the package also
registers the ``AuthChallenge`` model on the shared declarative base before
``create_app`` creates tables.

``router`` is a plain parent router (no prefix) so later identity features --
verify, refresh, logout, ``GET /v1/did/{did}`` -- add themselves with
``router.include_router(...)`` and keep their own paths.

See :mod:`app.modules.identity.challenge` for the endpoint's wire format and
errors, :mod:`app.modules.identity.service` for what issuing guarantees and
:mod:`app.modules.identity.models` for the table.
"""

from __future__ import annotations

from fastapi import APIRouter

from .challenge import (
    INVALID_DID_TYPE,
    ChallengeRequest,
    ChallengeResponse,
    router as challenge_router,
)
from .models import AuthChallenge, ensure_table
from .service import (
    CHALLENGE_TTL,
    NONCE_BYTES,
    InvalidDid,
    issue_challenge,
    validate_did,
)

#: Router the module loader mounts under ``/v1``.
router = APIRouter()
router.include_router(challenge_router)

__all__ = [
    "AuthChallenge",
    "CHALLENGE_TTL",
    "ChallengeRequest",
    "ChallengeResponse",
    "INVALID_DID_TYPE",
    "InvalidDid",
    "NONCE_BYTES",
    "ensure_table",
    "issue_challenge",
    "router",
    "validate_did",
]
