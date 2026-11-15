"""Deterministic fake provider used by tests and local development."""

from __future__ import annotations

import hashlib
import json

from .base import LLMProvider, LLMRequest, LLMResponse


class FakeProvider(LLMProvider):
    """Offline provider with fully deterministic output.

    The response text is derived from a sha256 digest of the canonical
    request payload — no clock, randomness or network — so the same request
    always yields the same response, and any change to instructions, data
    blocks or listing state changes the digest.
    """

    name = "fake"
    hosted = False

    def __init__(self, model: str = "fake-deterministic-v1") -> None:
        self.model = model

    @staticmethod
    def request_digest(request: LLMRequest) -> str:
        """A stable digest of the request content, for reproducible output."""
        payload = json.dumps(
            {
                "instructions": request.instructions,
                "data_blocks": [
                    [block.id, block.content] for block in request.data_blocks
                ],
                "listed": request.listed,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _complete(self, request: LLMRequest) -> LLMResponse:
        digest = self.request_digest(request)
        block_ids = ", ".join(block.id for block in request.data_blocks) or "none"
        lines = [
            "fake provider deterministic response",
            f"model: {self.model}",
            f"request_sha256: {digest}",
            f"data_blocks: {block_ids}",
        ]
        return LLMResponse(text="\n".join(lines), provider=self.name, model=self.model)
