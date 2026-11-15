"""Tests for ``GET /v1/search/semantic`` (feature 87).

Covers: the hashing embedder (deterministic, sensible similarity) and the Ollama
embedder (over a mock transport); choosing between them from ``OLLAMA_URL``; the
``embeddings`` table and its self-describing blobs; vectors written when a
version is listed and removed when it is not; the endpoint's ranking, filtering
to listed versions, validation and failure modes; and the self-healing of
missing or foreign vectors.

Isolation: tests in a worker share one database, so every test uses fresh
random words and asserts on its own versions, never on table totals.  Queries
built from a version's own unique words rank that version first whatever else
the shared database holds.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import subprocess
import sys
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from scholium_record_core import compute_record_id
from sqlalchemy import text

from app import db
from app.main import app
from app.modules import checks, search
from app.modules.search import embedder as embedder_module
from app.modules.search import embeddings as embeddings_module
from app.modules.search.embedder import (
    DEFAULT_OLLAMA_MODEL,
    EmbedderError,
    HashingEmbedder,
    OllamaEmbedder,
    cosine_similarity,
    get_embedder,
    set_embedder,
)
from app.modules.search.embeddings import decode_vector, encode_vector
from app.modules.submissions import (
    AWAITING_CONSENT,
    HELD,
    LISTED,
    MODERATION,
    REJECTED,
    SCANNING,
    Paper,
    get_version,
    save_version,
    transition_version,
)

URL = "/v1/search/semantic"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def word() -> str:
    """A token no other test's text contains."""
    return "w" + uuid.uuid4().hex


def new_cid() -> str:
    """A real, unique dag-cbor record id, as a version's cid is (``checks`` insists on one)."""
    return compute_record_id(
        {
            "v": 1,
            "type": "test.search",
            "author": "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        }
    )


def make_version(
    title: str, abstract: str = "An abstract.", *, state: str = AWAITING_CONSENT, paper: str | None = None
) -> str:
    cid = new_cid()
    save_version(
        version_cid=cid,
        paper_cid=paper or f"paper-{uuid.uuid4().hex}",
        n=1,
        title=title,
        abstract=abstract,
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=None,
        state=state,
    )
    return cid


def list_version(cid: str) -> None:
    transition_version(cid, SCANNING)
    transition_version(cid, MODERATION)
    transition_version(cid, LISTED)


def listed(title: str, abstract: str = "An abstract.", **kwargs) -> str:
    cid = make_version(title, abstract, **kwargs)
    list_version(cid)
    return cid


def row_exists(cid: str) -> bool:
    embeddings_module.ensure_table()
    with db.engine.connect() as connection:
        return (
            connection.execute(
                text("SELECT count(*) FROM embeddings WHERE version_cid = :c"), {"c": cid}
            ).scalar_one()
            > 0
        )


def raw_vector(cid: str) -> bytes:
    with db.engine.connect() as connection:
        return connection.execute(
            text("SELECT vector FROM embeddings WHERE version_cid = :c"), {"c": cid}
        ).scalar_one()


def cids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [r["version_cid"] for r in response.json()["results"]]


class KeywordEmbedder:
    """A tiny embedder with an exact, hand-checkable geometry: one axis per keyword."""

    KEYWORDS = ("alpha", "beta", "gamma")
    name = "keywords-3"

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts):
        self.calls.append(list(texts))
        return [[float(t.lower().count(k)) for k in self.KEYWORDS] for t in texts]


class DownEmbedder:
    name = "down"

    def embed(self, texts):
        raise EmbedderError("the model server is down")


@pytest.fixture(autouse=True)
def default_embedder(monkeypatch):
    """Every test starts from the environment's choice: hashing, no Ollama."""
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    monkeypatch.delenv("OLLAMA_EMBED_MODEL", raising=False)
    set_embedder(None)
    yield
    set_embedder(None)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# --------------------------------------------------------------------------- #
# The hashing embedder
# --------------------------------------------------------------------------- #


