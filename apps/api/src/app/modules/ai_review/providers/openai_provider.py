"""Hosted OpenAI-compatible provider (listed, public papers only).

``openai`` names the chat-completions protocol, not a vendor: any server
that speaks the OpenAI ``/chat/completions`` wire format is reached by
pointing ``OPENAI_BASE_URL`` at it.  The model comes from
``AI_HOSTED_MODEL`` (which must be set for this provider in production,
because its default is an Anthropic model id).
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.settings import settings

from ..errors import ProviderError
from .base import LLMProvider, LLMRequest, LLMResponse

#: Total requests per completion, including the first one.
_MAX_ATTEMPTS = 3
#: Exponential backoff before the second request; doubles from there.
_INITIAL_BACKOFF = 1.0
#: Upper bound for a server-provided ``Retry-After`` wait.
_MAX_RETRY_AFTER = 30.0
#: Read/write/connect/pool timeout of the lazily built httpx client.
_REQUEST_TIMEOUT = 120.0


class OpenAIProvider(LLMProvider):
    """POSTs to ``OPENAI_BASE_URL`` + ``/chat/completions`` with Bearer auth.

    Hosted: paper content leaves the node, so the base class rejects any
    request whose draft is not listed with ``PrivateDraftError`` before a
    client is ever built or a request is ever sent.

    Retryable failures — a 429 or 5xx answer, an ``httpx.TimeoutException``
    or any other ``httpx.TransportError`` — are retried at most twice more
    (three requests in total) with exponential backoff starting at one
    second, or the server's ``Retry-After`` seconds when the header holds a
    whole number of them (capped at 30).  Anything else fails fast with
    :class:`~app.modules.ai_review.errors.ProviderError`, as does an answer
    that cannot become a complete review (no ``choices``, null or empty
    content, or ``finish_reason`` ``length``).
    """

    name = "openai"
    hosted = True

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        client: Any | None = None,
        sleep: Any | None = None,
    ) -> None:
        self.model = model or settings.AI_HOSTED_MODEL
        self.base_url = (base_url or settings.OPENAI_BASE_URL).rstrip("/")
        self._api_key = api_key if api_key is not None else settings.OPENAI_API_KEY
        self._client = client
        self._sleep = sleep if sleep is not None else time.sleep

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = httpx.Client(timeout=_REQUEST_TIMEOUT)
        return self._client

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    @staticmethod
    def _retry_after(response: httpx.Response) -> float | None:
        """The ``Retry-After`` wait, or None when it is not whole seconds.

        Only a whole number of seconds counts; any other form (an HTTP-date,
        a fraction, a missing header) falls back to the exponential backoff.
        ASCII digits only: ``str.isdigit`` also accepts characters such as
        ``"²"`` that ``int`` cannot parse.
        """
        value = (response.headers.get("Retry-After") or "").strip()
        if value.isascii() and value.isdigit():
            return min(float(int(value)), _MAX_RETRY_AFTER)
        return None

    def _complete(self, request: LLMRequest) -> LLMResponse:
        # Data blocks are quoted exactly as the Ollama provider quotes them,
        # in a user message kept separate from the system instructions.
        quoted = "\n\n".join(
            f'<data id="{block.id}">\n{block.content}\n</data>'
            for block in request.data_blocks
        ) or "(no data blocks)"
        payload = {
            "model": self.model,
            "max_tokens": request.max_tokens,
            "temperature": 0,
            "stream": False,
            "messages": [
                {"role": "system", "content": request.instructions},
                {"role": "user", "content": quoted},
            ],
        }
        url = f"{self.base_url}/chat/completions"
        delay = _INITIAL_BACKOFF
        attempts = 0
        while True:
            attempts += 1
            try:
                response = self._get_client().post(
                    url, json=payload, headers=self._headers()
                )
            except httpx.TransportError as exc:
                # httpx.TimeoutException is a TransportError subclass, so
                # this covers timeouts and every other transport failure.
                if attempts >= _MAX_ATTEMPTS:
                    raise ProviderError(
                        f"{self.name} provider: {type(exc).__name__} from POST {url} "
                        f"after {attempts} attempts"
                    ) from exc
                self._sleep(delay)
                delay *= 2
                continue
            status = response.status_code
            if 200 <= status < 300:
                return self._parse_response(response)
            if status != 429 and status < 500:
                # Other 4xx (and any 3xx) are never retried.
                raise ProviderError(
                    f"{self.name} provider: HTTP {status} from POST {url}"
                )
            if attempts >= _MAX_ATTEMPTS:
                raise ProviderError(
                    f"{self.name} provider: HTTP {status} from POST {url} "
                    f"after {attempts} attempts"
                )
            wait = self._retry_after(response)
            self._sleep(wait if wait is not None else delay)
            delay *= 2

    def _parse_response(self, response: httpx.Response) -> LLMResponse:
        """Turn a 2xx chat-completions answer into an LLMResponse.

        Raises ProviderError, naming the reason, for any answer that must
        not become a partial review.
        """
        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderError(
                f"{self.name} provider: answer is not JSON ({type(exc).__name__})"
            ) from exc
        if not isinstance(data, dict):
            raise ProviderError(
                f"{self.name} provider: answer is not a JSON object"
            )
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ProviderError(f"{self.name} provider: answer has no choices")
        choice = choices[0]
        if not isinstance(choice, dict):
            raise ProviderError(
                f"{self.name} provider: answer's first choice is not an object"
            )
        if choice.get("finish_reason") == "length":
            raise ProviderError(
                f"{self.name} provider: answer was truncated "
                "(finish_reason is 'length'); raise max_tokens"
            )
        message = choice.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        # reasoning_content, when a server sends it, is deliberately ignored.
        if not content:
            raise ProviderError(
                f"{self.name} provider: answer message content is null or empty"
            )
        if not isinstance(content, str):
            raise ProviderError(
                f"{self.name} provider: answer message content is not text"
            )
        model = data.get("model")
        return LLMResponse(
            text=content,
            provider=self.name,
            model=model if isinstance(model, str) and model else self.model,
        )
