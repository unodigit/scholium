"""Tests for record body validation against the shipped JSON Schemas."""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path

import pytest

import scholium_record_core as src
from scholium_record_core import (
    RECORD_TYPES,
    SCHEMA_DIR,
    SUPPORTED_RECORD_TYPES,
    RecordValidationError,
    UnknownRecordTypeError,
    assert_valid_body,
    available_types,
    check_schemas,
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
from scholium_record_core.vectors import load_vectors

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SCHEMAS_PATH = PACKAGE_ROOT / "schemas"
VECTORS_PATH = PACKAGE_ROOT / "vectors" / "records.json"

DID_A = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
DID_B = "did:key:z6Mkf5r9oKZXWyScE3fDnsVM3L4X7oaLLrQtLgYgLKxkbPgK"
CID_1 = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey"
CID_2 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
CID_3 = "bafkreigh2akiscncdcy3g4y27ndfn7levj4k4gs4wdbpci5qvixvim5dha"

RUBRIC = (
    "soundness",
    "evidence",
    "reproducibility",
    "novelty",
    "clarity",
    "limitations",
)

VALID_BODIES: dict[str, dict] = {
    "paper.genesis": {
        "seed": "scholium-test-seed",
        "title": "A Minimal Paper",
        "abstract": "A short abstract.",
        "categories": ["cs.AI"],
        "licence": "CC-BY-4.0",
        "authors": [{"did": DID_A, "credit": ["conceptualization"]}],
    },
    "paper.version": {
        "paper": CID_1,
        "n": 1,
        "title": "A Minimal Paper",
        "abstract": "A short abstract.",
        "authors": [
            {
                "did": DID_A,
                "credit": ["writing – original draft"],
                "corresponding": True,
                "orcid": None,
            }
        ],
        "manifest": CID_2,
        "licence": "CC-BY-4.0",
        "changeNote": "Initial version.",
    },
    "manifest": {
        "files": [
            {
                "path": "main.pdf",
                "cid": CID_3,
                "size": 1048576,
                "mediaType": "application/pdf",
                "role": "manuscript",
            }
        ]
    },
    "coauthor.consent": {
        "version": CID_1,
        "role": "writing – original draft",
        "decision": "accept",
    },
    "review.commit": {
        "target": CID_1,
        "commitment": "ab" * 32,
        "reviewKey": "review-key-1",
        "nullifier": "nullifier-1",
    },
    "review.formal": {
        "target": CID_1,
        "scores": {
            dimension: {"score": 4, "justification": "Well done."}
            for dimension in RUBRIC
        },
        "confidence": 4,
        "recommendation": "minor_revisions",
        "reportCid": CID_3,
        "coi": False,
        "escrow": {"sealed": "opaque"},
    },
    "review.response": {
        "review": CID_1,
        "replyCid": CID_3,
        "items": [
            {"dimension": "soundness", "reply": "Thank you."},
            "General response.",
        ],
    },
    "review.rating": {"review": CID_1, "rating": 4, "noteCid": CID_3},
    "discussion.post": {
        "target": CID_1,
        "anchor": CID_1,
        "textCid": CID_3,
        "parent": None,
    },
    "ai.review": {
        "target": CID_1,
        "agents": ["methodology", {"name": "literature"}],
        "models": [{"name": "fake", "version": "1"}],
        "promptSetHash": "a" * 64,
        "findings": [
            {
                "claim": "No baseline comparison.",
                "severity": "medium",
                "confidence": 0.8,
                "evidence": {"span": "we compare against"},
            }
        ],
    },
    "rendition": {
        "source": CID_1,
        "files": [
            {
                "path": "main.pdf",
                "cid": CID_3,
                "size": 10,
                "mediaType": "application/pdf",
                "role": "manuscript",
            }
        ],
        "tools": [{"name": "qpdf", "version": "11.0"}],
    },
    "endorsement": {
        "endorsee": DID_B,
        "category": "physics",
        "expiry": "2027-11-14T00:00:00Z",
    },
    "moderation.decision": {
        "target": CID_1,
        "action": "list",
        "clause": "policy-1",
        "reason": "Meets the listing criteria.",
    },
    "appeal": {
        "target": CID_1,
        "grounds": "The decision applied the wrong policy clause.",
    },
    "appeal.decision": {
        "target": CID_1,
        "outcome": "overturned",
        "reasons": "The panel agreed the clause did not apply.",
    },
    "retraction": {
        "target": CID_1,
        "reason": "Data fabrication.",
        "replacement": None,
    },
    "correction": {
        "target": CID_1,
        "reason": "Figure 2 was corrected.",
        "replacement": CID_2,
    },
    "withdrawal": {"target": CID_1, "reason": "The author withdrew the paper."},
    "key.rotation": {
        "oldKey": DID_A,
        "newKey": DID_B,
        "recoveryProof": {"approvals": 3},
    },
    "erasure.request": {
        "content": [CID_1],
        "basis": "GDPR Article 17",
    },
    "external.mirror": {
        "source": "arXiv:2401.00001",
        "metadata": {"title": "A Mirrored Preprint", "authors": ["A. Author"]},
        "manifest": CID_2,
        "claimed": False,
    },
    "flag": {
        "target": CID_1,
        "reason": "spam",
        "detail": "Duplicate advertisement.",
    },
}


def test_record_types_match_the_phase_1_contract():
    assert RECORD_TYPES == (
        "paper.genesis",
        "paper.version",
        "manifest",
        "coauthor.consent",
        "review.commit",
        "review.formal",
        "review.response",
        "review.rating",
        "discussion.post",
        "ai.review",
        "rendition",
        "endorsement",
        "moderation.decision",
        "appeal",
        "appeal.decision",
        "retraction",
        "correction",
        "withdrawal",
        "key.rotation",
        "erasure.request",
        "external.mirror",
        "flag",
    )
    assert SUPPORTED_RECORD_TYPES is RECORD_TYPES
    assert list_record_types() == list(RECORD_TYPES)
    assert available_types() == list(RECORD_TYPES)


def test_schema_directory_ships_one_file_per_type():
    assert SCHEMA_DIR == SCHEMAS_PATH
    assert schema_dir() == SCHEMAS_PATH
    files = sorted(path.name for path in SCHEMAS_PATH.glob("*.json"))
    assert files == sorted(f"{record_type}.json" for record_type in RECORD_TYPES)


def test_every_schema_parses_and_has_the_expected_shape():
    for record_type in RECORD_TYPES:
        path = schema_path(record_type)
        assert path == SCHEMAS_PATH / f"{record_type}.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        assert document["$schema"] == (
            "https://json-schema.org/draft/2020-12/schema"
        )
        assert isinstance(document["$id"], str)
        assert document["type"] == "object"
        assert isinstance(document["required"], list) and document["required"]
        assert isinstance(document["properties"], dict)
        for required in document["required"]:
            assert required in document["properties"]
        # Phase 1 schemas never reach across files.
        for ref in _iter_refs(document):
            assert ref.startswith("#/")


