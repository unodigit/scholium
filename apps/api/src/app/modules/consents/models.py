"""Models re-exported for the consents plugin.

The consents plugin stores its state on the submissions plugin's
``authorship`` table (``consent_cid`` / ``consent_decision``), so there is
no table of its own.  This module keeps the ``consents`` package shape
consistent with the other plugins and exposes the shared table's model and
self-healing ``ensure_tables``.
"""

from __future__ import annotations

from app.modules.submissions.models import Authorship, ensure_tables

__all__ = ["Authorship", "ensure_tables"]
