"""Tests for sch: short id derivation and version id parsing."""

import re

import pytest
from multiformats import CID

from scholium_record_core import (
    MAX_VERSION,
    SHORT_ID_ALPHABET,
    VersionId,
    compute_record_id,
    derive_short_id,
    format_version_id,
    parse_short_id,
    parse_version_id,
)
from scholium_record_core.short_id import _crc10

DID_A = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"

SHORT_ID_RE = re.compile(r"sch:[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}")

# A real record id and the short id derived from it (also pinned by
# vectors/short_ids.json).
GENESIS_CID = "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4"
GENESIS_SHORT_ID = "sch:5jmi-pmva-4lmr"


def record_cid(digest: bytes) -> CID:
    return CID("base32", 1, "dag-cbor", ("sha2-256", digest))


def genesis_envelope(**body):
    return {
        "v": 1,
        "type": "paper.genesis",
        "author": DID_A,
        "created": "2026-11-14T05:33:00Z",
        "prev": None,
        "body": {"title": "A Paper", **body},
        "proofs": [],
    }


def swap(text: str, i: int) -> str:
    return text[:i] + text[i + 1] + text[i] + text[i + 2 :]


def corrupt(short_id: str, index: int, char: str) -> str:
    """Replace the ``index``-th id character (ignoring prefix and hyphens)."""
    body = short_id.removeprefix("sch:").replace("-", "")
    body = body[:index] + char + body[index + 1 :]
    return f"sch:{body[:4]}-{body[4:8]}-{body[8:]}"


# --- the checksum algorithm ------------------------------------------------


def test_crc10_matches_the_published_crc_10_atm_check_value():
    """CRC-10/ATM of ASCII "123456789" is 0x199 in the CRC catalogue, so the
    implementation is pinned independently of its own output."""
    data = b"123456789"
    assert _crc10(int.from_bytes(data, "big"), len(data) * 8) == 0x199


def test_all_zero_digest_is_all_a_with_zero_checksum():
    """CRC of an all-zero message is zero, so every character is "a"."""
    assert derive_short_id(record_cid(bytes(32))) == "sch:aaaa-aaaa-aaaa"


# --- deriving the short id -------------------------------------------------


def test_derives_the_pinned_short_id_for_a_real_record_cid():
    assert derive_short_id(GENESIS_CID) == GENESIS_SHORT_ID


def test_short_id_has_the_grouped_base32_form():
    short_id = derive_short_id(GENESIS_CID)
    assert SHORT_ID_RE.fullmatch(short_id)
    assert set(short_id.removeprefix("sch:").replace("-", "")) <= set(
        SHORT_ID_ALPHABET
    )


def test_payload_is_the_first_50_digest_bits_in_base32():
    digest = bytes.fromhex(
        "ea5887b2a0e2e4f34babab4d2eef39d1a73d32c9ff34bcfeb1308a2dae8a93cf"
    )
    bits = bin(int.from_bytes(digest, "big"))[2:].zfill(256)[:50]
    expected = "".join(
        SHORT_ID_ALPHABET[int(bits[i : i + 5], 2)] for i in range(0, 50, 5)
    )
    payload = derive_short_id(record_cid(digest)).removeprefix("sch:")
    assert payload.replace("-", "")[:10] == expected == "5jmipmva4l"


def test_only_the_first_50_digest_bits_matter():
    base = bytes(6) + b"\x00" + bytes(25)
    tail_noise = bytes(6) + b"\x3f" + b"\xff" * 25  # bits 50.. all set
    assert derive_short_id(record_cid(tail_noise)) == derive_short_id(
        record_cid(base)
    )
    bit_49 = bytes(6) + b"\x40" + bytes(25)  # last payload bit
    assert derive_short_id(record_cid(bit_49)) != derive_short_id(
        record_cid(base)
    )


def test_is_stable_across_cid_encodings_and_objects():
    cid = CID.decode(GENESIS_CID)
    spellings = [
        GENESIS_CID,
        GENESIS_CID.upper(),  # base32upper
        cid.set(base="base58btc").encode(),
        cid.set(base="base16").encode(),
        cid,
    ]
    assert {derive_short_id(s) for s in spellings} == {GENESIS_SHORT_ID}


def test_is_deterministic_and_distinct_per_genesis():
    ids = [derive_short_id(compute_record_id(genesis_envelope(n=n))) for n in range(50)]
    assert ids == [
        derive_short_id(compute_record_id(genesis_envelope(n=n))) for n in range(50)
    ]
    assert len(set(ids)) == len(ids)


