"""Record envelope handling and record id computation.

A Scholium record is a signed envelope::

    {
      "v": 1,
      "type": "paper.version",
      "author": "did:key:z6Mk...",
      "created": "2026-11-14T05:33:00Z",
      "prev": "bafyrei... | null",
      "body": {...},
      "proofs": [...],
      "id": "bafyrei...",
      "sig": "..."
    }

The record id is a CIDv1 (dag-cbor codec, sha2-256, base32) computed over
the DAG-CBOR encoding of the seven content fields ``v``, ``type``,
``author``, ``created``, ``prev``, ``body`` and ``proofs``.  The ``id``
and ``sig`` fields are excluded from the hash, so signing or re-signing a
record never changes its id.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

import dag_cbor
from dag_cbor.encoding.err import DAGCBOREncodingError
from multiformats import CID

#: Envelope fields that are hashed into the record id, in envelope order.
ENVELOPE_FIELDS: tuple[str, ...] = (
    "v",
    "type",
    "author",
    "created",
    "prev",
    "body",
    "proofs",
)

#: Envelope fields explicitly excluded from the record id.
EXCLUDED_FIELDS: tuple[str, ...] = ("id", "sig")

#: CID parameters used for record ids.
CID_VERSION = 1
CID_CODEC = "dag-cbor"
CID_CODEC_CODE = 0x71
CID_HASH = "sha2-256"
CID_BASE = "base32"


def _require_string(envelope: Mapping[str, Any], field: str) -> None:
    value = envelope[field]
    if not isinstance(value, str) or not value:
        raise ValueError(
            f"envelope field {field!r} must be a non-empty string, "
            f"got {type(value).__name__}"
        )


def canonical_envelope(envelope: Mapping[str, Any]) -> dict[str, Any]:
    """Return the seven id-relevant envelope fields, validated.

    The result is a plain mapping containing exactly ``ENVELOPE_FIELDS``.
    ``id``, ``sig`` and any other extra keys are ignored, mirroring the
    hash rule for record ids.

    Raises:
        ValueError: if ``envelope`` is not a mapping, a required field is
            missing, or a field has the wrong type.
    """
    if not isinstance(envelope, Mapping):
        raise ValueError(
            f"envelope must be a mapping, got {type(envelope).__name__}"
        )
    missing = [field for field in ENVELOPE_FIELDS if field not in envelope]
    if missing:
        raise ValueError(
            "envelope is missing required field(s): " + ", ".join(missing)
        )

    v = envelope["v"]
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        raise ValueError(
            f"envelope field 'v' must be a positive integer, got {v!r}"
        )
    for field in ("type", "author", "created"):
        _require_string(envelope, field)
    prev = envelope["prev"]
    if prev is not None and not isinstance(prev, str):
        raise ValueError(
            "envelope field 'prev' must be a string CID or null, "
            f"got {type(prev).__name__}"
        )
    body = envelope["body"]
    if not isinstance(body, Mapping):
        raise ValueError(
            f"envelope field 'body' must be a mapping, got {type(body).__name__}"
        )
    proofs = envelope["proofs"]
    if isinstance(proofs, (str, bytes)) or not isinstance(proofs, (list, tuple)):
        raise ValueError(
            f"envelope field 'proofs' must be a sequence, got {type(proofs).__name__}"
        )

    return {field: envelope[field] for field in ENVELOPE_FIELDS}


def record_bytes(envelope: Mapping[str, Any]) -> bytes:
    """Return the canonical DAG-CBOR bytes the record id is computed over.

    The bytes encode exactly the ``ENVELOPE_FIELDS`` of ``envelope`` in
    canonical DAG-CBOR form (map keys sorted length-first then bytewise,
    minimal integer heads).  ``id`` and ``sig`` never appear in them.

    Raises:
        ValueError: if validation fails or the envelope contains values
            that have no canonical DAG-CBOR encoding.
    """
    canonical = canonical_envelope(envelope)
    try:
        return dag_cbor.encode(canonical)
    except DAGCBOREncodingError as exc:
        raise ValueError(f"envelope is not DAG-CBOR encodable: {exc}") from exc


def compute_record_cid(envelope: Mapping[str, Any]) -> CID:
    """Return the record id of ``envelope`` as a CIDv1 dag-cbor object."""
    digest = hashlib.sha256(record_bytes(envelope)).digest()
    return CID(
        base=CID_BASE,
        version=CID_VERSION,
        codec=CID_CODEC,
        digest=(CID_HASH, digest),
    )


def compute_record_id(envelope: Mapping[str, Any]) -> str:
    """Return the record id of ``envelope`` as a base32 CIDv1 string.

    The id is ``CIDv1(dag-cbor, sha2-256)`` over :func:`record_bytes`.
    Changing ``id`` or ``sig`` never changes the result; changing any of
    the seven content fields always does.
    """
    return str(compute_record_cid(envelope))
