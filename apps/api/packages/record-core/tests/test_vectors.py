"""Tests for the cross-language record id vectors (vectors/records.json)."""

import copy
import json
from pathlib import Path

import pytest
from multiformats import CID, multibase

from scholium_record_core import (
    CID_BASE,
    CID_CODEC,
    CID_CODEC_CODE,
    CID_HASH,
    CID_VERSION,
    ENVELOPE_FIELDS,
    EXCLUDED_FIELDS,
    compute_record_id,
    record_bytes,
)
from scholium_record_core.vectors import (
    dumps_vectors,
    load_vectors,
    refresh_vectors,
)

VECTORS_PATH = Path(__file__).resolve().parents[1] / "vectors" / "records.json"


@pytest.fixture(scope="module")
def doc():
    return load_vectors(VECTORS_PATH)


def vector(doc, name):
    return next(v for v in doc["vectors"] if v["name"] == name)


def test_vector_file_exists_and_parses():
    assert VECTORS_PATH.is_file()
    parsed = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    assert parsed["version"] == 1
    assert len(parsed["vectors"]) >= 7


def test_header_pins_the_id_rules(doc):
    assert doc["envelope_fields"] == list(ENVELOPE_FIELDS)
    assert doc["excluded_fields"] == list(EXCLUDED_FIELDS)
    assert doc["record_id"] == {
        "cid_version": CID_VERSION,
        "codec": CID_CODEC,
        "codec_code": f"0x{CID_CODEC_CODE:02x}",
        "hash": CID_HASH,
        "base": CID_BASE,
    }


def test_vector_names_are_unique(doc):
    names = [v["name"] for v in doc["vectors"]]
    assert len(names) == len(set(names))


def test_every_vector_reproduces_id_and_bytes(doc):
    for vec in doc["vectors"]:
        envelope = vec["envelope"]
        assert set(ENVELOPE_FIELDS) <= set(envelope)
        assert record_bytes(envelope).hex() == vec["dag_cbor_hex"], vec["name"]
        assert compute_record_id(envelope) == vec["id"], vec["name"]


def test_expected_ids_are_well_formed_cidv1_dag_cbor(doc):
    for vec in doc["vectors"]:
        cid = CID.decode(multibase.decode(vec["id"]))
        assert cid.version == 1
        assert cid.codec.code == 0x71
        assert bytes(cid.digest)[:2] == b"\x12\x20"  # sha2-256
        assert len(bytes(cid.digest)) == 34  # prefix + 32-byte digest


def test_vectors_contain_no_floats(doc):
    """Floats would make JS JSON round-trips lossy; keep them out."""

    def walk(value):
        if isinstance(value, float):
            raise AssertionError("vector data must not contain floats")
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(doc)


def test_id_and_sig_exclusion_pair(doc):
    a = vector(doc, "id-and-sig-excluded-a")
    b = vector(doc, "id-and-sig-excluded-b")
    strip = lambda env: {k: env[k] for k in ENVELOPE_FIELDS}  # noqa: E731
    assert strip(a["envelope"]) == strip(b["envelope"])
    assert a["envelope"]["sig"] != b["envelope"]["sig"]
    assert a["envelope"]["id"] != b["envelope"]["id"]
    assert a["id"] == b["id"]
    assert b["envelope"]["id"] != b["id"]  # stale id must not be trusted


def test_prev_chain_references_earlier_ids(doc):
    genesis = vector(doc, "paper-genesis-minimal")
    version = vector(doc, "paper-version-with-prev")
    discussion = vector(doc, "discussion-post-length-first-keys")
    excluded = vector(doc, "id-and-sig-excluded-a")
    assert version["envelope"]["prev"] == genesis["id"]
    assert version["envelope"]["body"]["paper"] == genesis["id"]
    assert discussion["envelope"]["body"]["anchor"] == genesis["id"]
    assert discussion["envelope"]["body"]["target"] == version["id"]
    assert excluded["envelope"]["body"]["anchor"] == genesis["id"]


def test_committed_file_matches_the_implementation(doc):
    """The file must be exactly what refresh_vectors produces — no drift."""
    text = VECTORS_PATH.read_text(encoding="utf-8")
    refreshed = refresh_vectors(copy.deepcopy(doc))
    assert dumps_vectors(refreshed) == text
    # refreshing twice is stable
    assert dumps_vectors(refresh_vectors(refreshed)) == text
