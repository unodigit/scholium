"""Annotations plugin (plugin: annotations).

Feature 103: ``POST /v1/annotations`` accepts a signed ``discussion.post``
record whose anchor names a version cid, ``paragraph_id``, ``quote`` and
``offset``, and answers ``201``.  The record flows through the standard
ingest pipeline; this package registers the ``discussion.post`` handler so
the type is known on a node with the annotations plugin installed.

Feature 104: ``GET /v1/papers/{id}/v/{n}/annotations`` returns the
annotations of version ``n`` of paper ``id`` grouped by ``paragraph_id``,
so each one re-attaches to the same paragraph on reload.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to register the handler and mount the
router under ``/v1``.
"""

from __future__ import annotations

from app.modules.ingest import register

from . import service
from .router import router

register("discussion.post", service.handle_annotation, min_tier=0)

__all__ = ["router", "service"]
