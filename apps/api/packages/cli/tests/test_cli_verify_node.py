"""Tests for ``scholium verify <sch-id> --node URL`` (READ-2).

A node serves each record's canonical bytes as ``raw`` -- which by design
leave out ``id`` and ``sig`` -- and the author's signature as a separate
``sig`` field of the same ``/v1/sync/range`` entry.  Node mode has to rebuild
the signed record from both, or every record looks unsigned and a correctly
signed paper is reported NOT VERIFIED while the CAR path and the browser
verifier accept it.

The node is faked at ``httpx.get`` with exactly the wire shape of the API's
``SyncEntry`` (``app.modules.ledger.sync_range``).
"""

import base64
import copy

import httpx
import pytest
from car_helpers import make_paper, signed
from scholium_cli import verify as verify_module
from scholium_cli.main import main
from scholium_cli.verify import verify_car_bytes
from scholium_record_core import compute_file_id, record_bytes

NODE = "http://node.test"


def sync_entries(records):
    """The ``/v1/sync/range`` entries a node holding ``records`` serves."""
    return [
        {
            "seq": seq,
            "record_cid": record["id"],
            "record_type": record["type"],
            "author_did": record["author"],
            "body": record["body"],
            # Canonical bytes: what the id hashes, so no ``id`` and no ``sig``.
            "raw": base64.b64encode(record_bytes(record)).decode("ascii"),
            "sig": record["sig"],
            "prev_hash": "00" * 32,
            "entry_hash": "11" * 32,
            "received_at": "2026-11-15T09:30:12Z",
            "origin_node": "did:key:z6Mknode",
        }
        for seq, record in enumerate(records, start=1)
    ]


@pytest.fixture
def serve(monkeypatch):
    """Make ``NODE`` serve a paper; ``serve(paper, mutate=...)`` may alter its entries."""
    state = {"entries": [], "files": {}}

    def get(url, params=None, timeout=None, **_):
        request = httpx.Request("GET", url, params=params)
        if url == f"{NODE}/v1/sync/range":
            after = int((params or {}).get("from", 0))  # exclusive, like the node
            page = [e for e in state["entries"] if e["seq"] > after]
            return httpx.Response(200, json=page, request=request)
        if url.startswith(f"{NODE}/v1/content/"):
            data = state["files"].get(url.rsplit("/", 1)[1])
            if data is not None:
                return httpx.Response(200, content=data, request=request)
        elif url.startswith(f"{NODE}/v1/records/") and url.endswith("/proof"):
            return httpx.Response(200, json={}, request=request)
        return httpx.Response(404, json={}, request=request)

    monkeypatch.setattr(verify_module.httpx, "get", get)

    def setup(paper, mutate=None):
        entries = sync_entries(paper.records())
        if mutate is not None:
            mutate(entries)
        state["entries"] = entries
        state["files"] = {compute_file_id(data): data for data in paper.files.values()}

    return setup


def verify_node(paper, capsys, *options):
    code = main(["verify", paper.short_id, "--node", NODE, *options])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_a_correctly_signed_paper_verifies_through_a_node(serve, capsys):
    paper = make_paper(versions=2)
    serve(paper)

    code, out, err = verify_node(paper, capsys)

    assert "has no signature" not in out, out
    assert "NOT VERIFIED" not in out, out
    assert code == 0, out
    assert err == ""
    assert "Result: VERIFIED" in out
    assert "Signed by all 2 listed authors" in out


def test_node_mode_reaches_the_same_verdict_as_the_car_path(serve, capsys):
    paper = make_paper(versions=2)
    serve(paper)

    car = verify_car_bytes(paper.car(), paper=paper.short_id)
    code, out, _ = verify_node(paper, capsys)

    assert car.ok
    assert code == 0, out
    # Every line of the CAR checklist is there too.  (The archive line is
    # skipped: it states a block count, which depends on what was fetched.)
    for item in car.items:
        if item.key != "archive":
            assert item.text in out, f"node mode lost the checklist line {item.text!r}:\n{out}"


def test_a_signature_by_the_wrong_key_is_still_rejected_through_a_node(serve, capsys):
    """Attaching ``sig`` must not make node mode trust whatever it is sent."""
    paper = make_paper(versions=1)
    consent = copy.deepcopy(paper.consents[0][1])
    # Mallory's signature, offered as the signature of bob's consent.
    consent["sig"] = signed("mallory", "coauthor.consent", consent["body"])["sig"]
    paper.consents[0][1] = consent
    serve(paper)

    code, out, _ = verify_node(paper, capsys)

    assert code == 1, out
    assert "NOT VERIFIED" in out
    assert "signature does not verify against its author" in out


def test_a_record_the_node_serves_without_a_signature_is_reported_unsigned(serve, capsys):
    paper = make_paper(versions=1)

    def drop_one_consent_signature(entries):
        consent = next(e for e in entries if e["record_type"] == "coauthor.consent")
        consent["sig"] = None

    serve(paper, mutate=drop_one_consent_signature)

    code, out, _ = verify_node(paper, capsys)

    assert code == 1, out
    assert "has no signature" in out
