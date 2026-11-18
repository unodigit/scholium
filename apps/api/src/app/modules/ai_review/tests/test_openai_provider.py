"""Tests for the hosted OpenAI-compatible provider (feature: AI pre-review).

Covers the chat-completions request (URL, Bearer header, body), the parsing
of answers, the unlisted-draft refusal, every retry rule (429/5xx answers,
timeouts, transport errors, ``Retry-After``) with the number of requests
actually made, and every rejected answer.  No test touches a real network:
the httpx client rides an ``httpx.MockTransport`` that records requests and
replays canned answers, and ``sleep`` is a fake recording the waited
seconds.  The API key below is a dummy that must never leak into an error
message; tests assert that it does not.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.modules.ai_review.errors import PrivateDraftError, ProviderError
from app.modules.ai_review.providers import (
    DataBlock,
    LLMRequest,
    OpenAIProvider,
    get_provider,
)
from app.settings import settings

INSTRUCTIONS = "Review the methodology of the quoted paragraphs."
BLOCK_P1 = DataBlock(id="p1", content="We train the model on 10 samples.")
BLOCK_P2 = DataBlock(
    id="p2", content="The code is available at github.com/example/repo."
)
API_KEY = "test-key-123"
BASE_URL = "https://openai.test/v1"


def make_request(**overrides) -> LLMRequest:
    kwargs = dict(
        instructions=INSTRUCTIONS,
        data_blocks=(BLOCK_P1, BLOCK_P2),
        listed=True,
    )
    kwargs.update(overrides)
    return LLMRequest(**kwargs)


def chat_answer(
    content: str | None = "finding: sample is small",
    model: str | None = "test-model-served",
    finish_reason: str = "stop",
    message_extra: dict | None = None,
) -> httpx.Response:
    """A well-formed 2xx chat-completions answer."""
    message: dict = {"role": "assistant", "content": content}
    if message_extra:
        message.update(message_extra)
    body = {
        "id": "chatcmpl-test",
        "model": model,
        "choices": [
            {"index": 0, "message": message, "finish_reason": finish_reason}
        ],
    }
    return httpx.Response(200, json=body)


class Replay:
    """A provider wired to a recording transport and a fake sleep.

    ``answers`` are replayed in order: an ``httpx.Response`` is returned, an
    exception is raised (as a transport failure would be).  ``requests``
    records every request the provider actually sent and ``sleeps`` every
    wait it asked for.
    """

    def __init__(self, answers: list) -> None:
        self.requests: list[httpx.Request] = []
        self.sleeps: list[float] = []
        self._answers = list(answers)
        self.client = httpx.Client(
            transport=httpx.MockTransport(self._handle)
        )
        self.provider = OpenAIProvider(
            model="test-model",
            base_url=BASE_URL,
            api_key=API_KEY,
            client=self.client,
            sleep=self.sleeps.append,
        )

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self._answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def sent_body(self, index: int = 0) -> dict:
        return json.loads(self.requests[index].content)


class TestConstruction:
    def test_openai_is_a_hosted_provider(self):
        assert OpenAIProvider.name == "openai"
        assert OpenAIProvider.hosted is True

    def test_defaults_come_from_settings(self, monkeypatch):
        monkeypatch.setattr(settings, "AI_HOSTED_MODEL", "hosted-model-x")
        monkeypatch.setattr(settings, "OPENAI_BASE_URL", "https://compat.test/v1")
        monkeypatch.setattr(settings, "OPENAI_API_KEY", "key-from-settings")
        provider = OpenAIProvider()
        assert provider.model == "hosted-model-x"
        assert provider.base_url == "https://compat.test/v1"
        assert provider._api_key == "key-from-settings"

    def test_arguments_override_the_settings(self):
        provider = OpenAIProvider(
            model="override-model",
            base_url="https://other.test/v1/",
            api_key="override-key",
        )
        assert provider.model == "override-model"
        assert provider.base_url == "https://other.test/v1"
        assert provider._api_key == "override-key"

    def test_get_provider_selects_openai_with_no_arguments(self):
        assert isinstance(get_provider("openai"), OpenAIProvider)

    def test_client_is_built_lazily_with_a_120_second_timeout(self):
        provider = OpenAIProvider(api_key="k")
        assert provider._client is None
        client = provider._get_client()
        try:
            assert isinstance(client, httpx.Client)
            assert client.timeout.read == 120.0
            assert client.timeout.connect == 120.0
            assert provider._client is client
        finally:
            client.close()


class TestUnlistedRefusal:
    def test_unlisted_draft_refused_before_any_request(self):
        replay = Replay([chat_answer()])
        with pytest.raises(PrivateDraftError) as excinfo:
            replay.provider.complete(make_request(listed=False))
        message = str(excinfo.value)
        assert message.startswith("PrivateDraftError")
        assert "openai" in message
        assert replay.requests == []
        assert replay.sleeps == []

    def test_unlisted_by_default_also_refused(self):
        replay = Replay([chat_answer()])
        with pytest.raises(PrivateDraftError):
            replay.provider.complete(LLMRequest(instructions=INSTRUCTIONS))
        assert replay.requests == []


class TestRequestShape:
    def test_posts_to_chat_completions_with_bearer_authorization(self):
        replay = Replay([chat_answer()])
        replay.provider.complete(make_request(max_tokens=512))
        (request,) = replay.requests
        assert request.method == "POST"
        assert str(request.url) == f"{BASE_URL}/chat/completions"
        assert request.headers["authorization"] == f"Bearer {API_KEY}"
        assert request.headers["content-type"] == "application/json"

    def test_body_holds_model_max_tokens_temperature_and_stream(self):
        replay = Replay([chat_answer()])
        replay.provider.complete(make_request(max_tokens=512))
        body = replay.sent_body()
        assert body["model"] == "test-model"
        assert body["max_tokens"] == 512
        assert body["temperature"] == 0
        assert body["stream"] is False

    def test_instructions_travel_as_the_system_message_only(self):
        replay = Replay([chat_answer()])
        replay.provider.complete(make_request())
        body = replay.sent_body()
        system = next(m for m in body["messages"] if m["role"] == "system")
        user = next(m for m in body["messages"] if m["role"] == "user")
        assert system["content"] == INSTRUCTIONS
        assert BLOCK_P1.content not in system["content"]
        assert INSTRUCTIONS not in user["content"]

    def test_data_blocks_quoted_exactly_as_ollama_quotes_them(self):
        replay = Replay([chat_answer()])
        replay.provider.complete(make_request())
        user = next(
            m for m in replay.sent_body()["messages"] if m["role"] == "user"
        )
        assert user["content"] == (
            "<data id=\"p1\">\n"
            "We train the model on 10 samples.\n"
            "</data>\n\n"
            "<data id=\"p2\">\n"
            "The code is available at github.com/example/repo.\n"
            "</data>"
        )

    def test_request_without_data_blocks_says_so(self):
        replay = Replay([chat_answer()])
        replay.provider.complete(make_request(data_blocks=()))
        user = next(
            m for m in replay.sent_body()["messages"] if m["role"] == "user"
        )
        assert user["content"] == "(no data blocks)"


class TestParsing:
    def test_returns_first_choice_content_and_the_response_model(self):
        replay = Replay(
            [chat_answer(content="finding: baseline missing", model="served-1")]
        )
        response = replay.provider.complete(make_request())
        assert response.text == "finding: baseline missing"
        assert response.provider == "openai"
        assert response.model == "served-1"

    def test_reasoning_content_is_ignored(self):
        replay = Replay(
            [
                chat_answer(
                    content="final answer",
                    message_extra={"reasoning_content": "internal chain of thought"},
                )
            ]
        )
        response = replay.provider.complete(make_request())
        assert response.text == "final answer"

    def test_model_falls_back_to_the_configured_model_when_absent(self):
        replay = Replay([chat_answer(model=None)])
        response = replay.provider.complete(make_request())
        assert response.model == "test-model"


class TestRejectedAnswers:
    """A 2xx answer that cannot become a complete review raises ProviderError."""

    def test_answer_with_no_choices(self):
        replay = Replay(
            [httpx.Response(200, json={"model": "m", "choices": []})]
        )
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "no choices" in message
        assert len(replay.requests) == 1
        assert replay.sleeps == []

    def test_answer_with_null_content(self):
        replay = Replay([chat_answer(content=None)])
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "null or empty" in message
        assert len(replay.requests) == 1

    def test_answer_with_empty_content(self):
        replay = Replay([chat_answer(content="")])
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "null or empty" in message
        assert len(replay.requests) == 1

    def test_answer_that_hit_the_token_limit(self):
        replay = Replay(
            [chat_answer(content="a partial review", finish_reason="length")]
        )
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "length" in message
        assert len(replay.requests) == 1
        assert replay.sleeps == []

    def test_answer_that_is_not_json(self):
        replay = Replay(
            [
                httpx.Response(
                    200,
                    content=b"<html>not json</html>",
                    headers={"content-type": "text/html"},
                )
            ]
        )
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "not JSON" in message
        assert len(replay.requests) == 1

    @pytest.mark.parametrize(
        ("body", "reason"),
        [
            ([1, 2], "not a JSON object"),
            ("hello", "not a JSON object"),
            ({"choices": "x"}, "no choices"),
            ({"choices": ["x"]}, "first choice is not an object"),
            ({"choices": [{"message": "x"}]}, "null or empty"),
            ({"choices": [{"message": None}]}, "null or empty"),
            (
                {
                    "choices": [
                        {"message": {"content": [{"type": "text", "text": "a"}]}}
                    ]
                },
                "not text",
            ),
        ],
    )
    def test_a_malformed_answer_raises_provider_error_not_a_type_error(
        self, body, reason
    ):
        replay = Replay([httpx.Response(200, json=body)])
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert reason in message
        assert len(replay.requests) == 1
        assert replay.sleeps == []


class TestHttpClientErrors:
    @pytest.mark.parametrize("status", [400, 401, 404])
    def test_other_4xx_is_never_retried(self, status):
        replay = Replay(
            [httpx.Response(status, json={"error": "bad"}), chat_answer()]
        )
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert f"HTTP {status}" in message
        assert API_KEY not in message
        assert len(replay.requests) == 1
        assert replay.sleeps == []


class TestRetries:
    def test_429_then_success(self):
        replay = Replay(
            [httpx.Response(429, json={"error": "rate limited"}), chat_answer()]
        )
        response = replay.provider.complete(make_request())
        assert response.text == "finding: sample is small"
        assert len(replay.requests) == 2
        assert replay.sleeps == [1.0]

    def test_5xx_then_success(self):
        replay = Replay(
            [httpx.Response(503, json={"error": "overloaded"}), chat_answer()]
        )
        response = replay.provider.complete(make_request())
        assert response.text == "finding: sample is small"
        assert len(replay.requests) == 2
        assert replay.sleeps == [1.0]

    def test_two_retryable_answers_then_success(self):
        replay = Replay(
            [
                httpx.Response(429, json={"error": "rate limited"}),
                httpx.Response(503, json={"error": "overloaded"}),
                chat_answer(),
            ]
        )
        response = replay.provider.complete(make_request())
        assert response.text == "finding: sample is small"
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]

    def test_429_outlasts_the_retries(self):
        replay = Replay(
            [httpx.Response(429, json={"error": "rate limited"})] * 3
        )
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "HTTP 429" in message
        assert "3 attempts" in message
        assert API_KEY not in message
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]

    def test_5xx_outlasts_the_retries(self):
        replay = Replay(
            [httpx.Response(503, json={"error": "overloaded"})] * 3
        )
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "HTTP 503" in message
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]

    def test_four_429s_still_make_only_three_requests(self):
        replay = Replay(
            [httpx.Response(429, json={"error": "rate limited"})] * 4
        )
        with pytest.raises(ProviderError):
            replay.provider.complete(make_request())
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]


class TestRetryAfter:
    def test_whole_seconds_are_waited_instead_of_the_backoff(self):
        replay = Replay(
            [
                httpx.Response(
                    429,
                    json={"error": "rate limited"},
                    headers={"Retry-After": "7"},
                ),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert replay.sleeps == [7.0]

    def test_retry_after_is_capped_at_30_seconds(self):
        replay = Replay(
            [
                httpx.Response(
                    429,
                    json={"error": "rate limited"},
                    headers={"Retry-After": "120"},
                ),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert replay.sleeps == [30.0]

    def test_zero_seconds_retry_after_waits_zero(self):
        replay = Replay(
            [
                httpx.Response(
                    429,
                    json={"error": "rate limited"},
                    headers={"Retry-After": "0"},
                ),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert replay.sleeps == [0.0]

    def test_http_date_retry_after_falls_back_to_the_backoff(self):
        replay = Replay(
            [
                httpx.Response(
                    429,
                    json={"error": "rate limited"},
                    headers={
                        "Retry-After": "Fri, 31 Dec 1999 23:59:59 GMT"
                    },
                ),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert replay.sleeps == [1.0]

    def test_fractional_retry_after_falls_back_to_the_backoff(self):
        replay = Replay(
            [
                httpx.Response(
                    429,
                    json={"error": "rate limited"},
                    headers={"Retry-After": "2.5"},
                ),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert replay.sleeps == [1.0]

    @pytest.mark.parametrize(
        "value", [b"\xb2", b"-5", b"", b"5 s", "0x10".encode()]
    )
    def test_retry_after_that_is_not_ascii_whole_seconds_falls_back(self, value):
        # b"\xb2" decodes to "²", which str.isdigit() accepts but int() rejects.
        replay = Replay(
            [
                httpx.Response(429, headers=[(b"Retry-After", value)]),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert len(replay.requests) == 2
        assert replay.sleeps == [1.0]

    def test_retry_after_then_a_backoff_wait(self):
        replay = Replay(
            [
                httpx.Response(
                    429,
                    json={"error": "rate limited"},
                    headers={"Retry-After": "7"},
                ),
                httpx.Response(503, json={"error": "overloaded"}),
                chat_answer(),
            ]
        )
        replay.provider.complete(make_request())
        assert replay.sleeps == [7.0, 2.0]


class TestTransportErrors:
    def test_timeout_then_success(self):
        replay = Replay([httpx.ConnectTimeout("connect timed out"), chat_answer()])
        response = replay.provider.complete(make_request())
        assert response.text == "finding: sample is small"
        assert len(replay.requests) == 2
        assert replay.sleeps == [1.0]

    def test_other_transport_error_then_success(self):
        replay = Replay(
            [
                httpx.ReadError("connection reset"),
                httpx.ConnectError("no route to host"),
                chat_answer(),
            ]
        )
        response = replay.provider.complete(make_request())
        assert response.text == "finding: sample is small"
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]

    def test_timeout_outlasts_the_retries_and_names_the_exception(self):
        replay = Replay([httpx.ReadTimeout("read timed out")] * 3)
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "ReadTimeout" in message
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]

    def test_transport_error_outlasts_the_retries_and_names_the_exception(self):
        replay = Replay([httpx.ConnectError("no route to host")] * 3)
        with pytest.raises(ProviderError) as excinfo:
            replay.provider.complete(make_request())
        message = str(excinfo.value)
        assert "openai" in message
        assert "ConnectError" in message
        assert "3 attempts" in message
        assert len(replay.requests) == 3
        assert replay.sleeps == [1.0, 2.0]
