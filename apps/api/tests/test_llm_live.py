"""Opt-in checks of both LLM providers against a real endpoint.

These tests make network calls, so they never run in the default suite: the
``live_llm`` marker is excluded by ``addopts`` in ``pyproject.toml``.  Run
them through ``npm run test:llm-live`` with the credentials injected by
``op run --env-file=deploy/llm-live.env.tpl -- npm run test:llm-live``.

The variables are deliberately named ``LLM_LIVE_*`` rather than the
``ANTHROPIC_*``/``OPENAI_*`` names, so injecting them cannot reroute any
other tool.  When any of them is missing every test here is skipped.

Each check sends one :class:`LLMRequest` for a listed draft with one quoted
data block through a provider and asserts that the reply is non-empty, that
it echoes the configured model, and that no thinking block (Anthropic
protocol) or ``reasoning_content`` (OpenAI protocol) text ends up in the
returned text.  The raw answer is captured through a thin recording wrapper
around the real client; the API key is only ever passed to the provider.
"""

from __future__ import annotations

import os
from typing import Any

import anthropic
import httpx
import pytest

from app.modules.ai_review import (
    AnthropicProvider,
    DataBlock,
    LLMRequest,
    LLMResponse,
    OpenAIProvider,
)

LIVE_BASE_URL = (os.environ.get("LLM_LIVE_BASE_URL") or "").strip()
LIVE_API_KEY = (os.environ.get("LLM_LIVE_API_KEY") or "").strip()
LIVE_MODEL = (os.environ.get("LLM_LIVE_MODEL") or "").strip()

MISSING_ENV_REASON = (
    "LLM_LIVE_BASE_URL, LLM_LIVE_API_KEY and LLM_LIVE_MODEL are not set"
)

pytestmark = [
    pytest.mark.live_llm,
    pytest.mark.skipif(
        not (LIVE_BASE_URL and LIVE_API_KEY and LIVE_MODEL),
        reason=MISSING_ENV_REASON,
    ),
]

INSTRUCTIONS = (
    "You are checking an LLM gateway. Read the quoted data block and reply "
    "with one short sentence that says what it describes."
)
DATA_BLOCK = DataBlock(
    id="live-data-1",
    content="The quick brown fox jumps over the lazy dog.",
)
#: Generous enough for a thinking model to reason and then answer.
MAX_TOKENS = 2048
#: Total request budget of the OpenAI-compatible provider's httpx client.
REQUEST_TIMEOUT = 120.0


def live_request() -> LLMRequest:
    """One listed request carrying one quoted data block; built per test."""
    return LLMRequest(
        instructions=INSTRUCTIONS,
        data_blocks=(DATA_BLOCK,),
        listed=True,
        max_tokens=MAX_TOKENS,
    )


def openai_base_url() -> str:
    """``LLM_LIVE_OPENAI_BASE_URL``, else the shared base URL plus ``/v1``."""
    explicit = (os.environ.get("LLM_LIVE_OPENAI_BASE_URL") or "").strip()
    if explicit:
        return explicit
    return LIVE_BASE_URL.rstrip("/") + "/v1"


class RecordingAnthropicClient:
    """Stands in for ``anthropic.Anthropic`` and keeps the raw message."""

    def __init__(self, inner: anthropic.Anthropic) -> None:
        self._inner = inner
        self.last_message: Any = None

    @property
    def messages(self) -> "RecordingAnthropicClient":
        return self

    def create(self, **kwargs: Any) -> Any:
        message = self._inner.messages.create(**kwargs)
        self.last_message = message
        return message

    def close(self) -> None:
        self._inner.close()


class RecordingHttpxClient:
    """Stands in for ``httpx.Client`` and keeps the last raw response."""

    def __init__(self, inner: httpx.Client) -> None:
        self._inner = inner
        self.last_response: httpx.Response | None = None

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        response = self._inner.post(url, **kwargs)
        self.last_response = response
        return response

    def close(self) -> None:
        self._inner.close()


def anthropic_thinking_text(message: Any) -> str:
    """The text of every thinking block the endpoint sent, or ``""``."""
    content = (
        message.get("content")
        if isinstance(message, dict)
        else getattr(message, "content", None)
    )
    parts: list[str] = []
    for block in content or []:
        if isinstance(block, dict):
            block_type, text = block.get("type"), block.get("thinking")
        else:
            block_type = getattr(block, "type", None)
            text = getattr(block, "thinking", None)
        if block_type == "thinking" and isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def openai_reasoning_text(payload: Any) -> str:
    """The ``reasoning_content`` the endpoint sent, or ``""``."""
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return ""
    if not isinstance(message, dict):
        return ""
    value = message.get("reasoning_content")
    return value if isinstance(value, str) else ""


def assert_live_completion(response: LLMResponse, hidden_text: str) -> None:
    """Assert the provider returned the answer, not its hidden reasoning."""
    assert response.text.strip(), "the provider returned an empty completion"
    assert response.model == LIVE_MODEL, (
        f"the provider echoed model {response.model!r}, expected {LIVE_MODEL!r}"
    )
    hidden = hidden_text.strip()
    if hidden:
        assert hidden not in response.text, (
            "the provider leaked a thinking block or reasoning_content into "
            "the returned text"
        )


def test_anthropic_provider_against_the_live_endpoint() -> None:
    client = RecordingAnthropicClient(
        anthropic.Anthropic(api_key=LIVE_API_KEY, base_url=LIVE_BASE_URL)
    )
    provider = AnthropicProvider(
        model=LIVE_MODEL,
        api_key=LIVE_API_KEY,
        base_url=LIVE_BASE_URL,
        client=client,
    )
    try:
        response = provider.complete(live_request())
    finally:
        client.close()

    assert_live_completion(response, anthropic_thinking_text(client.last_message))


def test_openai_provider_against_the_live_endpoint() -> None:
    client = RecordingHttpxClient(httpx.Client(timeout=REQUEST_TIMEOUT))
    provider = OpenAIProvider(
        model=LIVE_MODEL,
        base_url=openai_base_url(),
        api_key=LIVE_API_KEY,
        client=client,
    )
    try:
        response = provider.complete(live_request())
    finally:
        client.close()

    payload: Any = None
    if client.last_response is not None:
        try:
            payload = client.last_response.json()
        except ValueError:
            payload = None
    assert_live_completion(response, openai_reasoning_text(payload))
