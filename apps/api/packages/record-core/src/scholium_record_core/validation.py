"""Backward-friendly alias for :mod:`scholium_record_core.schemas`.

Some callers reach for ``scholium_record_core.validation`` when they
want body validation; this module keeps that import working without a
second implementation.
"""

from .schemas import (  # noqa: F401
    RECORD_TYPES,
    SCHEMA_DIR,
    SUPPORTED_RECORD_TYPES,
    RecordValidationError,
    UnknownRecordTypeError,
    assert_valid_body,
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

__all__ = [
    "RECORD_TYPES",
    "SCHEMA_DIR",
    "SUPPORTED_RECORD_TYPES",
    "RecordValidationError",
    "UnknownRecordTypeError",
    "assert_valid_body",
    "available_types",
    "check_schemas",
    "get_schema",
    "has_schema",
    "is_valid_body",
    "list_record_types",
    "load_all_schemas",
    "load_schema",
    "schema_dir",
    "schema_for",
    "schema_path",
    "validate",
    "validate_body",
    "validate_body_errors",
    "validate_envelope",
    "validate_record",
    "validate_record_body",
]
