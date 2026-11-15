"""Tests for ``POST /v1/imports/arxiv`` (feature 124).

Covers the 201 body, the node-signed ``external.mirror`` record the import
appends (author, signature, cid, body, ``claimed: false``), the accepted id
spellings, the tier-4 gate, and every refusal -- bad id, unknown paper, a paper
already mirrored, no node key, unreachable arXiv -- including that a refused
import leaves nothing in the ledger.
"""

import httpx
import pytest
from scholium_record_core import compute_file_id, compute_record_id, validate_body, verify_record

from app.modules import content, ledger
from app.modules.imports import arxiv, service

from .conftest import headers_for, unique_arxiv_id

URL = "/v1/imports/arxiv"
PROBLEM_JSON = "application/problem+json"


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


@pytest.fixture
def appended(monkeypatch):
    """The records the import appended to the ledger, as signed (with ``sig``)."""
    records = []
    real = ledger.append

    def spy(record, **kwargs):
        records.append(dict(record))
        return real(record, **kwargs)

    monkeypatch.setattr(service.ledger, "append", spy)
    return records


# --------------------------------------------------------------------------- #
# Success
# --------------------------------------------------------------------------- #


def test_import_creates_an_unclaimed_mirror(client, node_did, moderator):
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxiv_id": ident}, headers=moderator)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["type"] == "external.mirror"
    assert body["source"] == f"arXiv:{ident}"
    assert body["claimed"] is False
    assert body["state"] == "unclaimed"
    assert body["author"] == node_did
    assert body["anchor"] == "pending"
    assert body["metadata"]["arxivId"] == ident
    assert body["metadata"]["title"] == f"Mock arXiv paper {ident}"


def test_the_record_is_node_signed_and_in_the_ledger(client, node_did, moderator, appended):
    ident = unique_arxiv_id()

    cid = client.post(URL, json={"arxiv_id": ident}, headers=moderator).json()["id"]

    (record,) = appended
    assert record["id"] == cid
    assert record["type"] == "external.mirror"
    assert record["author"] == node_did
    assert record["prev"] is None
    assert record["proofs"] == []
    # Self-consistent and signed by the node key.
    assert compute_record_id(record) == cid
    assert verify_record(record)

    body = record["body"]
    assert validate_body("external.mirror", body) == []
    assert body["source"] == f"arXiv:{ident}"
    assert body["claimed"] is False
    assert body["manifest"] == service.snapshot_id(body["metadata"])

    entry = ledger.entry_by_cid(cid)
    assert entry is not None
    assert entry.record_type == "external.mirror"
    assert entry.author_did == node_did


def test_the_mirror_is_served_by_get_records(client, node_did, moderator):
    ident = unique_arxiv_id()
    cid = client.post(URL, json={"arxiv_id": ident}, headers=moderator).json()["id"]

    stored = client.get(f"/v1/records/{cid}")

    assert stored.status_code == 200, stored.text
    envelope = stored.json()
    assert envelope["type"] == "external.mirror"
    assert envelope["author"] == node_did
    assert envelope["body"]["claimed"] is False
    assert compute_record_id(envelope) == cid


def test_the_manifest_is_a_stored_snapshot_of_the_metadata(client, node_key, moderator, content_dir):
    ident = unique_arxiv_id()

    body = client.post(URL, json={"arxiv_id": ident}, headers=moderator).json()

    manifest = client.get(f"/v1/records/{body['id']}").json()["body"]["manifest"]
    blob = content.get_blob(manifest)
    assert blob is not None
    assert blob.media_type == "application/json"
    data = (content_dir / manifest).read_bytes()
    assert blob.size == len(data)
    assert data == service.snapshot_bytes(body["metadata"])
    assert compute_file_id(data) == manifest


