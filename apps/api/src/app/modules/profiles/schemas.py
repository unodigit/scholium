"""API shapes for the profiles module.

``PUT /v1/profiles/{did}`` takes the whole profile -- a PUT replaces it::

    {"name": "Ada Lovelace",
     "affiliation": "Analytical Engine Co.",
     "email": "ada@example.org"}

``name`` and ``email`` must be non-blank; ``affiliation`` is required but may be
empty (an independent researcher has none).  Leading and trailing whitespace is
trimmed.  Unknown members are ignored, so nothing but these three fields -- in
particular no trust tier -- can be written through this route.  The response
echoes the saved profile with the owning ``did``.

``GET /v1/profiles/{did}`` (feature 29) answers with the public view assembled
in :mod:`app.modules.profiles.views`::

    {"did": "did:key:z6Mk...",
     "name": "Ada Lovelace",          # null once erased
     "affiliation": "Analytical Engine Co.",
     "email": "ada@example.org",      # only when the caller is the owner
     "orcid": "0000-0002-1825-0097",  # null: not linked, or erased
     "tier": 1,
     "erased": false,
     "reviews": [{"review_cid": "sch:...", ...}]}

Every personal member is nullable: "nothing to show" is a normal answer for a
DID that never saved a profile, and it is the *only* answer after erasure.
``email`` is also ``null`` for anyone but the owner: it is personal data, not
part of the DID's public face.  ``tier`` and ``reviews`` are never personal
data, so they always appear.

``POST /v1/profiles/{did}/verify-email`` (feature 178) takes the token from the
emailed link either as a query parameter (the link itself) or as a small JSON
body::

    {"token": "v1.…"}

and answers ``200`` with the state it just set::

    {"did": "did:key:z6Mk...", "email_verified": true}
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "AFFILIATION_MAX",
    "EMAIL_MAX",
    "NAME_MAX",
    "EmailVerificationOut",
    "ProfileIn",
    "ProfileOut",
    "PublicProfileOut",
    "PublicReviewOut",
    "VerifyEmailIn",
]

NAME_MAX = 200
AFFILIATION_MAX = 300
EMAIL_MAX = 254  # RFC 5321 limit for a forward-path

# Deliberately pragmatic: one "@", no whitespace, and a dotted domain.  Real
# deliverability is proven by the verification link, not by a regex.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$")


def _reject_control_characters(value: str) -> str:
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise ValueError("must not contain control characters")
    return value


class ProfileIn(BaseModel):
    """The personal data a user saves about themselves."""

    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=NAME_MAX)
    affiliation: str = Field(max_length=AFFILIATION_MAX)
    email: str = Field(max_length=EMAIL_MAX)

    @field_validator("name", "affiliation", "email")
    @classmethod
    def _no_control_characters(cls, value: str) -> str:
        return _reject_control_characters(value)

    @field_validator("email")
    @classmethod
    def _looks_like_an_email(cls, value: str) -> str:
        if not _EMAIL.match(value):
            raise ValueError("must be a valid email address")
        return value


class ProfileOut(BaseModel):
    """A saved profile, as returned to its owner."""

    did: str
    name: str
    affiliation: str
    email: str


class VerifyEmailIn(BaseModel):
    """The token carried by an emailed verification link (JSON-body form)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    token: str = Field(min_length=1)


class EmailVerificationOut(BaseModel):
    """The state ``POST /v1/profiles/{did}/verify-email`` leaves behind."""

    did: str
    email_verified: bool = True


class PublicReviewOut(BaseModel):
    """One revealed review the DID signed, for public credit.

    The rubric scores pass through as stored.  ``review_key`` and ``nullifier``
    have no member here on purpose: the pseudonymity material must never leave
    the ``review`` table.
    """

    review_cid: str
    version_cid: str
    recommendation: Optional[str] = None
    confidence: Optional[int] = None
    scores: Optional[Any] = None
    report_cid: Optional[str] = None
    committed_at: Optional[datetime] = None
    revealed_at: Optional[datetime] = None


class PublicProfileOut(BaseModel):
    """The public view of a DID: who they are, and what they signed.

    A member that is ``null`` is one there is nothing to say about; ``did``,
    ``tier``, ``erased`` and ``reviews`` are always present.  ``email`` is
    populated only for the owner's own read: it is personal data.
    """

    did: str
    name: Optional[str] = None
    affiliation: Optional[str] = None
    email: Optional[str] = None
    orcid: Optional[str] = None
    tier: int = 0
    erased: bool = False
    reviews: list[PublicReviewOut] = Field(default_factory=list)
