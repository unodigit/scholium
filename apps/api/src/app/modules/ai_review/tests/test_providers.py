"""Tests for the LLM provider interface (feature: AI pre-review 115).

Covers: the provider interface contract, the deterministic fake provider,
the hosted Anthropic provider (AI_HOSTED_MODEL default claude-sonnet-5-5,
PrivateDraftError on unlisted drafts), the self-hosted Ollama provider and
the AI_PROVIDER factory.  No test touches a real network: hosted and
Ollama clients are injected stubs.
"""

from types import SimpleNamespace

import pytest

from app.modules.ai_review import (
    AnthropicProvider,
    DataBlock,
    FakeProvider,
    LLMProvider,
    LLMRequest,
    OllamaProvider,
    PrivateDraftError,
    get_provider,
)
from app.settings import settings

INSTRUCTIONS = "Review the methodology of the quoted paragraphs."
BLOCK_P1 = DataBlock(id="p1", content="We train the model on 10 samples.")
BLOCK_P2 = DataBlock(id="p2", content="The code is available at github.com/example/repo.")


def make_request(**overrides) -> LLMRequest:
    kwargs = dict(
        instructions=INSTRUCTIONS,
        data_blocks=(BLOCK_P1, BLOCK_P2),
        listed=True,
    )
    kwargs.update(overrides)
    return LLMRequest(**kwargs)


class StubAnthropicClient:
    """Stands in for anthropic.Anthropic; records every create() call."""

    def __init__(self, text: str = "finding: sample is small") -> None:
        self.calls: list[dict] = []
        self._message = SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            model="claude-sonnet-5-5",
        )

    @property
    def messages(self) -> "StubAnthropicClient":
        return self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._message


class StubOllamaResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class StubOllamaClient:
    """Stands in for httpx.Client; records every post()."""

    def __init__(self, payload: dict | None = None) -> None:
        self.posts: list[tuple[str, dict]] = []
        self._payload = payload or {
            "model": "llama3.1:latest",
            "message": {"role": "assistant", "content": "finding: no random seed stated"},
        }

    def post(self, url: str, json: dict | None = None) -> StubOllamaResponse:
        self.posts.append((url, json))
        return StubOllamaResponse(self._payload)


class TestProviderInterface:
    def test_all_providers_implement_the_interface(self):
        for cls in (FakeProvider, AnthropicProvider, OllamaProvider):
            assert issubclass(cls, LLMProvider)

    def test_only_anthropic_is_hosted(self):
        assert AnthropicProvider.hosted is True
        assert FakeProvider.hosted is False
        assert OllamaProvider.hosted is False

    def test_request_fails_closed_to_unlisted(self):
        request = LLMRequest(instructions=INSTRUCTIONS)
        assert request.listed is False


class TestFakeProvider:
    def test_same_request_gives_identical_response(self):
        provider = FakeProvider()
        first = provider.complete(make_request())
        second = provider.complete(make_request())
        assert first == second

    def test_output_changes_with_instructions(self):
        provider = FakeProvider()
        baseline = provider.complete(make_request())
        changed = provider.complete(make_request(instructions="Other instructions."))
        assert baseline.text != changed.text

    def test_output_changes_with_data_block_content(self):
        provider = FakeProvider()
        baseline = provider.complete(make_request())
        other_block = DataBlock(id="p1", content="We train the model on 10,000 samples.")
        changed = provider.complete(
            make_request(data_blocks=(other_block, BLOCK_P2))
        )
        assert baseline.text != changed.text

    def test_processes_unlisted_drafts(self):
        response = FakeProvider().complete(make_request(listed=False))
        assert response.provider == "fake"
        assert "fake provider deterministic response" in response.text
        assert "request_sha256: " in response.text

    def test_response_reports_model_and_block_ids(self):
        response = FakeProvider(model="fake-x").complete(make_request())
        assert response.model == "fake-x"
        assert "data_blocks: p1, p2" in response.text


