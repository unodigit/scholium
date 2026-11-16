"""Pre-listing visibility of stored bytes (plugin: content).

Which callers ``GET /v1/content/{cid}`` may serve a blob to is decided here,
not in the router, so the rule reads in one place:

* a blob **no version references** is public once the sanitizer passed it --
  avatars, import snapshots and freshly uploaded files are not part of any
  paper under moderation, and feature 44's contract ("a passed blob returns
  200") is about exactly those;
* a blob a ``paper.version`` references through its ``manifest`` record is
  public only once **at least one referencing version is ``listed``**;
* while every referencing version is still unlisted -- ``awaiting_consent``,
  ``scanning``, ``moderation``, ``held``, ``rejected``, ``draft`` -- the bytes
  are pre-listing (tech_architect threat 15): only **the referencing
  versions' authors** and **moderators (tier 4)** may read them.  Everyone
  else, anonymous callers included, gets the router's ``404``: the same answer
  as for a cid nothing is stored for, so a refusal never reveals that
  unlisted content exists.

A version references a blob when its ``manifest`` record lists the cid among
its ``files``.  The manifest bodies live in the ledger, and reading them all
on every download made a request cost as much as the node was large, so
:mod:`app.modules.content.refs` keeps the answer -- which manifests list a
cid -- in an index that the ledger feeds and that this check reads by primary
key.  The index holds exactly the manifests the scan used to find, so the rule
above is unchanged.

The submissions plugin is imported when the check runs, not when this package
loads: submissions imports this package (a manifest must prove its bytes
exist), so a module-level import would be circular.  When it is not installed
the lookups find no rows and every blob stays public, which is the standalone
behaviour of feature 44.
"""

from __future__ import annotations

from typing import Optional

from app import db
from app.security import Principal

from . import refs
from .refs import ContentRef

__all__ = [
    "MODERATOR_TIER",
    "may_read",
]

#: The trust tier that may read any blob (``Tier.MODERATOR``).
MODERATOR_TIER = 4


def may_read(cid: object, principal: Optional[Principal]) -> bool:
    """Whether ``principal`` may be served the bytes stored for ``cid``.

    ``principal`` is ``None`` for an anonymous caller.  See the module
    docstring for the rule; in short, a refusal is reserved for bytes every
    referencing version has left unlisted and the caller is neither one of
    those versions' authors nor a moderator.
    """
    if not isinstance(cid, str) or not cid:
        # Not a cid: nothing is stored under it, so there is nothing to keep
        # private.  The router answers 404 before this is consulted anyway.
        return True

    # Imported here, not above: submissions imports this package, and doing
    # so while it is still initialising would be circular at load time.
    from app.modules import submissions
    from app.modules.submissions.models import Authorship, PaperVersion

    # Make the content-reference index current before trusting it: when it is
    # (the normal case) that is two indexed point lookups.  It also creates
    # the tables the lookups below read.
    refs.sync()

    with db.SessionLocal() as session:
        manifest_cids = {
            manifest_cid
            for (manifest_cid,) in session.query(ContentRef.manifest_cid).filter(
                ContentRef.content_cid == cid
            )
        }
        if not manifest_cids:
            # No submission ever named these bytes: not pre-listing content.
            return True

        versions = (
            session.query(PaperVersion.version_cid, PaperVersion.state)
            .filter(PaperVersion.manifest_cid.in_(manifest_cids))
            .all()
        )
        if any(state == submissions.LISTED for _cid, state in versions):
            # A moderator listed a version naming these bytes: public.
            return True
        if principal is None:
            return False
        if principal.tier >= MODERATOR_TIER:
            return True
        author = (
            session.query(Authorship.author_did)
            .filter(
                Authorship.version_cid.in_(
                    version_cid for version_cid, _state in versions
                ),
                Authorship.author_did == principal.did,
            )
            .first()
        )
        return author is not None
