"""ORCID plugin (plugin: orcid).

Feature 31: ``GET /v1/auth/orcid/start`` returns the ORCID authorize URL with a
signed ``state`` parameter.  The URL is built from ``ORCID_BASE_URL`` and points
at the ORCID sandbox (``https://sandbox.orcid.org``) unless the operator sets
that variable.  See :mod:`app.modules.orcid.router` for the contract and
:mod:`app.modules.orcid.state` for the state's claims.

For finishing the link (feature 32): ORCID redirects the browser to the web
app's ``/onboarding/orcid`` page, which calls the authenticated
``POST /v1/auth/orcid/complete`` with ``{code, state}``.  :func:`verify_state`
checks the ``state`` and returns its claims.  The ``did`` claim is present only
when ``/start`` was called with a valid access token, in which case it is that
token's DID -- it is never taken from a query string -- and ``/complete``
refuses (``403``) any caller whose DID is not that one, before the state is
consumed.  The old unauthenticated ``GET /v1/auth/orcid/callback`` answers
``410``: it trusted that DID, so any browser that completed the redirect linked
its ORCID iD to whichever DID had started the flow.

Feature 33: linking stores the nullifier ``H(issuer || orcid || domain)`` in the
``nullifiers`` table, so one ORCID iD maps to one active DID; a second link of
the same iD is ``409`` problem details (:class:`OrcidAlreadyLinked`).  See
:mod:`app.modules.orcid.nullifier`.

Feature 34: once a credential is linked and the owner's email is verified,
linking saves tier 1 (Member) to the ``accounts`` row of an account that is
still at tier 0.  See :mod:`app.modules.orcid.promotion`.

The module loader discovers packages under ``app.modules`` by scan and mounts
the ``router`` exported here under ``/v1``; nothing else needs wiring.
"""

from __future__ import annotations

from .models import Credential, Nullifier, ensure_tables as ensure_credential_tables
from .nullifier import (
    NULLIFIER_DOMAIN,
    ORCID_ALREADY_LINKED,
    OrcidAlreadyLinked,
    claim_nullifier,
    compute_nullifier,
    credential_nullifier,
    normalise_orcid,
)
from .router import (
    AUTHORIZE_PATH,
    CALLBACK_PATH,
    COMPLETE_PATH,
    DEFAULT_ORCID_BASE_URL,
    ORCID_AUTH_SCOPE,
    ORCID_STATE_PRINCIPAL_MISMATCH,
    REDIRECT_PATH,
    OrcidCompleteRequest,
    OrcidStartResponse,
    OrcidStatePrincipalMismatch,
    authorize_endpoint,
    build_authorize_url,
    orcid_base_url,
    public_web_origin,
    redirect_uri,
    router,
)
from .service import exchange_code, issue_orcid_credential
from .promotion import (
    MEMBER_TIER,
    READER_TIER,
    has_orcid_credential,
    promote_if_eligible,
    promotion_eligible,
)
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
    consume_state,
    is_state_consumed,
    mark_state_consumed,
    sign_state,
    verify_and_consume_state,
    verify_state,
)

__all__ = [
    "AUTHORIZE_PATH",
    "CALLBACK_PATH",
    "COMPLETE_PATH",
    "CREDENTIAL_PRESENTATION_INVALID",
    "CREDENTIAL_SIGNATURE_INVALID",
    "CREDENTIAL_STATUS_INVALID",
    "Credential",
    "DEFAULT_ORCID_BASE_URL",
    "InvalidCredentialPresentation",
    "InvalidCredentialSignature",
    "InvalidCredentialStatus",
    "InvalidState",
    "MEMBER_TIER",
    "NULLIFIER_DOMAIN",
    "Nullifier",
    "ORCID_ALREADY_LINKED",
    "ORCID_AUTH_SCOPE",
    "ORCID_STATE_PRINCIPAL_MISMATCH",
    "OrcidAlreadyLinked",
    "OrcidCompleteRequest",
    "OrcidStartResponse",
    "OrcidStatePrincipalMismatch",
    "PRESENT_PATH",
    "PresentationVerified",
    "READER_TIER",
    "REDIRECT_PATH",
    "STATE_ALGORITHM",
    "STATE_PURPOSE",
    "STATE_TTL",
    "authorize_endpoint",
    "build_authorize_url",
    "claim_nullifier",
    "compute_nullifier",
    "credential_nullifier",
    "ensure_credential_tables",
    "exchange_code",
    "has_orcid_credential",
    "issue_orcid_credential",
    "normalise_orcid",
    "orcid_base_url",
    "promote_if_eligible",
    "promotion_eligible",
    "public_web_origin",
    "redirect_uri",
    "router",
    "consume_state",
    "is_state_consumed",
    "mark_state_consumed",
    "sign_state",
    "verify_and_consume_state",
    "verify_presentation",
    "verify_state",
]
