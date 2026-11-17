"""The ORCID link flow: ``GET /start`` and ``POST /complete`` (plugin: orcid).

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
(:mod:`app.modules.orcid.state`), so ``POST /v1/auth/orcid/complete`` can detect
a tampered or expired redirect without keeping per-attempt state on the server.
It is single-use: ``/complete`` consumes the state's ``jti`` on redemption, so a
captured state cannot be replayed.  It also stops being accepted after
:data:`app.modules.orcid.state.STATE_TTL`.

Who the credential is for
    The endpoint works without credentials -- a browser may start the flow
    before it holds an access token.  When the request carries an
    ``Authorization: Bearer`` access token, the token's DID is bound into the
    signed state (claim ``did``) so ``/complete`` knows which DID the ORCID
    ownership credential is for.  A caller-chosen DID is deliberately *not*
    accepted from the query string: this endpoint would sign whatever it was
    given, letting anyone start a link flow for somebody else's DID.  A bearer
    token that is present but unusable is a ``401``, not silently ignored,
    because a state without the DID the caller expected would fail later and
    far from the cause.

Where ORCID sends the browser back to
    ``redirect_uri`` is the web app's ``/onboarding/orcid`` page on the
    configured public web origin (the first entry of ``WEB_ORIGINS``), **not**
    an endpoint of this API.  A bare redirect from ORCID carries no bearer
    token, so an API endpoint behind it could only trust the DID inside the
    state -- and that DID is whoever *started* the flow, not whoever finishes
    it.  An attacker could start a flow, hand the authorize URL to a victim and
    have the victim's ORCID iD linked to the attacker's DID.  The page instead
    reads ``code`` and ``state`` from its own URL and calls ``/complete`` as the
    signed-in user.  ORCID itself refuses a redirect URI that is not registered
    for the client, so register ``<web origin>/onboarding/orcid``.  ``scope`` is
    ORCID's ``/authenticate``: the flow proves ownership of an iD, it does not
    read the member's private record.

``POST /v1/auth/orcid/complete``
    Body ``{"code": "...", "state": "..."}``, authenticated with the caller's
    bearer token.  In order:

    1. the state must verify (``400`` when forged, expired or not an ORCID
       state) and name a DID (``400``);
    2. the caller's DID must equal the state's ``did`` claim, else ``403``
       problem details -- nothing is consumed and nothing is exchanged;
    3. only then is the state's ``jti`` consumed (``400`` when already used),
       the code exchanged (``400`` when it is not a usable code, ``502`` when
       ORCID is unreachable) and the credential issued and persisted (``200``,
       or ``409`` when the iD is already linked to an active DID).

    Consuming the ``jti`` only after the principal check means a stranger who
    gets hold of a state cannot burn it: its owner can still finish.

``GET /v1/auth/orcid/callback`` is retired and answers ``410`` problem details.

With ``ORCID_MOCK=1`` the browser never leaves this node: the authorize URL
points at ``GET /v1/auth/orcid/mock/authorize`` (below), a small HTML page that
looks like ORCID's consent screen and redirects to the same web
``/onboarding/orcid`` page with a ``mock-<orcid>`` code and the state it was
given.  That exercises the real return path -- a whole-page navigation away
from the app and back -- without an ORCID client registration.  Each page
render *generates a fresh, checksum-valid iD* and offers it in an editable
field, so several newcomers on one node can each link an account (and a tester
can type in a specific iD instead).  Mock mode is refused in production by
:meth:`app.settings.Settings.validate_for_environment`, and the mock page
itself answers ``404`` unless it is on.

Failures of ``/start``:

* ``401`` problem details when a bearer token is sent but is invalid/expired.
* ``503`` problem details when ORCID is not configured: ``ORCID_MOCK`` is off
  and ``ORCID_CLIENT_ID`` is blank, so the URL could not work -- or when no
  ``WEB_ORIGINS`` entry is usable as the redirect origin.  With
  ``ORCID_MOCK=1`` (the default) a blank client id is allowed, because mock
  codes never reach ORCID.

The ``/start`` response carries a short-lived signed value, so it is sent with
``Cache-Control: no-store``.
"""

from __future__ import annotations

import html
import os
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from app.security import Principal, get_current_principal
from app.settings import settings

from app.modules.ledger.origin import node_signing_key
from .ids import generate_mock_orcid_id, is_valid_orcid_id
from .nullifier import OrcidAlreadyLinked
from .state import InvalidState, consume_state, mark_state_consumed, sign_state, verify_state
from .service import exchange_code, issue_orcid_credential
from .present import router as credentials_router

