"""Co-author consent plugin (plugin: consents).

Feature 54: a ``coauthor.consent`` record (version, role, decision accept or
decline) is accepted only from a DID listed on that version, saving
``consent_cid`` to the ``authorship`` table and rejecting others with ``403``.

Feature 56: ``GET /v1/papers/{id}/v/{n}/consents`` returns each author listed
on version ``n`` of paper ``id`` with status ``waiting``, ``signed`` or
``declined``, so the consent tracker can show who still has to sign.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package registers the record type and mounts the router under
``/v1``.
"""

from __future__ import annotations

from app.modules.ingest import register

from . import service
from .models import ensure_tables
from .router import router
from .service import *

# Keep the package-level names in sync with the service module.
register(COAUTHOR_CONSENT_TYPE, service.handle_consent, min_tier=0)

__all__ = list(service.__all__) + ["ensure_tables", "router", "service"]
