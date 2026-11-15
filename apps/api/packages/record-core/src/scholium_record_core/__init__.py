"""Scholium record core (Python).

Canonical envelope handling and record id computation for Scholium
signed records.  Record ids are CIDv1 (dag-cbor codec, sha2-256) over
the DAG-CBOR encoding of the envelope content fields, excluding ``id``
and ``sig``.

Records are signed by their author's Ed25519 key over those same
canonical bytes, and authors are identified by `did:key` Ed25519
identifiers (see :mod:`scholium_record_core.signing`).

Files are addressed by file ids: CIDv1 (raw codec, sha2-256) over the
file bytes (see :mod:`scholium_record_core.file_id`).  ``manifest``
record bodies -- the ``files`` list of ``path``/``cid``/``size``/
``mediaType``/``role`` entries tying a paper version to its content --
are validated by :mod:`scholium_record_core.manifest`.

Record bodies are validated against the JSON Schemas shipped in
``schemas/`` (see :mod:`scholium_record_core.schemas`).

Papers and paper versions are addressed by stable ``sch:xxxx-xxxx-xxxx``
and ``sch:xxxx-xxxx-xxxx/vN`` short ids derived from the genesis record
CID (see :mod:`scholium_record_core.short_id`).

A whole paper is verified from a set of records by
:func:`~scholium_record_core.verify.verify_paper`: it follows ``prev``
links from the newest version to the genesis record, checks every
signature, every prev hash and a consent from every listed author, applies
retraction, correction and tombstone supersession, and returns a
:class:`~scholium_record_core.verify.VerificationReport`.
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
from .file_id import (
    FILE_BASE,
    FILE_CODEC,
    FILE_CODEC_CODE,
    FILE_HASH,
    FILE_ID_PREFIX,
    compute_file_cid,
    compute_file_id,
    parse_file_cid,
)
from .manifest import (
    FILE_FIELDS,
    FILE_ROLES,
    FILES_FIELD,
    MANIFEST_TYPE,
    MAX_FILE_SIZE,
    MAX_PATH_LENGTH,
    validate_manifest_body,
    validate_manifest_entry,
)
from .schemas import (
    RECORD_TYPES,
    SCHEMA_DIR,
    SUPPORTED_RECORD_TYPES,
    RecordValidationError,
    UnknownRecordTypeError,
    assert_valid_body,
    all_schemas,
    available_types,
    check_schemas,
    get_schema,
    has_schema,
    is_valid_body,
    list_record_types,
    load_all_schemas,
    load_schema,
    schema_dir,
    schema_for,
    schema_path,
    validate,
    validate_body,
    validate_body_errors,
    validate_envelope,
    validate_record,
    validate_record_body,
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
from .signing import (
    DID_KEY_PREFIX,
    DID_KEY_SCHEME_PREFIX,
    ED25519_MULTICODEC,
    ED25519_PUBLIC_KEY_LENGTH,
    ED25519_SEED_LENGTH,
    ED25519_SIGNATURE_LENGTH,
    SIG_ENCODING,
    decode_signature,
    did_key_from_public_key,
    did_key_from_signing_key,
    encode_signature,
    is_ed25519_did_key,
    public_key_from_did_key,
    sign_envelope,
    sign_record,
    verify_envelope,
    verify_record,
)

from .verify import (
    CHECK_NAMES,
    CONSENT_ACCEPT,
    CONSENT_DECLINE,
    CONSENT_TYPE,
    CORRECTION_TYPE,
    GENESIS_TYPE,
    KIND_CORRECTION,
    KIND_RETRACTION,
    KIND_TOMBSTONE,
    MODERATION_TYPE,
    RETRACTION_TYPE,
    STATUS_CORRECTED,
    STATUS_INVALID,
    STATUS_RETRACTED,
    STATUS_TOMBSTONED,
    STATUS_VERIFIED,
    STATUSES,
    TOMBSTONE_ACTION,
    VERSION_TYPE,
    CheckResult,
    Supersession,
    VerificationReport,
    verify_paper,
)

__version__ = "0.1.0"

__all__ = [
    "CHECK_NAMES",
    "CID_BASE",
    "CID_CODEC",
    "CID_CODEC_CODE",
    "CID_HASH",
    "CID_VERSION",
    "CONSENT_ACCEPT",
    "CONSENT_DECLINE",
    "CONSENT_TYPE",
    "CORRECTION_TYPE",
    "CheckResult",
    "DID_KEY_PREFIX",
    "DID_KEY_SCHEME_PREFIX",
    "ED25519_MULTICODEC",
    "ED25519_PUBLIC_KEY_LENGTH",
    "ED25519_SEED_LENGTH",
    "ED25519_SIGNATURE_LENGTH",
    "ENVELOPE_FIELDS",
    "EXCLUDED_FIELDS",
    "FILES_FIELD",
    "FILE_BASE",
    "FILE_CODEC",
    "FILE_CODEC_CODE",
    "FILE_FIELDS",
    "FILE_HASH",
    "FILE_ID_PREFIX",
    "FILE_ROLES",
    "GENESIS_TYPE",
    "KIND_CORRECTION",
    "KIND_RETRACTION",
    "KIND_TOMBSTONE",
    "MANIFEST_TYPE",
    "MAX_FILE_SIZE",
    "MAX_PATH_LENGTH",
    "MAX_VERSION",
    "MODERATION_TYPE",
    "RECORD_TYPES",
    "RETRACTION_TYPE",
    "SCHEMA_DIR",
    "SHORT_ID_ALPHABET",
    "SHORT_ID_CHECKSUM_LENGTH",
    "SHORT_ID_GROUP_SIZE",
    "SHORT_ID_PAYLOAD_LENGTH",
    "SHORT_ID_PREFIX",
    "SIG_ENCODING",
    "STATUSES",
    "STATUS_CORRECTED",
    "STATUS_INVALID",
    "STATUS_RETRACTED",
    "STATUS_TOMBSTONED",
    "STATUS_VERIFIED",
    "SUPPORTED_RECORD_TYPES",
    "Supersession",
    "TOMBSTONE_ACTION",
    "VERSION_TYPE",
    "VerificationReport",
    "VersionId",
    "RecordValidationError",
    "UnknownRecordTypeError",
    "assert_valid_body",
    "all_schemas",
    "available_types",
    "canonical_envelope",
    "check_schemas",
    "compute_file_cid",
    "compute_file_id",
    "compute_record_cid",
    "compute_record_id",
    "decode_signature",
    "derive_short_id",
    "did_key_from_public_key",
    "did_key_from_signing_key",
    "encode_signature",
    "format_version_id",
    "get_schema",
    "has_schema",
    "is_ed25519_did_key",
    "is_valid_body",
    "list_record_types",
    "load_all_schemas",
    "load_schema",
    "parse_file_cid",
    "parse_short_id",
    "parse_version_id",
    "public_key_from_did_key",
    "record_bytes",
    "schema_dir",
    "schema_for",
    "schema_path",
    "sign_envelope",
    "sign_record",
    "validate",
    "validate_body",
    "validate_body_errors",
    "validate_envelope",
    "validate_manifest_body",
    "validate_manifest_entry",
    "validate_record",
    "validate_record_body",
    "verify_envelope",
    "verify_paper",
    "verify_record",
]
