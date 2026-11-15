"""Tests for Ed25519 signing and did:key conversion over envelope bytes."""

import base64

import pytest
from multiformats import multibase
from nacl.signing import SigningKey

from scholium_record_core import (
    DID_KEY_PREFIX,
    ED25519_MULTICODEC,
    ED25519_SIGNATURE_LENGTH,
    SIG_ENCODING,
    compute_record_id,
    decode_signature,
    did_key_from_public_key,
    did_key_from_signing_key,
    encode_signature,
    is_ed25519_did_key,
    public_key_from_did_key,
    record_bytes,
    sign_envelope,
    sign_record,
    verify_envelope,
    verify_record,
)


def make_envelope(**overrides):
    envelope = {
        "v": 1,
        "type": "paper.genesis",
        "author": "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
        "created": "2026-11-14T05:33:00Z",
        "prev": None,
        "body": {"seed": "s-1", "title": "A Paper"},
        "proofs": [],
    }
    envelope.update(overrides)
    return envelope


@pytest.fixture(scope="module")
def author_key():
    return SigningKey(b"\x01" * 32)


@pytest.fixture()
def signed_envelope(author_key):
    envelope = make_envelope(author=did_key_from_signing_key(author_key))
    return envelope, sign_envelope(envelope, author_key)


# --- did:key conversion -------------------------------------------------


def test_did_key_round_trips_through_the_public_key():
    public_key = bytes(SigningKey.generate().verify_key)
    did = did_key_from_public_key(public_key)
    assert did.startswith(DID_KEY_PREFIX)
    assert did.startswith("did:key:z6Mk")  # ed25519-pub always encodes z6Mk…
    assert public_key_from_did_key(did) == public_key
    assert is_ed25519_did_key(did)


def test_did_key_multicodec_layout():
    public_key = bytes(SigningKey.generate().verify_key)
    decoded = multibase.decode(did_key_from_public_key(public_key)[len("did:key:") :])
    assert decoded == ED25519_MULTICODEC + public_key


def test_did_key_from_wrong_length_public_key_raises():
    with pytest.raises(ValueError, match="32 bytes"):
        did_key_from_public_key(b"\x00" * 31)
    with pytest.raises(ValueError, match="32 bytes"):
        did_key_from_public_key(b"\x00" * 33)
    with pytest.raises(ValueError):
        did_key_from_public_key("not-bytes")


def test_public_key_from_malformed_did_key_raises():
    for bad in [
        "",  # empty
        "6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",  # no scheme
        "did:web:example.com",  # wrong method
        "did:key:u6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",  # not z multibase
        "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb0OIl",  # bad base58
    ]:
        with pytest.raises(ValueError):
            public_key_from_did_key(bad)
        assert not is_ed25519_did_key(bad)


def test_public_key_from_non_ed25519_did_key_raises():
    secp256k1 = "did:key:" + multibase.encode(b"\xe7\x01" + b"\x11" * 33, "base58btc")
    truncated = "did:key:" + multibase.encode(
        ED25519_MULTICODEC + b"\x11" * 16, "base58btc"
    )
    for bad in [secp256k1, truncated]:
        with pytest.raises(ValueError, match="Ed25519"):
            public_key_from_did_key(bad)
        assert not is_ed25519_did_key(bad)


def test_is_ed25519_did_key_rejects_non_strings():
    assert not is_ed25519_did_key(None)
    assert not is_ed25519_did_key(12345)
    assert not is_ed25519_did_key(["did:key:z6Mk"])


def test_did_key_from_signing_key_accepts_a_seed():
    seed = b"\x02" * 32
    assert did_key_from_signing_key(seed) == did_key_from_public_key(
        bytes(SigningKey(seed).verify_key)
    )


# --- signature encoding -------------------------------------------------


def test_encode_signature_is_unpadded_base64url():
    raw = bytes(range(ED25519_SIGNATURE_LENGTH))
    text = encode_signature(raw)
    assert SIG_ENCODING == "base64url-unpadded"
    assert text == base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    assert "=" not in text
    assert decode_signature(text) == raw


