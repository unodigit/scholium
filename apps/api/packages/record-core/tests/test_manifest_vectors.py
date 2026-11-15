"""Tests for the cross-language manifest vectors (vectors/manifests.json)."""

import copy
import json
import re
from pathlib import Path

import pytest

from scholium_record_core import (
    FILE_FIELDS,
    FILE_ROLES,
    FILES_FIELD,
    MANIFEST_TYPE,
    MAX_FILE_SIZE,
    MAX_PATH_LENGTH,
    compute_record_id,
    validate_manifest_body,
)
from scholium_record_core.vectors import (
    dumps_vectors,
    load_vectors,
    refresh_manifest_vectors,
)

VECTORS_PATH = Path(__file__).resolve().parents[1] / "vectors" / "manifests.json"
RECORDS_PATH = VECTORS_PATH.with_name("records.json")

#: What the error message must mention for each invalid kind.
KIND_PATTERNS = {
    "body": r"manifest (body|field)",
    "path": "path",
    "cid": "cid",
    "size": "size",
    "mediaType": "mediaType",
    "role": "role",
    "fields": r"field|mapping",
}


@pytest.fixture(scope="module")
def doc():
    return load_vectors(VECTORS_PATH)


def vector(doc, name):
    return next(v for v in doc["vectors"] if v["name"] == name)


def test_vector_file_exists_and_parses(doc):
    assert VECTORS_PATH.is_file()
    parsed = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    assert parsed["version"] == 1
    assert len(parsed["vectors"]) >= 4
    assert len(parsed["invalid"]) >= 30


def test_header_pins_the_manifest_rules(doc):
    header = doc["manifest"]
    assert header["record_type"] == MANIFEST_TYPE
    assert header["body_fields"] == [FILES_FIELD]
    assert header["file_fields"] == list(FILE_FIELDS)
    assert set(header["roles"]) == set(FILE_ROLES)
    assert header["max_file_size"] == MAX_FILE_SIZE
    assert header["max_path_length"] == MAX_PATH_LENGTH


def test_vector_names_are_unique_per_section(doc):
    for section in ("vectors", "invalid"):
        names = [entry["name"] for entry in doc[section]]
        assert len(names) == len(set(names)), section


def test_every_vector_validates_and_matches_its_canonical_files(doc):
    for vec in doc["vectors"]:
        result = validate_manifest_body(vec["body"])
        assert result[FILES_FIELD] == vec["files"], vec["name"]
        # canonical output: entries in order, fields in FILE_FIELDS order
        for entry in result[FILES_FIELD]:
            assert list(entry) == list(FILE_FIELDS)


def test_scrambled_key_order_canonicalizes_to_the_same_files(doc):
    """Key order inside entries is not semantic: the scrambled vector's
    canonical files equal the plain ones, so the record id is the same."""
    plain = vector(doc, "paper-bundle")
    scrambled = vector(doc, "scrambled-key-order")
    assert validate_manifest_body(scrambled["body"]) == validate_manifest_body(
        plain["body"]
    )


def test_scrambled_order_does_not_change_the_record_id(doc):
    plain = vector(doc, "paper-bundle")
    scrambled = vector(doc, "scrambled-key-order")
    envelope = {
        "v": 1,
        "type": MANIFEST_TYPE,
        "author": "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
        "created": "2026-11-14T09:15:30Z",
        "prev": None,
        "proofs": [],
    }
    assert compute_record_id({**envelope, "body": plain["body"]}) == (
        compute_record_id({**envelope, "body": scrambled["body"]})
    )


def test_paper_bundle_ties_back_to_the_record_vectors(doc):
    records = load_vectors(RECORDS_PATH)
    manifest = next(
        v for v in records["vectors"] if v["name"] == "manifest-files"
    )
    bundle = vector(doc, "paper-bundle")
    assert bundle["body"] == manifest["envelope"]["body"]
    assert validate_manifest_body(manifest["envelope"]["body"])[FILES_FIELD] == (
        bundle["files"]
    )


def test_zero_byte_file_vector_uses_the_empty_file_cid(doc):
    unicode_vec = vector(doc, "zero-byte-and-unicode-paths")
    supplementary = unicode_vec["body"][FILES_FIELD][0]
    assert supplementary["size"] == 0
    assert supplementary["cid"] == "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"


def test_invalid_vectors_are_rejected_with_the_stated_kind(doc):
    kinds = set()
    for case in doc["invalid"]:
        kinds.add(case["error"])
        with pytest.raises(ValueError) as excinfo:
            validate_manifest_body(case["body"])
        assert re.search(KIND_PATTERNS[case["error"]], str(excinfo.value)), (
            case["name"]
        )
    assert kinds == set(KIND_PATTERNS)


def test_invalid_vectors_stay_minimal(doc):
    """Every invalid body is a small mutation of a valid one, so each
    failure really pins the one rule it claims to."""
    good = {
        "path": "main.pdf",
        "cid": "bafkreif2sbz225g2woo56samodlotnvvgla7frwsrsc6deybfgnszz57rm",
        "size": 21,
        "mediaType": "application/pdf",
        "role": "manuscript",
    }
    for case in doc["invalid"]:
        body = case["body"]
        if not isinstance(body, dict) or FILES_FIELD not in body:
            continue
        files = body[FILES_FIELD]
        if not isinstance(files, list) or not files:
            continue
        for entry in files:
            if isinstance(entry, dict):
                shared = set(entry) & set(good)
                assert len(shared) >= 3, case["name"]


def test_committed_file_matches_the_implementation(doc):
    """The file must be exactly what refresh_manifest_vectors produces."""
    text = VECTORS_PATH.read_text(encoding="utf-8")
    refreshed = refresh_manifest_vectors(copy.deepcopy(doc))
    assert dumps_vectors(refreshed) == text
    assert dumps_vectors(refresh_manifest_vectors(refreshed)) == text


def test_valid_vector_data_contains_no_floats(doc):
    """Invalid inputs may carry 12.5 (exactly representable everywhere);
    valid vector data must stay integer-only for lossless JS round-trips."""

    def walk(value):
        assert not isinstance(value, float)
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(doc["vectors"])
    json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
