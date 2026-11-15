"""Endorsements plugin (plugin: endorsements).

Feature 41: the module owns the ``endorsement`` record type.  An endorsement
names an ``endorsee``, a ``category`` and an optional ``expiry``; the ingest
pipeline (``POST /v1/records``) verifies the envelope, the body schema, the
cid and the signature, and then calls :func:`handle_endorsement`, which

* refuses the record with ``403`` problem details unless the endorser -- the
  record's author -- holds trust tier 3 (Reviewer) or higher;
* saves the endorsement to the ``endorsements`` table, keyed by the record's
  cid, with the endorser, endorsee, category and expiry;
* grants the endorsee trust tier 2 (Author), never demoting a higher tier.

Accepting the record and applying its effects are one step, so a refused
endorsement never reaches the ledger and never changes a tier.

The module loader discovers packages under ``app.modules`` automatically.
Importing this package is what registers the type handler; there is no router
of its own yet (``GET /v1/me/endorsements`` arrives with feature 42).
"""

from __future__ import annotations

from app.modules.ingest import register

from .models import Endorsement, ensure_tables
from .service import (
    AUTHOR_TIER,
    ENDORSEMENT_TYPE,
    ENDORSER_MIN_TIER,
    InsufficientEndorserTier,
    account_tier,
    handle_endorsement,
    normalise_expiry,
    save_endorsement,
)

#: Register the type with the ingest pipeline.  ``min_tier`` is what the
#: ingest plugin enforces against the author's account tier (feature 21);
#: ``handle_endorsement`` enforces the same floor itself, so the endorsement
#: semantics do not depend on that enforcement being present.
register(ENDORSEMENT_TYPE, handle_endorsement, min_tier=ENDORSER_MIN_TIER)

__all__ = [
    "AUTHOR_TIER",
    "ENDORSEMENT_TYPE",
    "ENDORSER_MIN_TIER",
    "Endorsement",
    "InsufficientEndorserTier",
    "account_tier",
    "ensure_tables",
    "handle_endorsement",
    "normalise_expiry",
    "save_endorsement",
]
