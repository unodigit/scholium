"""Cross-language test vectors for the record core (``vectors/*.json``).

The vector files are the shared source of truth between language ports of
the record core:

* ``records.json`` -- every implementation must derive each vector's
  ``dag_cbor_hex`` and ``id`` from its ``envelope`` alone.
* ``short_ids.json`` -- every implementation must derive each vector's
  ``short_id`` and ``version_ids`` from its ``genesis_cid`` alone, and
  reject every entry of ``invalid``.
* ``file_ids.json`` -- every implementation must derive each vector's
  ``digest_hex`` and ``cid`` from its ``bytes_hex`` alone, and reject
  every entry of ``invalid``.
* ``manifests.json`` -- every implementation must canonicalize each
  vector's ``body`` into ``files``, and reject every entry of
  ``invalid`` with the stated error kind.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from multiformats import CID

from .envelope import compute_record_id, record_bytes
from .file_id import compute_file_id
from .manifest import validate_manifest_body
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


def refresh_file_id_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every file id vector's expected outputs in place.

    ``digest_hex`` and ``cid`` are rewritten from ``bytes_hex``; the
    ``bytes_hex`` inputs and the ``invalid`` inputs are preserved
    verbatim.
    """
    for vector in doc["vectors"]:
        data = bytes.fromhex(vector["bytes_hex"])
        vector["digest_hex"] = hashlib.sha256(data).hexdigest()
        vector["cid"] = compute_file_id(data)
    return doc


def refresh_manifest_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every manifest vector's canonical ``files`` in place.

    ``files`` is rewritten as :func:`validate_manifest_body` renders the
    vector's ``body``; the ``body`` inputs (which may carry scrambled
    key order) and the ``invalid`` inputs are preserved verbatim.
    """
    for vector in doc["vectors"]:
        vector["files"] = validate_manifest_body(vector["body"])["files"]
    return doc


def dumps_vectors(doc: dict[str, Any]) -> str:
    """Serialize a vector document to its stable on-disk text form."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def load_vectors(path: str | Path) -> dict[str, Any]:
    """Load a vector document from ``path``."""
    return json.loads(Path(path).read_text(encoding="utf-8"))
