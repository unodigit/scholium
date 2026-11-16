"""One ORCID iD, one active DID: the uniqueness nullifier (plugin: orcid).

Feature 33.  Linking an ORCID iD records a *nullifier* in the ``nullifiers``
table::

    nullifier = hex( SHA-256( issuer || orcid || domain ) )

``issuer`` is the DID of the node that signs the ORCID ownership credential,
``orcid`` the normalised iD and ``domain`` the scope the uniqueness holds in
(:data:`NULLIFIER_DOMAIN`).  The row maps the nullifier to the DID it was
claimed for.  Because the nullifier is a one-way hash, the table lets the node
refuse a second link of the same iD without keeping a plain ``orcid -> did``
lookup next to the credentials.

A second link is refused with ``409`` problem details
(:class:`OrcidAlreadyLinked`, ``application/problem+json``).  The problem does
not say *which* DID holds the iD: telling a caller that would publish exactly
the link the nullifier exists to keep private.

Encoding
    ``||`` is not a bare concatenation: each part is UTF-8 encoded and prefixed
    with its length as 4 big-endian bytes, so ``("ab", "c")`` and ``("a", "bc")``
    can never hash alike.  The iD is normalised first (:func:`normalise_orcid`):
    ``0000-0002-1825-009x``, ``https://orcid.org/0000-0002-1825-009X`` and
    ``0000-0002-1825-009X`` are one iD and give one nullifier.

"Active"
    A nullifier is held by its DID only while that DID still has a *current*
    ORCID credential for the iD.  If the credential was revoked (its row's
    status is no longer one :mod:`app.modules.orcid.present` accepts) or has
    gone, the iD is free again and the next link takes the nullifier over.
    Otherwise an iD would stay bound for ever to a DID that no longer vouches
    for it.

Concurrency
    :func:`claim_nullifier` relies on the primary key, not on a read followed
    by a write: two requests linking the same iD at the same moment cannot both
    succeed, whatever order the database interleaves them in.

The claim and the credential row are written in one transaction by
:func:`app.modules.orcid.service.issue_orcid_credential`, so a nullifier never
exists without the credential it was claimed for.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Mapping, Optional

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Credential, Nullifier
from .present import VALID_STATUSES

__all__ = [
    "NULLIFIER_DOMAIN",
    "ORCID_ALREADY_LINKED",
    "ORCID_CREDENTIAL_KIND",
    "OrcidAlreadyLinked",
    "claim_nullifier",
    "compute_nullifier",
    "credential_nullifier",
    "normalise_orcid",
]

#: Problem ``type`` of the ``409`` returned when an iD is already linked.
ORCID_ALREADY_LINKED = "urn:scholium:problem:orcid-already-linked"

#: The ``domain`` in ``H(issuer || orcid || domain)``: uniqueness is per ORCID
#: link.  A different kind of credential would use its own domain and so never
#: collide with these.
NULLIFIER_DOMAIN = "orcid"

#: ``credentials.kind`` of the rows this plugin issues for linked iDs.
ORCID_CREDENTIAL_KIND = "orcid"

# ``https://orcid.org/0000-...``, ``http://sandbox.orcid.org/0000-...``.
_ORCID_URL_PREFIX = re.compile(r"^https?://(?:www\.|sandbox\.)?orcid\.org/", re.IGNORECASE)


class OrcidAlreadyLinked(HTTPException):
    """The ORCID iD is already linked to an active DID: ``409`` problem details.

    Like the other problems of this plugin it is an :class:`fastapi.HTTPException`
    carrying the ``type``/``title``/``errors`` members ``app.errors``' handler
    renders, and does not import ``app.errors`` itself (importing it from a
    plugin starts a circular import of ``app.main``).
    """

    def __init__(self, orcid_id: Optional[str] = None) -> None:
        shown = normalise_orcid(orcid_id) if isinstance(orcid_id, str) and orcid_id.strip() else None
        subject = f"The ORCID iD {shown}" if shown else "This ORCID iD"
        message = f"{subject} is already linked to an active DID; an ORCID iD can be linked to one DID only."
        super().__init__(status_code=409, detail=message)
        self.type = ORCID_ALREADY_LINKED
        self.title = "Conflict"
        self.errors = [
            {
                "loc": ["body", "code"],
                "msg": message,
                "type": "orcid_already_linked",
            }
        ]


def normalise_orcid(orcid_id: str) -> str:
    """Return the canonical spelling of ``orcid_id`` used for hashing.

    Surrounding whitespace and a ``https://orcid.org/`` style prefix are
    removed and the check character is upper-cased (``...009x`` is ``...009X``),
    so every way of writing one iD gives the same nullifier.  Text that is not
    shaped like an iD is still returned (stripped and upper-cased) rather than
    refused: whether a code carries a real iD is the code exchange's concern.
    """
    text = _ORCID_URL_PREFIX.sub("", orcid_id.strip()).strip().strip("/")
    return text.upper()


def _part(value: str) -> bytes:
    data = value.encode("utf-8")
    return len(data).to_bytes(4, "big") + data


def compute_nullifier(issuer: str, orcid_id: str, domain: str = NULLIFIER_DOMAIN) -> str:
    """Return ``hex(SHA-256(issuer || orcid || domain))`` for one ORCID link.

    All three parts must be non-empty strings; the iD is normalised with
    :func:`normalise_orcid`.  The result is 64 lower-case hex characters.
    """
    for name, value in (("issuer", issuer), ("orcid_id", orcid_id), ("domain", domain)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"a non-empty {name} is required")
    digest = hashlib.sha256()
    for part in (issuer, normalise_orcid(orcid_id), domain):
        digest.update(_part(part))
    return digest.hexdigest()


def credential_nullifier(vc: Any) -> Optional[str]:
    """Return the nullifier of an ORCID credential document, or ``None``.

    ``vc`` is the credential as a mapping or as the JSON text the
    ``credentials`` table stores.  ``None`` means the document does not name an
    issuer and an iD, so no nullifier can be derived from it.
    """
    if isinstance(vc, (str, bytes)):
        try:
            vc = json.loads(vc)
        except ValueError:
            return None
    if not isinstance(vc, Mapping):
        return None

    issuer = vc.get("issuer")
    if isinstance(issuer, Mapping):
        issuer = issuer.get("id")
    subject = vc.get("credentialSubject")
    orcid_id = subject.get("orcid") if isinstance(subject, Mapping) else None
    if not isinstance(issuer, str) or not isinstance(orcid_id, str):
        return None
    try:
        return compute_nullifier(issuer, orcid_id)
    except ValueError:
        return None


def _holder(session: Session, nullifier: str) -> Optional[str]:
    return session.execute(
        select(Nullifier.did).where(Nullifier.nullifier == nullifier)
    ).scalar_one_or_none()


def _is_active(session: Session, nullifier: str, did: str) -> bool:
    """True when ``did`` still holds a current ORCID credential for ``nullifier``."""
    rows = session.execute(
        select(Credential.status, Credential.vc).where(
            Credential.did == did, Credential.kind == ORCID_CREDENTIAL_KIND
        )
    ).all()
    return any(
        str(status).strip().casefold() in VALID_STATUSES
        and credential_nullifier(vc) == nullifier
        for status, vc in rows
    )


def claim_nullifier(
    session: Session,
    nullifier: str,
    did: str,
    *,
    orcid_id: Optional[str] = None,
) -> None:
    """Record ``did`` as the holder of ``nullifier``, or raise :class:`OrcidAlreadyLinked`.

    The row is only added to ``session``: the caller commits it together with
    whatever depends on it (the credential).  ``orcid_id`` is used for the
    wording of the refusal only.

    * No row yet: it is inserted.  If another request inserted it first the
      primary key refuses ours, the session is rolled back and the answer is
      the refusal.
    * A row exists and its holder is still active (see the module docstring):
      refused, including when the holder is ``did`` itself -- the iD is
      already linked.
    * A row exists but its holder no longer holds a current credential: ``did``
      takes it over.  The update names the holder it saw, so a concurrent
      takeover cannot be overwritten.
    """
    holder = _holder(session, nullifier)

    if holder is None:
        session.add(Nullifier(nullifier=nullifier, did=did))
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            if _holder(session, nullifier) is None:
                raise  # not the duplicate we were expecting
            raise OrcidAlreadyLinked(orcid_id) from None
        return

    if _is_active(session, nullifier, holder):
        raise OrcidAlreadyLinked(orcid_id)

    taken = session.execute(
        update(Nullifier)
        .where(Nullifier.nullifier == nullifier, Nullifier.did == holder)
        .values(did=did)
    )
    if taken.rowcount != 1:
        raise OrcidAlreadyLinked(orcid_id)
