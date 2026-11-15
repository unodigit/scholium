"""Cross-language test vectors for record ids (``vectors/records.json``).

The vector file is the shared source of truth between language ports of
the record core: every implementation must derive each vector's
``dag_cbor_hex`` and ``id`` from its ``envelope`` alone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .envelope import compute_record_id, record_bytes


def refresh_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every vector's ``dag_cbor_hex`` and ``id`` in place.

    Only the expected outputs are rewritten; envelopes (including their
    illustrative ``id``/``sig`` members) are preserved verbatim.
    """
    for vector in doc["vectors"]:
        envelope = vector["envelope"]
        vector["dag_cbor_hex"] = record_bytes(envelope).hex()
        vector["id"] = compute_record_id(envelope)
    return doc


def dumps_vectors(doc: dict[str, Any]) -> str:
    """Serialize a vector document to its stable on-disk text form."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def load_vectors(path: str | Path) -> dict[str, Any]:
    """Load a vector document from ``path``."""
    return json.loads(Path(path).read_text(encoding="utf-8"))