def test_a_refused_import_stores_no_snapshot(client, node_key, moderator, content_dir):
    ident = unique_arxiv_id()
    client.post(URL, json={"arxiv_id": ident}, headers=moderator)
    stored = sorted(p.name for p in content_dir.iterdir())

    assert_problem(client.post(URL, json={"arxiv_id": ident}, headers=moderator), 409)
    assert_problem(client.post(URL, json={"arxiv_id": "2401.99999"}, headers=moderator), 404)
    assert_problem(client.post(URL, json={"arxiv_id": "nope"}, headers=moderator), 422)
    assert_problem(client.post(URL, json={"arxiv_id": ident}), 401)

    assert sorted(p.name for p in content_dir.iterdir()) == stored


@pytest.mark.parametrize(
    "spell",
    [
        lambda i: i,
        lambda i: f"arXiv:{i}",
        lambda i: f"ARXIV:{i}v3",
        lambda i: f"https://arxiv.org/abs/{i}v2",
        lambda i: f"https://arxiv.org/pdf/{i}.pdf",
        lambda i: f"  {i}  ",
    ],
)
def test_every_spelling_of_an_id_names_the_same_source(client, node_key, moderator, spell):
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxiv_id": spell(ident)}, headers=moderator)

    assert response.status_code == 201, response.text
    assert response.json()["source"] == f"arXiv:{ident}"


def test_arxivId_is_accepted_as_an_alias(client, node_key, moderator):
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxivId": ident}, headers=moderator)

    assert response.status_code == 201, response.text
    assert response.json()["source"] == f"arXiv:{ident}"


def test_old_style_ids_are_imported(client, node_key, moderator):
    ident = unique_arxiv_id(old_style=True)

    response = client.post(URL, json={"arxiv_id": ident}, headers=moderator)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["source"] == f"arXiv:{ident}"
    assert body["metadata"]["categories"] == ["hep-th"]


def test_a_requested_version_is_kept_in_the_metadata(client, node_key, moderator):
    ident = unique_arxiv_id()

    body = client.post(URL, json={"arxiv_id": f"{ident}v2"}, headers=moderator).json()

    assert body["source"] == f"arXiv:{ident}"
    assert body["metadata"]["version"] == "v2"


# --------------------------------------------------------------------------- #
# Authorization
# --------------------------------------------------------------------------- #


def test_no_token_is_401(client, node_key):
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxiv_id": ident})

    assert_problem(response, 401)
    assert service.find_mirror(f"arXiv:{ident}") is None


@pytest.mark.parametrize("tier", [0, 1, 2, 3])
def test_a_tier_below_four_is_403(client, node_key, tier):
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxiv_id": ident}, headers=headers_for(tier))

    body = assert_problem(response, 403)
    assert body["required_tier"] == 4
    assert body["caller_tier"] == tier
    assert service.find_mirror(f"arXiv:{ident}") is None


# --------------------------------------------------------------------------- #
# Refusals
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "value",
    ["", "not an id", "2401", "2401.1", "24011.00001", "hep-th/123", "https://example.com/abs/2401.00001", "2401.00001v0"],
)
def test_a_value_that_is_not_an_arxiv_id_is_422(client, node_key, moderator, value):
    response = client.post(URL, json={"arxiv_id": value}, headers=moderator)

    assert_problem(response, 422)


def test_a_malformed_id_is_reported_at_arxiv_id(client, node_key, moderator):
    body = assert_problem(client.post(URL, json={"arxiv_id": "nope"}, headers=moderator), 422)

    assert body["type"] == "urn:scholium:problem:invalid-arxiv-id"
    assert body["errors"][0]["loc"] == ["body", "arxiv_id"]


@pytest.mark.parametrize("payload", [{}, {"arxiv_id": 2401.00001}, {"arxiv_id": None}, {"arxiv_id": ["2401.00001"]}])
def test_a_missing_or_non_string_id_is_422(client, node_key, moderator, payload):
    assert_problem(client.post(URL, json=payload, headers=moderator), 422)


