"""Tests for verify_log, the hash-chain verifier (feature 18).

Covers: an intact chain (full log and anchored window) verifies; a rewritten
entry is reported at its own seq; a recomputed-away rewrite is caught at the
next link; a reordered or removed entry is reported at the first seq the
sequence fails to supply; entries are accepted as event_log rows, mappings,
``to_dict()`` output and the sync range's wire model (hex hashes, base64
``raw``); malformed input raises instead of being reported as a break.

Most tests build their chain in memory from ``compute_entry_hash``: they
exercise the verifier, not the database, and never edit a row (the log is
append-only and the worker's database is shared).  The last group verifies
rows this test appended for real.

Isolation note: like the other ledger tests, the real-entry tests share the
worker's append-only log, so they only assert on a window they hold (plus
the chain head's predecessor) or on the whole log, which appending cannot
rewrite.
"""

from __future__ import annotations

import base64
import uuid

import pytest

from app.modules import ledger
from app.modules.ledger import GENESIS_PREV_HASH, compute_entry_hash, verify_log
from app.modules.ledger.sync_range import serialise_entry

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"


def make_chain(count: int, *, start_seq: int = 1, anchor: bytes = GENESIS_PREV_HASH) -> list[dict]:
    """Return ``count`` consistent entries in seq order, starting at ``start_seq``."""
    entries: list[dict] = []
    prev_hash = anchor
    tag = uuid.uuid4().hex
    for index in range(count):
        record_cid = f"bafyreiverify{tag}{index}"
        raw = f"canonical cbor {tag} {index}".encode("utf-8")
        entry_hash = compute_entry_hash(prev_hash, record_cid, raw)
        entries.append(
            {
                "seq": start_seq + index,
                "record_cid": record_cid,
                "raw": raw,
                "prev_hash": prev_hash,
                "entry_hash": entry_hash,
            }
        )
        prev_hash = entry_hash
    return entries


def make_envelope(*, record_type: str = "test.ledger.verify"):
    tag = uuid.uuid4().hex
    return {
        "v": 1,
        "type": record_type,
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {"tag": tag},
        "proofs": [],
        "id": f"bafyreiverifylog{tag}",
    }


# --------------------------------------------------------------------------- #
# An intact chain
# --------------------------------------------------------------------------- #


def test_an_intact_log_verifies():
    assert verify_log(make_chain(5)) is None


def test_an_empty_log_verifies():
    assert verify_log([]) is None
    assert verify_log(iter(())) is None


def test_an_anchored_window_verifies():
    anchor = compute_entry_hash(GENESIS_PREV_HASH, "bafyreiprior", b"earlier record")
    window = make_chain(3, start_seq=42, anchor=anchor)

    assert verify_log(window, anchor=anchor) is None


def test_accepted_hash_and_raw_encodings_verify():
    chain = make_chain(2)
    hexed = [
        {
            **entry,
            "raw": base64.b64encode(entry["raw"]).decode("ascii"),
            "prev_hash": entry["prev_hash"].hex(),
            "entry_hash": entry["entry_hash"].hex(),
        }
        for entry in chain
    ]

    assert verify_log(hexed) is None


# --------------------------------------------------------------------------- #
# A rewritten entry
# --------------------------------------------------------------------------- #


def test_a_rewritten_raw_reports_that_seq():
    chain = make_chain(4)
    chain[1]["raw"] = b"a different record"

    assert verify_log(chain) == 2


def test_a_rewritten_record_cid_reports_that_seq():
    chain = make_chain(4)
    chain[2]["record_cid"] = "bafyreiswapped"

    assert verify_log(chain) == 3


def test_a_rewritten_entry_hash_reports_that_seq():
    chain = make_chain(4)
    chain[0]["entry_hash"] = b"\x11" * 32

    assert verify_log(chain) == 1


def test_a_rewritten_prev_hash_reports_that_seq():
    chain = make_chain(4)
    chain[1]["prev_hash"] = b"\x22" * 32

    assert verify_log(chain) == 2


def test_a_rewrite_with_a_recomputed_hash_is_caught_at_the_next_link():
    chain = make_chain(4)
    chain[1]["raw"] = b"a different record"
    chain[1]["entry_hash"] = compute_entry_hash(
        chain[1]["prev_hash"], chain[1]["record_cid"], chain[1]["raw"]
    )

    # Seq 2's own hash now recomputes, but seq 3 still commits to the old one.
    assert verify_log(chain) == 3


