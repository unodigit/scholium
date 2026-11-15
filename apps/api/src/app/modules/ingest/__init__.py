"""Record ingest module (plugin: ingest).

Feature 19: the record-type handler registry. Modules call
``register(record_type, handler, min_tier)`` at import time, and
``lookup(record_type)`` resolves a type to its handler and minimum trust tier,
raising :class:`UnknownRecordType` (``422`` problem details) for a type nobody
registered. See :mod:`app.modules.ingest.registry` for the semantics.

The module loader discovers packages under ``app.modules`` automatically.
Importing this package is all a record-owning module needs::

    from app.modules.ingest import register
"""

from __future__ import annotations

from .errors import UNKNOWN_RECORD_TYPE, UnknownRecordType
from .registry import (
    HandlerRegistration,
    RecordHandler,
    get,
    lookup,
    register,
    registered_types,
    unregister,
)

__all__ = [
    "UNKNOWN_RECORD_TYPE",
    "HandlerRegistration",
    "RecordHandler",
    "UnknownRecordType",
    "get",
    "lookup",
    "register",
    "registered_types",
    "unregister",
]
