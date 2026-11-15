"""Tests for the cross-language short id vectors (vectors/short_ids.json)."""

import copy
import json
import re
from pathlib import Path

import pytest
from multiformats import CID

from scholium_record_core import (
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
from scholium_record_core.vectors import (
    dumps_vectors,
    load_vectors,
    refresh_short_id_vectors,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[1] / "vectors" / "short_ids.json"
)
RECORDS_PATH = VECTORS_PATH.with_name("records.json")

WELL_FORMED = re.compile(r"sch:[a-z2-7]{4}(-[a-z2-7]{4}){2}(/v[1-9][0-9]{0,8})?")


@pytest.fixture(scope="module")
def doc():
    return load_vectors(VECTORS_PATH)


def vector(doc, name):
    return next(v for v in doc["vectors"] if v["name"] == name)


def test_vector_file_exists_and_parses(doc):
    assert VECTORS_PATH.is_file()
    assert doc["version"] == 1
    assert len(doc["vectors"]) >= 8
    assert len(doc["invalid"]) >= 20
    assert len(doc["parse"]) >= 4


def test_header_pins_the_short_id_rules(doc):
    header = doc["short_id"]
    assert header["prefix"] == SHORT_ID_PREFIX
    assert header["alphabet"] == SHORT_ID_ALPHABET
    assert header["payload_length"] == SHORT_ID_PAYLOAD_LENGTH
    assert header["checksum_length"] == SHORT_ID_CHECKSUM_LENGTH
    assert header["group_size"] == SHORT_ID_GROUP_SIZE
    assert str(MAX_VERSION) in header["version"]
    # three groups of four: the xxxx-xxxx-xxxx of the spec
    assert (
        SHORT_ID_PAYLOAD_LENGTH + SHORT_ID_CHECKSUM_LENGTH
        == 3 * SHORT_ID_GROUP_SIZE
    )


def test_names_are_unique_per_section(doc):
    for section in ("vectors", "parse", "invalid"):
        names = [entry["name"] for entry in doc[section]]
        assert len(names) == len(set(names)), section


def test_every_vector_reproduces_its_outputs(doc):
    for vec in doc["vectors"]:
        genesis_cid = vec["genesis_cid"]
        assert derive_short_id(genesis_cid) == vec["short_id"], vec["name"]
        digest = bytes(CID.decode(genesis_cid).raw_digest)
        assert digest.hex() == vec["digest_hex"], vec["name"]
        assert vec["version_ids"], vec["name"]
        for number, version_id in vec["version_ids"].items():
            assert version_id == f"{vec['short_id']}/v{number}", vec["name"]
            assert format_version_id(vec["short_id"], int(number)) == version_id
            assert parse_version_id(version_id) == VersionId(
                vec["short_id"], int(number)
            )
        assert parse_short_id(vec["short_id"]) == vec["short_id"]


def test_only_the_first_50_digest_bits_decide_the_short_id(doc):
    # digest-bits-50-to-55-ignored shares its first 50 bits with
    # digest-all-zero, so it must share the short id; flipping bit 49 must not.
    zero = vector(doc, "digest-all-zero")["short_id"]
    assert vector(doc, "digest-bits-50-to-55-ignored")["short_id"] == zero
    assert vector(doc, "digest-bit-49-counts")["short_id"] != zero


def test_genesis_vector_ties_back_to_the_record_vectors(doc):
    records = load_vectors(RECORDS_PATH)
    genesis = next(
        v for v in records["vectors"] if v["name"] == "paper-genesis-minimal"
    )
    assert vector(doc, "paper-genesis-minimal")["genesis_cid"] == genesis["id"]


def test_parse_vectors(doc):
    for case in doc["parse"]:
        if case["version"] is None:
            assert parse_short_id(case["input"]) == case["short_id"], case["name"]
        else:
            assert parse_version_id(case["input"]) == VersionId(
                case["short_id"], case["version"]
            ), case["name"]


def test_invalid_vectors_are_rejected_with_the_stated_kind(doc):
    kinds = set()
    for case in doc["invalid"]:
        kinds.add(case["error"])
        for parse in (parse_short_id, parse_version_id):
            with pytest.raises(ValueError) as excinfo:
                parse(case["input"])
            says_checksum = "checksum" in str(excinfo.value)
            assert says_checksum == (case["error"] == "checksum"), case["name"]
    assert kinds == {"format", "checksum"}


def test_invalid_checksum_vectors_are_otherwise_well_formed(doc):
    """A "checksum" vector must differ from a valid id only in its digits,
    never in its shape, so it really exercises the checksum path."""
    for case in doc["invalid"]:
        assert bool(WELL_FORMED.fullmatch(case["input"])) == (
            case["error"] == "checksum"
        ), case["name"]


def test_committed_file_matches_the_implementation(doc):
    """The file must be exactly what refresh_short_id_vectors produces."""
    text = VECTORS_PATH.read_text(encoding="utf-8")
    refreshed = refresh_short_id_vectors(copy.deepcopy(doc))
    assert dumps_vectors(refreshed) == text
    assert dumps_vectors(refresh_short_id_vectors(refreshed)) == text


def test_vector_file_contains_no_floats_and_valid_json(doc):
    def walk(value):
        assert not isinstance(value, float)
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(doc)
    json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
