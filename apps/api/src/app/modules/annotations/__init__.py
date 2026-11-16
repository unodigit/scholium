"""Annotations plugin (plugin: annotations).

Feature 103: ``POST /v1/annotations`` accepts a signed ``discussion.post``
record whose anchor names a version cid, ``paragraph_id``, ``quote`` and
``offset``, and answers ``201``.  The record flows through the standard
ingest pipeline; this package registers the ``discussion.post`` handler so
the type is known on a node with the annotations plugin installed.

Feature 104: ``GET /v1/papers/{id}/v/{n}/annotations`` returns the
annotations of version ``n`` of paper ``id`` grouped by ``paragraph_id``,
so each one re-attaches to the same paragraph on reload.
``GET /v1/papers/{id}/annotations`` is the same read for the paper's latest
version, for a client that does not name one.

An annotation is a ``discussion.post``, and posting to discussion is a tier-1
action (REV-1), so this package registers the type at tier 1 -- never weaker.
The discussion plugin registers the same type the same way, and whichever
package the loader imports first wins: the second sees the registration and
leaves it alone instead of conflicting with it or loosening its tier.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to register the handler and mount the
router under ``/v1``.
"""

from __future__ import annotations

from app.modules import ingest
from app.security import Tier

from . import service
from .router import router


def _ensure_record_type() -> None:
    """Register ``discussion.post`` at tier 1 unless the discussion plugin already did."""
    if ingest.get(service.DISCUSSION_POST_TYPE) is None:
        ingest.register(
            service.DISCUSSION_POST_TYPE,
            service.handle_annotation,
            min_tier=int(Tier.MEMBER),
        )


_ensure_record_type()

__all__ = ["router", "service"]