def test_hashing_embedder_is_deterministic_and_unit_length():
    one = HashingEmbedder().embed(["Timing of millisecond pulsars"])[0]
    two = HashingEmbedder().embed(["Timing of millisecond pulsars"])[0]

    assert one == two
    assert len(one) == 1024
    assert math.isclose(math.sqrt(sum(x * x for x in one)), 1.0)


def test_hashing_embedder_gives_the_same_vector_in_another_process():
    # ``hash()`` is salted per process; a stored vector is only meaningful after
    # a restart if the embedder does not use it.  Load the module by path so the
    # child needs no database.
    probe = (
        "import hashlib, importlib.util, struct, sys\n"
        "spec = importlib.util.spec_from_file_location('embedder', sys.argv[1])\n"
        "mod = importlib.util.module_from_spec(spec)\n"
        "sys.modules['embedder'] = mod\n"
        "spec.loader.exec_module(mod)\n"
        "v = mod.HashingEmbedder().embed(['Timing of millisecond pulsars'])[0]\n"
        "print(hashlib.sha256(struct.pack('<%df' % len(v), *v)).hexdigest())\n"
    )
    import struct

    out = subprocess.run(
        [sys.executable, "-I", "-c", probe, str(Path(embedder_module.__file__))],
        env={"PYTHONHASHSEED": "12345"},
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    here = HashingEmbedder().embed(["Timing of millisecond pulsars"])[0]
    assert out == hashlib.sha256(struct.pack(f"<{len(here)}f", *here)).hexdigest()


def test_hashing_embedder_ranks_shared_words_above_unrelated_text():
    e = HashingEmbedder()
    query, related, other = e.embed(
        [
            "pulsar timing array",
            "Precise timing of millisecond pulsars in a gravitational wave array",
            "Protein folding dynamics in aqueous solution",
        ]
    )

    assert cosine_similarity(query, related) > 0.3
    assert cosine_similarity(query, related) > cosine_similarity(query, other) + 0.2


def test_hashing_embedder_treats_plurals_and_case_as_close():
    e = HashingEmbedder()
    a, b, c = e.embed(["Pulsar", "PULSARS", "turbulence"])

    # Not identical (they are different words) but clearly related, where
    # unrelated words share nothing.
    assert 0.2 < cosine_similarity(a, b) < 1.0
    assert abs(cosine_similarity(a, c)) < 0.1


def test_hashing_embedder_embeds_text_without_features_to_the_zero_vector():
    [vector] = HashingEmbedder().embed(["the of and !!!"])

    assert not any(vector)
    assert cosine_similarity(vector, vector) == 0.0


def test_cosine_similarity_of_known_vectors():
    assert cosine_similarity([1, 0], [1, 0]) == pytest.approx(1.0)
    assert cosine_similarity([1, 0], [0, 1]) == pytest.approx(0.0)
    assert cosine_similarity([1, 0], [-2, 0]) == pytest.approx(-1.0)
    assert cosine_similarity([1, 1], [1, 0]) == pytest.approx(math.sqrt(0.5))
    with pytest.raises(ValueError):
        cosine_similarity([1, 0], [1, 0, 0])


# --------------------------------------------------------------------------- #
# Choosing the embedder
# --------------------------------------------------------------------------- #


def test_hashing_is_the_default_embedder():
    assert isinstance(get_embedder(), HashingEmbedder)
    assert search.get_embedder() is get_embedder()


@pytest.mark.parametrize("value", ["", "   "])
def test_an_empty_ollama_url_is_not_set(monkeypatch, value):
    monkeypatch.setenv("OLLAMA_URL", value)

    assert isinstance(get_embedder(), HashingEmbedder)


def test_ollama_is_used_when_ollama_url_is_set(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test:11434/")

    chosen = get_embedder()

    assert isinstance(chosen, OllamaEmbedder)
    assert chosen.base_url == "http://ollama.test:11434"
    assert chosen.model == DEFAULT_OLLAMA_MODEL
    assert chosen.name == f"ollama:{DEFAULT_OLLAMA_MODEL}"


def test_the_ollama_model_comes_from_ollama_embed_model(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test:11434")
    monkeypatch.setenv("OLLAMA_EMBED_MODEL", "mxbai-embed-large")

    assert get_embedder().name == "ollama:mxbai-embed-large"


def test_the_choice_follows_the_environment_on_every_call(monkeypatch):
    assert isinstance(get_embedder(), HashingEmbedder)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test:11434")
    assert isinstance(get_embedder(), OllamaEmbedder)
    monkeypatch.delenv("OLLAMA_URL")
    assert isinstance(get_embedder(), HashingEmbedder)


def test_set_embedder_overrides_the_environment(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test:11434")
    fake = KeywordEmbedder()

    set_embedder(fake)

    assert get_embedder() is fake


# --------------------------------------------------------------------------- #
# The Ollama embedder
# --------------------------------------------------------------------------- #


def ollama_over(handler) -> OllamaEmbedder:
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return OllamaEmbedder("http://ollama.test:11434", "test-model", client=client)


def test_ollama_embedder_posts_the_texts_to_api_embed():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"embeddings": [[1, 2, 3], [4.5, 5, 6]]})

    vectors = ollama_over(handler).embed(["first", "second"])

    assert vectors == [[1.0, 2.0, 3.0], [4.5, 5.0, 6.0]]
    assert seen == [("POST", "/api/embed", {"model": "test-model", "input": ["first", "second"]})]


def test_ollama_embedder_makes_no_request_for_no_texts():
    def handler(request):
        raise AssertionError("no request expected")

    assert ollama_over(handler).embed([]) == []


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(404, json={"error": "model not found"}),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"embeddings": [[1.0]]}),  # one vector for two texts
        httpx.Response(200, json={"nope": []}),
        httpx.Response(200, json=["a list"]),
        httpx.Response(200, json={"embeddings": [[1.0], []]}),
        httpx.Response(200, json={"embeddings": [[1.0], ["x"]]}),
        httpx.Response(200, json={"embeddings": [[1.0], [True]]}),
        httpx.Response(200, content=b'{"embeddings": [[1.0], [NaN]]}'),
    ],
)
def test_ollama_embedder_refuses_a_bad_reply(response):
    with pytest.raises(EmbedderError):
        ollama_over(lambda request: response).embed(["a", "b"])


