"""Self-hosted Ollama provider (safe for unlisted drafts)."""

from __future__ import annotations

import os
from typing import Any

import httpx

from app.settings import settings

from .base import LLMProvider, LLMRequest, LLMResponse


class OllamaProvider(LLMProvider):
    """Calls a self-hosted Ollama server's ``/api/chat`` at ``OLLAMA_URL``.

    Self-hosted: content never leaves the operator's machine, so unlisted
    drafts may be processed.  The model defaults to the ``OLLAMA_MODEL``
    environment variable (``llama3.1`` if unset).  ``client`` may be
    injected for tests; otherwise an ``httpx.Client`` is created lazily.
    """

    name = "ollama"
    hosted = False

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.model = model or os.getenv("OLLAMA_MODEL", "llama3.1")
        self.base_url = (base_url or settings.OLLAMA_URL).rstrip("/")
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = httpx.Client(timeout=120.0)
        return self._client

    def _complete(self, request: LLMRequest) -> LLMResponse:
        quoted = "\n\n".join(
            f'<data id="{block.id}">\n{block.content}\n</data>'
            for block in request.data_blocks
        ) or "(no data blocks)"
        payload = {
            "model": self.model,
            "stream": False,
            "options": {"temperature": 0},
            # Instructions and quoted data travel in separate messages.
            "messages": [
                {"role": "system", "content": request.instructions},
                {"role": "user", "content": quoted},
            ],
        }
        response = self._get_client().post(f"{self.base_url}/api/chat", json=payload)
        response.raise_for_status()
        data = response.json()
        message = data.get("message") or {}
        return LLMResponse(
            text=message.get("content", ""),
            provider=self.name,
            model=data.get("model") or self.model,
        )