__all__ = [
    "AUTHORIZE_PATH",
    "CALLBACK_PATH",
    "COMPLETE_PATH",
    "DEFAULT_ORCID_BASE_URL",
    "MOCK_AUTHORIZE_PATH",
    "MOCK_ORCID_ID",
    "ORCID_AUTH_SCOPE",
    "ORCID_STATE_PRINCIPAL_MISMATCH",
    "OrcidCompleteRequest",
    "OrcidStartResponse",
    "OrcidStatePrincipalMismatch",
    "REDIRECT_PATH",
    "authorize_endpoint",
    "build_authorize_url",
    "mock_authorize_endpoint",
    "orcid_base_url",
    "public_web_origin",
    "redirect_uri",
    "router",
]

#: The ORCID OAuth routes, served below ``/v1/auth/orcid``.
auth_router = APIRouter(prefix="/auth/orcid", tags=["orcid"])

#: Router the module loader mounts under ``/v1``.  It carries the ORCID OAuth
#: routes and feature 35's credential presentation route (``/v1/credentials``),
#: which ships in this plugin but not below the ``/auth/orcid`` prefix.
router = APIRouter()
router.include_router(auth_router)
router.include_router(credentials_router)

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

#: Page of the *web app* ORCID sends the browser back to, below the public web
#: origin.  It finishes the flow by calling :data:`COMPLETE_PATH` as the
#: signed-in user.
REDIRECT_PATH = "/onboarding/orcid"

#: Path of the authenticated endpoint that finishes the link.
COMPLETE_PATH = "/v1/auth/orcid/complete"

#: Path of the retired unauthenticated callback; it only answers ``410`` now.
CALLBACK_PATH = "/v1/auth/orcid/callback"

#: Path of the API-served substitute for ORCID's consent screen, used when
#: ``ORCID_MOCK`` is on (dev/tests) so the full-page return path still runs.
MOCK_AUTHORIZE_PATH = "/v1/auth/orcid/mock/authorize"

#: A known-valid ORCID iD, kept as the documented example in this module and
#: as a fixture for callers.  The mock consent screen no longer issues it by
#: default: every authorization gets a freshly generated, also valid iD.
MOCK_ORCID_ID = "0000-0002-1825-0097"

#: Problem ``type`` of the ``403`` returned when the caller is not the DID the
#: state was issued to.
ORCID_STATE_PRINCIPAL_MISMATCH = "urn:scholium:problem:orcid-state-principal-mismatch"

# ``auto_error=False``: a request with no token is fine here; one with a bad
# token is rejected by ``get_current_principal`` below.
_bearer = HTTPBearer(auto_error=False)


class OrcidStatePrincipalMismatch(HTTPException):
    """The caller is not the DID this state was issued to: ``403`` problem details.

    Like the other problems of this plugin it is an :class:`fastapi.HTTPException`
    carrying the ``type``/``title``/``errors`` members ``app.errors``' handler
    renders.  The message deliberately does not name the DID the state is bound
    to: that would tell whoever holds a stray state whose flow it is.
    """

    def __init__(self) -> None:
        message = (
            "This ORCID sign-in was started by a different account. "
            "Sign in as the account that started it, or start linking your ORCID iD again."
        )
        super().__init__(status_code=403, detail=message)
        self.type = ORCID_STATE_PRINCIPAL_MISMATCH
        self.title = "Forbidden"
        self.errors = [
            {
                "loc": ["body", "state"],
                "msg": message,
                "type": "orcid_state_principal_mismatch",
            }
        ]


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


class OrcidCompleteRequest(BaseModel):
    """What the web app's ``/onboarding/orcid`` page got back from ORCID."""

    #: The authorization ``code`` ORCID put on the redirect.
    code: str
    #: The signed ``state`` ORCID echoed back, exactly as ``/start`` issued it.
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


def mock_authorize_endpoint(api_origin: Optional[str] = None) -> str:
    """Return this node's mock ORCID authorize page, absolute.

    ``api_origin`` is the origin the browser reached the API on (the request's
    base URL, so proxy headers are honoured); without it the configured
    ``NEXT_PUBLIC_API_URL`` is used, which is what the web app itself calls.
    """
    base = (api_origin or settings.NEXT_PUBLIC_API_URL or "").strip().rstrip("/")
    return base + MOCK_AUTHORIZE_PATH