def test_ollama_embedder_reports_an_unreachable_server():
    def handler(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(EmbedderError):
        ollama_over(handler).embed(["a"])


# --------------------------------------------------------------------------- #
# The embeddings table and its blobs
# --------------------------------------------------------------------------- #


def test_embeddings_table_has_the_spec_columns():
    embeddings_module.ensure_table()

    with db.engine.connect() as connection:
        columns = [
            (row[1], row[2].upper(), bool(row[3]), bool(row[5]))
            for row in connection.execute(text("PRAGMA table_info(embeddings)"))
        ]

    # (name, type, not null, primary key)
    assert columns == [("version_cid", "TEXT", True, True), ("vector", "BLOB", True, False)]


def test_a_vector_round_trips_through_its_blob():
    blob = encode_vector("my-embedder", [0.5, -1.25, 3.0])

    stored = decode_vector(blob)

    assert stored is not None
    assert stored.embedder == "my-embedder"
    assert stored.vector == (0.5, -1.25, 3.0)


@pytest.mark.parametrize(
    "blob",
    [
        None,
        "text",
        b"",
        b"SCV1",
        b"SCV1\x00",  # no name
        b"SCV1\x05ab",  # name longer than the blob
        b"SCV1\x01a",  # no vector
        b"SCV1\x01a\x00\x00\x80",  # vector not a whole number of floats
        b"XXXX\x01a\x00\x00\x80\x3f",  # wrong magic
        b"\x00\x00\x80\x3f" * 8,  # a bare float array
        b"SCV1\x02\xff\xfe\x00\x00\x80\x3f",  # name is not utf-8
    ],
)
def test_a_blob_that_is_not_ours_does_not_decode(blob):
    assert decode_vector(blob) is None


def test_put_embedding_inserts_then_replaces_the_one_row():
    cid = new_cid()

    embeddings_module.put_embedding(cid, "e1", [1.0, 2.0])
    embeddings_module.put_embedding(cid, "e2", [3.0, 4.0, 5.0])

    stored = embeddings_module.get_embedding(cid)
    assert stored is not None
    assert (stored.embedder, stored.vector) == ("e2", (3.0, 4.0, 5.0))
    with db.engine.connect() as connection:
        count = connection.execute(
            text("SELECT count(*) FROM embeddings WHERE version_cid = :c"), {"c": cid}
        ).scalar_one()
    assert count == 1
    assert embeddings_module.remove_embedding(cid) is True
    assert embeddings_module.remove_embedding(cid) is False
    assert embeddings_module.get_embedding(cid) is None


# --------------------------------------------------------------------------- #
# Vectors follow the listing
# --------------------------------------------------------------------------- #


def test_listing_a_version_stores_its_embedding():
    w = word()
    cid = listed(f"Spectroscopy of {w}", "We measure things.")

    stored = embeddings_module.get_embedding(cid)

    assert stored is not None
    assert stored.embedder == HashingEmbedder().name
    expected = HashingEmbedder().embed([f"Spectroscopy of {w}\n\nWe measure things."])[0]
    assert stored.vector == pytest.approx(expected, abs=1e-6)


def test_the_embedded_text_includes_the_start_of_the_extracted_text():
    w = word()
    cid = make_version("Title", "Abstract")
    checks.save_paragraphs(cid, [f"The body discusses {w} at length.", "More text."])

    list_version(cid)

    stored = embeddings_module.get_embedding(cid)
    expected = HashingEmbedder().embed(
        [f"Title\n\nAbstract\n\nThe body discusses {w} at length.\n\nMore text."]
    )[0]
    assert stored is not None
    assert stored.vector == pytest.approx(expected, abs=1e-6)


def test_only_the_start_of_a_long_text_is_embedded():
    far = word()
    cid = make_version("Title", "Abstract")
    checks.save_paragraphs(cid, ["x" * 3000, "y" * 3000, f"{far}"])

    text_ = embeddings_module.embedding_text(cid, "Title", "Abstract")

    assert far not in text_
    assert len(text_) < 4000 + 100


def test_a_version_that_is_not_listed_has_no_embedding():
    for state in (AWAITING_CONSENT, SCANNING, MODERATION):
        cid = make_version("A draft", state=state)
        assert embeddings_module.sync_embedding(cid) is False
        assert not row_exists(cid)


def test_holding_or_rejecting_a_listed_version_removes_its_embedding():
    for state in (HELD, REJECTED):
        cid = listed(f"About {word()}")
        assert row_exists(cid)

        transition_version(cid, state)

        assert not row_exists(cid), state


def test_relisting_a_held_version_restores_its_embedding():
    cid = listed(f"About {word()}")
    transition_version(cid, HELD)
    assert not row_exists(cid)

    transition_version(cid, LISTED)

    assert row_exists(cid)


def test_sync_embedding_picks_up_changed_text():
    cid = listed("Title", "Abstract")
    before = embeddings_module.get_embedding(cid)

    checks.save_paragraphs(cid, [f"Entirely new content about {word()}."])
    assert embeddings_module.sync_embedding(cid) is True

    after = embeddings_module.get_embedding(cid)
    assert before is not None and after is not None
    assert after.vector != before.vector


def test_an_embedder_failure_when_listing_does_not_block_the_listing():
    set_embedder(DownEmbedder())
    cid = make_version(f"About {word()}")

    list_version(cid)  # must not raise

    assert get_version(cid).state == LISTED
    assert not row_exists(cid)


def test_rebuild_embeddings_adds_missing_rows_and_drops_stale_ones():
    in_index = listed(f"Rebuild {word()}")
    missing = listed(f"Rebuild {word()}")
    embeddings_module.remove_embedding(missing)
    draft = make_version(f"Draft {word()}")
    embeddings_module.put_embedding(draft, HashingEmbedder().name, [1.0, 2.0])
    gone = new_cid()
    embeddings_module.put_embedding(gone, HashingEmbedder().name, [1.0, 2.0])

    count = search.rebuild_embeddings()

    assert count >= 2
    assert row_exists(in_index) and row_exists(missing)
    assert not row_exists(draft) and not row_exists(gone)


# --------------------------------------------------------------------------- #
# GET /v1/search/semantic
# --------------------------------------------------------------------------- #


def test_a_word_from_a_listed_title_finds_that_version_first(client):
    w = word()
    cid = listed(f"On the nature of {w}", "A study.")
    listed(f"Something else entirely {word()}", "Other words.")

    response = client.get(URL, params={"q": w})

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == w
    assert body["embedder"] == HashingEmbedder().name
    assert body["results"][0]["version_cid"] == cid
    assert body["results"][0]["title"] == f"On the nature of {w}"
    assert body["results"][0]["score"] > 0.3


def test_a_word_from_an_abstract_or_the_text_finds_the_version(client):
    in_abstract, in_text = word(), word()
    by_abstract = listed("Title", f"We study {in_abstract} here.")
    by_text = make_version("Another title", "Another abstract.")
    checks.save_paragraphs(by_text, [f"Section about {in_text}."])
    list_version(by_text)

    assert cids(client.get(URL, params={"q": in_abstract}))[0] == by_abstract
    assert cids(client.get(URL, params={"q": in_text}))[0] == by_text


def test_results_are_ranked_by_cosine_similarity_of_the_stored_embeddings(client):
    set_embedder(KeywordEmbedder())
    full = listed("alpha beta")
    partial = listed("alpha gamma gamma gamma")
    none = listed("beta beta")

    response = client.get(URL, params={"q": "alpha beta", "limit": 100})

    assert response.status_code == 200
    ranked = {r["version_cid"]: r["score"] for r in response.json()["results"]}
    order = [c for c in cids(response) if c in (full, partial, none)]
    assert order == [full, none, partial]
    assert ranked[full] == pytest.approx(1.0)
    assert ranked[none] == pytest.approx(1 / math.sqrt(2), abs=1e-6)
    assert ranked[partial] == pytest.approx(1 / math.sqrt(2 * 10), abs=1e-6)
    scores = [r["score"] for r in response.json()["results"]]
    assert scores == sorted(scores, reverse=True)
    assert response.json()["embedder"] == "keywords-3"


def test_equal_scores_are_ordered_by_version_cid(client):
    set_embedder(KeywordEmbedder())
    first, second, third = (listed("alpha") for _ in range(3))

    got = [c for c in cids(client.get(URL, params={"q": "alpha", "limit": 100})) if c in (first, second, third)]

    assert got == sorted([first, second, third])


def test_a_result_describes_its_version_and_paper(client):
    w = word()
    paper_cid = f"paper-{uuid.uuid4().hex}"
    short_id = f"sch:{uuid.uuid4().hex[:12]}"
    with db.SessionLocal() as session:
        session.add(Paper(paper_cid=paper_cid, short_id=short_id, categories=["astro-ph", "cs.LG"], status="reviewed"))
        session.commit()
    cid = listed(f"Described {w}", "Its abstract.", paper=paper_cid)

    [hit] = [r for r in client.get(URL, params={"q": w}).json()["results"] if r["version_cid"] == cid]

    assert hit["paper_cid"] == paper_cid
    assert hit["short_id"] == short_id
    assert hit["n"] == 1
    assert hit["abstract"] == "Its abstract."
    assert hit["categories"] == ["astro-ph", "cs.LG"]
    assert hit["status"] == "reviewed"
    assert hit["listed_at"] is not None or get_version(cid).listed_at is None


def test_a_version_whose_paper_is_not_held_still_ranks(client):
    w = word()
    cid = listed(f"Orphan {w}")

    [hit] = [r for r in client.get(URL, params={"q": w}).json()["results"] if r["version_cid"] == cid]

    assert hit["short_id"] is None
    assert hit["categories"] == []
    assert hit["status"] is None


def test_unlisted_versions_are_never_returned(client):
    w = word()
    draft = make_version(f"Draft {w}", state=AWAITING_CONSENT)
    held = listed(f"Held {w}")
    transition_version(held, HELD)
    rejected = listed(f"Rejected {w}")
    transition_version(rejected, REJECTED)
    visible = listed(f"Visible {w}")
    # Even a stray vector for an unlisted version must not surface it.
    for cid in (draft, held, rejected):
        embeddings_module.put_embedding(cid, HashingEmbedder().name, HashingEmbedder().embed([w])[0])

    got = cids(client.get(URL, params={"q": w, "limit": 100}))

    assert visible in got
    assert not {draft, held, rejected} & set(got)


def test_limit_caps_the_results(client):
    w = word()
    for i in range(4):
        listed(f"Cap {w} {i}")

    assert len(client.get(URL, params={"q": w, "limit": 2}).json()["results"]) == 2
    assert len(client.get(URL, params={"q": w, "limit": 3}).json()["results"]) == 3
    # The default is ten.
    assert len(client.get(URL, params={"q": w}).json()["results"]) <= 10


def test_a_query_with_no_features_matches_nothing(client):
    listed(f"Anything {word()}")

    response = client.get(URL, params={"q": "the of and"})

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_the_query_is_trimmed(client):
    w = word()
    cid = listed(f"Trim {w}")

    response = client.get(URL, params={"q": f"   {w}  "})

    assert response.json()["query"] == w
    assert cids(response)[0] == cid


def test_search_is_public(client):
    assert client.get(URL, params={"q": "anything"}, headers={}).status_code == 200


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"q": ""},
        {"q": "   "},
        {"q": "x" * 2001},
        {"q": "ok", "limit": 0},
        {"q": "ok", "limit": 101},
        {"q": "ok", "limit": "many"},
    ],
)
def test_a_bad_request_is_a_422_problem(client, params):
    response = client.get(URL, params=params)

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 422


