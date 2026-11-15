"""Annotation handler for ``discussion.post`` records (plugin: annotations).

Feature 103: ``POST /v1/annotations`` accepts a signed ``discussion.post``
record whose anchor names a version cid, a ``paragraph_id``, a ``quote`` and
an ``offset``.  The record flows through the standard ingest pipeline; this
module owns the ``discussion.post`` type handler so that type is known to
the registry on a node that has the annotations plugin installed.
"""

from __future__ import annotations

from typing import Any


def handle_annotation(record: dict[str, Any]) -> None:
    """Accept an inline annotation record.

    Validation of the envelope, body schema, cid and signature happens in the
    ingest pipeline before this handler runs; nothing extra is required here
    for the record to be appended to the event log.
    """
    return None
