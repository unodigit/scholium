"""Record ingest module (plugin: ingest).

Feature 19: the record-type handler registry. Modules call
``register(record_type, handler, min_tier)`` at import time, and
``lookup(record_type)`` resolves a type to its handler and minimum trust tier,
raising :class:`UnknownRecordType` (``422`` problem details) for a type nobody
registered. See :mod:`app.modules.ingest.registry` for the semantics.

Feature 20: ``POST /v1/records`` takes a client-signed record through the
ingest pipeline -- envelope and body validation, cid recomputation, signature
verification against the author's active key, the registered type handler, and
the ledger append -- and answers ``201`` with the record's ``id``, the paper's
``shortId`` (when it has one), the handler-reported ``state`` and
``"anchor": "pending"``.  See :mod:`app.modules.ingest.service` for the
pipeline and the handler contract.

Feature 22: ``POST /v1/records`` honours an ``Idempotency-Key`` header.  The
first ``201`` is stored in the ``idempotency_keys`` table, and a repeat of the
key replays it instead of running the pipeline again.  See
:mod:`app.modules.ingest.idempotency`.

The module loader discovers packages under ``app.modules`` automatically.
Importing this package is all a record-owning module needs::

    from app.modules.ingest import register

and importing it also mounts the endpoint, because the ``router`` exported
here is wired under ``/v1``.
"""

from __future__ import annotations

from .errors import (
    DUPLICATE_RECORD,
    IDEMPOTENCY_KEY_REUSED,
    INVALID_IDEMPOTENCY_KEY,
    INVALID_RECORD,
    INVALID_RECORD_SIGNATURE,
    RECORD_ID_MISMATCH,
    UNKNOWN_RECORD_TYPE,
    DuplicateRecord,
    IdempotencyKeyReused,
    InvalidIdempotencyKey,
    InvalidRecord,
    InvalidRecordSignature,
    RecordIdMismatch,
    UnknownRecordType,
)
from .models import IdempotencyKey
from .registry import (
    HandlerRegistration,
    RecordHandler,
    get,
    lookup,
    register,
    registered_types,
    unregister,
)
from .router import RecordAccepted, router
from .service import (
    ANCHOR_PENDING,
    DEFAULT_STATE,
    PAPER_GENESIS_TYPE,
    PAPER_VERSION_TYPE,
    IngestResult,
    active_signing_key,
    ingest,
    record_short_id,
)

__all__ = [
    "ANCHOR_PENDING",
    "DEFAULT_STATE",
    "DUPLICATE_RECORD",
    "DuplicateRecord",
    "HandlerRegistration",
    "IDEMPOTENCY_KEY_REUSED",
    "INVALID_IDEMPOTENCY_KEY",
    "INVALID_RECORD",
    "INVALID_RECORD_SIGNATURE",
    "IdempotencyKey",
    "IdempotencyKeyReused",
    "IngestResult",
    "InvalidIdempotencyKey",
    "InvalidRecord",
    "InvalidRecordSignature",
    "PAPER_GENESIS_TYPE",
    "PAPER_VERSION_TYPE",
    "RECORD_ID_MISMATCH",
    "RecordAccepted",
    "RecordHandler",
    "RecordIdMismatch",
    "UNKNOWN_RECORD_TYPE",
    "UnknownRecordType",
    "active_signing_key",
    "get",
    "ingest",
    "lookup",
    "record_short_id",
    "register",
    "registered_types",
    "router",
    "unregister",
]