def test_decode_signature_accepts_raw_bytes_and_padded_text():
    raw = bytes(range(ED25519_SIGNATURE_LENGTH))
    assert decode_signature(raw) == raw
    assert decode_signature(bytearray(raw)) == raw
    padded = base64.urlsafe_b64encode(raw).decode()
    assert decode_signature(padded) == raw


def test_decode_signature_rejects_malformed_input():
    for bad in [
        "",
        "====",
        "not base64url!",
        "AB+CD",  # standard base64 alphabet (+/) is not base64url
        "A" * 85,  # wrong decoded length
        "A" * 87,
        b"\x00" * 63,  # raw, wrong length
        b"\x00" * 65,
        12345,
        None,
    ]:
        with pytest.raises(ValueError):
            decode_signature(bad)


# --- signing --------------------------------------------------------------


def test_sign_envelope_signs_the_canonical_bytes(author_key):
    """The preimage is exactly record_bytes — pinned by re-signing by hand."""
    envelope = make_envelope(author=did_key_from_signing_key(author_key))
    sig = sign_envelope(envelope, author_key)
    assert sig == encode_signature(author_key.sign(record_bytes(envelope)).signature)


def test_sign_envelope_ignores_id_and_sig_members(author_key):
    envelope = make_envelope(author=did_key_from_signing_key(author_key))
    carrier = dict(envelope, id="bafyreistale", sig="old-sig")
    assert sign_envelope(carrier, author_key) == sign_envelope(envelope, author_key)


def test_sign_envelope_is_deterministic_per_seed():
    envelope = make_envelope()
    a = sign_envelope(envelope, b"\x03" * 32)
    b = sign_envelope(envelope, SigningKey(b"\x03" * 32))
    c = sign_envelope(envelope, b"\x04" * 32)
    assert a == b  # same seed, same bytes
    assert a != c  # different key
    assert len(decode_signature(a)) == ED25519_SIGNATURE_LENGTH


def test_sign_envelope_rejects_bad_key_and_envelope():
    with pytest.raises(ValueError, match="seed"):
        sign_envelope(make_envelope(), b"\x03" * 31)
    with pytest.raises(ValueError, match="SigningKey"):
        sign_envelope(make_envelope(), "a string")
    key = SigningKey.generate()
    with pytest.raises(ValueError):
        sign_envelope({"v": 1}, key)  # envelope missing required fields


# --- verification ---------------------------------------------------------


def test_verify_envelope_accepts_a_freshly_signed_record(signed_envelope):
    envelope, sig = signed_envelope
    assert verify_envelope(envelope, sig)  # did from the envelope author
    assert verify_envelope(envelope, sig, envelope["author"])
    assert verify_envelope(envelope, sig, public_key_from_did_key(envelope["author"]))


def test_verify_envelope_returns_false_for_a_tampered_body(signed_envelope):
    envelope, sig = signed_envelope
    tampered = dict(
        envelope, body={"seed": envelope["body"]["seed"], "title": "A Tampered Paper"}
    )
    assert tampered["body"] != envelope["body"]
    assert verify_envelope(tampered, sig) is False
    assert verify_envelope(tampered, sig, envelope["author"]) is False


def test_verify_envelope_returns_false_for_any_tampered_content_field(signed_envelope):
    envelope, sig = signed_envelope
    for field, value in [
        ("type", "paper.version"),
        ("created", "2026-11-14T05:33:01Z"),
        ("prev", "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4"),
        ("proofs", ["vc-1"]),
        ("v", 2),
    ]:
        assert verify_envelope({**envelope, field: value}, sig) is False, field


def test_verify_envelope_ignores_id_and_sig_members(signed_envelope):
    envelope, sig = signed_envelope
    carrier = dict(envelope, id="bafyreistale", sig="garbage")
    assert verify_envelope(carrier, sig)
    assert verify_envelope(carrier, sig, envelope["author"])


