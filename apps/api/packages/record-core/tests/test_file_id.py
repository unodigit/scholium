"""Tests for file id computation and parsing."""

import hashlib
from array import array

import pytest
from multiformats import CID

from scholium_record_core import (
    CID_VERSION,
    FILE_BASE,
    FILE_CODEC,
    FILE_CODEC_CODE,
    FILE_HASH,
    FILE_ID_PREFIX,
    compute_file_cid,
    compute_file_id,
    compute_record_id,
    parse_file_cid,
)


def test_file_id_is_a_cidv1_raw_sha2_256():
    data = b"file bytes, exactly as uploaded"
    cid = compute_file_cid(data)
    assert cid.version == CID_VERSION == 1
    assert cid.codec.name == FILE_CODEC == "raw"
    assert cid.codec.code == FILE_CODEC_CODE == 0x55
    assert cid.hashfun.name == FILE_HASH == "sha2-256"
    # the multihash is sha2-256 (0x12) of length 0x20 over the exact bytes
    digest = bytes(cid.digest)
    assert digest[:2] == b"\x12\x20"
    assert digest[2:] == hashlib.sha256(data).digest()
    assert len(digest) == 34


def test_file_id_string_is_canonical_base32():
    as_string = compute_file_id(b"some bytes")
    assert as_string == str(compute_file_cid(b"some bytes"))
    assert as_string.startswith(FILE_ID_PREFIX)  # bafkrei...
    assert as_string == as_string.lower()
    assert len(as_string) == 59  # 'b' multibase prefix + 58 base32 chars
    assert CID.decode(as_string) == compute_file_cid(b"some bytes")


def test_file_id_is_deterministic_and_content_addressed():
    assert compute_file_id(b"hello") == compute_file_id(b"hello")
    # the classic cross-implementation pin
    assert compute_file_id(b"hello") == (
        "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
    )
    # a single flipped bit changes the id
    tampered = bytearray(b"hello")
    tampered[0] ^= 0x01
    assert compute_file_id(bytes(tampered)) != compute_file_id(b"hello")
    # length is not the identity: same length, different bytes
    assert compute_file_id(b"hellp") != compute_file_id(b"hello")


def test_empty_file_has_a_well_defined_id():
    assert compute_file_id(b"") == (
        "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
    )


def test_large_input_hashes_incrementally_identical():
    data = bytes(range(256)) * 4096  # 1 MiB
    assert compute_file_id(data) == compute_file_id(data)


def test_memoryviews_and_bytearrays_hash_like_bytes():
    data = bytearray(b"same bytes")
    assert compute_file_id(data) == compute_file_id(bytes(data))
    assert compute_file_id(memoryview(data)) == compute_file_id(bytes(data))
    assert compute_file_id(array("B", data)) == compute_file_id(bytes(data))


@pytest.mark.parametrize(
    "bad",
    ["hello", 123, None, 1.5, [b"h"], {"bytes": b"h"}],
)
def test_non_bytes_input_raises_value_error(bad):
    with pytest.raises(ValueError, match="bytes-like"):
        compute_file_id(bad)


def test_file_ids_never_collide_with_record_ids():
    """Record ids are dag-cbor CIDs (bafyrei...), file ids raw (bafkrei...)."""
    envelope = {
        "v": 1,
        "type": "discussion.post",
        "author": "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
        "created": "2026-11-14T05:33:00Z",
        "prev": None,
        "body": {"text": "hello"},
        "proofs": [],
    }
    record_id = compute_record_id(envelope)
    file_id = compute_file_id(b"hello")
    assert record_id.startswith("bafyrei")
    assert file_id.startswith("bafkrei")
    assert record_id != file_id


def test_parse_file_cid_round_trips_compute_file_id():
    data = b"round trip"
    cid = parse_file_cid(compute_file_id(data))
    assert cid == compute_file_cid(data)
    # raw_digest is the bare 32-byte sha2-256 digest of the file bytes
    assert bytes(cid.raw_digest) == hashlib.sha256(data).digest()


def test_parse_file_cid_rejects_non_strings():
    for bad in (123, None, b"bafkrei...", ["bafkrei..."]):
        with pytest.raises(ValueError, match="must be a string"):
            parse_file_cid(bad)


def test_parse_file_cid_rejects_undecodable_strings():
    for bad in ("", "not-a-cid", "bafkrei", "hello world"):
        with pytest.raises(ValueError, match="not a valid CID"):
            parse_file_cid(bad)


def test_parse_file_cid_rejects_other_cid_kinds():
    # a record id: dag-cbor codec, not raw
    with pytest.raises(ValueError, match="not a raw file id"):
        parse_file_cid(
            "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4"
        )
    # a CIDv0 dag-pb id
    with pytest.raises(ValueError, match="not a raw file id"):
        parse_file_cid("QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR")
    # raw codec but sha2-512
    sha2_512 = CID(
        base=FILE_BASE,
        version=1,
        codec=FILE_CODEC,
        digest=("sha2-512", hashlib.sha512(b"hello").digest()),
    )
    with pytest.raises(ValueError, match="not a raw file id"):
        parse_file_cid(str(sha2_512))


def test_parse_file_cid_rejects_non_canonical_spellings():
    canonical = compute_file_id(b"hello")
    # same CID, uppercase base32
    with pytest.raises(ValueError, match="canonical base32"):
        parse_file_cid("B" + canonical[1:].upper())
    # same CID, base58btc multibase
    with pytest.raises(ValueError, match="canonical base32"):
        parse_file_cid(CID.decode(canonical).encode("base58btc"))
