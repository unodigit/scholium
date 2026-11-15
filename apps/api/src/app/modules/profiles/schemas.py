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
"""

from __future__ import annotations

import re
import unicodedata

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "AFFILIATION_MAX",
    "EMAIL_MAX",
    "NAME_MAX",
    "ProfileIn",
    "ProfileOut",
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