def test_verify_envelope_returns_false_for_a_wrong_key(signed_envelope):
    envelope, sig = signed_envelope
    other = SigningKey.generate()
    assert verify_envelope(envelope, sig, did_key_from_signing_key(other)) is False
    assert verify_envelope(envelope, sig, bytes(other.verify_key)) is False
    # a signature made by the other key over the intact envelope also fails
    forged = sign_envelope(envelope, other)
    assert verify_envelope(envelope, forged) is False


def test_verify_envelope_returns_false_for_a_corrupt_signature(signed_envelope):
    envelope, sig = signed_envelope
    raw = bytearray(decode_signature(sig))
    raw[0] ^= 1
    assert verify_envelope(envelope, bytes(raw)) is False
    for bad in ["", "AAAA", "A" * 86, 12345, None, b"\x00" * 63]:
        assert verify_envelope(envelope, bad) is False


def test_verify_envelope_returns_false_for_invalid_inputs():
    key = SigningKey.generate()
    sig = sign_envelope(make_envelope(), key)
    assert verify_envelope({"v": 1}, sig) is False  # invalid envelope
    assert verify_envelope("nope", sig) is False
    assert verify_envelope(make_envelope(), sig, "did:key:z6Mkbad") is False
    assert verify_envelope(make_envelope(), sig, b"\x00" * 31) is False
    assert verify_envelope(make_envelope(), sig, 12345) is False
    # a structurally valid envelope whose author is not a did:key
    not_a_did = sign_envelope(make_envelope(author="alice"), key)
    assert verify_envelope(make_envelope(author="alice"), not_a_did) is False


# --- signed records -------------------------------------------------------


def test_sign_record_completes_and_verifies_a_record():
    key = SigningKey(b"\x05" * 32)
    with pytest.raises(ValueError, match="author"):
        sign_record(make_envelope(), key)  # envelope claims another author

    envelope = make_envelope(author=did_key_from_signing_key(key))
    record = sign_record(envelope, key)
    assert record["author"] == did_key_from_signing_key(key)
    assert record["id"].startswith("bafyre")  # a base32 CIDv1 string
    assert set(record) == set(envelope) | {"id", "sig"}
    assert record["id"] == compute_record_id(envelope)
    assert verify_record(record)


def test_sign_record_fills_a_missing_author():
    key = SigningKey(b"\x06" * 32)
    envelope = make_envelope()
    del envelope["author"]
    record = sign_record(envelope, key)
    assert record["author"] == did_key_from_signing_key(key)
    assert verify_record(record)


def test_sign_record_rejects_a_non_mapping():
    with pytest.raises(ValueError, match="mapping"):
        sign_record(["not", "an", "envelope"], SigningKey.generate())


def test_verify_record_returns_false_for_a_tampered_body():
    key = SigningKey(b"\x07" * 32)
    record = sign_record(make_envelope(author=did_key_from_signing_key(key)), key)

    tampered = dict(
        record, body={"seed": record["body"]["seed"], "title": "A Tampered Paper"}
    )
    assert verify_record(tampered) is False  # id and signature both disagree

    # a consistent attacker: recompute the id, keep the stale signature
    reidentified = dict(tampered, id=compute_record_id(tampered))
    assert verify_record(reidentified) is False  # signature still fails

    # re-signed by the author: valid again
    resigned = dict(reidentified, sig=sign_envelope(reidentified, key))
    assert verify_record(resigned)


def test_verify_record_returns_false_for_structural_problems():
    key = SigningKey(b"\x08" * 32)
    record = sign_record(make_envelope(author=did_key_from_signing_key(key)), key)

    assert verify_record(dict(record, id="bafyreistale")) is False  # stale id
    no_id = {k: v for k, v in record.items() if k != "id"}
    assert verify_record(no_id) is False
    no_sig = {k: v for k, v in record.items() if k != "sig"}
    assert verify_record(no_sig) is False
    assert verify_record({"v": 1}) is False
    assert verify_record("nope") is False
    assert verify_record(None) is False