def public_web_origin() -> Optional[str]:
    """Return the public origin of the web app, or ``None`` when none is configured.

    That is the first usable ``WEB_ORIGINS`` entry (an ``http(s)://host[:port]``
    URL; ``*`` and blanks are skipped), without a trailing slash.  Read on every
    call, so a changed setting takes effect without a restart.
    """
    for origin in settings.web_origins:
        candidate = origin.strip().rstrip("/")
        parts = urlsplit(candidate)
        if parts.scheme in ("http", "https") and parts.netloc:
            return candidate
    return None


def redirect_uri() -> str:
    """Return the URL ORCID sends the browser back to: the web app's ORCID page.

    Raises ``503`` problem details when no web origin is configured, because an
    authorize URL with a redirect nobody can serve would fail at ORCID.
    """
    origin = public_web_origin()
    if origin is None:
        raise HTTPException(
            status_code=503,
            detail="ORCID sign-in is not configured: set WEB_ORIGINS to the public web origin (for example https://scholium.example.org).",
        )
    return origin + REDIRECT_PATH


def build_authorize_url(
    *,
    did: Optional[str] = None,
    state: Optional[str] = None,
    base_url: Optional[str] = None,
    api_origin: Optional[str] = None,
) -> tuple[str, str]:
    """Build the authorize URL and return ``(url, state)``.

    ``state`` defaults to a freshly signed one bound to ``did`` (when given);
    callers that already minted a state may pass it in.  ``base_url`` overrides
    the configured ORCID base for this call.  The redirect is the web app's
    ``/onboarding/orcid`` page (see :func:`redirect_uri`).

    With ``ORCID_MOCK`` on and no explicit ``base_url``, the URL is this node's
    mock consent page instead of ORCID: no client registration exists in dev,
    so sending the browser to the real sandbox could never complete.  The
    query parameters are the same, so the mock page can send the browser back
    with the code and state the real one would.
    """
    signed_state = sign_state(did=did) if state is None else state
    params = {
        "client_id": settings.ORCID_CLIENT_ID or "",
        "response_type": "code",
        "scope": ORCID_AUTH_SCOPE,
        "redirect_uri": redirect_uri(),
        "state": signed_state,
    }
    endpoint = (
        mock_authorize_endpoint(api_origin)
        if settings.ORCID_MOCK and base_url is None
        else authorize_endpoint(base_url)
    )
    return f"{endpoint}?{urlencode(params)}", signed_state


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


@auth_router.get(
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

    url, state = build_authorize_url(
        did=principal.did if principal else None,
        api_origin=str(request.base_url),
    )
    # The state is signed material tied to one attempt; keep it out of caches.
    response.headers["Cache-Control"] = "no-store"
    return OrcidStartResponse(
        authorize_url=url,
        authorization_url=url,
        url=url,
        auth_url=url,
        state=state,
    )


def _redirect_is_allowed(target: str) -> bool:
    """True when ``target`` is the web app's ORCID return page.

    The mock page must not become an open redirect, even in development: it
    only ever sends the browser back to the page that started the flow, on an
    origin ``CORS`` trusts.  A ``*`` entry means "any origin" in dev, so any
    absolute http(s) URL on the return path is accepted then.
    """
    parts = urlsplit(target)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return False
    if parts.path.rstrip("/") != REDIRECT_PATH:
        return False
    if "*" in settings.web_origins:
        return True
    origin = f"{parts.scheme}://{parts.netloc}"
    return any(origin == entry.strip().rstrip("/") for entry in settings.web_origins)


def _with_query(url: str, **params: str) -> str:
    """Append/replace query parameters on ``url``."""
    parts = urlsplit(url)
    query = parse_qs(parts.query, keep_blank_values=True)
    for name, value in params.items():
        query[name] = [value]
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment)
    )


