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
    "DEFAULT_ORCID_BASE_URL",
    "InvalidState",
    "ORCID_AUTH_SCOPE",
    "OrcidStartResponse",
    "STATE_ALGORITHM",
    "STATE_PURPOSE",
    "STATE_TTL",
    "authorize_endpoint",
    "build_authorize_url",
    "callback_url",
    "orcid_base_url",
    "router",
    "sign_state",
    "verify_state",
]
