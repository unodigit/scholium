"""Scholium record core (Python).

Canonical envelope handling and record id computation for Scholium
signed records.  Record ids are CIDv1 (dag-cbor codec, sha2-256) over
the DAG-CBOR encoding of the envelope content fields, excluding ``id``
and ``sig``.

Papers and paper versions are addressed by stable ``sch:xxxx-xxxx-xxxx``
and ``sch:xxxx-xxxx-xxxx/vN`` short ids derived from the genesis record
CID (see :mod:`scholium_record_core.short_id`).
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
from .short_id import (
    MAX_VERSION,
    SHORT_ID_ALPHABET,
    SHORT_ID_CHECKSUM_LENGTH,
    SHORT_ID_GROUP_SIZE,
    SHORT_ID_PAYLOAD_LENGTH,
    SHORT_ID_PREFIX,
    VersionId,
    derive_short_id,
    format_version_id,
    parse_short_id,
    parse_version_id,
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
    "MAX_VERSION",
    "SHORT_ID_ALPHABET",
    "SHORT_ID_CHECKSUM_LENGTH",
    "SHORT_ID_GROUP_SIZE",
    "SHORT_ID_PAYLOAD_LENGTH",
    "SHORT_ID_PREFIX",
    "VersionId",
    "canonical_envelope",
    "compute_record_cid",
    "compute_record_id",
    "derive_short_id",
    "format_version_id",
    "parse_short_id",
    "parse_version_id",
    "record_bytes",
]
