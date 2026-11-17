"""The reproducibility agent: run the code bundle, then read the paper beside the log (feature 119).

``run_agent("reproducibility", ...)`` (feature 117) only reads the paper, plus
a run log if the caller has one.  This is the caller that gets the log: it
runs the version's code bundle in the docker sandbox
(:mod:`app.modules.ai_review.sandbox`) and hands the log to the agent::

    from app.modules import ai_review

    report = ai_review.run_reproducibility_agent(
        version_cid, bundle_cid, pdf_cid=pdf_cid, listed=True
    )
    report.findings      # the run's own finding, then the model's
    report.run.status    # "completed" | "failed" | "timeout" | "not_run"
    report.run_log       # what every log_line finding is checked against

Findings, in this order:

1. what the *sandbox* found, if the code did not complete: a ``not_run``
   finding (docker unavailable, no bundle, bad bundle, no entry point), a
   ``timeout`` or a non-zero exit.  These are made here, not by the model, and
   cite the sandbox's own last log line.  A clean run gives none.
2. what the *model* found: with ``log_line`` evidence copied from the run log
   when the code ran (for instance, a number the code printed that differs from
   the paper's), and ``span`` evidence from the paper otherwise.

When the code was not run the model is given no ``run_log`` block and is told
so, and any ``log_line`` finding it returns anyway is discarded (and listed in
``report.dropped``): there is no log to quote.  The result is still a report,
never an error: docker being absent, or a bundle being unrunnable, is a normal
state of the node or the paper, and the paper text is still worth reading.

The slow part, the sandbox, runs only after checks that cannot be done later:
the prompts exist, the provider is known, and an unlisted draft is not about to
be refused by a hosted provider.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Sequence
from typing import Optional

from .agents import DEFAULT_MAX_TOKENS, AgentReport, run_agent
from .findings import Finding
from .prompt_set import prompt_set_hash
from .providers import LLMProvider, get_provider
from .sandbox import Runner, SandboxLimits, run_bundle

__all__ = ["run_reproducibility_agent"]


def run_reproducibility_agent(
    version_cid: str,
    bundle_cid: Optional[str] = None,
    *,
    provider: Optional[LLMProvider] = None,
    pdf_cid: Optional[str] = None,
    listed: bool = False,
    limits: Optional[SandboxLimits] = None,
    image: Optional[str] = None,
    command: Optional[Sequence[str]] = None,
    docker_bin: str = "docker",
    podman_bin: str = "podman",
    runner: Optional[Runner] = None,
    backend: Optional[str] = None,
    sandbox_url: Optional[str] = None,
    sandbox_token: Optional[str] = None,
    http_client: Optional[object] = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> AgentReport:
    """Run the code bundle in the sandbox, then the reproducibility agent over paper and log.

    Args:
        version_cid: the version whose saved text the agent reads.
        bundle_cid: the version's code bundle in the content store, or ``None``
            if it has none (a ``no_bundle`` ``not_run`` finding).
        provider: the LLM provider; defaults to the one ``AI_PROVIDER`` selects.
        pdf_cid: the manuscript PDF, for the sanitizer's hidden-text findings.
        listed: whether the draft is listed, as for
            :func:`~app.modules.ai_review.run_agent`.
        limits, image, command, docker_bin, podman_bin, runner, backend,
        sandbox_url, sandbox_token, http_client: how and where the sandbox
        runs; see :func:`~app.modules.ai_review.sandbox.run_bundle`.
        max_tokens: the provider's response budget.

    Returns:
        An :class:`~app.modules.ai_review.AgentReport` whose ``run`` is the
        :class:`~app.modules.ai_review.sandbox.SandboxRun`.

    Raises:
        PromptSetError, ValueError (unknown provider, bad image or command),
        PrivateDraftError: before the code is run.
        AgentOutputError: if the model's reply holds no findings list.  The
            code has run by then; the failure is in the reply, not the run.
    """
    # Fail before the slow, expensive part, not after it.
    prompt_set_hash()
    provider = provider or get_provider()
    provider.check_listed(listed)

    run = run_bundle(
        bundle_cid,
        limits=limits,
        image=image,
        command=command,
        docker_bin=docker_bin,
        podman_bin=podman_bin,
        runner=runner,
        backend=backend,
        sandbox_url=sandbox_url,
        sandbox_token=sandbox_token,
        http_client=http_client,
    )
    report = run_agent(
        "reproducibility",
        version_cid,
        provider=provider,
        pdf_cid=pdf_cid,
        listed=listed,
        run_log=run.log if run.ran else None,
        max_tokens=max_tokens,
    )

    model_findings: tuple[Finding, ...] = report.findings
    dropped = list(report.dropped)
    if not run.ran:
        kept = []
        for finding in model_findings:
            if finding.evidence.kind == "log_line":
                dropped.append(
                    "finding discarded: it cites a log line but the code bundle was "
                    f"not run ({finding.claim[:80]})"
                )
            else:
                kept.append(finding)
        model_findings = tuple(kept)

    return dataclasses.replace(
        report,
        findings=run.findings() + model_findings,
        dropped=tuple(dropped),
        run=run,
    )
