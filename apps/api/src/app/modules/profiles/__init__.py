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

Personal data lives nowhere else: records reference DIDs only.

The module loader discovers packages under ``app.modules`` automatically.
Importing this package registers the models on the shared declarative base
before ``create_app`` creates tables, and the ``router`` exported here is
mounted under ``/v1``.
"""

from __future__ import annotations

from .crypto import ProfileDecryptionError, open_profile, seal_profile
from .models import Profile, ProfileKey, ensure_tables
from .router import router
from .schemas import ProfileIn, ProfileOut, PublicProfileOut, PublicReviewOut
from .service import ProfileData, read_profile, save_profile
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
    "ERASURE_RECORD_TYPE",
    "ORCID_PATTERN",
    "Profile",
    "ProfileData",
    "ProfileDecryptionError",
    "ProfileIn",
    "ProfileKey",
    "ProfileOut",
    "PublicProfile",
    "PublicProfileOut",
    "PublicReviewOut",
    "SignedReview",
    "ensure_tables",
    "open_profile",
    "public_profile",
    "read_orcid",
    "read_profile",
    "read_signed_reviews",
    "read_tier",
    "router",
    "save_profile",
    "seal_profile",
]
