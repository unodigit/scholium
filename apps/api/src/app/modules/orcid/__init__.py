"""ORCID plugin (plugin: orcid).

Feature 31: ``GET /v1/auth/orcid/start`` returns the ORCID authorize URL with a
signed ``state`` parameter.  The URL is built from ``ORCID_BASE_URL`` and points
at the ORCID sandbox (``https://sandbox.orcid.org``) unless the operator sets
that variable.  See :mod:`app.modules.orcid.router` for the contract and
:mod:`app.modules.orcid.state` for the state's claims.

For the callback (feature 32): :func:`verify_state` checks the ``state`` ORCID
sends back and returns its claims.  The ``did`` claim is present only when
``/start`` was called with a valid access token, in which case it is that
token's DID -- it is never taken from a query string.

The module loader discovers packages under ``app.modules`` by scan and mounts
the ``router`` exported here under ``/v1``; nothing else needs wiring.
"""

from __future__ import annotations

from .models import Credential, ensure_tables as ensure_credential_tables
from .router import (
    AUTHORIZE_PATH,
    CALLBACK_PATH,
    DEFAULT_ORCID_BASE_URL,
    ORCID_AUTH_SCOPE,
    OrcidStartResponse,
    authorize_endpoint,
    build_authorize_url,
    callback_url,
    orcid_base_url,
    router,
)
from .service import exchange_code, issue_orcid_credential
from .present import (
    CREDENTIAL_PRESENTATION_INVALID,
    CREDENTIAL_SIGNATURE_INVALID,
    CREDENTIAL_STATUS_INVALID,
    PRESENT_PATH,
    InvalidCredentialPresentation,
    InvalidCredentialSignature,
    InvalidCredentialStatus,
    PresentationVerified,
    verify_presentation,
)
from .state import (
    STATE_ALGORITHM,
    STATE_PURPOSE,
    STATE_TTL,
    InvalidState,
    sign_state,
    verify_state,
)

__all__ = [
    "AUTHORIZE_PATH",
    "CALLBACK_PATH",
    "CREDENTIAL_PRESENTATION_INVALID",
    "CREDENTIAL_SIGNATURE_INVALID",
    "CREDENTIAL_STATUS_INVALID",
    "Credential",
    "DEFAULT_ORCID_BASE_URL",
    "InvalidCredentialPresentation",
    "InvalidCredentialSignature",
    "InvalidCredentialStatus",
    "InvalidState",
    "ORCID_AUTH_SCOPE",
    "OrcidStartResponse",
    "PRESENT_PATH",
    "PresentationVerified",
    "STATE_ALGORITHM",
    "STATE_PURPOSE",
    "STATE_TTL",
    "authorize_endpoint",
    "build_authorize_url",
    "callback_url",
    "ensure_credential_tables",
    "exchange_code",
    "issue_orcid_credential",
    "orcid_base_url",
    "router",
    "sign_state",
    "verify_presentation",
    "verify_state",
]
