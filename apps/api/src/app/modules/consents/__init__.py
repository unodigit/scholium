"""Co-author consent plugin (plugin: consents).

Feature 54: a ``coauthor.consent`` record (version, role, decision accept or
decline) is accepted only from a DID listed on that version, saving
``consent_cid`` to the ``authorship`` table and rejecting others with ``403``.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package registers the record type and mounts any router.
"""

from __future__ import annotations

from app.modules.ingest import register

from . import service
from .models import ensure_tables
from .service import *

# Keep the package-level names in sync with the service module.
register(COAUTHOR_CONSENT_TYPE, service.handle_consent, min_tier=0)

__all__ = list(service.__all__) + ["service", "ensure_tables"]