# --------------------------------------------------------------------------- #
# Self-healing vectors
# --------------------------------------------------------------------------- #


def test_a_listed_version_without_a_vector_is_embedded_by_the_search(client):
    w = word()
    cid = listed(f"Backfill {w}")
    embeddings_module.remove_embedding(cid)  # e.g. listed before this plugin existed

    assert cids(client.get(URL, params={"q": w}))[0] == cid
    assert row_exists(cid)


def test_a_vector_from_another_embedder_is_recomputed_not_compared(client):
    w = word()
    cid = listed(f"Foreign {w}")
    # A leftover from a previous embedder, of a different dimension and a
    # deliberately misleading direction.
    embeddings_module.put_embedding(cid, "some-old-model", [1.0, 0.0, 0.0])

    response = client.get(URL, params={"q": w})

    assert cids(response)[0] == cid
    stored = embeddings_module.get_embedding(cid)
    assert stored is not None and stored.embedder == HashingEmbedder().name


def test_an_unreadable_vector_is_recomputed(client):
    w = word()
    cid = listed(f"Corrupt {w}")
    with db.engine.begin() as connection:
        connection.execute(
            text("UPDATE embeddings SET vector = :v WHERE version_cid = :c"),
            {"v": b"\x00\x01garbage", "c": cid},
        )

    assert cids(client.get(URL, params={"q": w}))[0] == cid
    assert embeddings_module.get_embedding(cid) is not None


