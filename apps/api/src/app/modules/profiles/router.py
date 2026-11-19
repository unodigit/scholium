"""HTTP routes for the profiles plugin.

The module loader mounts this router under ``/v1``:

* ``PUT /v1/profiles/{did}`` (feature 28) -- the owner saves their name,
  affiliation and email.  The fields are encrypted under a per-object key into
  ``profile.enc_blob``; the key lives in ``profile_keys``.  Answers ``200`` with
  the saved profile.  Saving again replaces the earlier profile.
* ``GET /v1/profiles/{did}`` (feature 29) -- anyone reads the public view of a
  DID: the decrypted name and affiliation, the linked ORCID iD, the trust
  tier and the public signed reviews, with ``erased`` saying which of the two
  states the profile is in.  No authentication is required -- a profile is
  the DID's public face, and signed reviews are shown on it for public credit
  -- but a token that is *sent* and unusable is still a ``401``, never
  silently ignored, so a caller who meant to identify themselves finds out
  (the stance ``GET /v1/auth/orcid/start`` takes).  The email is personal
  data (PRD ID-7, tech_architect section 12), so it is only filled in for the
  owner reading their own profile; anonymous and different-DID callers read
  ``null`` there.  Personal data makes the response uncacheable (``no-store``),
  as with the PUT.
* ``POST /v1/profiles/{did}/verify-email`` (feature 178) -- redeems the token
  from a verification link and returns ``200`` with ``email_verified: true``.
  The token is the credential: it reaches the address's owner by email and is
  bound to this DID and this address, so the route works from a mail client
  without a signed-in session.  A caller who *does* send a token must be this
  DID (a ``403`` otherwise, like the PUT); one that is sent and unusable is a
  ``401``.  A missing, forged, expired or address-changed token is ``400``
  problem details, and a DID with no readable profile is ``404``.  A successful
  redemption also runs the tier-1 promotion check (feature 34): tier 1 needs a
  verified email *and* a linked ORCID iD, and the iD cannot be linked twice,
  so the order of the two onboarding steps must not decide whether the account
  is ever promoted -- completing either half runs the same check.
* ``POST /v1/profiles/{did}/verify-email/resend`` (feature 178) emails the
  owner a fresh link for the address already saved.  It is the expired-link
  screen's resend option and is owner-only: a DID is public, so an
  unauthenticated resend would let anyone flood an address.
* ``PUT /v1/profiles/{did}`` also emails a fresh verification link to the saved
  address (feature 178); a save with a different address clears an earlier
  verification.

Authorization for the PUT is the caller's access token, and only the owner may
write: the token's DID must equal ``{did}``.  Any trust tier may save a
profile -- an email is a precondition for tier 1, so a tier-0 reader has to be
able to.  Failures, all RFC 9457 problem documents:

* No or unusable token: ``401`` with a ``WWW-Authenticate`` challenge.
* A valid token for a different DID, whatever its tier: ``403``.  Moderators
  get no access to other people's personal data.
* A body that is missing a field or has an invalid one (blank name, malformed
  email, over-long or control characters): ``422`` listing each problem.

Authorization runs before the body is validated, so a stranger learns nothing
from the validation errors and an anonymous caller always sees ``401``.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.security import Principal, get_current_principal

from .crypto import ProfileDecryptionError
from .schemas import (
    EmailVerificationOut,
    ProfileIn,
    ProfileOut,
    PublicProfileOut,
    VerificationEmailResendOut,
    VerifyEmailIn,
)
from .service import (
    InvalidEmailVerificationToken,
    ProfileData,
    ProfileNotFound,
    erase_profile,
    mark_email_verified,
    read_profile,
    save_profile,
    send_verification_email,
)
from .views import public_profile

router = APIRouter(prefix="/profiles", tags=["profiles"])

logger = logging.getLogger(__name__)

# For the GET: no token is fine, one that is sent must be usable (see above).
_bearer = HTTPBearer(auto_error=False)


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


def require_owner(
    did: str,
    principal: Principal = Depends(get_current_principal),
) -> Principal:
    """Admit only the caller whose DID is the one in the path."""
    if principal.did != did:
        raise HTTPException(
            status_code=403,
            detail="A profile can only be changed by its owner.",
        )
    return principal


@router.get("/{did}", response_model=PublicProfileOut)
def get_profile(
    did: str,
    response: Response,
    caller: Optional[Principal] = Depends(optional_principal),
) -> PublicProfileOut:
    """Return the public view of ``did``'s profile.

    ``200`` for any DID -- one with no profile at all answers with the
    pseudonymous DID, null personal fields, tier 0 and no reviews, which is
    exactly what an erased profile answers too.  ``email`` is personal data
    and is filled in only when the caller *is* the profile's owner; an
    anonymous or different-DID caller reads ``null`` there.  A stored blob
    that will not decrypt although its key exists is corruption, not erasure,
    and answers ``500`` problem details instead of quietly impersonating one.
    """
    try:
        view = public_profile(did, viewer_did=None if caller is None else caller.did)
    except ProfileDecryptionError as exc:
        raise HTTPException(
            status_code=500,
            detail="The stored profile could not be decrypted.",
        ) from exc
    # Personal data: keep it out of shared caches and the browser's history cache.
    response.headers["Cache-Control"] = "no-store"
    return PublicProfileOut(**asdict(view))


@router.put("/{did}", response_model=ProfileOut)
def put_profile(
    did: str,
    body: ProfileIn,
    response: Response,
    _owner: Principal = Depends(require_owner),
) -> ProfileOut:
    """Encrypt and save the owner's name, affiliation and email.

    Saving also emails a verification link to the address just stored
    (feature 178).  The mail is best-effort: the save is already committed, so
    a transport problem must not turn a successful PUT into a failure.
    """
    saved = save_profile(
        did,
        ProfileData(name=body.name, affiliation=body.affiliation, email=body.email),
    )
    send_verification_email(did, saved.email)
    # Personal data: keep it out of shared caches and the browser's history cache.
    response.headers["Cache-Control"] = "no-store"
    return ProfileOut(did=did, name=saved.name, affiliation=saved.affiliation, email=saved.email)


@router.post("/{did}/verify-email", response_model=EmailVerificationOut)
def verify_email(
    did: str,
    response: Response,
    token: Optional[str] = Query(default=None, description="the token from the emailed link"),
    body: Optional[VerifyEmailIn] = Body(default=None),
    caller: Optional[Principal] = Depends(optional_principal),
) -> EmailVerificationOut:
    """Redeem the emailed verification token and mark the address verified.

    A successful redemption also runs the tier-1 promotion check (feature 34),
    so completing the email half of the Member pair promotes exactly like
    completing the ORCID half does; see the module docstring.
    """
    if caller is not None and caller.did != did:
        raise HTTPException(
            status_code=403,
            detail="A profile's email can only be verified by its owner.",
        )

    resolved = token if token is not None else (body.token if body is not None else None)
    if resolved is None or not resolved.strip():
        raise HTTPException(
            status_code=400,
            detail="A verification token is required.",
        )

    try:
        mark_email_verified(did, resolved.strip())
    except ProfileNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail="There is no profile to verify for this DID.",
        ) from exc
    except InvalidEmailVerificationToken as exc:
        raise HTTPException(
            status_code=400,
            detail="The email verification link is invalid or has expired.",
        ) from exc

    # The redemption may complete the tier-1 pair (feature 34): a verified
    # email and a linked ORCID iD.  The link itself runs the same check, but
    # an iD cannot be linked twice, so when the iD came first this redemption
    # is the pair's last step and must promote too.  The orcid plugin exports
    # the check for exactly this caller; it is imported lazily because that
    # plugin already imports this one lazily (a top-level import would be
    # circular).  Best-effort, like the link's own check: the verification is
    # already committed, so a failure is logged, not raised.
    try:
        from app.modules.orcid import promote_if_eligible

        promote_if_eligible(did)
    except Exception:
        logger.exception("could not promote %s to tier 1 after verifying the email", did)

    # The answer reflects personal state (whether this DID's address was proven).
    response.headers["Cache-Control"] = "no-store"
    return EmailVerificationOut(did=did, email_verified=True)


@router.post("/{did}/verify-email/resend", response_model=VerificationEmailResendOut, status_code=202)
def resend_verification_email(
    did: str,
    response: Response,
    _owner: Principal = Depends(require_owner),
) -> VerificationEmailResendOut:
    """Email the owner a fresh verification link for the address already saved.

    The expired-link screen offers this.  Only the owner may ask: an iD is
    public, so an unauthenticated resend would let anyone flood an address.
    """
    profile = read_profile(did)
    if profile is None:
        raise HTTPException(
            status_code=404,
            detail="There is no profile to verify for this DID.",
        )
    if send_verification_email(did, profile.email) is None:
        raise HTTPException(
            status_code=503,
            detail="The verification email could not be sent right now.",
        )
    # The answer reflects personal state (whether this DID's address was written to).
    response.headers["Cache-Control"] = "no-store"
    return VerificationEmailResendOut(did=did, sent=True)


@router.delete("/{did}", status_code=202)
def delete_profile(
    did: str,
    _owner: Principal = Depends(require_owner),
) -> None:
    """Crypto-shred the owner's profile and record the erasure (returns 202)."""
    erase_profile(did)
