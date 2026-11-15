"""Tests for the CARv1 reader (scholium_cli.car)."""

import hashlib

import dag_cbor
import pytest
from car_helpers import dag_cbor_cid, file_block, flip, header, varint, write_car
from multiformats import CID
from scholium_cli.car import Block, CarError, block_problem, read_car


def raw_cid(data: bytes) -> CID:
    return file_block(data)[0]


def test_reads_roots_and_blocks_in_order():
    first, second = file_block(b"one"), file_block(b"two")
    car = read_car(write_car([first, second], roots=[first[0]]))
    assert car.roots == (first[0],)
    assert [(b.cid, b.data) for b in car] == [first, second]


def test_a_header_only_archive_has_no_blocks():
    car = read_car(header())
    assert car.roots == ()
    assert car.blocks == ()


def test_a_cidv0_section_is_read():
    digest = hashlib.sha256(b"legacy").digest()
    cid = CID("base58btc", 0, "dag-pb", ("sha2-256", digest))
    car = read_car(write_car([(cid, b"legacy")]))
    assert car.blocks[0].cid == cid
    assert block_problem(car.blocks[0]) is None


def test_accepts_bytes_bytearray_and_memoryview():
    data = write_car([file_block(b"x")])
    for wrapped in (data, bytearray(data), memoryview(data)):
        assert len(read_car(wrapped).blocks) == 1


@pytest.mark.parametrize("data", [b"", b"\x00", b"\x05abc"])
def test_a_truncated_or_empty_header_is_an_error(data):
    with pytest.raises(CarError):
        read_car(data)


def test_a_header_that_is_not_dag_cbor_is_an_error():
    junk = b"\xff\xff\xff"
    with pytest.raises(CarError, match="DAG-CBOR"):
        read_car(varint(len(junk)) + junk)


def test_a_header_that_is_not_a_map_is_an_error():
    body = dag_cbor.encode([1, 2])
    with pytest.raises(CarError, match="not a map"):
        read_car(varint(len(body)) + body)


def test_carv2_and_unknown_versions_are_refused():
    for version in (2, 0, 3):
        body = dag_cbor.encode({"roots": [], "version": version})
        with pytest.raises(CarError, match="unsupported CAR version"):
            read_car(varint(len(body)) + body)


def test_a_missing_version_is_refused():
    body = dag_cbor.encode({"roots": []})
    with pytest.raises(CarError, match="unsupported CAR version"):
        read_car(varint(len(body)) + body)


@pytest.mark.parametrize("roots", ["x", [1], {"a": 1}])
def test_roots_must_be_a_list_of_cids(roots):
    body = dag_cbor.encode({"roots": roots, "version": 1})
    with pytest.raises(CarError, match="roots"):
        read_car(varint(len(body)) + body)


def test_a_truncated_section_is_an_error():
    data = write_car([file_block(b"hello world")])
    with pytest.raises(CarError, match="truncated"):
        read_car(data[:-1])


def test_trailing_garbage_is_an_error_not_silently_ignored():
    data = write_car([file_block(b"hello")]) + b"\x07abc"
    with pytest.raises(CarError):
        read_car(data)


def test_an_empty_section_is_an_error():
    with pytest.raises(CarError, match="empty"):
        read_car(header() + b"\x00")


def test_a_section_too_short_for_its_cid_is_an_error():
    cid = raw_cid(b"x")
    body = bytes(cid)[:10]
    with pytest.raises(CarError, match="too short"):
        read_car(header() + varint(len(body)) + body)


def test_a_section_that_does_not_start_with_a_cid_is_an_error():
    body = b"\x09\x09\x09\x09\x09\x09\x09\x09\x09"
    with pytest.raises(CarError):
        read_car(header() + varint(len(body)) + body)


def test_non_minimal_varints_are_refused():
    cid, data = file_block(b"x")
    body = bytes(cid) + data
    padded = bytes([len(body) | 0x80, 0x00])  # the length, with a redundant byte
    with pytest.raises(CarError, match="minimally"):
        read_car(header() + padded + body)


def test_an_overlong_varint_is_refused():
    with pytest.raises(CarError, match="longer than"):
        read_car(b"\xff" * 12)


def test_a_huge_length_does_not_allocate_it():
    huge = varint(2**62)
    with pytest.raises(CarError, match="truncated"):
        read_car(header() + huge + b"abc")


def test_duplicate_sections_are_both_kept_by_the_reader():
    block = file_block(b"same")
    assert len(read_car(write_car([block, block])).blocks) == 2


# --- block hashes -------------------------------------------------------


def test_a_matching_block_has_no_problem():
    cid, data = file_block(b"payload")
    assert block_problem(Block(cid, data)) is None


def test_a_changed_byte_is_a_hash_mismatch():
    cid, data = file_block(b"payload")
    assert "do not match" in block_problem(Block(cid, flip(data, 0)))


def test_a_block_filed_under_the_wrong_cid_is_a_mismatch():
    wrong = raw_cid(b"something else")
    assert block_problem(Block(wrong, b"payload")) is not None


def test_dag_cbor_blocks_are_hashed_too():
    data = dag_cbor.encode({"a": 1})
    assert block_problem(Block(dag_cbor_cid(data), data)) is None
    assert block_problem(Block(dag_cbor_cid(data), data + b"\x00")) is not None


def test_a_hash_function_that_cannot_be_computed_is_reported_not_skipped():
    # blake3 (multihash 0x1e) decodes as a CID, but its optional library may
    # not be installed: such a block must be reported, never assumed intact.
    cid = varint(1) + varint(0x55) + varint(0x1E) + varint(32) + bytes(32)
    body = cid + b"payload"
    block = read_car(header() + varint(len(body)) + body).blocks[0]
    problem = block_problem(block)
    assert problem is not None  # no digest of b"payload" is all zeroes either