def test_vectors_that_are_current_are_not_recomputed(client):
    set_embedder(KeywordEmbedder())
    cid = listed("alpha")
    fake = KeywordEmbedder()
    set_embedder(fake)
    # Everything else in the shared database is brought up to date by this call...
    client.get(URL, params={"q": "alpha"})
    fake.calls.clear()

    client.get(URL, params={"q": "alpha"})

    # ... so a second search embeds only the query.
    assert fake.calls == [["alpha"]]
    assert row_exists(cid)


def test_switching_embedders_re_embeds_on_the_next_search(client):
    w = word()
    cid = listed(f"Switch {w}")
    assert embeddings_module.get_embedding(cid).embedder == HashingEmbedder().name

    set_embedder(KeywordEmbedder())
    response = client.get(URL, params={"q": "alpha"})

    assert response.json()["embedder"] == "keywords-3"
    assert embeddings_module.get_embedding(cid).embedder == "keywords-3"
    # ... and back again.
    set_embedder(None)
    assert cids(client.get(URL, params={"q": w}))[0] == cid
    assert embeddings_module.get_embedding(cid).embedder == HashingEmbedder().name


# --------------------------------------------------------------------------- #
# Ollama, end to end
# --------------------------------------------------------------------------- #


def install_fake_ollama(monkeypatch, handler):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test:11434")
    monkeypatch.setattr(
        embedder_module,
        "_ollama",
        lambda url, model: OllamaEmbedder(
            url, model, client=httpx.Client(transport=httpx.MockTransport(handler))
        ),
    )


