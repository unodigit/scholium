"""Running one specialist agent and getting its findings (feature 117).

An agent is a prompt from ``prompts/*.md`` plus a provider.  The prompt is the
request's instructions; the paper travels only as quoted data blocks, so a
paragraph that says "ignore previous instructions" stays data::

    from app.modules import ai_review

    report = ai_review.run_agent("methodology", version_cid, pdf_cid=pdf_cid)
    report.findings          # (Finding(claim, severity, confidence, evidence), ...)
    report.dropped           # reasons for replies' malformed findings
    report.prompt_set_hash   # hash of the prompts that produced it
    report.model             # model the provider reported

What each agent is given besides the paragraphs and the sanitizer's
``hidden_text`` findings:

``literature``
    the paper's reference list, one ``ref:<n>`` block per entry, so it can
    cite a ``reference_id``;
``reproducibility``
    the sandbox ``run_log`` block, when ``run_log`` is passed, so it can cite a
    ``log_line``.  Without a run log the code was not run, and the agent is
    told it may report only what the paper text shows.

The findings are well-formed, not verified: a span may still be invented and a
reference id unknown.  The evidence verifier (feature 118) checks them against
the paper.  Nothing here writes a record or a paper status; an agent returns
findings and that is all.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Optional

from .agent_input import RUN_LOG_BLOCK_ID, build_agent_input, reference_blocks
from .findings import Finding, parse_findings
from .prompt_set import load_prompt, prompt_set_hash
from .providers import LLMProvider, get_provider
from .providers.base import DataBlock

__all__ = ["AgentReport", "run_agent"]

#: Response budget for an agent: ten findings with quotations need more room
#: than the generic request default.
DEFAULT_MAX_TOKENS = 4096


@dataclass(frozen=True)
class AgentReport:
    """What one agent returned for one version."""

    #: The agent's name, one of ``AGENT_NAMES``.
    agent: str
    #: The well-formed findings, in the agent's order.
    findings: tuple[Finding, ...]
    #: One reason per malformed finding that was discarded.
    dropped: tuple[str, ...]
    #: Provider and model that answered, as the provider reported them.
    provider: str
    model: str
    #: Hash of the prompt set in force when the agent ran.
    prompt_set_hash: str


def run_agent(
    agent: str,
    version_cid: str,
    *,
    provider: Optional[LLMProvider] = None,
    pdf_cid: Optional[str] = None,
    listed: bool = False,
    run_log: Optional[str] = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> AgentReport:
    """Run the specialist ``agent`` on ``version_cid`` and parse its findings.

    Args:
        agent: one of :data:`~app.modules.ai_review.prompt_set.AGENT_NAMES`.
        version_cid: the version whose saved text the agent reads.
        provider: the LLM provider; defaults to the one ``AI_PROVIDER`` selects.
        pdf_cid: the manuscript PDF, for the sanitizer's hidden-text findings.
        listed: whether the draft is listed.  Defaults to ``False`` so a hosted
            provider refuses it, as with
            :func:`~app.modules.ai_review.agent_input.build_agent_input`.
        run_log: the sandbox run log; only the reproducibility agent takes it.
        max_tokens: the provider's response budget.

    Raises:
        UnknownAgentError: if ``agent`` is not a specialist agent.
        ValueError: if ``run_log`` is given to an agent other than
            reproducibility.
        PromptSetError: if a prompt file is missing or empty.
        PrivateDraftError: if a hosted provider is given an unlisted draft.
        AgentOutputError: if the reply holds no JSON ``findings`` list.
    """
    # Both checks come before any paper data is read.
    instructions = load_prompt(agent)
    if run_log is not None and agent != "reproducibility":
        raise ValueError(
            f"run_log is only used by the reproducibility agent, not '{agent}'"
        )
    set_hash = prompt_set_hash()

    request = build_agent_input(
        version_cid,
        instructions,
        pdf_cid=pdf_cid,
        listed=listed,
        max_tokens=max_tokens,
    )
    extra: tuple[DataBlock, ...] = ()
    if agent == "literature":
        extra = reference_blocks(version_cid)
    elif agent == "reproducibility" and run_log is not None:
        extra = (DataBlock(id=RUN_LOG_BLOCK_ID, content=run_log),)
    if extra:
        request = dataclasses.replace(
            request, data_blocks=request.data_blocks + extra
        )

    response = (provider or get_provider()).complete(request)
    findings, dropped = parse_findings(agent, response.text)
    return AgentReport(
        agent=agent,
        findings=findings,
        dropped=dropped,
        provider=response.provider,
        model=response.model,
        prompt_set_hash=set_hash,
    )