def _mock_consent_page(
    *,
    redirect_uri: str,
    state: str,
    client_id: str,
    scope: str,
    response_type: str,
    orcid: str,
) -> str:
    """The fake ORCID consent screen, as one self-contained HTML document.

    ``orcid`` is a freshly generated, checksum-valid iD offered in an editable
    field.  The tester may accept it or type another valid iD before
    authorizing; the submitted value becomes the ``mock-<orcid>`` code.
    """
    escape = html.escape
    fields = "".join(
        f'<input type="hidden" name="{name}" value="{escape(value, quote=True)}">'
        for name, value in (
            ("redirect_uri", redirect_uri),
            ("state", state),
            ("client_id", client_id),
            ("scope", scope),
            ("response_type", response_type),
        )
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in to ORCID (mock)</title>
<style>
  :root {{
    color-scheme: light dark;
    --bg: #f7f7f4; --surface: #ffffff; --ink: #1b1d22; --ink-2: #5a5f6b;
    --rule: #e4e1d9; --accent: #a6ce39; --on-accent: #1b1d22;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #14151a; --surface: #1c1e25; --ink: #ecebe6; --ink-2: #a3a7b2;
      --rule: #2c2f38; --accent: #a6ce39; --on-accent: #14151a;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 24px 16px; background: var(--bg); color: var(--ink);
    font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px; line-height: 22px;
  }}
  main {{
    width: 100%; max-width: 420px; padding: 32px 24px;
    background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.55), 0 12px 32px rgb(0 0 0 / 0.08);
  }}
  .badge {{
    display: inline-block; margin: 0 0 16px; padding: 2px 10px; border-radius: 999px;
    background: var(--accent); color: var(--on-accent);
    font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }}
  h1 {{ margin: 0 0 8px; font-size: 24px; line-height: 30px; letter-spacing: -0.01em; }}
  p {{ margin: 0 0 16px; color: var(--ink-2); }}
  .field-label {{
    display: block; margin: 0 0 6px; font-size: 13px; font-weight: 600;
    letter-spacing: 0.01em; color: var(--ink);
  }}
  .iD {{
    display: block; width: 100%; margin: 0 0 8px; padding: 12px 16px;
    border: 1px solid var(--rule); border-radius: 8px; background: transparent;
    color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 16px; line-height: 24px; min-height: 48px;
  }}
  .iD:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
  .actions {{ display: flex; gap: 12px; flex-wrap: wrap; }}
  button {{
    min-height: 44px; padding: 10px 20px; border-radius: 999px; border: 1px solid transparent;
    font: inherit; font-weight: 600; cursor: pointer;
    transition: transform 120ms ease-out, filter 120ms ease-out;
  }}
  button:active {{ transform: scale(0.97); }}
  button:focus-visible {{ outline: 2px solid var(--ink); outline-offset: 2px; }}
  .approve {{ flex: 1; background: var(--accent); color: var(--on-accent); }}
  .approve:active {{ filter: brightness(0.94); }}
  .deny {{ background: transparent; color: var(--ink-2); border-color: var(--rule); }}
  .note {{ margin: 20px 0 0; font-size: 13px; line-height: 18px; color: var(--ink-2); }}
</style>
</head>
<body>
<main>
  <p class="badge">Mock ORCID</p>
  <h1>Scholium wants to sign you in</h1>
  <p>This is a stand-in for ORCID's consent screen. No real ORCID account is
     used and nothing leaves this machine.</p>
  <form method="get" action="{escape(MOCK_AUTHORIZE_PATH, quote=True)}">
    {fields}
    <label class="field-label" for="mock-orcid">ORCID iD</label>
    <input
      class="iD"
      id="mock-orcid"
      name="orcid"
      type="text"
      value="{escape(orcid, quote=True)}"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      required
      aria-describedby="mock-orcid-hint"
    >
    <p class="note" id="mock-orcid-hint">Generated for this sign-in, so every
       newcomer gets a different iD. Accept it, or type another valid ORCID iD.</p>
    <div class="actions">
      <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
  <p class="note">ORCID would normally ask you to sign in and approve sharing
     your iD with Scholium.</p>
