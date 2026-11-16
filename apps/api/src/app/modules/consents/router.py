"""HTTP routes for the consents plugin (feature 56).

The module loader mounts ``router`` under ``/v1``, so this package serves:

* ``GET /v1/papers/{id}/v/{n}/consents`` -- return every author listed on
  version ``n`` of paper ``id`` together with the status of their consent::

      {
        "paper": "sch:xxxx-xxxx-xxxx",
        "version": 2,
        "versionCid": "bafyrei...",
        "state": "awaiting_consent",
        "declinedBy": null,
        "count": 3,
        "waiting": 1,
        "signed": 2,
        "declined": 0,
        "authors": [
          {"did": "did:key:z6Mk...", "author": "did:key:z6Mk...",
           "position": 1, "status": "signed", "decision": "accept",
           "consentCid": "bafyrei...", "role": "Conceptualization",
           "creditRoles": ["Conceptualization"]},
          {"did": "did:key:z6Mk...", "author": "did:key:z6Mk...",
           "position": 2, "status": "waiting", "decision": null,
           "consentCid": null, "role": null, "creditRoles": null}
        ]
      }

  ``status`` is ``waiting`` before the author signs, ``signed`` when their
  ``coauthor.consent`` accepted authorship and ``declined`` when it refused
  it.  ``state`` is the version's lifecycle state: it stays
  ``awaiting_consent`` until every listed author has accepted, moves to
  ``scanning`` then, and drops back to ``draft`` when one author declines --
  ``declinedBy`` names that author (feature 55).  ``{id}`` is the paper's
  ``sch:`` short id (a full genesis cid is accepted too) and ``{n}`` its
  version number.

  An unknown short id, a paper with no such version, or a malformed id
  answers ``404`` problem details -- a malformed id is simply not a paper this
  node holds.  Reading is public, like reading a record.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from app.security import InvalidAccessToken, Principal, decode_access_token

from . import service

__all__ = ["ConsentAuthorOut", "PaperConsents", "router"]

#: Router the module loader mounts under ``/v1``.
router = APIRouter(tags=["consents"])


#: Bearer credentials, read only to widen access to an unlisted version.
_bearer = HTTPBearer(auto_error=False)


def _optional_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """The caller when the request carries a usable token, otherwise ``None``.

    Reading is public; a token matters only for a version that is not listed
    yet, where it carries the caller's authorship or moderator tier.  A token
    that is present but unusable is ignored rather than turning a readable
    page into a ``401`` (the same courtesy ``content.router`` pays its
    readers).
    """
    if credentials is None:
        return None
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken:
        return None


class ConsentAuthorOut(BaseModel):
    """One listed author and the status of their consent, on the wire."""

    model_config = ConfigDict(extra="allow")

    #: The author's DID (the canonical field).
    did: str
    #: Alias of ``did`` for clients that name the author ``author``.
    author: str
    #: 1-based byline position.
    position: int
    #: ``waiting``, ``signed`` or ``declined``.
    status: str
    #: The raw decision (``accept``/``decline``) or ``null`` while waiting.
    decision: Optional[str] = None
    #: cid of the author's ``coauthor.consent`` record, once signed.
    consentCid: Optional[str] = None
    #: The CRediT role the consent record names, when it names one.
    role: Optional[str] = None
    #: The CRediT roles the version lists for this author, if any.
    creditRoles: Optional[list[str]] = None


class PaperConsents(BaseModel):
    """The response body of ``GET /v1/papers/{id}/v/{n}/consents``."""

    model_config = ConfigDict(extra="forbid")

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: The version number from the URL.
    version: int
    #: cid of the ``paper.version`` record for that version.
    versionCid: str
    #: The version's lifecycle state (``awaiting_consent``, ``scanning``, ...).
    state: str
    #: The DID of the author who declined and sent the version back to
    #: ``draft`` (feature 55), or ``null`` when nobody has declined.
    declinedBy: Optional[str] = None
    #: Number of listed authors.
    count: int
    #: How many authors have not signed yet.
    waiting: int
    #: How many authors accepted authorship.
    signed: int
    #: How many authors declined authorship.
    declined: int
    #: One entry per listed author, in byline order.
    authors: list[ConsentAuthorOut]


def _not_found(paper_id: str, n: int):
    """A 404 problem response for a paper/version this node does not hold."""
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No paper {paper_id!r} has a version {n} on this node.",
    )


def _author_out(entry: service.ConsentEntry) -> ConsentAuthorOut:
    return ConsentAuthorOut(
        did=entry.did,
        author=entry.did,
        position=entry.position,
        status=entry.status,
        decision=entry.decision,
        consentCid=entry.consent_cid,
        role=entry.role,
        creditRoles=entry.credit_roles,
    )


@router.get(
    "/papers/{paper_id}/v/{n}/consents",
    response_model=PaperConsents,
    summary="List a paper version's authors and their consent status",
)
def get_paper_consents(
    paper_id: str,
    n: int,
    principal: Optional[Principal] = Depends(_optional_principal),
) -> PaperConsents:
    """Return every author of version ``n`` with status waiting, signed or declined."""
    try:
        version = service.resolve_version(paper_id, n)
    except ValueError:
        # Not a well-formed paper id or version number: nothing can be stored
        # under it, so it is simply not a paper this node has.
        version = None
    if version is None:
        raise _not_found(paper_id, n)

    # Pre-listing visibility: an unlisted version's co-author list is private to
    # its authors and to tier-4 moderators, the same rule the reading routes
    # apply to every other read of an unlisted version.  Everyone else,
    # anonymous callers included, gets the unknown-version 404 so the answer
    # never reveals that the unlisted version exists.
    if not service.may_read(version, principal):
        raise _not_found(paper_id, n)

    entries = service.consents_for_version(version.version_cid)
    authors = [_author_out(entry) for entry in entries]
    return PaperConsents(
        paper=version.paper,
        version=n,
        versionCid=version.version_cid,
        state=version.state,
        declinedBy=service.first_decliner(entries),
        count=len(authors),
        waiting=sum(1 for entry in entries if entry.status == service.STATUS_WAITING),
        signed=sum(1 for entry in entries if entry.status == service.STATUS_SIGNED),
        declined=sum(1 for entry in entries if entry.status == service.STATUS_DECLINED),
        authors=authors,
    )
