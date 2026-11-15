"""HTTP routes for the profiles plugin.

The module loader mounts this router under ``/v1``:

* ``PUT /v1/profiles/{did}`` (feature 28) -- the owner saves their name,
  affiliation and email.  The fields are encrypted under a per-object key into
  ``profile.enc_blob``; the key lives in ``profile_keys``.  Answers ``200`` with
  the saved profile.  Saving again replaces the earlier profile.

Authentication is the caller's access token, and only the owner may write:
the token's DID must equal ``{did}``.  Any trust tier may save a profile -- an
email is a precondition for tier 1, so a tier-0 reader has to be able to.
Failures, all RFC 9457 problem documents:

* No or unusable token: ``401`` with a ``WWW-Authenticate`` challenge.
* A valid token for a different DID, whatever its tier: ``403``.  Moderators
  get no access to other people's personal data.
* A body that is missing a field or has an invalid one (blank name, malformed
  email, over-long or control characters): ``422`` listing each problem.

Authorization runs before the body is validated, so a stranger learns nothing
from the validation errors and an anonymous caller always sees ``401``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from app.security import Principal, get_current_principal

from .schemas import ProfileIn, ProfileOut
from .service import ProfileData, save_profile

router = APIRouter(prefix="/profiles", tags=["profiles"])


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


@router.put("/{did}", response_model=ProfileOut)
def put_profile(
    did: str,
    body: ProfileIn,
    response: Response,
    _owner: Principal = Depends(require_owner),
) -> ProfileOut:
    """Encrypt and save the owner's name, affiliation and email."""
    saved = save_profile(
        did,
        ProfileData(name=body.name, affiliation=body.affiliation, email=body.email),
    )
    # Personal data: keep it out of shared caches and the browser's history cache.
    response.headers["Cache-Control"] = "no-store"
    return ProfileOut(did=did, name=saved.name, affiliation=saved.affiliation, email=saved.email)
