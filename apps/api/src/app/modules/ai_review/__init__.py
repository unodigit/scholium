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

Feature 117 puts each specialist agent's prompt (methodology, literature,
reproducibility, integrity) in ``prompts/*.md``.  An agent answers with
findings, each with a claim, severity, confidence and evidence (a quoted
``span``, a ``reference_id`` or a ``log_line``), and the sha256 of the
prompt set is exposed as :func:`prompt_set_hash` for the signed record::

    report = ai_review.run_agent("methodology", version_cid, pdf_cid=pdf_cid)
    report.findings, report.prompt_set_hash
    ai_review.prompt_set_hash()

See :mod:`app.modules.ai_review.prompt_set` for how the hash is defined,
:mod:`app.modules.ai_review.findings` for the finding shape and
:mod:`app.modules.ai_review.agents` for running an agent.
"""

from .agent_input import (
    DEFAULT_INSTRUCTIONS,
    HIDDEN_TEXT_BLOCK_PREFIX,
    REFERENCE_BLOCK_PREFIX,
    RUN_LOG_BLOCK_ID,
    build_agent_input,
    build_data_blocks,
    hidden_text_blocks,
    paragraph_blocks,
    reference_blocks,
)
from .agents import AgentReport, run_agent
from .errors import (
    AgentOutputError,
    PrivateDraftError,
    PromptSetError,
    UnknownAgentError,
)
from .findings import (
    CONFIDENCES,
    EVIDENCE_KINDS,
    SEVERITIES,
    Evidence,
    Finding,
    parse_findings,
)
from .prompt_set import (
    AGENT_NAMES,
    PROMPTS_DIR,
    load_prompt,
    load_prompts,
    prompt_files,
    prompt_set_hash,
)
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
    "AGENT_NAMES",
    "AgentOutputError",
    "AgentReport",
    "AnthropicProvider",
    "CONFIDENCES",
    "DEFAULT_INSTRUCTIONS",
    "DataBlock",
    "EVIDENCE_KINDS",
    "Evidence",
    "FakeProvider",
    "Finding",
    "HIDDEN_TEXT_BLOCK_PREFIX",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "OllamaProvider",
    "PROMPTS_DIR",
    "PrivateDraftError",
    "PromptSetError",
    "REFERENCE_BLOCK_PREFIX",
    "RUN_LOG_BLOCK_ID",
    "SEVERITIES",
    "UnknownAgentError",
    "build_agent_input",
    "build_data_blocks",
    "get_provider",
    "hidden_text_blocks",
    "load_prompt",
    "load_prompts",
    "paragraph_blocks",
    "parse_findings",
    "prompt_files",
    "prompt_set_hash",
    "reference_blocks",
    "run_agent",
]
