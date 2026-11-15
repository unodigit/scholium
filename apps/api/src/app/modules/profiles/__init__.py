"""Profiles & erasure module (plugin: profiles).

Feature 28: ``PUT /v1/profiles/{did}`` lets a user save their name, affiliation
and email.  The three fields are encrypted with a per-object AES-256-GCM key
into ``profile.enc_blob``, and the key is held in the ``profile_keys`` table, so
that erasing a profile later is just deleting its key (crypto-shredding).

Feature 29: ``GET /v1/profiles/{did}`` returns the public view of a DID -- the
decrypted name, affiliation and email, the linked ORCID iD, the trust tier and
the public signed reviews.  After erasure the same route shows only the
pseudonymous DID: the personal fields and the ORCID iD read as ``null`` while
the tier and the signed reviews (public records, not personal data) remain.

Feature 178: saving a profile emails the owner a signed verification link, and
``POST /v1/profiles/{did}/verify-email`` redeems it, marking the stored address
verified.  :func:`email_verified` is the predicate tier 1 (Member) requires;
it is false until the link is redeemed and false again when a save changes the
address or the profile is erased.

Personal data lives nowhere else: records reference DIDs only.

The module loader discovers packages under ``app.modules`` automatically.
Importing this package registers the models on the shared declarative base
before ``create_app`` creates tables, and the ``router`` exported here is
mounted under ``/v1``.
"""

from __future__ import annotations

from .crypto import ProfileDecryptionError, open_profile, seal_profile
from .models import Profile, ProfileEmailVerification, ProfileKey, ensure_tables
from .router import router
from .schemas import (
    EmailVerificationOut,
    ProfileIn,
    ProfileOut,
    PublicProfileOut,
    PublicReviewOut,
    VerifyEmailIn,
)
from .service import (
    EmailVerification,
    EmailVerificationError,
    EmailVerificationTokenError,
    InvalidEmailVerificationToken,
    ProfileData,
    ProfileNotFound,
    email_verified,
    erase_profile,
    is_email_verified,
    mark_email_verified,
    read_profile,
    save_profile,
    send_verification_email,
)
from .verification import (
    DEFAULT_VERIFICATION_TTL,
    EMAIL_VERIFICATION_KIND,
    build_verification_link,
    email_fingerprint,
    issue_verification_token,
    verify_verification_token,
)
from .views import (
    ERASURE_RECORD_TYPE,
    ORCID_PATTERN,
    PublicProfile,
    SignedReview,
    public_profile,
    read_orcid,
    read_signed_reviews,
    read_tier,
)

__all__ = [
    "DEFAULT_VERIFICATION_TTL",
    "EMAIL_VERIFICATION_KIND",
    "ERASURE_RECORD_TYPE",
    "ORCID_PATTERN",
    "EmailVerification",
    "EmailVerificationError",
    "EmailVerificationOut",
    "EmailVerificationTokenError",
    "InvalidEmailVerificationToken",
    "Profile",
    "ProfileData",
    "ProfileDecryptionError",
    "ProfileEmailVerification",
    "ProfileIn",
    "ProfileKey",
    "ProfileNotFound",
    "ProfileOut",
    "PublicProfile",
    "PublicProfileOut",
    "PublicReviewOut",
    "SignedReview",
    "VerifyEmailIn",
    "build_verification_link",
    "email_fingerprint",
    "email_verified",
    "ensure_tables",
    "erase_profile",
    "is_email_verified",
    "issue_verification_token",
    "mark_email_verified",
    "open_profile",
    "public_profile",
    "read_orcid",
    "read_profile",
    "read_signed_reviews",
    "read_tier",
    "router",
    "save_profile",
    "seal_profile",
    "send_verification_email",
    "verify_verification_token",
]
