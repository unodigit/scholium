"""Advisory AI pre-review module (plugin: ai_review).

Defines the LLM provider interface with a deterministic fake provider, a
hosted Anthropic provider (``AI_HOSTED_MODEL``, default
``claude-sonnet-5-5``) and a self-hosted Ollama provider.  Hosted
providers refuse to process unlisted drafts, raising
:class:`PrivateDraftError` before any content leaves the node.
"""

from .errors import PrivateDraftError
from .providers import (
    AnthropicProvider,
    DataBlock,
    FakeProvider,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    OllamaProvider,
    get_provider,
)

__all__ = [
    "AnthropicProvider",
    "DataBlock",
    "FakeProvider",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "OllamaProvider",
    "PrivateDraftError",
    "get_provider",
]