def test_unknown_members_are_422(client, node_key, moderator):
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxiv_id": ident, "claimed": True}, headers=moderator)

    assert_problem(response, 422)
    assert service.find_mirror(f"arXiv:{ident}") is None


def test_an_unknown_paper_is_404_and_nothing_is_stored(client, node_key, moderator, appended):
    response = client.post(URL, json={"arxiv_id": "2401.99999"}, headers=moderator)

    body = assert_problem(response, 404)
    assert body["type"] == "urn:scholium:problem:arxiv-not-found"
    assert appended == []


def test_importing_a_paper_twice_is_409_naming_the_first_record(client, node_key, moderator, appended):
    ident = unique_arxiv_id()
    first = client.post(URL, json={"arxiv_id": ident}, headers=moderator).json()

    again = client.post(URL, json={"arxiv_id": f"arXiv:{ident}v2"}, headers=moderator)

    body = assert_problem(again, 409)
    assert body["type"] == "urn:scholium:problem:already-imported"
    assert first["id"] in body["detail"]
    assert len(appended) == 1


def test_without_a_node_key_the_import_is_503(client, tmp_path, monkeypatch, moderator, appended):
    from app.settings import settings

    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(tmp_path / "missing.key"))
    ident = unique_arxiv_id()

    response = client.post(URL, json={"arxiv_id": ident}, headers=moderator)

    body = assert_problem(response, 503)
    assert body["type"] == "urn:scholium:problem:node-key-unavailable"
    assert appended == []


# --------------------------------------------------------------------------- #
# Live mode (ARXIV_MOCK=0)
# --------------------------------------------------------------------------- #


def atom_for(ident: str, title: str = "A Live Title") -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/{ident}v1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>{title}</title>
    <summary>Live abstract.</summary>
    <author><name>Ada Lovelace</name></author>
    <arxiv:doi>10.1000/live.1</arxiv:doi>
    <category term="cs.CR"/>
  </entry>
</feed>""".encode()


@pytest.fixture
def live(monkeypatch):
    """ARXIV_MOCK=0 with arXiv replaced by ``live.handler``; records the requests."""
    from app.settings import settings

    class Live:
        requests: list = []
        handler = None

    monkeypatch.setattr(settings, "ARXIV_MOCK", 0)
    real_client = httpx.Client

    def respond(request: httpx.Request) -> httpx.Response:
        Live.requests.append(request)
        return Live.handler(request)

    monkeypatch.setattr(
        arxiv.httpx,
        "Client",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )
    Live.requests = []
    return Live


def test_live_import_reads_the_arxiv_api(client, node_key, moderator, live):
    ident = unique_arxiv_id()
    live.handler = lambda request: httpx.Response(200, content=atom_for(ident))

    response = client.post(URL, json={"arxiv_id": ident}, headers=moderator)

    assert response.status_code == 201, response.text
    metadata = response.json()["metadata"]
    assert metadata["title"] == "A Live Title"
    assert metadata["authors"] == ["Ada Lovelace"]
    assert metadata["doi"] == "10.1000/live.1"
    (request,) = live.requests
    assert request.url.host == "export.arxiv.org"
    assert request.url.params["id_list"] == ident
    assert request.url.params["max_results"] == "1"


def test_live_arxiv_errors_are_502_and_nothing_is_stored(client, node_key, moderator, live, appended):
    ident = unique_arxiv_id()
    live.handler = lambda request: httpx.Response(503)

    response = client.post(URL, json={"arxiv_id": ident}, headers=moderator)

    body = assert_problem(response, 502)
    assert body["type"] == "urn:scholium:problem:arxiv-unavailable"
    assert appended == []


def test_live_unknown_paper_is_404(client, node_key, moderator, live):
    ident = unique_arxiv_id()
    live.handler = lambda request: httpx.Response(
        200, content=b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>'
    )

    assert_problem(client.post(URL, json={"arxiv_id": ident}, headers=moderator), 404)