def test_id_is_not_taken_from_the_shared_cid_header():
    """Record CID strings all start "bafyrei"; ids must not just slice them."""
    a = compute_record_id(genesis_envelope(n=1))
    b = compute_record_id(genesis_envelope(n=2))
    assert a[:7] == b[:7] == "bafyrei"
    id_a, id_b = derive_short_id(a), derive_short_id(b)
    assert id_a != id_b
    # a slice of the CID string would put "bafyrei" at the start of the id
    assert not id_a.startswith("sch:bafy") and not id_b.startswith("sch:bafy")


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "not-a-cid",
        "bafy",
        "bafyreiZZZ",
        GENESIS_CID[:-3],  # truncated digest
        "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",  # CIDv0
        str(CID("base32", 1, "raw", ("sha2-256", bytes(32)))),  # file id
        str(CID("base32", 1, "dag-cbor", ("sha2-512", bytes(64)))),
        None,
        123,
        b"bafyrei",
        ["bafyrei"],
    ],
)
def test_rejects_anything_that_is_not_a_record_cid(bad):
    with pytest.raises(ValueError):
        derive_short_id(bad)


def test_rejected_cid_message_names_the_problem():
    with pytest.raises(ValueError, match="not a valid CID"):
        derive_short_id("not-a-cid")
    raw = CID("base32", 1, "raw", ("sha2-256", bytes(32)))
    with pytest.raises(ValueError, match="not a record id"):
        derive_short_id(raw)
    with pytest.raises(ValueError, match="CID string or object"):
        derive_short_id(None)


# --- parsing paper ids -----------------------------------------------------


def test_parse_short_id_round_trips_a_derived_id():
    assert parse_short_id(GENESIS_SHORT_ID) == GENESIS_SHORT_ID
    for n in range(20):
        short_id = derive_short_id(compute_record_id(genesis_envelope(n=n)))
        assert parse_short_id(short_id) == short_id


def test_parse_is_case_insensitive_and_canonicalises_to_lowercase():
    assert parse_short_id(GENESIS_SHORT_ID.upper()) == GENESIS_SHORT_ID
    assert parse_short_id("Sch:5Jmi-pMVa-4lMR") == GENESIS_SHORT_ID
    assert parse_version_id("SCH:5JMI-PMVA-4LMR/V3") == VersionId(
        GENESIS_SHORT_ID, 3
    )


def test_parse_short_id_rejects_a_version_id():
    with pytest.raises(ValueError, match="version id"):
        parse_short_id(GENESIS_SHORT_ID + "/v1")


# --- parsing version ids ---------------------------------------------------


@pytest.mark.parametrize("n", [1, 2, 9, 10, 123, MAX_VERSION])
def test_parse_version_id(n):
    parsed = parse_version_id(f"{GENESIS_SHORT_ID}/v{n}")
    assert parsed == VersionId(short_id=GENESIS_SHORT_ID, version=n)
    assert isinstance(parsed.version, int)
    short_id, version = parsed  # unpacks like a tuple
    assert (short_id, version) == (GENESIS_SHORT_ID, n)


def test_parse_version_id_requires_a_version():
    with pytest.raises(ValueError, match="no version"):
        parse_version_id(GENESIS_SHORT_ID)


def test_format_version_id_round_trips_with_parse():
    for n in (1, 2, 10, MAX_VERSION):
        version_id = format_version_id(GENESIS_SHORT_ID, n)
        assert version_id == f"{GENESIS_SHORT_ID}/v{n}"
        assert parse_version_id(version_id) == VersionId(GENESIS_SHORT_ID, n)


def test_format_version_id_canonicalises_the_short_id():
    assert (
        format_version_id(GENESIS_SHORT_ID.upper(), 2) == f"{GENESIS_SHORT_ID}/v2"
    )


@pytest.mark.parametrize(
    "version", [0, -1, MAX_VERSION + 1, True, False, 1.0, "1", None]
)
def test_format_version_id_rejects_bad_versions(version):
    with pytest.raises(ValueError, match="version must be an integer"):
        format_version_id(GENESIS_SHORT_ID, version)


def test_format_version_id_rejects_a_bad_short_id():
    with pytest.raises(ValueError, match="bad checksum"):
        format_version_id("sch:5jmi-pmva-4lma", 1)
    with pytest.raises(ValueError, match="version id"):
        format_version_id(GENESIS_SHORT_ID + "/v1", 2)


# --- bad checksums ---------------------------------------------------------


