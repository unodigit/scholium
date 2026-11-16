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
its ``files``.  The manifest bodies live in the ledger, so resolving that is
a read of every ``manifest`` entry -- the same resolution
:mod:`app.modules.moderation.tombstones` makes when a takedown names a
version.

The submissions and ledger plugins are imported when the check runs, not when
this package loads: submissions imports this package (a manifest must prove
its bytes exist), so a module-level import would be circular.  When neither
plugin is installed the lookups find no rows and every blob stays public,
which is the standalone behaviour of feature 44.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from app import db
from app.security import Principal

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
    from app.modules import ledger, submissions
    from app.modules.ledger.models import EventLog
    from app.modules.submissions.models import Authorship, PaperVersion

    ledger.ensure_table()
    submissions.ensure_tables()

    with db.SessionLocal() as session:
        # Only the two columns the check needs: a full ``EventLog`` row would
        # also load the record's raw bytes and chain hashes.
        manifest_cids = {
            record_cid
            for record_cid, body in session.query(
                EventLog.record_cid, EventLog.body
            ).filter(EventLog.record_type == submissions.MANIFEST_TYPE)
            if _lists(body, cid)
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


def _lists(body: Any, cid: str) -> bool:
    """Whether a ``manifest`` record ``body`` names file ``cid``."""
    if not isinstance(body, Mapping):
        return False
    files = body.get("files")
    if not isinstance(files, list):
        return False
    return any(
        isinstance(item, Mapping) and item.get("cid") == cid for item in files
    )
