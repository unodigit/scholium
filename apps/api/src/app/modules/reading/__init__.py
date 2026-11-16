"""Reading plugin (plugin: reading).

Feature 182: ``GET /v1/papers/{id}/v/{n}/text`` returns the version's
paragraphs -- ``paragraph_id``, ``position`` and ``text`` -- for the HTML
reading view.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package is enough to mount the router under ``/v1``.
"""

from __future__ import annotations

from . import service, visibility
from .router import router

__all__ = ["router", "service", "visibility"]
