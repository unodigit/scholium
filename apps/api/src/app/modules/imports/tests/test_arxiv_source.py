"""Tests for where import metadata comes from: id parsing, mock data, Atom parsing."""

import httpx
import pytest
from scholium_record_core import validate_body

from app.modules.imports import (
    ArxivId,
    ArxivNotFound,
    ArxivUnavailable,
    InvalidArxivId,
    mock_metadata,
    parse_arxiv_id,
    parse_atom_entry,
)
from app.modules.imports import arxiv, service

IDENT = ArxivId("2401.00001")

ENTRY = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v2</id>
    <updated>2024-02-01T10:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>A   Title
      Over Two Lines</title>
    <summary>  First paragraph.
  Second paragraph. </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>  Alan   Turing </name></author>
    <arxiv:doi>10.1000/xyz123</arxiv:doi>
    <link href="http://evil.example/abs" rel="alternate"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="stat.ML" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>"""


# --- ids ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value, base, version",
    [
        ("2401.00001", "2401.00001", None),
        ("2401.00001v7", "2401.00001", 7),
        ("0704.0001", "0704.0001", None),
        ("arXiv:2401.00001", "2401.00001", None),
        ("arxiv:2401.00001v2", "2401.00001", 2),
        ("https://arxiv.org/abs/2401.00001", "2401.00001", None),
        ("http://www.arxiv.org/abs/2401.00001v3", "2401.00001", 3),
        ("https://arxiv.org/pdf/2401.00001v1.pdf", "2401.00001", 1),
        ("hep-th/9901001", "hep-th/9901001", None),
        ("arXiv:math.GT/0309136v2", "math.GT/0309136", 2),
        ("cond-mat/0001001", "cond-mat/0001001", None),
        ("  2401.00001\n", "2401.00001", None),
    ],
)
def test_parse_arxiv_id(value, base, version):
    ident = parse_arxiv_id(value)

    assert ident == ArxivId(base, version)
    assert ident.source == f"arXiv:{base}"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "2401",
        "2401.123",
        "2401.123456",
        "240.00001",
        "2401.00001v0",
        "2401.00001v",
        "2401.00001v12345",
        "2401.00001 extra",
        "2401.00001/../../etc/passwd",
        "https://example.com/abs/2401.00001",
        "https://arxiv.org.evil.example/abs/2401.00001",
        "hep-th/123456",
        "HEP-TH/9901001",
        "math.gt/0309136",
        "2401.00001?x=1",
        None,
        2401.00001,
        ["2401.00001"],
    ],
)
def test_parse_arxiv_id_rejects(value):
    with pytest.raises(InvalidArxivId) as raised:
        parse_arxiv_id(value)

    assert raised.value.status_code == 422


def test_query_id_carries_a_requested_version():
    assert ArxivId("2401.00001").query_id == "2401.00001"
    assert ArxivId("2401.00001", 2).query_id == "2401.00001v2"


# --- mock -----------------------------------------------------------------------


def test_mock_metadata_is_deterministic_and_fits_the_schema():
    first, second = mock_metadata(IDENT), mock_metadata(IDENT)

    assert first == second
    assert first["arxivId"] == "2401.00001"
    assert first["published"] == "2024-01-01T00:00:00Z"
    body = {"source": IDENT.source, "metadata": first, "manifest": service.snapshot_id(first), "claimed": False}
    assert validate_body("external.mirror", body) == []


@pytest.mark.parametrize("base", ["9901.99999", "hep-th/9999999"])
def test_mock_treats_all_nines_as_unknown(base):
    with pytest.raises(ArxivNotFound):
        mock_metadata(ArxivId(base))


def test_mock_published_follows_the_id():
    assert mock_metadata(ArxivId("hep-th/9901001"))["published"] == "1999-01-01T00:00:00Z"
    assert mock_metadata(ArxivId("hep-th/0703123"))["published"] == "2007-03-01T00:00:00Z"


def test_snapshot_id_ignores_key_order():
    assert service.snapshot_id({"a": 1, "b": ["é"]}) == service.snapshot_id({"b": ["é"], "a": 1})
    assert service.snapshot_id({"a": 1}) != service.snapshot_id({"a": 2})


# --- Atom -----------------------------------------------------------------------


def test_parse_atom_entry_reduces_the_feed_to_metadata():
    metadata = parse_atom_entry(ENTRY.encode(), IDENT)

    assert metadata == {
        "title": "A Title Over Two Lines",
        "abstract": "First paragraph. Second paragraph.",
        "authors": ["Ada Lovelace", "Alan Turing"],
        "categories": ["cs.LG", "stat.ML"],
        "arxivId": "2401.00001",
        "version": "v2",
        "published": "2024-01-01T00:00:00Z",
        "updated": "2024-02-01T10:00:00Z",
        "url": "https://arxiv.org/abs/2401.00001",
        "pdfUrl": "https://arxiv.org/pdf/2401.00001",
        "doi": "10.1000/xyz123",
    }


def test_links_come_from_the_validated_id_not_the_feed():
    metadata = parse_atom_entry(ENTRY.encode(), IDENT)

    assert "evil.example" not in repr(metadata)


def test_parsed_metadata_fits_the_mirror_schema():
    metadata = parse_atom_entry(ENTRY.encode(), IDENT)
    body = {"source": IDENT.source, "metadata": metadata, "manifest": service.snapshot_id(metadata), "claimed": False}

    assert validate_body("external.mirror", body) == []


def test_an_empty_feed_is_not_found():
    with pytest.raises(ArxivNotFound):
        parse_atom_entry(b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>', IDENT)


def test_arxivs_error_entry_is_not_found():
    error = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/api/errors#incorrect_id_format_for_2401.00001</id>
      <title>Error</title><summary>incorrect id format</summary></entry></feed>"""

    with pytest.raises(ArxivNotFound):
        parse_atom_entry(error, IDENT)


