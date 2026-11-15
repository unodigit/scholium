"""Advisory AI pre-review module (plugin: ai_review).

Defines the LLM provider interface with a deterministic fake provider, a
hosted Anthropic provider (``AI_HOSTED_MODEL``, default
``claude-sonnet-5-5``) and a self-hosted Ollama provider.  Hosted
providers refuse to process unlisted drafts, raising
:class:`PrivateDraftError` before any content leaves the node.

Feature 116 assembles the input an agent receives: the sanitized version's
paragraphs as quoted :class:`DataBlock` items keyed by their stable
paragraph ids, plus the sanitizer's ``hidden_text`` findings, all kept out
of the instructions::

    request = ai_review.build_agent_input(version_cid, pdf_cid=pdf_cid)
    response = ai_review.get_provider().complete(request)
"""

from .agent_input import (
    DEFAULT_INSTRUCTIONS,
    HIDDEN_TEXT_BLOCK_PREFIX,
    build_agent_input,
    build_data_blocks,
    hidden_text_blocks,
    paragraph_blocks,
)
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
    "DEFAULT_INSTRUCTIONS",
    "DataBlock",
    "FakeProvider",
    "HIDDEN_TEXT_BLOCK_PREFIX",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "OllamaProvider",
    "PrivateDraftError",
    "build_agent_input",
    "build_data_blocks",
    "get_provider",
    "hidden_text_blocks",
    "paragraph_blocks",
]
