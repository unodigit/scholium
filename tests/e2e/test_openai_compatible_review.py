"""The AI pre-review through a running OpenAI-compatible server.

``AI_PROVIDER=openai`` names a protocol, not a vendor: the API POSTs
``<OPENAI_BASE_URL>/chat/completions`` with a Bearer key and the model from
``AI_HOSTED_MODEL``.  Here the server is a stub on a loopback port inside the
test process -- the neighbour a node talks to, like ``FakeS3`` -- and the node
is the shipped ``python -m app`` with ``JOBS_MODE=thread``.  Nothing reaches the
network beyond 127.0.0.1 and no credential is real.

A paper is submitted and listed over HTTP; listing a version enqueues the
``ai.review.run`` job, whose agents call the stub.  The test then reads
``GET /v1/papers/{id}/ai-reviews`` until the review names the stub's provider
and model, and checks what the stub saw: the bearer key, the model, the
chat-completions shape, and the paper text of a *listed* version.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator, Optional

import httpx
import pytest

from e2e_harness import Node, Published, poll, publish_listed_paper

STUB_MODEL = "stub-model"
STUB_KEY = "sk-e2e-stub-key-not-a-real-credential"

#: What the stub answers every agent with: a findings object with no findings,
#: which is a well-formed reply (the pipeline stores a review with no findings).
STUB_COMPLETION = json.dumps({"findings": []})

#: The agents the pipeline runs; each makes one request.
AGENT_COUNT = 4


class StubOpenAIServer:
    """A chat-completions server on 127.0.0.1 that records what it is sent.

    ``POST /v1/chat/completions`` is answered with one fixed completion
    (model ``stub-model``, ``finish_reason`` ``stop``, non-empty content);
    every other request gets a 404.  ``requests`` keeps each request it
    received, whatever its path, so a test can say what the node did and did
    not send.
    """

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:  # silence
                pass

            def _read_json(self) -> Optional[Any]:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    return json.loads(raw)
                except ValueError:
                    return None

            def _reply(self, status: int, body: dict[str, Any]) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _record(self) -> Optional[Any]:
                body = self._read_json()
                with stub._lock:
                    stub.requests.append(
                        {
                            "method": self.command,
                            "path": self.path,
                            "authorization": self.headers.get("Authorization"),
                            "body": body,
                        }
                    )
                return body

            def do_POST(self) -> None:
                body = self._record()
                if self.path != "/v1/chat/completions":
                    return self._reply(404, {"error": {"message": f"no route {self.path}"}})
                self._reply(
                    200,
                    {
                        "id": "chatcmpl-e2e-stub",
                        "object": "chat.completion",
                        "created": 1_700_000_000,
                        "model": STUB_MODEL,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": STUB_COMPLETION},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    },
                )

            def do_GET(self) -> None:
                self._record()
                self._reply(404, {"error": {"message": f"no route {self.path}"}})

        # Port 0: the kernel picks one and keeps it, so nothing can take it in between.
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        """The value of ``OPENAI_BASE_URL``: the server's ``/v1`` root."""
        return f"http://127.0.0.1:{self.port}/v1"

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.requests)

    def completions(self) -> list[dict[str, Any]]:
        """The requests that went to ``POST /v1/chat/completions``."""
        return [
            r for r in self.snapshot()
            if r["method"] == "POST" and r["path"] == "/v1/chat/completions"
        ]

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture(scope="module")
def stub() -> Iterator[StubOpenAIServer]:
    server = StubOpenAIServer()
    try:
        yield server
    finally:
        server.close()


@pytest.fixture(scope="module")
def openai_node(nodes, stub: StubOpenAIServer) -> Node:
    """A provisioned node whose jobs run in the API process and whose reviewer is the stub."""
    node = nodes.make("openai-review", storage="fs", jobs="thread")
    node.init_key()
    # The provider is chosen through the node's environment, like an operator's .env.
    node.env.update(
        AI_PROVIDER="openai",
        AI_HOSTED_MODEL=STUB_MODEL,
        OPENAI_API_KEY=STUB_KEY,
    )
    # ... and the base URL through the override of the start itself.
    node.start_api(OPENAI_BASE_URL=stub.base_url)
    return node


@pytest.fixture(scope="module")
def http(openai_node: Node) -> Iterator[httpx.Client]:
    with openai_node.client() as client:
        yield client


@pytest.fixture(scope="module")
def paper(openai_node: Node, http: httpx.Client) -> Published:
    return publish_listed_paper(openai_node, http, title="OpenAI-compatible review paper")


@pytest.fixture(scope="module")
def review(http: httpx.Client, paper: Published) -> dict[str, Any]:
    """The pre-review, once the job has run: it names the stub's provider and model."""

    def names_the_stub() -> Optional[dict[str, Any]]:
        response = http.get(f"/v1/papers/{paper.short_id}/ai-reviews")
        if response.status_code != 200:
            return None
        body = response.json()
        models = body.get("models") or []
        named = any(
            m.get("provider") == "openai" and m.get("name") == STUB_MODEL for m in models
        )
        return body if named else None

    return poll(names_the_stub, timeout=30, what="an AI pre-review naming provider openai and model stub-model")


def test_the_pre_review_names_the_provider_and_model_that_wrote_it(paper, review):
    assert review["advisory"] is True
    assert review["versionCid"] == paper.version_cid
    assert review["reviewCid"]
    assert {(m["provider"], m["name"]) for m in review["models"]} == {("openai", STUB_MODEL)}, review["models"]
    # Every agent has its section, though the stub reported no findings.
    assert {group["agent"] for group in review["agents"]} == {
        "methodology", "literature", "integrity", "reproducibility",
    }


def test_the_stub_received_the_bearer_key_on_every_request(review, stub):
    requests = stub.completions()
    assert len(requests) >= AGENT_COUNT, stub.snapshot()
    assert {r["authorization"] for r in requests} == {f"Bearer {STUB_KEY}"}, [
        r["authorization"] for r in requests
    ]


def test_every_request_is_a_chat_completion_for_the_configured_model(review, stub):
    assert {(r["method"], r["path"]) for r in stub.snapshot()} == {("POST", "/v1/chat/completions")}
    for request in stub.completions():
        body = request["body"]
        assert isinstance(body, dict), request
        assert body["model"] == STUB_MODEL
        assert body["stream"] is False
        roles = [message["role"] for message in body["messages"]]
        assert roles == ["system", "user"], roles


def test_the_stub_saw_the_listed_papers_text_only_as_quoted_data(paper, review, stub):
    system_texts = []
    user_texts = []
    for request in stub.completions():
        system, user = request["body"]["messages"]
        system_texts.append(system["content"])
        user_texts.append(user["content"])
    assert any(paper.sentence in text for text in user_texts), user_texts
    # The trusted instructions never carry the paper's words.
    assert not any(paper.sentence in text for text in system_texts), system_texts


def test_the_key_appears_nowhere_the_node_writes(openai_node, http, review):
    assert STUB_KEY not in json.dumps(review)
    assert openai_node.api is not None
    assert STUB_KEY not in openai_node.api.log
    # Nor in the stored review, nor in the ledger the signed review record went to.
    stored = openai_node.sql("SELECT models, findings FROM ai_reviews")
    assert stored, "the review row is missing"
    assert STUB_KEY not in repr(stored)
    archive = http.get("/v1/export/archive.car")
    assert archive.status_code == 200, archive.text
    assert STUB_KEY.encode() not in archive.content