def test_bad_checksum_raises_a_value_error_with_a_clear_message():
    with pytest.raises(ValueError) as excinfo:
        parse_short_id("sch:5jmi-pmva-4lma")
    message = str(excinfo.value)
    assert "bad checksum" in message
    assert "sch:5jmi-pmva-4lma" in message  # names the offending id

    with pytest.raises(ValueError, match="bad checksum"):
        parse_version_id("sch:5jmi-pmva-4lma/v1")


@pytest.mark.parametrize("name", ["genesis", "zero", "ones"])
def test_every_single_character_substitution_is_detected(name):
    short_id = {
        "genesis": GENESIS_SHORT_ID,
        "zero": derive_short_id(record_cid(bytes(32))),
        "ones": derive_short_id(record_cid(b"\xff" * 32)),
    }[name]
    body = short_id.removeprefix("sch:").replace("-", "")
    for index, original in enumerate(body):
        for char in SHORT_ID_ALPHABET:
            if char == original:
                continue
            with pytest.raises(ValueError, match="bad checksum"):
                parse_short_id(corrupt(short_id, index, char))


def test_every_adjacent_transposition_is_detected():
    for n in range(40):
        short_id = derive_short_id(compute_record_id(genesis_envelope(n=n)))
        body = short_id.removeprefix("sch:").replace("-", "")
        for i in range(len(body) - 1):
            if body[i] == body[i + 1]:
                continue  # swapping equal characters changes nothing
            swapped = swap(body, i)
            candidate = f"sch:{swapped[:4]}-{swapped[4:8]}-{swapped[8:]}"
            with pytest.raises(ValueError, match="bad checksum"):
                parse_short_id(candidate)


def test_checksum_is_checked_on_version_ids_too():
    for n in range(10):
        short_id = derive_short_id(compute_record_id(genesis_envelope(n=n)))
        bad = corrupt(short_id, 3, "a" if short_id[7] != "a" else "b")
        with pytest.raises(ValueError, match="bad checksum"):
            parse_version_id(f"{bad}/v1")


# --- malformed ids ---------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "5jmi-pmva-4lmr",  # no prefix
        "doi:5jmi-pmva-4lmr",
        "sch5jmi-pmva-4lmr",
        "sch:5jmipmva4lmr",  # no hyphens
        "sch:5jmip-mva4-lmr",  # wrong grouping
        "sch:5jmi_pmva_4lmr",
        "sch:5jmi-pmva-4lmr2",  # too long
        "sch:5jmi-pmva-4lm",  # too short
        "sch:5jmi-pmva-4lm1",  # '1' is not in the alphabet
        "sch:5jmi-pmva-4lm=",
        "sch:k3f9-q2xz-7mwd",  # the docs' illustrative id: '9' is not base32
        "sch:Kaaa-aaaa-aaaa",  # Kelvin sign: lowercases to ASCII "k"
        "sch:5jmi-pmva-4lmr\n",
        " sch:5jmi-pmva-4lmr",
        "sch:5jmi-pmva-4lmr ",
        "sch:5jmi-pmva-4lmr/",
        "sch:5jmi-pmva-4lmr/v",
        "sch:5jmi-pmva-4lmr/v0",
        "sch:5jmi-pmva-4lmr/v01",
        "sch:5jmi-pmva-4lmr/v-1",
        "sch:5jmi-pmva-4lmr/v+1",
        "sch:5jmi-pmva-4lmr/v1.0",
        "sch:5jmi-pmva-4lmr/v1a",
        "sch:5jmi-pmva-4lmr/v١",  # Arabic-Indic digit one
        "sch:5jmi-pmva-4lmr/1",
        "sch:5jmi-pmva-4lmr/v1/",
        "sch:5jmi-pmva-4lmr/v1/v2",
        f"sch:5jmi-pmva-4lmr/v{MAX_VERSION + 1}",
        "sch:5jmi-pmva-4lmr/v" + "9" * 5000,
    ],
)
def test_malformed_ids_raise_a_format_error_not_a_checksum_error(bad):
    for parse in (parse_short_id, parse_version_id):
        with pytest.raises(ValueError, match="not a valid sch: id") as excinfo:
            parse(bad)
        assert "checksum" not in str(excinfo.value)


@pytest.mark.parametrize("bad", [None, 123, b"sch:5jmi-pmva-4lmr", ["sch:x"]])
def test_non_string_input_raises_value_error(bad):
    for parse in (parse_short_id, parse_version_id):
        with pytest.raises(ValueError, match="must be a string"):
            parse(bad)


def test_error_messages_do_not_echo_unbounded_input():
    with pytest.raises(ValueError) as excinfo:
        parse_short_id("sch:" + "x" * 100_000)
    assert len(str(excinfo.value)) < 300