def test_the_endpoint_embeds_and_ranks_with_ollama_when_ollama_url_is_set(client, monkeypatch):
    hashing = HashingEmbedder(256)
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests.append((request.url.path, payload["model"], payload["input"]))
        return httpx.Response(200, json={"embeddings": hashing.embed(payload["input"])})

    install_fake_ollama(monkeypatch, handler)
    w = word()
    cid = listed(f"Ollama ranked {w}")

    response = client.get(URL, params={"q": w})

    assert response.status_code == 200
    assert response.json()["embedder"] == f"ollama:{DEFAULT_OLLAMA_MODEL}"
    assert cids(response)[0] == cid
    assert all(path == "/api/embed" and model == DEFAULT_OLLAMA_MODEL for path, model, _ in requests)
    assert [w] in [inputs for _, _, inputs in requests]  # the query was embedded
    stored = embeddings_module.get_embedding(cid)
    assert stored is not None
    assert stored.embedder == f"ollama:{DEFAULT_OLLAMA_MODEL}"
    assert len(stored.vector) == 256


def test_listing_embeds_with_ollama_when_ollama_url_is_set(monkeypatch):
    hashing = HashingEmbedder(256)
    install_fake_ollama(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"embeddings": hashing.embed(json.loads(request.content)["input"])}
        ),
    )

    cid = listed(f"Listed under ollama {word()}")

    stored = embeddings_module.get_embedding(cid)
    assert stored is not None and stored.embedder == f"ollama:{DEFAULT_OLLAMA_MODEL}"


