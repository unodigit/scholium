"""Tests for the cross-language file id vectors (vectors/file_ids.json)."""

import copy
import json
from pathlib import Path

import pytest
from multiformats import CID, multibase

from scholium_record_core import (
    FILE_BASE,
    FILE_CODEC,
    FILE_CODEC_CODE,
    FILE_HASH,
    FILE_ID_PREFIX,
    CID_VERSION,
    compute_file_cid,
    compute_file_id,
    parse_file_cid,
)
from scholium_record_core.vectors import (
    dumps_vectors,
    load_vectors,
    refresh_file_id_vectors,
)

VECTORS_PATH = Path(__file__).resolve().parents[1] / "vectors" / "file_ids.json"
RECORDS_PATH = VECTORS_PATH.with_name("records.json")

#: What the error message must mention for each invalid kind.
KIND_PHRASES = {
    "format": r"must be a string|not a valid CID",
    "version": "not a raw file id",
    "codec": "not a raw file id",
    "hash": "not a raw file id",
    "canonical": "canonical base32",
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
    assert len(parsed["vectors"]) >= 7
    assert len(parsed["invalid"]) >= 10


def test_header_pins_the_file_id_rules(doc):
    assert doc["file_id"] == {
        "cid_version": CID_VERSION,
        "codec": FILE_CODEC,
        "codec_code": f"0x{FILE_CODEC_CODE:02x}",
        "hash": FILE_HASH,
        "base": FILE_BASE,
        "prefix": FILE_ID_PREFIX,
        "input": doc["file_id"]["input"],
        "canonical": doc["file_id"]["canonical"],
    }


def test_vector_names_are_unique_per_section(doc):
    for section in ("vectors", "invalid"):
        names = [entry["name"] for entry in doc[section]]
        assert len(names) == len(set(names)), section


def test_every_vector_reproduces_digest_and_cid(doc):
    for vec in doc["vectors"]:
        data = bytes.fromhex(vec["bytes_hex"])
        assert compute_file_id(data) == vec["cid"], vec["name"]
        cid = parse_file_cid(vec["cid"])
        assert bytes(cid.raw_digest).hex() == vec["digest_hex"], vec["name"]
        assert cid == compute_file_cid(data), vec["name"]


def test_expected_cids_are_well_formed_cidv1_raw_sha2_256(doc):
    for vec in doc["vectors"]:
        cid = CID.decode(multibase.decode(vec["cid"]))
        assert cid.version == 1
        assert cid.codec.code == 0x55  # raw
        assert bytes(cid.digest)[:2] == b"\x12\x20"  # sha2-256
        assert len(bytes(cid.digest)) == 34  # prefix + 32-byte digest
        assert vec["cid"].startswith(FILE_ID_PREFIX)


def test_the_classic_hello_pin(doc):
    """bafkrei...4yeq is the widely cross-checked raw CID of b'hello'."""
    hello = vector(doc, "hello")
    assert hello["bytes_hex"] == b"hello".hex()
    assert hello["cid"] == (
        "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
    )


def test_manifest_file_vectors_tie_back_to_the_record_vectors(doc):
    records = load_vectors(RECORDS_PATH)
    manifest = next(
        v for v in records["vectors"] if v["name"] == "manifest-files"
    )
    by_role = {f["role"]: f for f in manifest["envelope"]["body"]["files"]}
    assert vector(doc, "manifest-main-pdf")["cid"] == by_role["manuscript"]["cid"]
    assert vector(doc, "manifest-main-pdf")["bytes_hex"] == b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n%%EOF\n".hex()
    assert vector(doc, "manifest-plot-svg")["cid"] == by_role["figure"]["cid"]
    assert vector(doc, "manifest-plot-svg")["bytes_hex"] == (
        b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n'.hex()
    )
    # the manifest's declared sizes describe the pinned bytes
    assert by_role["manuscript"]["size"] == len(
        bytes.fromhex(vector(doc, "manifest-main-pdf")["bytes_hex"])
    )
    assert by_role["figure"]["size"] == len(
        bytes.fromhex(vector(doc, "manifest-plot-svg")["bytes_hex"])
    )


def test_invalid_vectors_are_rejected_with_the_stated_kind(doc):
    kinds = set()
    for case in doc["invalid"]:
        kinds.add(case["error"])
        with pytest.raises(ValueError, match=KIND_PHRASES[case["error"]]):
            parse_file_cid(case["input"])
    assert kinds == {"format", "version", "codec", "hash", "canonical"}


def test_invalid_vectors_pin_each_parameter_mismatch_separately(doc):
    by_name = {case["name"]: case for case in doc["invalid"]}

    def message_for(name):
        with pytest.raises(ValueError) as excinfo:
            parse_file_cid(by_name[name]["input"])
        return str(excinfo.value)

    assert "CIDv0" in message_for("cidv0-dag-pb")
    assert "dag-cbor" in message_for("record-id-dag-cbor")
    assert "sha2-512" in message_for("raw-sha2-512")


def test_canonical_kind_vectors_decode_to_valid_file_cids(doc):
    """A 'canonical' rejection must still be a real raw CID, just
    misspelled -- otherwise it would be a format case."""
    for case in doc["invalid"]:
        if case["error"] != "canonical":
            continue
        cid = CID.decode(case["input"])
        assert cid.codec.name == FILE_CODEC
        assert cid.hashfun.name == FILE_HASH


def test_committed_file_matches_the_implementation(doc):
    """The file must be exactly what refresh_file_id_vectors produces."""
    text = VECTORS_PATH.read_text(encoding="utf-8")
    refreshed = refresh_file_id_vectors(copy.deepcopy(doc))
    assert dumps_vectors(refreshed) == text
    assert dumps_vectors(refresh_file_id_vectors(refreshed)) == text


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
