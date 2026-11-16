"""Pre-listing visibility of a version's text and checks (plugin: reading).

Which callers may read a version's extracted paragraphs -- through
``GET /v1/papers/{id}/v/{n}/text``, ``GET /v1/papers/{id}/compare`` or the
advisory report of ``GET /v1/papers/{id}/v/{n}/checks`` -- is decided here,
not in the routes, so the rule reads in one place.  It is the rule
:mod:`app.modules.content.visibility` applies to the version's bytes:

* a ``listed`` version is public, exactly as before;
* while the version is **not** ``listed`` -- ``awaiting_consent``,
  ``scanning``, ``moderation``, ``held``, ``rejected``, ``draft``, or a state
  this node never stored -- its text is pre-listing content
  (tech_architect threat 15), because the checks pipeline extracts the
  paragraphs as soon as the version enters ``moderation``, before any
  moderator has approved it.  Only **the version's authors** and
  **moderators (tier 4)** may read it; everyone else, anonymous callers
  included, gets the routes' unknown-version ``404`` -- the same answer as
  for a version this node does not hold, so a refusal never reveals that
  unlisted content exists.

Authors and moderators keep their access on purpose: the moderation queue
reviews the very text and checks these routes serve.

The submissions plugin is imported when the check runs, not when this
package loads, for the same reason :mod:`app.modules.reading.service` defers
its imports.  When that plugin is not installed there are no authorship rows
to consult, so only moderators read unlisted versions -- the fail-closed
side, like every unknown state here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from app.security import Principal, Tier

if TYPE_CHECKING:  # imported only for types: service imports this module.
    from .service import VersionRef

__all__ = [
    "MODERATOR_TIER",
    "may_read",
]

#: The trust tier that may read any version (``Tier.MODERATOR``).
MODERATOR_TIER = int(Tier.MODERATOR)


def may_read(ref: "VersionRef", principal: Optional[Principal]) -> bool:
    """Whether ``principal`` may read version ``ref``'s text and checks.

    ``principal`` is ``None`` for an anonymous caller.  See the module
    docstring for the rule; in short, a refusal is reserved for a version
    that is not ``listed`` and a caller who is neither one of its authors
    nor a moderator.  An unknown state refuses: this node cannot prove the
    version was ever listed.
    """
    if ref.state == _listed_state():
        return True
    if principal is None:
        return False
    if principal.tier >= MODERATOR_TIER:
        return True
    return _is_author(ref.version_cid, principal.did)


def _listed_state() -> str:
    """The ``listed`` state's name, straight from the submissions plugin."""
    try:
        from app.modules import submissions
    except Exception:  # pragma: no cover - a plugin-less node
        return "listed"
    return submissions.LISTED


def _is_author(version_cid: object, did: str) -> bool:
    """Whether ``did`` is listed among ``version_cid``'s authors."""
    try:
        from app.modules import submissions

        authors = submissions.authorship_for(version_cid)
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        return False
    return any(getattr(row, "author_did", None) == did for row in authors)
