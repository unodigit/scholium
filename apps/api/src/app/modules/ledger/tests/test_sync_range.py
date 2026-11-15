"""Tests for GET /v1/sync/range (feature 17).

Covers: the endpoint contract (200, entries in ``seq`` order, every
persisted column served), the bound semantics (``from`` exclusive, ``to``
inclusive, both optional), offline replay of the hash chain from the
response alone (recompute ``entry_hash``, check the links, genesis
anchor), the ``limit`` cap, and error handling (reversed range → 400
problem details, non-integer/negative bounds → 422 problem details).

Isolation note: like test_append.py, these tests share whatever database
the engine bound with the rest of the worker's run (and, in a
directory-local ``pytest src/app/modules/ledger`` invocation, with the
other xdist worker, which may append concurrently).  So each test
anchors on the current chain head, appends entries it can recognise by
unique CIDs, and only asserts on what an append-only log cannot change
underneath it: entries already inside a bounded window, membership and
relative order of its own CIDs, and windows whose predicate is
unsatisfiable.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime

import pytest

from app.modules import ledger
from app.modules.ledger import GENESIS_PREV_HASH

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
PROBLEM_JSON = "application/problem+json"

#: Exactly the columns a replaying third party is served.
WIRE_FIELDS = {
    "seq",
    "record_cid",
    "record_type",
    "author_did",
    "body",
    "raw",
    "prev_hash",
    "entry_hash",
    "received_at",
    "origin_node",
}


def make_envelope(*, record_type: str = "test.sync.range"):
    tag = uuid.uuid4().hex
    return {
        "v": 1,
        "type": record_type,
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {"tag": tag},
        "proofs": [],
        "id": f"bafyreisyncrange{tag}",
    }


def head_seq() -> int:
    """The current last seq (0 for an empty log): the replay anchor."""
    head = ledger.latest()
    return head.seq if head is not None else 0


def append_n(count: int) -> list:
    """Append ``count`` recognisable entries; return them in append order."""
    return [ledger.append(make_envelope()) for _ in range(count)]


def get_range(client, **params) -> dict:
    response = client.get("/v1/sync/range", params=params)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    return response.json()


def mine(body: list, appended: list) -> list:
    """The members of ``body`` that came from ``appended``, in body order.

    ``appended`` are one test's own entries (recognisable by cid); other
    entries may share the window when tests run against a shared log.
    """
    cids = {entry.record_cid for entry in appended}
    return [entry for entry in body if entry["record_cid"] in cids]


def predecessor_hash(seq: int) -> bytes:
    """The ``entry_hash`` of the row immediately before ``seq`` (genesis if none)."""
    rows = ledger.entries(through=seq - 1)
    return bytes(rows[-1].entry_hash) if rows else GENESIS_PREV_HASH


# --------------------------------------------------------------------------- #
# The endpoint contract
# --------------------------------------------------------------------------- #


def test_range_returns_entries_in_seq_order_with_every_column(client):
    anchor = head_seq()
    appended = append_n(3)

    body = get_range(client, **{"from": anchor, "to": appended[-1].seq})

    assert isinstance(body, list) and len(body) >= 3
    seqs = [entry["seq"] for entry in body]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)  # strictly increasing: seq order
    # Our entries are all there, in append order.
    assert [entry["seq"] for entry in mine(body, appended)] == [
        entry.seq for entry in appended
    ]

    first = mine(body, appended)[0]
    assert set(first) == WIRE_FIELDS
    assert first["record_cid"] == appended[0].record_cid
    assert first["record_type"] == appended[0].record_type
    assert first["author_did"] == AUTHOR
    assert first["body"] == appended[0].body
    assert first["origin_node"] == appended[0].origin_node


def test_hashes_and_raw_bytes_round_trip_to_their_column_values(client):
    anchor = head_seq()
    appended = append_n(2)

    body = get_range(client, **{"from": anchor, "to": appended[-1].seq})
    by_cid = {entry["record_cid"]: entry for entry in body}

    for row in appended:
        wire = by_cid[row.record_cid]
        assert wire["seq"] == row.seq
        assert wire["prev_hash"] == bytes(row.prev_hash).hex()
        assert wire["entry_hash"] == bytes(row.entry_hash).hex()
        assert base64.b64decode(wire["raw"]) == bytes(row.raw)
        assert wire["received_at"].endswith("Z")
        when = datetime.fromisoformat(wire["received_at"].replace("Z", "+00:00"))
        assert when.replace(tzinfo=None) == row.received_at


# --------------------------------------------------------------------------- #
# Replay: a third party recomputes the chain from the response alone
# --------------------------------------------------------------------------- #


def test_the_response_alone_replays_the_hash_chain(client):
    anchor = head_seq()
    appended = append_n(3)

    body = get_range(client, **{"from": anchor, "to": appended[-1].seq})

    assert len(body) >= 3
    # The link the window's first entry commits to is the true predecessor.
    prev = predecessor_hash(body[0]["seq"])
    for wire in body:
        raw = base64.b64decode(wire["raw"])
        assert wire["prev_hash"] == prev.hex()
        expected = hashlib.sha256(
            prev + wire["record_cid"].encode("utf-8") + raw
        ).digest()
        assert wire["entry_hash"] == expected.hex()
        prev = expected  # the next entry must commit to this digest
    # The window reaches at least our last append.
    assert body[-1]["seq"] >= appended[-1].seq


def test_replay_from_zero_anchors_the_first_link_at_genesis(client):
    append_n(1)  # make the test independent of what earlier tests left behind
    head = head_seq()
    assert head >= 1

    body = get_range(client, **{"from": 0, "to": head})

    seqs = [entry["seq"] for entry in body]
    # The whole log, contiguous from the very first entry.  The window
    # (0, head] is already immutable, so this holds even under concurrent
    # appends.
    assert seqs == list(range(1, head + 1))
    # ...whose only possible predecessor is the 32-zero-byte genesis hash.
    assert body[0]["prev_hash"] == GENESIS_PREV_HASH.hex()


# --------------------------------------------------------------------------- #
# Bound semantics: from exclusive, to inclusive, both optional
# --------------------------------------------------------------------------- #


def test_from_is_exclusive_and_to_is_inclusive(client):
    anchor = head_seq()
    first, second, third = append_n(3)

    def cids(**params) -> list:
        body = get_range(client, **params)
        return [entry["record_cid"] for entry in mine(body, [first, second, third])]

    def seqs(**params) -> list:
        return [entry["seq"] for entry in get_range(client, **params)]

    # (anchor, third] holds all three of ours, in order.
    assert cids(**{"from": anchor, "to": third.seq}) == [
        first.record_cid,
        second.record_cid,
        third.record_cid,
    ]
    # 'from' is exclusive: first.seq drops 'first' but keeps the rest.
    assert cids(**{"from": first.seq, "to": third.seq}) == [
        second.record_cid,
        third.record_cid,
    ]
    # 'to' is inclusive: second.seq keeps 'first' and 'second' only.
    assert cids(**{"from": anchor, "to": second.seq}) == [
        first.record_cid,
        second.record_cid,
    ]
    # An unsatisfiable window is empty, not an error.
    assert seqs(**{"from": second.seq, "to": second.seq}) == []


def test_omitted_bounds_read_from_the_beginning_through_the_head(client):
    anchor = head_seq()
    first, second = append_n(2)

    everything = get_range(client)

    seqs = [entry["seq"] for entry in everything]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    # At least the pre-existing entries plus our two.
    assert len(seqs) >= anchor + 2
    assert everything[-1]["seq"] >= second.seq  # reads through the head
    # Our appends sit right after the anchor inside the default window.
    assert [entry["seq"] for entry in mine(everything, [first, second])] == [
        first.seq,
        second.seq,
    ]


# --------------------------------------------------------------------------- #
# Paging
# --------------------------------------------------------------------------- #


def test_limit_caps_the_page_at_the_oldest_entries(client):
    anchor = head_seq()
    first, second, third = append_n(3)

    body = get_range(client, **{"from": anchor, "to": third.seq, "limit": 2})

    # The page is the window's first two entries, whatever else is in it.
    # The window (anchor, third.seq] is immutable, so the service query and
    # the endpoint must agree exactly.
    expected = ledger.entries(after=anchor, through=third.seq, limit=2)
    assert [entry["seq"] for entry in body] == [row.seq for row in expected]
    assert len(body) == 2


def test_limit_is_validated(client):
    response = client.get("/v1/sync/range", params={"from": 0, "limit": 0})
    assert response.status_code == 422
    assert response.headers["content-type"].startswith(PROBLEM_JSON)

    response = client.get(
        "/v1/sync/range", params={"from": 0, "limit": ledger.MAX_PAGE + 1}
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


def test_a_reversed_range_is_a_400_problem(client):
    response = client.get("/v1/sync/range", params={"from": 10, "to": 9})

    assert response.status_code == 400
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    problem = response.json()
    assert problem["status"] == 400
    assert problem["type"] == ledger.REVERSED_RANGE_TYPE
    assert problem["detail"]


@pytest.mark.parametrize(
    "params",
    [
        {"from": "abc"},
        {"to": "abc"},
        {"from": -1},
        {"to": -3},
        {"from": 1.5},
        {"to": ""},
    ],
)
def test_bounds_that_are_not_non_negative_integers_are_422_problems(client, params):
    response = client.get("/v1/sync/range", params=params)

    assert response.status_code == 422
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
