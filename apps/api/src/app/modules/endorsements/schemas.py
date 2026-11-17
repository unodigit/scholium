"""API shapes for the endorsements module (feature 42).

``GET /v1/me/endorsements`` serialises each active endorsement of the caller
as a JSON object::

    {
      "record_cid": "bafyrei...",
      "endorser_did": "did:key:z6Mk...",
      "endorsee_did": "did:key:z6Mk...",
      "category": "cs.AI",
      "expires_at": "2030-01-02T03:04:05Z",
      "expiry": "2030-01-02T03:04:05Z"
    }

``expires_at`` is the instant the endorsement lapses, as an ISO 8601 UTC
string, or ``null`` for an endorsement that never expires.  ``expiry`` is the
same instant under the name the ``endorsement`` record body uses, so a client
can render a row next to the signed record without renaming fields.

``GET /v1/profiles/{did}/endorsements`` is the public read of what a DID
holds -- what its profile page lists.  It is a list of
:class:`ProfileEndorsementOut`::

    {
      "record_cid": "bafyrei...",
      "endorser_did": "did:key:z6Mk...",
      "endorser_name": "Tunde Okafor",
      "endorsee_did": "did:key:z6Mk...",
      "category": "cs.AI",
      "endorsed_at": "2026-11-17T09:30:00Z",
      "expires_at": null
    }

``endorser_name`` is the name the endorser made public (``null`` when they
have none or erased it); ``endorsed_at`` is when the node accepted the record
(``null`` for a row stored without a ledger entry).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, ConfigDict

from .models import Endorsement
from .service import PublicEndorsement

__all__ = ["EndorsementOut", "ProfileEndorsementOut"]

#: Wire form of a stored expiry: ISO 8601 UTC with a ``Z`` suffix, or ``None``.
ExpiryString = Optional[str]


def _iso_utc(value: Optional[datetime]) -> ExpiryString:
    """Render a stored naive UTC timestamp as an unambiguous ISO 8601 string."""
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


class EndorsementOut(BaseModel):
    """One active endorsement of the signed-in account."""

    model_config = ConfigDict(extra="forbid")

    record_cid: str
    endorser_did: str
    endorsee_did: str
    category: str
    #: UTC instant the endorsement lapses (ISO 8601, ``Z`` suffix) or ``null``.
    expires_at: ExpiryString = None
    #: The same instant under the ``endorsement`` record body's field name.
    expiry: ExpiryString = None

    @classmethod
    def from_row(cls, row: Endorsement) -> "EndorsementOut":
        """Map one persisted ``endorsements`` row onto its wire form."""
        expiry = _iso_utc(row.expires_at)
        return cls(
            record_cid=row.record_cid,
            endorser_did=row.endorser_did,
            endorsee_did=row.endorsee_did,
            category=row.category,
            expires_at=expiry,
            expiry=expiry,
        )


class ProfileEndorsementOut(BaseModel):
    """One endorsement a DID holds, as its public profile lists it."""

    model_config = ConfigDict(extra="forbid")

    record_cid: str
    endorser_did: str
    #: The endorser's public name, or ``null`` -- show the DID then.
    endorser_name: Optional[str] = None
    endorsee_did: str
    category: str
    #: When the node accepted the record (ISO 8601 UTC, ``Z`` suffix) or ``null``.
    endorsed_at: ExpiryString = None
    #: UTC instant the endorsement lapses (ISO 8601, ``Z`` suffix) or ``null``.
    expires_at: ExpiryString = None

    @classmethod
    def from_view(cls, view: PublicEndorsement) -> "ProfileEndorsementOut":
        """Map one :class:`PublicEndorsement` onto its wire form."""
        return cls(
            record_cid=view.record_cid,
            endorser_did=view.endorser_did,
            endorser_name=view.endorser_name,
            endorsee_did=view.endorsee_did,
            category=view.category,
            endorsed_at=_iso_utc(view.endorsed_at),
            expires_at=_iso_utc(view.expires_at),
        )