@pytest.mark.parametrize(
    "data",
    [
        b"not xml at all",
        b"",
        ENTRY.replace("2401.00001v2", "2402.77777v1").encode(),  # a different paper
        ENTRY.replace("http://arxiv.org/abs/2401.00001v2", "tag:whatever").encode(),
        ENTRY.replace("<title>A   Title\n      Over Two Lines</title>", "<title>  </title>").encode(),
        b'<!DOCTYPE feed [<!ENTITY a "aaaa">]><feed xmlns="http://www.w3.org/2005/Atom"><entry/></feed>',
        b'<!doctype feed><feed xmlns="http://www.w3.org/2005/Atom"/>',
    ],
)
def test_unusable_feeds_are_unavailable(data):
    with pytest.raises(ArxivUnavailable) as raised:
        parse_atom_entry(data, IDENT)

    assert raised.value.status_code == 502


# --- HTTP -----------------------------------------------------------------------


@pytest.fixture
def transport(monkeypatch):
    """Route the arXiv client to ``transport.handler``."""

    class Transport:
        handler = None

    real_client = httpx.Client
    monkeypatch.setattr(
        arxiv.httpx,
        "Client",
        lambda **kwargs: real_client(transport=httpx.MockTransport(lambda r: Transport.handler(r)), **kwargs),
    )
    return Transport


def test_fetch_atom_returns_the_response_body(transport):
    transport.handler = lambda request: httpx.Response(200, content=b"<feed/>")

    assert arxiv._fetch_atom(ArxivId("2401.00001", 2)) == b"<feed/>"


def test_fetch_atom_asks_for_the_versioned_id(transport):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=b"<feed/>")

    transport.handler = handler
    arxiv._fetch_atom(ArxivId("2401.00001", 2))

    assert seen[0].url.params["id_list"] == "2401.00001v2"
    assert seen[0].method == "GET"


def test_fetch_atom_honours_the_configured_endpoint(transport, monkeypatch):
    seen = []
    transport.handler = lambda request: (seen.append(request), httpx.Response(200, content=b"<feed/>"))[1]
    monkeypatch.setenv("ARXIV_API_URL", "https://arxiv.test/api/query")

    arxiv._fetch_atom(IDENT)

    assert seen[0].url.host == "arxiv.test"


@pytest.mark.parametrize("status", [404, 429, 500, 503])
def test_fetch_atom_http_errors_are_unavailable(transport, status):
    transport.handler = lambda request: httpx.Response(status)

    with pytest.raises(ArxivUnavailable) as raised:
        arxiv._fetch_atom(IDENT)

    assert str(status) in raised.value.reason


def test_fetch_atom_network_errors_are_unavailable(transport):
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    transport.handler = handler

    with pytest.raises(ArxivUnavailable):
        arxiv._fetch_atom(IDENT)


def test_fetch_atom_refuses_an_oversized_response(transport):
    transport.handler = lambda request: httpx.Response(200, content=b"x" * (arxiv.MAX_FEED_BYTES + 1))

    with pytest.raises(ArxivUnavailable):
        arxiv._fetch_atom(IDENT)
