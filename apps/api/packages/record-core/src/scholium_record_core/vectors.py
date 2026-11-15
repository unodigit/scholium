"""Cross-language test vectors for the record core (``vectors/*.json``).

The vector files are the shared source of truth between language ports of
the record core:

* ``records.json`` -- every implementation must derive each vector's
  ``dag_cbor_hex`` and ``id`` from its ``envelope`` alone.
* ``short_ids.json`` -- every implementation must derive each vector's
  ``short_id`` and ``version_ids`` from its ``genesis_cid`` alone, and
  reject every entry of ``invalid``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from multiformats import CID

from .envelope import compute_record_id, record_bytes
from .short_id import derive_short_id, format_version_id


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


def refresh_short_id_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every short id vector's expected outputs in place.

    ``digest_hex``, ``short_id`` and the values of ``version_ids`` are
    rewritten from ``genesis_cid``; the genesis CIDs, the version numbers
    (the keys of ``version_ids``) and the ``invalid`` inputs are preserved
    verbatim.
    """
    for vector in doc["vectors"]:
        genesis_cid = vector["genesis_cid"]
        short_id = derive_short_id(genesis_cid)
        vector["digest_hex"] = bytes(CID.decode(genesis_cid).raw_digest).hex()
        vector["short_id"] = short_id
        vector["version_ids"] = {
            number: format_version_id(short_id, int(number))
            for number in vector["version_ids"]
        }
    return doc


def dumps_vectors(doc: dict[str, Any]) -> str:
    """Serialize a vector document to its stable on-disk text form."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def load_vectors(path: str | Path) -> dict[str, Any]:
    """Load a vector document from ``path``."""
    return json.loads(Path(path).read_text(encoding="utf-8"))
