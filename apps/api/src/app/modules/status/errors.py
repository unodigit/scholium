"""Errors raised by the paper status plugin (plugin: status).

These are plain Python exceptions, not HTTP ones: ``compute_status`` is a
library function the ledger subscription (and anything else that needs a
paper's standing) calls.  Only an invalid *argument* raises; every oddity in
a well-formed record -- a missing field, an unknown recommendation, an
unparseable timestamp -- is handled by the documented rules instead.
"""

from __future__ import annotations

__all__ = ["InvalidRecordError", "StatusError"]


class StatusError(Exception):
    """Base class for paper status failures."""


class InvalidRecordError(StatusError, ValueError):
    """``records`` is not an iterable of record envelopes.

    Raised when a single record (or a string) is passed instead of a
    collection, or when an item is neither a mapping nor an object that can
    be dumped to one (such as the ledger's ``RecordEnvelope`` model).
    """
