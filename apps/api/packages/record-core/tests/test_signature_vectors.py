"""Tests for the cross-language signature vectors (vectors/signatures.json)."""

import copy
import json
from pathlib import Path

import pytest

from scholium_record_core import (
    ED25519_PUBLIC_KEY_LENGTH,
    ED25519_SEED_LENGTH,
    ED25519_SIGNATURE_LENGTH,
    compute_record_id,
    decode_signature,
    did_key_from_public_key,
    did_key_from_signing_key,
    encode_signature,
    is_ed25519_did_key,
    public_key_from_did_key,
    record_bytes,
    sign_envelope,
    verify_envelope,
    verify_record,
)
from scholium_record_core.vectors import (
    dumps_vectors,
    load_vectors,
    refresh_signature_vectors,
)

VECTORS_PATH = Path(__file__).resolve().parents[1] / "vectors" / "signatures.json"


@pytest.fixture(scope="module")
def doc():
    return load_vectors(VECTORS_PATH)


@pytest.fixture(scope="module")
def keys(doc):
    return {key["name"]: key for key in doc["keys"]}


def vector(doc, name):
    return next(v for v in doc["vectors"] if v["name"] == name)


def test_vector_file_exists_and_parses():
    assert VECTORS_PATH.is_file()
    parsed = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    assert parsed["version"] == 1
    assert len(parsed["keys"]) >= 2
    assert len(parsed["vectors"]) >= 4


def test_header_pins_the_signature_rules(doc):
    assert doc["signature"]["algorithm"] == "Ed25519"
    assert doc["signature"]["encoding"] == "base64url-unpadded"
    assert "record_bytes" in doc["signature"]["preimage"]
    assert doc["did_key"] == {
        "method": "did:key",
        "multicodec": "0xed01",
        "multicodec_name": "ed25519-pub",
        "multibase": "base58btc",
        "prefix": "did:key:z",
        "public_key_length": ED25519_PUBLIC_KEY_LENGTH,
    }


def test_key_names_are_unique_and_vectors_name_known_keys(doc, keys):
    names = [key["name"] for key in doc["keys"]]
    assert len(names) == len(set(names))
    for vec in doc["vectors"]:
        assert vec["key"] in keys, vec["name"]


def test_every_key_derives_from_its_seed_alone(keys):
    for key in keys.values():
        seed = bytes.fromhex(key["seed_hex"])
        assert len(seed) == ED25519_SEED_LENGTH
        public_key = bytes.fromhex(key["public_key_hex"])
        assert len(public_key) == ED25519_PUBLIC_KEY_LENGTH
        assert did_key_from_public_key(public_key) == key["did_key"]
        assert public_key_from_did_key(key["did_key"]) == public_key
        assert is_ed25519_did_key(key["did_key"])
        assert key["did_key"].startswith("did:key:z6Mk")


def test_every_vector_reproduces_bytes_id_and_signature(doc, keys):
    for vec in doc["vectors"]:
        envelope = vec["envelope"]
        seed = bytes.fromhex(keys[vec["key"]]["seed_hex"])
        assert record_bytes(envelope).hex() == vec["dag_cbor_hex"], vec["name"]
        assert compute_record_id(envelope) == vec["id"], vec["name"]
        assert sign_envelope(envelope, seed) == vec["sig"], vec["name"]
        assert len(decode_signature(vec["sig"])) == ED25519_SIGNATURE_LENGTH
        assert "=" not in vec["sig"]


def test_every_vector_verifies_and_is_signed_by_its_author(doc, keys):
    for vec in doc["vectors"]:
        envelope = vec["envelope"]
        assert envelope["author"] == keys[vec["key"]]["did_key"], vec["name"]
        assert verify_envelope(envelope, vec["sig"]), vec["name"]
        record = {**envelope, "id": vec["id"], "sig": vec["sig"]}
        assert verify_record(record), vec["name"]


def test_signatures_are_pinned_by_the_seeds_not_by_the_dids(doc, keys):
    """A fresh key from the vector seed reproduces the envelope's author
    did — the signature, the did and the key are one deterministic system."""
    for vec in doc["vectors"]:
        seed = bytes.fromhex(keys[vec["key"]]["seed_hex"])
        assert did_key_from_signing_key(seed) == vec["envelope"]["author"]


def apply_set(envelope, path, value):
    """Replace the dotted ``path`` in a deep copy of ``envelope``."""
    parts = path.split(".")
    mutated = copy.deepcopy(envelope)
    target = mutated
    for part in parts[:-1]:
        target = target[part]
    target[parts[-1]] = value
    return mutated


def test_every_invalid_entry_fails_verification(doc, keys):
    for entry in doc["invalid"]:
        base = vector(doc, entry["base"])
        envelope = copy.deepcopy(base["envelope"])
        sig = base["sig"]

        if "set" in entry:
            for path, value in entry["set"].items():
                envelope = apply_set(envelope, path, value)
        if entry.get("sign_with"):
            sig = sign_envelope(
                envelope, bytes.fromhex(keys[entry["sign_with"]]["seed_hex"])
            )
        if entry.get("corrupt_sig"):
            raw = bytearray(decode_signature(sig))
            raw[-1] ^= 1
            sig = encode_signature(bytes(raw))

        assert verify_envelope(envelope, sig) is False, entry["name"]
        record = {**envelope, "id": compute_record_id(envelope), "sig": sig}
        assert verify_record(record) is False, entry["name"]


def test_tampered_body_vector_is_present(doc):
    names = [entry["name"] for entry in doc["invalid"]]
    assert len(names) == len(set(names))
    assert "tampered-body" in names


def test_every_invalid_did_key_is_rejected(doc):
    for entry in doc["invalid_did_keys"]:
        assert entry["error"] in {"format", "encoding", "key"}, entry["name"]
        with pytest.raises(ValueError):
            public_key_from_did_key(entry["input"])
        assert is_ed25519_did_key(entry["input"]) is False


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


def test_prev_chain_references_earlier_vector_ids(doc):
    genesis = vector(doc, "paper-genesis-signed")
    version = vector(doc, "paper-version-signed")
    assert version["envelope"]["prev"] == genesis["id"]
    assert version["envelope"]["body"]["paper"] == genesis["id"]


def test_committed_file_matches_the_implementation(doc):
    """The file must be exactly what refresh_signature_vectors produces."""
    text = VECTORS_PATH.read_text(encoding="utf-8")
    refreshed = refresh_signature_vectors(copy.deepcopy(doc))
    assert dumps_vectors(refreshed) == text
    # refreshing twice is stable
    assert dumps_vectors(refresh_signature_vectors(refreshed)) == text