class TestAnthropicProvider:
    def test_default_model_is_hosted_model_setting(self):
        assert settings.AI_HOSTED_MODEL == "claude-sonnet-5-5"
        assert AnthropicProvider().model == "claude-sonnet-5-5"

    def test_model_can_be_overridden(self):
        provider = AnthropicProvider(model="claude-opus-5-5")
        assert provider.model == "claude-opus-5-5"

    def test_unlisted_draft_raises_private_draft_error(self):
        provider = AnthropicProvider()
        with pytest.raises(PrivateDraftError) as excinfo:
            provider.complete(make_request(listed=False))
        message = str(excinfo.value)
        assert message.startswith("PrivateDraftError")
        assert "unlisted draft" in message
        assert "anthropic" in message
        assert "self-hosted" in message

    def test_refusal_happens_before_any_client_is_created(self):
        provider = AnthropicProvider()
        with pytest.raises(PrivateDraftError):
            provider.complete(make_request(listed=False))
        assert provider._client is None

    def test_unlisted_by_default_also_refused(self):
        provider = AnthropicProvider()
        with pytest.raises(PrivateDraftError):
            provider.complete(LLMRequest(instructions=INSTRUCTIONS))

    def test_listed_draft_returns_completion_text(self):
        stub = StubAnthropicClient(text="finding: baseline not reported")
        provider = AnthropicProvider(client=stub)
        response = provider.complete(make_request())
        assert response.text == "finding: baseline not reported"
        assert response.provider == "anthropic"
        assert response.model == "claude-sonnet-5-5"

    def test_paper_data_travels_separately_from_instructions(self):
        stub = StubAnthropicClient()
        provider = AnthropicProvider(client=stub)
        provider.complete(make_request())
        (call,) = stub.calls
        assert call["system"] == INSTRUCTIONS
        assert call["model"] == provider.model
        assert call["max_tokens"] == make_request().max_tokens
        assert BLOCK_P1.content not in call["system"]
        (message,) = call["messages"]
        assert message["role"] == "user"
        assert len(message["content"]) == 2
        first_block = message["content"][0]
        assert first_block["type"] == "text"
        assert 'id="p1"' in first_block["text"]
        assert BLOCK_P1.content in first_block["text"]


class TestOllamaProvider:
    def test_base_url_comes_from_settings(self):
        provider = OllamaProvider(base_url="http://ollama.test:11434/")
        assert provider.base_url == "http://ollama.test:11434"

    def test_processes_unlisted_drafts(self):
        stub = StubOllamaClient()
        provider = OllamaProvider(base_url="http://ollama.test:11434", client=stub)
        response = provider.complete(make_request(listed=False))
        assert response.text == "finding: no random seed stated"
        assert response.provider == "ollama"
        assert response.model == "llama3.1:latest"

    def test_calls_ollama_chat_api_with_quoted_data_separate(self):
        stub = StubOllamaClient()
        provider = OllamaProvider(
            model="qwen2.5", base_url="http://ollama.test:11434", client=stub
        )
        provider.complete(make_request())
        (url, payload), = stub.posts
        assert url == "http://ollama.test:11434/api/chat"
        assert payload["model"] == "qwen2.5"
        assert payload["stream"] is False
        messages = payload["messages"]
        system = next(m for m in messages if m["role"] == "system")
        user = next(m for m in messages if m["role"] == "user")
        assert system["content"] == INSTRUCTIONS
        assert BLOCK_P1.content not in system["content"]
        assert 'id="p1"' in user["content"]
        assert BLOCK_P1.content in user["content"]
        assert BLOCK_P2.content in user["content"]


class TestGetProvider:
    def test_default_is_the_fake_provider(self):
        assert isinstance(get_provider(), FakeProvider)

    def test_selects_each_provider_by_name(self):
        assert isinstance(get_provider("fake"), FakeProvider)
        assert isinstance(get_provider("anthropic"), AnthropicProvider)
        assert isinstance(get_provider("ollama"), OllamaProvider)

    def test_unknown_provider_name_raises(self):
        with pytest.raises(ValueError, match="Unknown AI provider 'openai'"):
            get_provider("openai")