def test_a_rewritten_hex_hash_is_reported():
    chain = make_chain(3)
    chain[1]["entry_hash"] = ("00" * 32)

    assert verify_log(chain) == 2


# --------------------------------------------------------------------------- #
# A reordered or removed entry
# --------------------------------------------------------------------------- #


def test_a_removed_middle_entry_reports_the_missing_seq():
    chain = make_chain(4)
    del chain[1]

    assert verify_log(chain) == 2


def test_a_removed_first_entry_is_detected_against_genesis():
    chain = make_chain(4)
    del chain[0]

    assert verify_log(chain) == 1


def test_a_removed_entry_in_an_anchored_window_reports_the_missing_seq():
    anchor = b"\x33" * 32
    window = make_chain(4, start_seq=10, anchor=anchor)
    del window[2]

    assert verify_log(window, anchor=anchor) == 12


def test_reordered_entries_report_the_first_out_of_place_seq():
    chain = make_chain(4)
    chain[1], chain[2] = chain[2], chain[1]

    assert verify_log(chain) == 2


def test_a_duplicated_entry_reports_the_repeated_seq():
    chain = make_chain(3)
    chain.insert(2, dict(chain[1]))

    assert verify_log(chain) == 2


def test_a_sequence_that_starts_late_is_not_a_whole_log():
    # Without an anchor the sequence must start at genesis (seq 1).
    assert verify_log(make_chain(2, start_seq=7, anchor=b"\x44" * 32)) == 1


def test_a_wrong_window_anchor_reports_the_first_seq():
    window = make_chain(2, start_seq=7, anchor=b"\x55" * 32)

    assert verify_log(window, anchor=b"\x66" * 32) == 7


# --------------------------------------------------------------------------- #
# Entry shapes: rows, mappings and the sync range's wire form
# --------------------------------------------------------------------------- #


def test_event_log_rows_verify():
    assert verify_log(ledger.entries()) is None


def test_a_window_of_event_log_rows_verifies_against_its_predecessor():
    entry = ledger.append(make_envelope())
    rows = ledger.entries(after=entry.seq - 1, through=entry.seq)

    assert verify_log(rows, anchor=entry.prev_hash) is None


def test_to_dict_output_verifies():
    entry = ledger.append(make_envelope())
    rows = ledger.entries(after=entry.seq - 1, through=entry.seq)

    assert verify_log([row.to_dict() for row in rows], anchor=entry.prev_hash) is None


def test_sync_range_wire_entries_verify_without_decoding():
    entry = ledger.append(make_envelope())
    wire = [
        serialise_entry(row)
        for row in ledger.entries(after=entry.seq - 1, through=entry.seq)
    ]

    assert verify_log(wire, anchor=bytes(entry.prev_hash).hex()) is None
    assert verify_log([item.model_dump() for item in wire], anchor=entry.prev_hash) is None


def test_a_tampered_wire_entry_reports_its_seq():
    entry = ledger.append(make_envelope())
    wire = serialise_entry(ledger.entry_by_cid(entry.record_cid))
    wire.raw = base64.b64encode(b"not the stored bytes").decode("ascii")

    assert verify_log([wire], anchor=entry.prev_hash) == entry.seq


# --------------------------------------------------------------------------- #
# Malformed input is an error, not a reported break
# --------------------------------------------------------------------------- #


def test_a_non_iterable_raises_type_error():
    with pytest.raises(TypeError):
        verify_log(42)


def test_a_missing_field_raises_type_error():
    chain = make_chain(1)
    del chain[0]["raw"]

    with pytest.raises(TypeError):
        verify_log(chain)


def test_a_non_integer_seq_raises_type_error():
    chain = make_chain(1)
    chain[0]["seq"] = "1"

    with pytest.raises(TypeError):
        verify_log(chain)


def test_a_non_hexadecimal_hash_raises_value_error():
    chain = make_chain(1)
    chain[0]["entry_hash"] = "not hex"

    with pytest.raises(ValueError):
        verify_log(chain)


def test_a_non_base64_raw_string_raises_value_error():
    chain = make_chain(1)
    chain[0]["raw"] = "not base64!"

    with pytest.raises(ValueError):
        verify_log(chain)


def test_a_non_string_record_cid_raises_type_error():
    chain = make_chain(1)
    chain[0]["record_cid"] = 7

    with pytest.raises(TypeError):
        verify_log(chain)
