"""``GET /v1/auth/orcid/start``: begin linking an ORCID iD (plugin: orcid).

The browser asks this node where to send the user to sign in at ORCID.  The
answer is the ORCID authorize URL, built from ``ORCID_BASE_URL`` (the ORCID
*sandbox*, ``https://sandbox.orcid.org``, unless the operator configured
another base) with the usual OAuth authorization-code parameters::

    GET /v1/auth/orcid/start

    200 OK
    Cache-Control: no-store
    {
      "authorize_url": "https://sandbox.orcid.org/oauth/authorize?client_id=...",
      "authorization_url": "...",     # same value, OAuth-ecosystem spelling
      "url": "...",                   # same value
      "auth_url": "...",              # same value
      "state": "eyJhbGciOiJIUzI1NiJ9..."   # signed, expiring state
    }

The spec fixes only "the authorize URL with a signed state parameter", not the
JSON member names, so the URL is offered under the spellings OAuth client code
commonly expects; ``state`` is the same value that is embedded in the URL.

``state`` is a compact HS256 JWT signed with ``settings.JWT_SECRET``
(:mod:`app.modules.orcid.state`), so ``GET /v1/auth/orcid/callback`` can detect
a tampered or expired redirect without keeping per-attempt state on the server.
It is *not* single-use: nothing here records that a state was consumed, it just
stops being accepted after :data:`app.modules.orcid.state.STATE_TTL`.

Who the credential is for
    The endpoint works without credentials -- a browser may start the flow
    before it holds an access token.  When the request carries an
    ``Authorization: Bearer`` access token, the token's DID is bound into the
    signed state (claim ``did``) so the callback knows which DID the ORCID
    ownership credential is for.  A caller-chosen DID is deliberately *not*
    accepted from the query string: this endpoint would sign whatever it was
    given, letting anyone start a link flow for somebody else's DID.  A bearer
    token that is present but unusable is a ``401``, not silently ignored,
    because a state without the DID the caller expected would fail later and
    far from the cause.

``redirect_uri`` is this request's ``/v1/auth/orcid/callback`` so the URL is
correct for whatever host serves the API (ORCID itself refuses a redirect URI
that is not registered for the client).  ``scope`` is ORCID's
``/authenticate``: the flow proves ownership of an iD, it does not read the
member's private record.

Failures:

* ``401`` problem details when a bearer token is sent but is invalid/expired.
* ``503`` problem details when ORCID is not configured: ``ORCID_MOCK`` is off
  and ``ORCID_CLIENT_ID`` is blank, so the URL could not work.  With
  ``ORCID_MOCK=1`` (the default) a blank client id is allowed, because mock
  codes never reach ORCID.

The response carries a short-lived signed value, so it is sent with
``Cache-Control: no-store``.
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from app.security import Principal, get_current_principal
from app.settings import settings

from app.modules.ledger.origin import node_signing_key
from .state import InvalidState, sign_state, verify_state
from .service import exchange_code, issue_orcid_credential

__all__ = [
    "AUTHORIZE_PATH",
    "CALLBACK_PATH",
    "DEFAULT_ORCID_BASE_URL",
    "ORCID_AUTH_SCOPE",
    "OrcidStartResponse",
    "authorize_endpoint",
    "build_authorize_url",
    "callback_url",
    "orcid_base_url",
    "router",
]

#: Router the module loader mounts under ``/v1`` (serves ``/v1/auth/orcid/start``).
router = APIRouter(prefix="/auth/orcid", tags=["orcid"])

#: ORCID's sandbox host, used unless ``ORCID_BASE_URL`` is configured.
DEFAULT_ORCID_BASE_URL = "https://sandbox.orcid.org"

#: What ``app.settings`` falls back to when ``ORCID_BASE_URL`` is not in the
#: environment.  That is ORCID *production*, which this plugin must not reach
#: by accident, so an unset variable that surfaces as this value means "sandbox".
_SETTINGS_FALLBACK_BASE_URL = "https://orcid.org"

#: Path of the OAuth authorize endpoint below the configured base URL.
AUTHORIZE_PATH = "/oauth/authorize"

#: ORCID scope that authenticates the member without reading private data.
ORCID_AUTH_SCOPE = "/authenticate"

#: Path of the callback this node serves (feature 32), below the request root.
CALLBACK_PATH = "/v1/auth/orcid/callback"

# ``auto_error=False``: a request with no token is fine here; one with a bad
# token is rejected by ``get_current_principal`` below.
_bearer = HTTPBearer(auto_error=False)


class OrcidStartResponse(BaseModel):
    """Where to send the browser, and the state to check on its return."""

    model_config = ConfigDict(extra="forbid")

    #: The ORCID authorize URL, state parameter included.
    authorize_url: str
    #: Same URL under the spelling OAuth client libraries often expose.
    authorization_url: str
    #: Same URL, short spelling.
    url: str
    #: Same URL, another common short spelling.
    auth_url: str
    #: The signed, expiring state also embedded in ``authorize_url``.
    state: str


def orcid_base_url() -> str:
    """Return the ORCID base URL to use: the configured one, else the sandbox.

    Read on every call, so a changed setting takes effect without a restart.
    Trailing slashes are removed so path joining is predictable.

    ``app.settings`` defaults ``ORCID_BASE_URL`` to production
    (``https://orcid.org``) and is not this plugin's to change, so that default
    is told apart from a deliberate choice by looking at the environment: the
    production URL counts only when ``ORCID_BASE_URL`` is actually set there.
    Any other value on the setting is taken as configured.
    """
    configured = (settings.ORCID_BASE_URL or "").strip().rstrip("/")
    if not configured:
        return DEFAULT_ORCID_BASE_URL
    explicitly_set = bool((os.environ.get("ORCID_BASE_URL") or "").strip())
    if configured == _SETTINGS_FALLBACK_BASE_URL and not explicitly_set:
        return DEFAULT_ORCID_BASE_URL
    return configured


def authorize_endpoint(base_url: Optional[str] = None) -> str:
    """Return the full ORCID authorize endpoint for ``base_url`` (or the setting)."""
    base = (base_url or orcid_base_url()).rstrip("/")
    if base.endswith(AUTHORIZE_PATH):
        return base
    return base + AUTHORIZE_PATH


def callback_url(request: Request) -> str:
    """Return this node's absolute ORCID callback URL for ``request``."""
    return str(request.base_url).rstrip("/") + CALLBACK_PATH


def build_authorize_url(
    request: Request,
    *,
    did: Optional[str] = None,
    state: Optional[str] = None,
    base_url: Optional[str] = None,
) -> tuple[str, str]:
    """Build the authorize URL and return ``(url, state)``.

    ``state`` defaults to a freshly signed one bound to ``did`` (when given);
    callers that already minted a state may pass it in.  ``base_url`` overrides
    the configured ORCID base for this call.
    """
    signed_state = sign_state(did=did) if state is None else state
    params = {
        "client_id": settings.ORCID_CLIENT_ID or "",
        "response_type": "code",
        "scope": ORCID_AUTH_SCOPE,
        "redirect_uri": callback_url(request),
        "state": signed_state,
    }
    return f"{authorize_endpoint(base_url)}?{urlencode(params)}", signed_state


def optional_principal(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """Return the caller named by a bearer token, ``None`` when none was sent.

    A token that is sent but invalid raises the 401 problem details from
    :func:`app.security.get_current_principal`.
    """
    if credentials is None:
        return None
    return get_current_principal(request, credentials)


@router.get(
    "/start",
    response_model=OrcidStartResponse,
    summary="Return the ORCID authorize URL with a signed state",
)
def start_orcid_link(
    request: Request,
    response: Response,
    principal: Optional[Principal] = Depends(optional_principal),
) -> OrcidStartResponse:
    """Return the ORCID authorize URL for this node, with a signed state."""
    if not settings.ORCID_MOCK and not (settings.ORCID_CLIENT_ID or "").strip():
        raise HTTPException(
            status_code=503,
            detail="ORCID sign-in is not configured: set ORCID_CLIENT_ID (or ORCID_MOCK=1 for tests).",
        )

    url, state = build_authorize_url(request, did=principal.did if principal else None)
    # The state is signed material tied to one attempt; keep it out of caches.
    response.headers["Cache-Control"] = "no-store"
    return OrcidStartResponse(
        authorize_url=url,
        authorization_url=url,
        url=url,
        auth_url=url,
        state=state,
    )


@router.get(
    "/callback",
    summary="Exchange an ORCID authorization code for a node-signed ORCID ownership credential",
)
def orcid_callback(
    request: Request,
    code: str,
    state: str,
) -> dict:
    """Exchange ``code`` and verify ``state``, then issue and persist the credential."""
    try:
        claims = verify_state(state)
    except InvalidState as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    did = claims.get("did")
    if not isinstance(did, str) or not did.strip():
        raise HTTPException(
            status_code=400,
            detail="The OAuth state is not bound to a DID.",
        )

    if node_signing_key() is None:
        raise HTTPException(
            status_code=503,
            detail="This node cannot issue credentials: no usable Ed25519 key was found at NODE_KEY_PATH.",
        )

    try:
        orcid_id = exchange_code(code, redirect_uri=callback_url(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # pragma: no cover - network/HTTP errors
        raise HTTPException(status_code=502, detail=str(exc))

    try:
        credential = issue_orcid_credential(did, orcid_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return credential
