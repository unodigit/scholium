"""Tests for envelope handling and record id computation."""

import hashlib

import dag_cbor
import pytest
from multiformats import CID, multibase

from scholium_record_core import (
    CID_CODEC_CODE,
    ENVELOPE_FIELDS,
    EXCLUDED_FIELDS,
    canonical_envelope,
    compute_record_cid,
    compute_record_id,
    record_bytes,
)

DID_A = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
DID_B = "did:key:z6Mkf5r9oKZXWyScE3fDnsVM3L4X7oaLLrQtLgYgLKxkbPgK"


def make_envelope(**overrides):
    envelope = {
        "v": 1,
        "type": "discussion.post",
        "author": DID_A,
        "created": "2026-11-14T05:33:00Z",
        "prev": None,
        "body": {"text": "hello"},
        "proofs": [],
    }
    envelope.update(overrides)
    return envelope


def test_canonical_bytes_are_hand_pinned():
    """The canonical bytes are checked against a by-hand CBOR derivation:
    map(7) with keys sorted length-first then bytewise
    (v, body, prev, type, author, proofs, created)."""
    envelope = make_envelope(
        type="t", author="a", created="2026", body={}, proofs=[]
    )
    expected = (
        "a7"  # map(7)
        "6176" "01"  # "v": 1
        "64626f6479" "a0"  # "body": {}
        "6470726576" "f6"  # "prev": null
        "6474797065" "6174"  # "type": "t"
        "66617574686f72" "6161"  # "author": "a"
        "6670726f6f6673" "80"  # "proofs": []
        "6763726561746564" "6432303236"  # "created": "2026"
    )
    assert record_bytes(envelope).hex() == expected


def test_input_key_order_does_not_matter():
    reordered = dict(reversed(list(make_envelope().items())))
    reordered["body"] = {"zz": 1, "a": 2, "k": 3}
    assert record_bytes(reordered) == record_bytes(make_envelope(
        body={"a": 2, "k": 3, "zz": 1}
    ))


def test_map_keys_sort_length_first_then_bytewise():
    # "z" (length 1) sorts before "aa" (length 2) even though 0x61 < 0x7a;
    # a plain bytewise sort would encode the pair the other way around.
    data = record_bytes(make_envelope(body={"z": 1, "aa": 2}))
    assert "a2617a0162616102" in data.hex()  # body: z(1) first, then aa(2)
    assert dag_cbor.decode(data)["body"]["z"] == 1  # round-trips


def test_canonical_envelope_drops_id_sig_and_extras():
    envelope = make_envelope(id="bafyreiwhatever", sig="s", extra="ignored")
    assert canonical_envelope(envelope) == {
        field: envelope[field] for field in ENVELOPE_FIELDS
    }


def test_id_and_sig_are_excluded_from_the_record_id():
    bare = make_envelope()
    with_ids = make_envelope(
        id=compute_record_id(bare), sig="first-signature"
    )
    assert compute_record_id(with_ids) == compute_record_id(bare)

    tampered = make_envelope(id="bafyreistale", sig="another-signature")
    assert compute_record_id(tampered) == compute_record_id(bare)
    assert record_bytes(tampered) == record_bytes(bare)


@pytest.mark.parametrize(
    "field,other",
    [
        ("v", 2),
        ("type", "discussion.postx"),
        ("author", DID_B),
        ("created", "2026-11-14T05:33:00+00:00"),
        ("prev", "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4"),
        ("body", {"text": "tampered"}),
        ("proofs", [{"type": "VerifiableCredential"}]),
    ],
)
def test_every_content_field_changes_the_id(field, other):
    base_id = compute_record_id(make_envelope())
    changed_id = compute_record_id(make_envelope(**{field: other}))
    assert changed_id != base_id


def test_missing_fields_raise_value_error():
    for field in ENVELOPE_FIELDS:
        envelope = make_envelope()
        del envelope[field]
        with pytest.raises(ValueError, match=field):
            compute_record_id(envelope)


@pytest.mark.parametrize(
    "field,bad",
    [
        ("v", "1"),
        ("v", True),
        ("v", 0),
        ("type", 7),
        ("type", ""),
        ("author", None),
        ("created", ""),
        ("prev", 5),
        ("body", "text"),
        ("proofs", "not-a-list"),
    ],
)
def test_field_type_validation(field, bad):
    with pytest.raises(ValueError, match=field):
        compute_record_id(make_envelope(**{field: bad}))


def test_envelope_must_be_a_mapping():
    with pytest.raises(ValueError, match="mapping"):
        compute_record_id(["not", "an", "envelope"])


def test_non_encodable_body_raises_value_error():
    with pytest.raises(ValueError, match="DAG-CBOR"):
        compute_record_id(make_envelope(body={"bad": float("nan")}))
    with pytest.raises(ValueError, match="DAG-CBOR"):
        compute_record_id(make_envelope(body={1: "non-string key"}))


def test_record_id_is_a_cidv1_dag_cbor_sha2_256():
    envelope = make_envelope(id="ignored", sig="ignored")
    cid = compute_record_cid(envelope)
    assert cid.version == 1
    assert cid.codec.code == CID_CODEC_CODE == 0x71
    assert cid.codec.name == "dag-cbor"
    # digest is the multihash: sha2-256 (0x12) of length 0x20 + raw digest
    digest = bytes(cid.digest)
    assert digest[:2] == b"\x12\x20"
    assert digest[2:] == hashlib.sha256(record_bytes(envelope)).digest()
    assert len(digest) == 34

    as_string = compute_record_id(envelope)
    assert as_string == str(cid)
    assert as_string.startswith("bafyrei")
    assert CID.decode(multibase.decode(as_string)) == cid


def test_exclusion_constants():
    assert EXCLUDED_FIELDS == ("id", "sig")
    assert ENVELOPE_FIELDS == (
        "v", "type", "author", "created", "prev", "body", "proofs",
    )


def test_records_hash_deterministically():
    envelope = make_envelope()
    assert compute_record_id(envelope) == compute_record_id(envelope)
    assert dag_cbor.decode(record_bytes(envelope)) == canonical_envelope(envelope)
