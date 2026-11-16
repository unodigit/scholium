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
        findings = []
        for block in request.data_blocks:
            if block.id.startswith("ref:"):
                findings.append(
                    {
                        "claim": "A cited reference may not support the claim made in the paper.",
                        "severity": "minor",
                        "confidence": "medium",
                        "evidence": {"reference_id": block.id},
                    }
                )
            elif block.id == "run_log":
                lines = [line for line in block.content.splitlines() if line.strip()]
                log_line = lines[0] if lines else block.content
                findings.append(
                    {
                        "claim": "The code bundle output does not match the paper reported results.",
                        "severity": "minor",
                        "confidence": "medium",
                        "evidence": {"log_line": log_line},
                    }
                )
            else:
                findings.append(
                    {
                        "claim": "The quoted passage may need closer review.",
                        "severity": "info",
                        "confidence": "medium",
                        "evidence": {"span": block.content, "paragraph_id": block.id},
                    }
                )
        lines = [
            "fake provider deterministic response",
            f"model: {self.model}",
            f"request_sha256: {digest}",
            f"data_blocks: {block_ids}",
        ]
        text = "\n".join(lines) + "\n" + json.dumps({"findings": findings})
        return LLMResponse(text=text, provider=self.name, model=self.model)
