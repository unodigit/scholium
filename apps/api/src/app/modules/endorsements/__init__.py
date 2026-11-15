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

Feature 42 turns an endorsement into a submission right and exposes it:

* :func:`can_submit` answers whether a DID may submit in a category -- ``True``
  exactly when it holds an active (unexpired) endorsement for that category;
* :func:`active_endorsements` lists those endorsements;
* ``GET /v1/me/endorsements`` serves the caller's own active endorsements,
  with their expiry, through the ``router`` exported here.

Other plugins gate on the same helper::

    from app.modules.endorsements import can_submit

    can_submit(record["author"], category)

The module loader discovers packages under ``app.modules`` automatically, so
importing this package registers the record type and mounts the router under
``/v1``.
"""

from __future__ import annotations

from app.modules.ingest import register

from .models import Endorsement, ensure_tables
from .router import router
from .schemas import EndorsementOut
from .service import (
    AUTHOR_TIER,
    ENDORSEMENT_TYPE,
    ENDORSER_MIN_TIER,
    InsufficientEndorserTier,
    account_tier,
    active_endorsements,
    can_submit,
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
    "EndorsementOut",
    "InsufficientEndorserTier",
    "account_tier",
    "active_endorsements",
    "can_submit",
    "ensure_tables",
    "handle_endorsement",
    "normalise_expiry",
    "router",
    "save_endorsement",
]
