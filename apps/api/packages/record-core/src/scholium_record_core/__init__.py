"""Scholium record core (Python).

Canonical envelope handling and record id computation for Scholium
signed records.  Record ids are CIDv1 (dag-cbor codec, sha2-256) over
the DAG-CBOR encoding of the envelope content fields, excluding ``id``
and ``sig``.
"""

from .envelope import (
    CID_BASE,
    CID_CODEC,
    CID_CODEC_CODE,
    CID_HASH,
    CID_VERSION,
    ENVELOPE_FIELDS,
    EXCLUDED_FIELDS,
    canonical_envelope,
    compute_record_cid,
    compute_record_id,
    record_bytes,
)

__version__ = "0.1.0"

__all__ = [
    "CID_BASE",
    "CID_CODEC",
    "CID_CODEC_CODE",
    "CID_HASH",
    "CID_VERSION",
    "ENVELOPE_FIELDS",
    "EXCLUDED_FIELDS",
    "canonical_envelope",
    "compute_record_cid",
    "compute_record_id",
    "record_bytes",
]