def test_check_schemas_reports_no_problems():
    assert check_schemas() == []


def test_load_schema_returns_an_independent_copy():
    first = load_schema("manifest")
    first["title"] = "mutated"
    second = schema_for("manifest")
    assert second["title"] == "manifest record body"
    assert schema_for is load_schema
    assert src.get_schema is load_schema


def test_load_all_schemas_returns_every_schema():
    documents = load_all_schemas()
    assert set(documents) == set(RECORD_TYPES)
    assert documents["flag"]["properties"]["target"]["$ref"] == "#/$defs/cid"


def test_schemas_submodule_is_still_a_module():
    import scholium_record_core.schemas as schemas_module

    assert schemas_module.validate_body is validate_body
    assert schemas_module.RECORD_TYPES is RECORD_TYPES


def test_unknown_record_type_raises_for_schema_lookup():
    with pytest.raises(UnknownRecordTypeError) as excinfo:
        load_schema("not.a.record")
    assert "not.a.record" in str(excinfo.value)
    assert isinstance(excinfo.value, KeyError)
    assert isinstance(excinfo.value, ValueError)
    assert has_schema("flag")
    assert not has_schema("curation")


@pytest.mark.parametrize("record_type", RECORD_TYPES)
def test_every_type_has_a_valid_example(record_type):
    assert validate_body(record_type, VALID_BODIES[record_type]) == []


