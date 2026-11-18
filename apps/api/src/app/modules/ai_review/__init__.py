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

Feature 119 runs the paper's code bundle for the reproducibility agent, in a
docker sandbox with ``--network none``, a read-only root, CPU and memory
limits and a 10-minute time limit.  The run's log goes to the agent as the
``run_log`` block and its lines are the ``log_line`` evidence; when docker (or
anything else the run needs) is unavailable the report carries a ``not_run``
finding instead, never an error::

    report = ai_review.run_reproducibility_agent(version_cid, bundle_cid, listed=True)
    report.run.status      # "completed" | "failed" | "timeout" | "not_run"
    report.run_log         # the log every log_line finding is checked against

Feature 118 verifies that evidence before a finding is shown: a span must be
a verbatim substring of the paper, a ``reference_id`` must name a reference
block the agent was given, and a ``log_line`` must be exactly one line of the
run log.  Anything else is rejected with a reason::

    result = ai_review.verify_findings(
        report.findings, version_cid, run_log=report.run_log
    )
    result.findings, result.rejected

Feature 120 is the meta-reviewer: it builds the final findings list from the
specialists' reports, merging findings that make the same point on the same
evidence, flagging findings the agents rated differently, and guaranteeing
the report's wording.  An integrity finding always ends with "Needs a human
check.", and no final claim states fraud, plagiarism, fabrication,
falsification, misconduct or cheating; such a claim becomes a neutral
sentence pointing at the evidence::

    final = ai_review.meta_review(reports)
    final.findings        # most severe first, duplicates merged
    final.merged          # notes on merged duplicates
    final.disagreements   # notes on flagged disagreement

See :mod:`app.modules.ai_review.prompt_set` for how the hash is defined,
:mod:`app.modules.ai_review.findings` for the finding shape,
:mod:`app.modules.ai_review.agents` for running an agent,
:mod:`app.modules.ai_review.verification` for the evidence verifier,
:mod:`app.modules.ai_review.meta_review` for the final findings list,
and :mod:`app.modules.ai_review.sandbox` for the sandbox.
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
    BundleError,
    PrivateDraftError,
    ProviderError,
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
from .meta_review import (
    DUPLICATE_SIMILARITY,
    HUMAN_CHECK,
    NEUTRAL_CLAIM,
    MetaReviewResult,
    finalize_findings,
    meta_review,
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
    OpenAIProvider,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    OllamaProvider,
    get_provider,
)
from .reproducibility import run_reproducibility_agent
from .router import ADVISORY_LABEL, router
from .models import (
    AIReview,
    AIReviewRebuttal,
    AIReviewAssessment,
    ensure_ai_reviews_table,
    ensure_ai_review_rebuttals_table,
    ensure_ai_review_assessments_table,
)
from .background import (
    JOB_KIND,
    JOB_KINDS,
    run_ai_review,
    run_ai_review_job,
    run_pipeline,
    run_review,
    review_version,
)
from .sandbox import (
    NOT_RUN_REASONS,
    SandboxLimits,
    SandboxRun,
    run_bundle,
)
from .verification import (
    EvidenceVerifier,
    VerificationResult,
    verify_findings,
)

__all__ = [
    "ADVISORY_LABEL",
    "AGENT_NAMES",
    "AgentOutputError",
    "AgentReport",
    "AnthropicProvider",
    "BundleError",
    "CONFIDENCES",
    "DEFAULT_INSTRUCTIONS",
    "DUPLICATE_SIMILARITY",
    "DataBlock",
    "EVIDENCE_KINDS",
    "Evidence",
    "EvidenceVerifier",
    "FakeProvider",
    "Finding",
    "HIDDEN_TEXT_BLOCK_PREFIX",
    "HUMAN_CHECK",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "MetaReviewResult",
    "NEUTRAL_CLAIM",
    "NOT_RUN_REASONS",
    "OllamaProvider",
    "OpenAIProvider",
    "PROMPTS_DIR",
    "PrivateDraftError",
    "PromptSetError",
    "ProviderError",
    "REFERENCE_BLOCK_PREFIX",
    "RUN_LOG_BLOCK_ID",
    "SEVERITIES",
    "SandboxLimits",
    "SandboxRun",
    "UnknownAgentError",
    "VerificationResult",
    "build_agent_input",
    "build_data_blocks",
    "finalize_findings",
    "get_provider",
    "hidden_text_blocks",
    "load_prompt",
    "load_prompts",
    "meta_review",
    "paragraph_blocks",
    "parse_findings",
    "prompt_files",
    "prompt_set_hash",
    "reference_blocks",
    "run_agent",
    "run_bundle",
    "run_reproducibility_agent",
    "AIReview",
    "ensure_ai_reviews_table",
    "JOB_KIND",
    "JOB_KINDS",
    "run_ai_review",
    "run_ai_review_job",
    "run_pipeline",
    "run_review",
    "review_version",
    "router",
    "verify_findings",
]