def test_an_unreachable_ollama_is_a_503_problem(client, monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    install_fake_ollama(monkeypatch, handler)

    response = client.get(URL, params={"q": "anything"})

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 503


def test_an_ollama_that_fails_while_embedding_listed_versions_is_a_503(client, monkeypatch):
    w = word()
    cid = listed(f"Needs a vector {w}")
    embeddings_module.remove_embedding(cid)
    install_fake_ollama(monkeypatch, lambda request: httpx.Response(500, text="boom"))

    response = client.get(URL, params={"q": w})

    assert response.status_code == 503


# --------------------------------------------------------------------------- #
# Wiring
# --------------------------------------------------------------------------- #


def test_the_loader_mounts_the_semantic_route_under_v1():
    # ``app.main.app`` was built by the module loader, so finding the route on it
    # shows the package's ``router`` was discovered and mounted.  (Calling
    # ``load_modules`` again here would re-run every plugin's startup hook and
    # change process-wide subscriber counts other tests assert on.)
    operation = app.openapi()["paths"]["/v1/search/semantic"]["get"]

    assert {p["name"] for p in operation["parameters"]} == {"q", "limit"}
    assert next(p for p in operation["parameters"] if p["name"] == "q")["required"] is True
    assert search.router is not None


def test_embeddings_ride_on_the_existing_subscriptions():
    # Feature 85's two subscriptions drive both projections; installing again
    # (as ``create_app`` does) must not add a subscriber of its own.
    from app.modules import ledger
    from app.modules.submissions import state_changed_subscriber_count

    ledger_before = ledger.subscriber_count("paper.version")
    state_before = state_changed_subscriber_count()

    search.install()
    search.install()

    assert ledger.subscriber_count("paper.version") == ledger_before
    assert state_changed_subscriber_count() == state_before == 1