def test_vector_envelopes_validate():
    document = load_vectors(VECTORS_PATH)
    for vector in document["vectors"]:
        envelope = vector["envelope"]
        assert validate_body(envelope["type"], envelope["body"]) == [], (
            vector["name"]
        )
        assert validate_record(envelope) == [], vector["name"]


@pytest.mark.parametrize("record_type", RECORD_TYPES)
def test_empty_body_is_rejected(record_type):
    errors = validate_body(record_type, {})
    assert errors, record_type
    assert all(isinstance(error, str) for error in errors)


@pytest.mark.parametrize("record_type", RECORD_TYPES)
def test_missing_required_property_is_named(record_type):
    body = copy.deepcopy(VALID_BODIES[record_type])
    required = load_schema(record_type)["required"][0]
    del body[required]
    errors = validate_body(record_type, body)
    assert errors
    assert any(required in error for error in errors), (record_type, errors)


@pytest.mark.parametrize(
    "record_type,body,match",
    [
        ("paper.genesis", {"title": "", "categories": ["cs.AI"], "licence": "x"},
         "title"),
        ("paper.genesis", {"title": "T", "categories": [], "licence": "x"},
         "categories"),
        ("manifest",
         {"files": [{"path": "main.pdf", "cid": "c", "size": -1,
                     "mediaType": "application/pdf", "role": "manuscript"}]},
         "size"),
        ("manifest",
         {"files": [{"path": "../escape.pdf", "cid": "c", "size": 1,
                     "mediaType": "application/pdf", "role": "manuscript"}]},
         "path"),
        ("coauthor.consent",
         {"version": "c", "role": "r", "decision": "maybe"}, "decision"),
        ("review.rating", {"review": "c", "rating": 0}, "rating"),
        ("review.rating", {"review": "c", "rating": 6}, "rating"),
        ("review.formal",
         {"target": "c", "confidence": 3, "recommendation": "accept"},
         "scores"),
        ("moderation.decision",
         {"target": "c", "action": "banish", "clause": "p", "reason": "r"},
         "action"),
        ("moderation.decision",
         {"target": "c", "action": "list", "reason": "r"}, "clause"),
        ("appeal.decision", {"target": "c", "reasons": "r"}, "outcome"),
        ("flag", {"target": "c"}, "reason"),
        ("discussion.post", {"target": "c", "anchor": "a"}, "text"),
        ("erasure.request", {"basis": "GDPR"}, "content"),
        ("key.rotation", {"oldKey": "o"}, "newKey"),
        ("ai.review",
         {"target": "c", "agents": ["a"], "models": ["m"],
          "promptSetHash": "h", "findings": [{"claim": "no evidence"}]},
         "evidence"),
        ("external.mirror", {"source": "arXiv:1", "manifest": "m"}, "metadata"),
        ("rendition", {"source": "c", "files": [{"path": "p", "cid": "c"}]},
         "tools"),
        ("review.response", {"review": "c"}, "items"),
        ("review.commit", {"target": "c", "commitment": "x"}, "nullifier"),
        ("withdrawal", {"target": "c"}, "reason"),
        ("retraction", {"target": "c"}, "reason"),
        ("correction", {"target": "c"}, "reason"),
        ("endorsement", {"endorsee": "not-a-did", "category": "cs.AI"},
         "endorsee"),
        ("paper.version",
         {"paper": "c", "n": 0, "title": "T", "abstract": "",
          "authors": [{"credit": []}], "manifest": "m", "licence": "l",
          "changeNote": "x"},
         "did"),
    ],
)
def test_invalid_values_are_reported(record_type, body, match):
    errors = validate_body(record_type, body)
    assert errors
    assert any(match in error for error in errors), errors


