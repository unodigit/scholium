"""Acceptance tests for: API exposes GET /v1/sync/head (feature 14).

The endpoint returns the node-signed log head: the log's current ``seq``
and ``entry_hash`` plus this node's ``node_did`` and an Ed25519
``signature`` made with the node key loaded from ``NODE_KEY_PATH`` (a
fresh key provisioned by this directory's ``conftest.py``).  Criteria:

* GET /v1/sync/head returns 200 with ``seq``, ``entry_hash``,
  ``node_did`` and ``signature`` fields.
* The signature in that response verifies against the ``node_did``
  public key.

The serialisation the node signs is not fixed by the spec, so the
verification test accepts any of the conventional encodings of the head
listed in :func:`head_messages` (text, packed binary, JSON and DAG-CBOR
forms); the signature's text encoding is likewise probed for base64url,
standard base64 and hex by :func:`signature_candidates`.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from scholium_record_core import did_key_from_signing_key, public_key_from_did_key

from app.modules import ledger

#: A well-formed Ed25519 did:key; the author of the records used to grow
#: the log (``ledger.append`` does not check author signatures).
AUTHOR = "did:key:z6MkhaKgUb4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"

#: Exactly the fields criterion 1 names.
HEAD_FIELDS = ("seq", "entry_hash", "node_did", "signature")


def make_envelope() -> dict:
    """A minimal valid record envelope with a unique body and cid."""
    tag = uuid.uuid4().hex
    return {
        "v": 1,
        "type": "test.sync.head",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {"tag": tag},
        "proofs": [],
        "id": f"bafyreisynchead{tag}",
    }


def signature_candidates(signature: str) -> list[bytes]:
    """Decode the wire ``signature`` into raw 64-byte Ed25519 signatures.

    The spec does not fix the text encoding, so the encodings this API
    family already uses are all tried: unpadded base64url (record
    signatures), standard base64 (the ``raw`` blobs of /v1/sync/range)
    and hex.  Only 64-byte decodings can be Ed25519 signatures.
    """
    text = signature.strip()
    stripped = text.rstrip("=")
    decoded: list[bytes] = []
    for altchars in (b"-_", b"+/"):
        try:
            decoded.append(
                base64.b64decode(
                    stripped + "=" * (-len(stripped) % 4),
                    altchars=altchars,
                    validate=True,
                )
            )
        except (binascii.Error, ValueError):
            pass
    try:
        decoded.append(bytes.fromhex(text))
    except ValueError:
        pass
    return [raw for raw in decoded if len(raw) == 64]


def head_messages(seq: int, entry_hash_hex: str, node_did: str) -> list[bytes]:
    """The conventional encodings of the head the node may have signed.

    A node signs its log head ``(seq, entryHash)`` (docs/tech_architect.md,
    "Transparency log"); which serialisation it uses is an implementation
    choice, so every canonical form of the pair is offered: text with and
    without a separator, packed binary (decimal or 8-byte big-endian seq
    followed by the 32-byte digest), and the JSON / DAG-CBOR object forms
    (with and without the signing node's did).
    """
    digest = bytes.fromhex(entry_hash_hex)
    candidates = [
        f"{seq}:{entry_hash_hex}".encode(),
        f"{seq}{entry_hash_hex}".encode(),
        f"{seq}:{digest.hex()}".encode(),
        str(seq).encode() + digest,
        seq.to_bytes(8, "big") + digest,
        json.dumps(
            {"seq": seq, "entry_hash": digest.hex()},
            sort_keys=True,
            separators=(",", ":"),
        ).encode(),
        json.dumps(
            {"entry_hash": digest.hex(), "node_did": node_did, "seq": seq},
            sort_keys=True,
            separators=(",", ":"),
        ).encode(),
    ]

    def _add(candidate: bytes) -> None:
        if candidate not in candidates:
            candidates.append(candidate)

    try:  # DAG-CBOR object forms, raw digest and hex digest alike.
        import dag_cbor

        _add(dag_cbor.encode({"seq": seq, "entry_hash": digest}))
        _add(dag_cbor.encode({"seq": seq, "entry_hash": digest.hex()}))
        _add(
            dag_cbor.encode(
                {"entry_hash": digest.hex(), "node_did": node_did, "seq": seq}
            )
        )
    except Exception:  # pragma: no cover - dag_cbor is a hard dependency
        pass
    return candidates


def _verifies(verify_key: VerifyKey, message: bytes, signature: bytes) -> bool:
    try:
        verify_key.verify(message, signature)
    except BadSignatureError:
        return False
    return True


# --------------------------------------------------------------------------- #
# Criterion 1: 200 with seq, entry_hash, node_did and signature fields
# --------------------------------------------------------------------------- #


def test_sync_head_returns_200_with_head_fields(client):
    ledger.append(make_envelope())
    head = ledger.latest()

    response = client.get("/v1/sync/head")

    assert response.status_code == 200
    body = response.json()
    for field in HEAD_FIELDS:
        assert field in body, f"response is missing the {field!r} field"
    assert isinstance(body["seq"], int) and not isinstance(body["seq"], bool)
    for field in ("entry_hash", "node_did", "signature"):
        assert isinstance(body[field], str) and body[field], (
            f"the {field!r} field must be a non-empty string"
        )
    # "the log head": the served head is the log's last entry, with its
    # 32-byte entry hash in hex -- the same wire form /v1/sync/range serves.
    assert body["seq"] == head.seq
    assert bytes.fromhex(body["entry_hash"]) == bytes(head.entry_hash)


# --------------------------------------------------------------------------- #
# Criterion 2: the signature verifies against the node_did public key
# --------------------------------------------------------------------------- #


def test_sync_head_signature_verifies_against_node_did_public_key(
    client, node_key_seed
):
    ledger.append(make_envelope())

    response = client.get("/v1/sync/head")

    assert response.status_code == 200
    body = response.json()
    # The head is signed with the key loaded from NODE_KEY_PATH (provisioned
    # by conftest), so node_did must be the did:key of that very key.
    assert body["node_did"] == did_key_from_signing_key(node_key_seed), (
        "node_did is not the did:key of the Ed25519 key at NODE_KEY_PATH"
    )

    public_key = public_key_from_did_key(body["node_did"])
    signatures = signature_candidates(body["signature"])
    assert signatures, "signature does not decode to 64 raw Ed25519 bytes"
    messages = head_messages(body["seq"], body["entry_hash"], body["node_did"])
    assert messages, "could not build the head message candidates"

    verify_key = VerifyKey(public_key)
    assert any(
        _verifies(verify_key, message, signature)
        for message in messages
        for signature in signatures
    ), (
        "the signature does not verify against the node_did public key "
        "over the head (seq, entry_hash)"
    )
