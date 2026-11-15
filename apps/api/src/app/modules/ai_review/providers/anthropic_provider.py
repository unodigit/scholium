"""Hosted Anthropic provider (listed, public papers only)."""

from __future__ import annotations

from typing import Any

import anthropic

from app.settings import settings

from .base import LLMProvider, LLMRequest, LLMResponse


class AnthropicProvider(LLMProvider):
    """Calls the Anthropic Messages API with ``AI_HOSTED_MODEL``.

    Hosted: paper content leaves the node, so the base class rejects any
    request whose draft is not listed with ``PrivateDraftError`` before the
    SDK client is ever constructed.

    ``client`` may be injected for tests; otherwise an ``anthropic.Anthropic``
    client is created lazily from ``ANTHROPIC_API_KEY``.
    """

    name = "anthropic"
    hosted = True

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.model = model or settings.AI_HOSTED_MODEL
        self._api_key = api_key
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            key = self._api_key if self._api_key is not None else ""
            self._client = anthropic.Anthropic(api_key=key or None)
        return self._client

    def _complete(self, request: LLMRequest) -> LLMResponse:
        message = self._get_client().messages.create(
            model=self.model,
            max_tokens=request.max_tokens,
            system=request.instructions,
            messages=[
                {
                    "role": "user",
                    # Quoted data travels as its own content blocks, separate
                    # from the system instructions.
                    "content": [
                        {"type": "text", "text": f'<data id="{block.id}">\n{block.content}\n</data>'}
                        for block in request.data_blocks
                    ]
                    or [{"type": "text", "text": "(no data blocks)"}],
                }
            ],
        )
        text = "".join(
            part.text
            for part in message.content
            if getattr(part, "type", None) == "text"
        )
        return LLMResponse(
            text=text,
            provider=self.name,
            model=getattr(message, "model", None) or self.model,
        )
