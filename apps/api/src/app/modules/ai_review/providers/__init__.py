"""Pluggable LLM providers for the AI pre-review subsystem.

Available providers: ``fake`` (deterministic, tests), ``anthropic``
(hosted, listed papers only) and ``ollama`` (self-hosted).  Selection is
driven by the ``AI_PROVIDER`` setting, overridable per call via
:func:`get_provider`.
"""

from __future__ import annotations

from .anthropic_provider import AnthropicProvider
from .base import DataBlock, LLMProvider, LLMRequest, LLMResponse
from .fake import FakeProvider
from .ollama_provider import OllamaProvider

_PROVIDER_CLASSES: dict[str, type[LLMProvider]] = {
    FakeProvider.name: FakeProvider,
    AnthropicProvider.name: AnthropicProvider,
    OllamaProvider.name: OllamaProvider,
}


def get_provider(name: str | None = None) -> LLMProvider:
    """Return the provider selected by ``AI_PROVIDER`` (or ``name``).

    Raises ``ValueError`` for unknown provider names.
    """
    from app.settings import settings

    key = (name or settings.AI_PROVIDER or "fake").strip().lower()
    try:
        provider_cls = _PROVIDER_CLASSES[key]
    except KeyError:
        expected = ", ".join(sorted(_PROVIDER_CLASSES))
        raise ValueError(
            f"Unknown AI provider '{key}'; expected one of: {expected}"
        ) from None
    return provider_cls()


__all__ = [
    "AnthropicProvider",
    "DataBlock",
    "FakeProvider",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "OllamaProvider",
    "get_provider",
]
