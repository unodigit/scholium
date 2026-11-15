"""Tests for the event log ledger (feature 12).

Covers: persisting every ``event_log`` column, the hash chain rule
``entry_hash = sha256(prev_hash || record_cid || raw)``, canonical raw bytes,
CID computation when the envelope omits ``id``, ``origin_node`` resolution,
duplicate-CID rejection, and in-process subscriber notification.

Isolation note: xdist workers get their own database file but sequential tests
in a worker share the table, so tests take their chain anchor from the current
head instead of assuming an empty log.  Subscribers are cleared between tests.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import ledger
from app.modules.ledger import EventLog, GENESIS_PREV_HASH, compute_entry_hash
from scholium_record_core import compute_record_id, record_bytes

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"


@pytest.fixture(autouse=True)
def clean_subscribers():
    ledger.clear_subscribers()
    yield
    ledger.clear_subscribers()


def make_envelope(*, record_type: str = "test.ledger.append", body=None, with_id: bool = False):
    tag = uuid.uuid4().hex
    envelope = {
        "v": 1,
        "type": record_type,
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {"tag": tag} if body is None else body,
        "proofs": [],
    }
    if with_id:
        envelope["id"] = f"bafyreitest{tag}"
    return envelope


def read_row(seq: int) -> EventLog:
    with db.SessionLocal() as session:
        row = session.get(EventLog, seq)
        assert row is not None
        return row


def predecessor_hash(seq: int) -> bytes:
    """The ``entry_hash`` of the row immediately before ``seq`` in the table.

    Read from the database rather than remembered before the append: parallel
    pytest workers share this file and may append between our statements, but
    writes are serialised, so the predecessor *by seq* is the true chain link.
    """
    with db.SessionLocal() as session:
        previous = session.execute(
            select(EventLog.entry_hash)
            .where(EventLog.seq < seq)
            .order_by(EventLog.seq.desc())
            .limit(1)
        ).scalar_one_or_none()
    return GENESIS_PREV_HASH if previous is None else bytes(previous)


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


def test_append_persists_every_column():
    envelope = make_envelope(with_id=True)

    entry = ledger.append(envelope)

    before = predecessor_hash(entry.seq)

    assert isinstance(entry.seq, int) and entry.seq > 0
    assert entry.record_cid == envelope["id"]
    assert entry.record_type == envelope["type"]
    assert entry.author_did == envelope["author"]
    assert entry.body == envelope["body"]
    assert bytes(entry.raw) == record_bytes(envelope)
    assert bytes(entry.prev_hash) == before
    assert bytes(entry.entry_hash) == compute_entry_hash(before, envelope["id"], record_bytes(envelope))
    assert isinstance(entry.received_at, datetime)
    assert entry.received_at.tzinfo is None
    assert isinstance(entry.origin_node, str) and entry.origin_node

    row = read_row(entry.seq)
    assert row.record_cid == envelope["id"]
    assert row.record_type == envelope["type"]
    assert row.author_did == envelope["author"]
    assert row.body == envelope["body"]
    assert bytes(row.raw) == record_bytes(envelope)
    assert bytes(row.prev_hash) == before
    assert bytes(row.entry_hash) == bytes(entry.entry_hash)
    assert row.origin_node == entry.origin_node


def test_append_links_each_entry_to_the_previous_hash():
    first = ledger.append(make_envelope())
    second = ledger.append(make_envelope())

    assert second.seq > first.seq

    for entry in (first, second):
        assert bytes(entry.prev_hash) == predecessor_hash(entry.seq)
        expected = hashlib.sha256(
            bytes(entry.prev_hash) + entry.record_cid.encode("utf-8") + bytes(entry.raw)
        ).digest()
        assert bytes(entry.entry_hash) == expected


def test_append_computes_the_cid_and_raw_bytes_when_id_is_absent():
    envelope = make_envelope()

    entry = ledger.append(envelope)

    assert entry.record_cid == compute_record_id(envelope)
    assert bytes(entry.raw) == record_bytes(envelope)


def test_append_uses_the_envelope_id_verbatim():
    envelope = make_envelope(with_id=True)

    entry = ledger.append(envelope)

    assert entry.record_cid == envelope["id"]


def test_genesis_prev_hash_is_32_zero_bytes():
    assert GENESIS_PREV_HASH == b"\x00" * 32


def test_duplicate_record_cid_is_rejected():
    envelope = make_envelope(with_id=True)
    ledger.append(envelope)

    with pytest.raises(IntegrityError):
        ledger.append(envelope)


def test_invalid_envelope_raises_value_error():
    with pytest.raises(ValueError):
        ledger.append({"type": "test.ledger.append"})

    with pytest.raises(TypeError):
        ledger.append(["not", "a", "mapping"])


def test_row_supports_mapping_access():
    entry = ledger.append(make_envelope())

    assert entry["record_cid"] == entry.record_cid
    assert entry.get("record_type") == entry.record_type
    assert entry.get("missing", "default") == "default"
    assert "entry_hash" in entry
    assert set(dict(entry)) == set(EventLog.COLUMN_NAMES)


def test_read_helpers_find_entries_by_seq_and_cid():
    entry = ledger.append(make_envelope())

    head = ledger.latest()
    assert head is not None and head.seq >= entry.seq

    found = ledger.entry_by_cid(entry.record_cid)
    assert found is not None and found.seq == entry.seq
    assert ledger.entry_by_cid("bafyreimissing") is None

    bounded = ledger.entries(after=entry.seq - 1, through=entry.seq)
    assert [row.seq for row in bounded] == [entry.seq]


# --------------------------------------------------------------------------- #
# origin_node
# --------------------------------------------------------------------------- #


def test_origin_node_can_be_overridden_per_append():
    entry = ledger.append(make_envelope(), origin_node="did:key:ztestone")

    assert entry.origin_node == "did:key:ztestone"


def test_origin_node_comes_from_environment(monkeypatch):
    monkeypatch.setenv("NODE_DID", "did:key:zenvironment")
    monkeypatch.delenv("ORIGIN_NODE", raising=False)
    monkeypatch.delenv("SCHOLIUM_NODE_DID", raising=False)

    entry = ledger.append(make_envelope())

    assert entry.origin_node == "did:key:zenvironment"


def test_origin_node_has_a_stable_default(monkeypatch, tmp_path):
    for name in ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(
        "app.modules.ledger.origin.settings.NODE_KEY_PATH", str(tmp_path / "missing.key")
    )

    assert ledger.node_did() == ledger.DEFAULT_ORIGIN_NODE
    assert ledger.append(make_envelope()).origin_node == ledger.DEFAULT_ORIGIN_NODE


def test_origin_node_is_derived_from_the_node_key_file(monkeypatch, tmp_path):
    from nacl.signing import SigningKey

    for name in ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID"):
        monkeypatch.delenv(name, raising=False)
    seed = bytes(range(32))
    key_path = tmp_path / "node.key"
    key_path.write_bytes(seed)
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))

    public_key = SigningKey(seed).verify_key.encode()

    assert ledger.node_did() == ledger.did_key_from_public_key(public_key)
    assert ledger.append(make_envelope()).origin_node == ledger.node_did()


# --------------------------------------------------------------------------- #
# Subscribers
# --------------------------------------------------------------------------- #


def test_subscribe_notifies_only_matching_record_types():
    seen_a: list = []
    seen_b: list = []

    ledger.subscribe("test.ledger.a", seen_a.append)
    ledger.subscribe("test.ledger.b", seen_b.append)
    entry = ledger.append(make_envelope(record_type="test.ledger.a"))

    assert seen_a == [entry]
    assert seen_b == []


def test_subscribe_works_as_a_decorator():
    seen: list = []

    @ledger.subscribe("test.ledger.decorated")
    def on_record(entry):
        seen.append(entry)

    assert callable(on_record)
    entry = ledger.append(make_envelope(record_type="test.ledger.decorated"))

    assert seen == [entry]


def test_wildcard_subscriber_receives_every_type():
    seen: list = []
    ledger.subscribe(ledger.WILDCARD, seen.append)

    first = ledger.append(make_envelope(record_type="test.ledger.one"))
    second = ledger.append(make_envelope(record_type="test.ledger.two"))

    assert seen == [first, second]


def test_unsubscribe_stops_delivery():
    seen: list = []

    def on_record(entry):
        seen.append(entry)

    ledger.subscribe("test.ledger.unsub", on_record)
    ledger.append(make_envelope(record_type="test.ledger.unsub"))
    ledger.unsubscribe("test.ledger.unsub", on_record)
    ledger.append(make_envelope(record_type="test.ledger.unsub"))

    assert len(seen) == 1


def test_subscribing_the_same_function_twice_is_a_noop():
    seen: list = []
    ledger.subscribe("test.ledger.dupe", seen.append)
    ledger.subscribe("test.ledger.dupe", seen.append)

    assert ledger.subscriber_count("test.ledger.dupe") == 1
    ledger.append(make_envelope(record_type="test.ledger.dupe"))
    assert len(seen) == 1


def test_a_failing_subscriber_does_not_lose_the_entry_or_block_others():
    seen: list = []

    def broken(entry):
        raise RuntimeError("subscriber is broken")

    ledger.subscribe("test.ledger.failing", broken)
    ledger.subscribe("test.ledger.failing", seen.append)

    entry = ledger.append(make_envelope(record_type="test.ledger.failing"))

    assert read_row(entry.seq).record_cid == entry.record_cid
    assert seen == [entry]


def test_subscribe_rejects_bad_arguments():
    with pytest.raises(ValueError):
        ledger.subscribe("", lambda entry: None)
    with pytest.raises(TypeError):
        ledger.subscribe("test.ledger.bad", "not-callable")