</main>
</body>
</html>"""


@auth_router.get(
    "/mock/authorize",
    response_class=HTMLResponse,
    summary="Mock ORCID consent screen (ORCID_MOCK only), redirecting back to the app",
)
def mock_authorize(
    redirect_uri: str = Query(..., description="the web app page to send the browser back to"),
    state: str = Query(..., description="the signed state /start issued"),
    decision: Optional[str] = Query(default=None),
    orcid: Optional[str] = Query(default=None, description="the iD to authorize"),
    client_id: str = Query(default=""),
    scope: str = Query(default=ORCID_AUTH_SCOPE),
    response_type: str = Query(default="code"),
) -> Response:
    """Show a fake ORCID consent screen, or complete it.

    The browser reaches this page from ``/start`` as a whole-page navigation
    (no bearer token, exactly like ORCID).  Without a decision the consent page
    is rendered with a freshly generated valid iD prefilled in an editable
    field, and nothing is issued.  ``decision=approve`` redirects to
    ``redirect_uri`` with ``code=mock-<orcid>`` and the original ``state`` --
    the submitted (or, when none was submitted, a freshly generated) iD, which
    must pass its ISO 7064 checksum.  ``decision=deny`` redirects with
    ``error=access_denied``.

    Only available with ``ORCID_MOCK`` on -- production configuration refuses
    that setting, and this route answers ``404`` otherwise -- and only ever
    redirects to an origin ``WEB_ORIGINS`` lists.
    """
    if not settings.ORCID_MOCK:
        raise HTTPException(status_code=404, detail="Mock ORCID is not enabled on this node.")
    if not _redirect_is_allowed(redirect_uri):
        raise HTTPException(
            status_code=400,
            detail=(
                "redirect_uri must be the web app's "
                f"{REDIRECT_PATH} page on a configured WEB_ORIGINS origin."
            ),
        )
    if not state.strip():
        raise HTTPException(status_code=400, detail="state is required.")

    if decision == "deny":
        target = _with_query(
            redirect_uri,
            error="access_denied",
            error_description="The user denied the authorization request.",
            state=state,
        )
        return RedirectResponse(target, status_code=302)
    if decision == "approve":
        chosen = (orcid or "").strip().upper() or generate_mock_orcid_id()
        if not is_valid_orcid_id(chosen):
            raise HTTPException(
                status_code=400,
                detail=(
                    "The ORCID iD must look like 0000-0002-1825-0097 and pass its "
                    "ISO 7064 check character."
                ),
            )
        target = _with_query(redirect_uri, code=f"mock-{chosen}", state=state)
        return RedirectResponse(target, status_code=302)

    response = HTMLResponse(
        _mock_consent_page(
            redirect_uri=redirect_uri,
            state=state,
            client_id=client_id,
            scope=scope,
            response_type=response_type,
            orcid=(orcid or "").strip().upper() or generate_mock_orcid_id(),
        )
    )
    # A one-time state and code: never keep this page in a shared cache.
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@auth_router.post(
    "/complete",
    summary="Finish linking an ORCID iD as the signed-in user who started the flow",
)
def complete_orcid_link(
    body: OrcidCompleteRequest,
    principal: Principal = Depends(get_current_principal),
) -> dict:
    """Verify ``state`` for the caller, exchange ``code``, issue and persist the credential.

    The caller must be the DID the state was issued to (``403`` otherwise).
    That check comes *before* the state is consumed and before the code is
    exchanged, so a refused attempt neither burns the state nor spends the code.

    ``409`` problem details when the ORCID iD is already linked to an active
    DID (see :mod:`app.modules.orcid.nullifier`).
    """
    try:
        claims = verify_state(body.state)
    except InvalidState as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    did = claims.get("did")
    if not isinstance(did, str) or not did.strip():
        raise HTTPException(
            status_code=400,
            detail="The OAuth state is not bound to a DID.",
        )

    # The state is bound to whoever *started* the flow; only they may finish it.
    # Nothing has been consumed or exchanged yet.
    if principal.did != did:
        raise OrcidStatePrincipalMismatch()

    if node_signing_key() is None:
        raise HTTPException(
            status_code=503,
            detail="This node cannot issue credentials: no usable Ed25519 key was found at NODE_KEY_PATH.",
        )

    jti = claims.get("jti")
    if not mark_state_consumed(jti):
        raise HTTPException(status_code=400, detail="The OAuth state has already been used.")

    try:
        orcid_id = exchange_code(body.code, redirect_uri=redirect_uri())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # pragma: no cover - network/HTTP errors
        raise HTTPException(status_code=502, detail=str(exc))

    try:
        credential = issue_orcid_credential(did, orcid_id)
    except OrcidAlreadyLinked:
        # 409 problem details: one ORCID iD maps to one active DID (feature 33).
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return credential


@auth_router.get(
    "/callback",
    deprecated=True,
    summary="Retired: ORCID now redirects to the web app, which calls POST /v1/auth/orcid/complete",
)
def orcid_callback_retired() -> None:
    """Always ``410``.  Takes no parameters and reads no state: it can link nothing.

    This route used to finish the flow with no authentication, trusting the DID
    inside the state; anyone who completed the ORCID redirect linked their iD
    to whichever DID had started the flow.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "GET /v1/auth/orcid/callback has been retired. ORCID now redirects to the web app's "
            f"{REDIRECT_PATH} page, which finishes linking with POST {COMPLETE_PATH} "
            "as the signed-in user."
        ),
    )