def test_nested_errors_use_a_readable_path():
    body = copy.deepcopy(VALID_BODIES["paper.version"])
    del body["authors"][0]["did"]
    errors = validate_body("paper.version", body)
    assert any("body.authors[0]" in error for error in errors)
    assert any("did" in error for error in errors)


def test_additional_properties_are_allowed_for_forward_compatibility():
    body = dict(VALID_BODIES["paper.genesis"])
    body["futureField"] = {"anything": [1, 2, 3]}
    assert validate_body("paper.genesis", body) == []


def test_validation_does_not_mutate_the_body():
    body = copy.deepcopy(VALID_BODIES["review.formal"])
    snapshot = copy.deepcopy(body)
    validate_body("review.formal", body)
    assert body == snapshot


def test_unknown_type_and_non_object_body_return_errors():
    assert validate_body("not.a.type", {}) == [
        "unknown record type: 'not.a.type'"
    ]
    assert validate_body("paper.genesis", ["not", "an", "object"]) == [
        "body must be a JSON object, got array"
    ]
    assert validate_body("paper.genesis", None) == [
        "body must be a JSON object, got null"
    ]


def test_argument_order_can_be_swapped():
    body = VALID_BODIES["flag"]
    assert validate_body(body, "flag") == []
    assert validate_record_body(body, "flag") == []
    assert validate_body_errors("flag", body) == []
    assert validate("flag", body) == []
    assert validate({"type": "flag", "body": body}) == []


def test_boolean_is_not_accepted_as_an_integer():
    # True == 1 in Python; JSON Schema keeps booleans distinct from integers.
    errors = validate_body("review.rating", {"review": "c", "rating": True})
    assert errors
    assert any("integer" in error for error in errors)


def test_is_valid_body_and_assert_valid_body():
    assert is_valid_body("flag", VALID_BODIES["flag"])
    assert not is_valid_body("flag", {})
    with pytest.raises(RecordValidationError) as excinfo:
        assert_valid_body("flag", {})
    assert excinfo.value.record_type == "flag"
    assert any("target" in error for error in excinfo.value.errors)


def test_validate_record_checks_type_and_body():
    assert validate_record(VALID_BODIES["flag"]) == [
        "record: missing required property 'type'"
    ]
    assert validate_record([1, 2]) == [
        "record must be a JSON object, got array"
    ]
    assert validate_record({"type": "unknown.type", "body": {}}) == [
        "unknown record type: 'unknown.type'"
    ]
    assert validate_record({"type": "flag"}) == [
        "record: flag record is missing required property 'body'"
    ]
    assert validate_record({"type": "flag", "body": "nope"}) == [
        "record.body: expected object, got string"
    ]
    assert validate_record(
        {"type": "flag", "body": VALID_BODIES["flag"]}
    ) == []


def test_validate_envelope_checks_the_canonical_fields_too():
    valid = {
        "v": 1,
        "type": "flag",
        "author": DID_A,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": VALID_BODIES["flag"],
        "proofs": [],
    }
    assert validate_envelope(valid) == []

    broken = dict(valid)
    del broken["author"]
    errors = validate_envelope(broken)
    assert errors
    assert any("author" in error for error in errors)

    wrong_body = dict(valid, body={})
    errors = validate_envelope(wrong_body)
    assert any("target" in error for error in errors)


def test_schema_dir_override_is_honoured(tmp_path, monkeypatch):
    destination = tmp_path / "schemas"
    shutil.copytree(SCHEMAS_PATH, destination)
    assert load_schema("flag", schema_dir=destination)["title"] == (
        "flag record body"
    )
    assert validate_body("flag", VALID_BODIES["flag"], schema_dir=destination) == []

    monkeypatch.setenv("SCHOLIUM_SCHEMA_DIR", str(destination))
    assert schema_dir() == destination


def test_validation_module_alias_exposes_the_same_api():
    from scholium_record_core import validation

    assert validation.validate_body is validate_body
    assert validation.RECORD_TYPES is RECORD_TYPES


def _iter_refs(value):
    if isinstance(value, dict):
        if isinstance(value.get("$ref"), str):
            yield value["$ref"]
        for item in value.values():
            yield from _iter_refs(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_refs(item)
