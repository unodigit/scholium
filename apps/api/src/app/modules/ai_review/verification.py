"""Verifying a finding's evidence against the paper, its references and a run log (feature 118).

Feature 117 parses an agent's reply into well-formed findings, but a
well-formed claim is not a supported one: the model may have invented a
quotation, named a reference it was never given, or cited a log line that the
code never printed.  This module is the evidence verifier.  It keeps a finding
only when its one piece of evidence is real::

    from app.modules import ai_review

    result = ai_review.verify_findings(
        report.findings, version_cid, run_log=report.run_log
    )
    result.findings   # the findings that may be shown, in order
    result.rejected   # one reason per discarded finding, in order

What each kind of evidence must match
    ``span``
        a substring, character for character, of one of the version's saved
        paragraphs.  When the finding also names ``paragraph_id``, that id must
        be a block the agent was given and the span must occur in *that*
        block, so the evidence link points at the words it quotes.  A
        quotation spanning two paragraphs, or one with a changed case, a
        paraphrase, or different whitespace, is not verbatim and is rejected.
        With ``pdf_cid`` the sanitizer's ``hidden_text`` blocks are part of the
        input too, and a span may be quoted from one of them.
    ``reference_id``
        one of the ``ref:<n>`` ids built from the version's reference list
        (see :func:`~app.modules.ai_review.agent_input.reference_blocks`).
        Anything else, including an index past the end of the list, is
        unknown.
    ``log_line``
        exactly one line of ``run_log`` (the string in
        :attr:`~app.modules.ai_review.AgentReport.run_log`).  A substring of a
        line is not a line; with no run log, every ``log_line`` finding is
        rejected.

The paper text is read with :func:`app.modules.checks.get_version_text`, the
same paragraphs feature 116 handed the agent, so verification and generation
look at one corpus.  Verification does not mutate findings and does not raise
for bad evidence: a rejected finding is data, returned beside the reason, just
as a malformed finding is in
:func:`~app.modules.ai_review.findings.parse_findings`.  This module never
writes a record or a status; it only decides what a caller may keep.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import NamedTuple, Optional

from .agent_input import hidden_text_blocks, reference_blocks
from .findings import Finding

__all__ = [
    "EvidenceVerifier",
    "VerificationResult",
    "verify_findings",
]

#: Why a span was discarded when its quoted words are not in the corpus.
SPAN_REJECTED = "evidence span is not found verbatim in the paper text"

#: Why a span was discarded when its ``paragraph_id`` names no block.
PARAGRAPH_ID_REJECTED = "paragraph_id is unknown for this version"

#: Why a ``reference_id`` was discarded.
REFERENCE_ID_REJECTED = "reference_id is unknown for this version"

#: Why a ``log_line`` was discarded.
LOG_LINE_REJECTED = "log_line is absent from the run log"


class VerificationResult(NamedTuple):
    """The findings whose evidence was verified, and why the others were not.

    Unpacks as ``(findings, rejected)`` like
    :func:`~app.modules.ai_review.findings.parse_findings`, and also exposes
    the fields by name.
    """

    #: Findings kept, in their original order.
    findings: tuple[Finding, ...]
    #: One reason per rejected finding, numbering the finding from 1 in the
    #: input order (``"finding 2: ..."``).
    rejected: tuple[str, ...]

    @property
    def verified(self) -> tuple[Finding, ...]:
        """Alias for :attr:`findings`."""
        return self.findings

    @property
    def dropped(self) -> tuple[str, ...]:
        """Alias for :attr:`rejected`, matching ``AgentReport.dropped``."""
        return self.rejected


class EvidenceVerifier:
    """Checks findings' evidence against one version's corpus and run log.

    Build it once per report, then check every finding against it::

        verifier = ai_review.EvidenceVerifier(version_cid, run_log=run)
        verifier.rejection_reason(finding)   # None when the evidence is real

    Args:
        version_cid: the version whose saved paragraphs and references the
            agent was given.
        run_log: the sandbox run log, or ``None`` when no code was run.
        pdf_cid: the version's manuscript PDF, when the agent was also given
            the sanitizer's ``hidden_text`` blocks; those blocks become part of
            the corpus a span may quote.
    """

    def __init__(
        self,
        version_cid: str,
        *,
        run_log: Optional[str] = None,
        pdf_cid: Optional[str] = None,
    ) -> None:
        from app.modules import checks

        # Pairs, not a dict: two paragraphs can share an id (the id is the hash
        # of the normalized text) while their stored forms differ; a span from
        # either is still verbatim in the paper.
        blocks: list[tuple[str, str]] = [
            (paragraph.paragraph_id, paragraph.text)
            for paragraph in checks.get_version_text(version_cid)
        ]
        if pdf_cid:
            blocks.extend(
                (block.id, block.content) for block in hidden_text_blocks(pdf_cid)
            )
        self.blocks: tuple[tuple[str, str], ...] = tuple(blocks)
        self.block_ids: frozenset[str] = frozenset(
            block_id for block_id, _ in self.blocks
        )
        self.reference_ids: frozenset[str] = frozenset(
            block.id for block in reference_blocks(version_cid)
        )
        # An empty log has no lines to cite.  split("\n") keeps a line exactly
        # as the sandbox produced it (see SandboxRun.log).
        self.run_log_lines: frozenset[str] = (
            frozenset(run_log.split("\n")) if run_log else frozenset()
        )

    def _span_found(self, span: str, paragraph_id: Optional[str]) -> bool:
        if paragraph_id is None:
            return any(span in text for _, text in self.blocks)
        return any(
            span in text for block_id, text in self.blocks if block_id == paragraph_id
        )

    def rejection_reason(self, finding: Finding) -> Optional[str]:
        """Why ``finding``'s evidence does not hold, or ``None`` when it does."""
        evidence = finding.evidence
        kind = evidence.kind
        if kind == "span":
            if self._span_found(evidence.span, evidence.paragraph_id):
                return None
            if (
                evidence.paragraph_id is not None
                and evidence.paragraph_id not in self.block_ids
            ):
                return f"{PARAGRAPH_ID_REJECTED}: {evidence.paragraph_id!r}"
            return SPAN_REJECTED
        if kind == "reference_id":
            if evidence.reference_id in self.reference_ids:
                return None
            return f"{REFERENCE_ID_REJECTED}: {evidence.reference_id!r}"
        if kind == "log_line":
            if evidence.log_line in self.run_log_lines:
                return None
            return LOG_LINE_REJECTED
        # Evidence guarantees one known kind, so this is only reachable through
        # a hand-built object; reject it rather than trust it.
        return f"unknown evidence kind '{kind}'"

    def accepts(self, finding: Finding) -> bool:
        """Whether ``finding``'s evidence was found."""
        return self.rejection_reason(finding) is None

    def verify(self, findings: Iterable[Finding]) -> VerificationResult:
        """Verify every finding, keeping the supported ones and explaining the rest."""
        kept: list[Finding] = []
        rejected: list[str] = []
        for number, finding in enumerate(findings, start=1):
            if not isinstance(finding, Finding):
                raise TypeError(
                    "findings must be Finding objects, got "
                    f"{type(finding).__name__}"
                )
            reason = self.rejection_reason(finding)
            if reason is None:
                kept.append(finding)
            else:
                rejected.append(f"finding {number}: {reason}")
        return VerificationResult(tuple(kept), tuple(rejected))


def verify_findings(
    findings: Iterable[Finding],
    version_cid: str,
    *,
    run_log: Optional[str] = None,
    pdf_cid: Optional[str] = None,
) -> VerificationResult:
    """Reject every finding whose evidence is not in the paper, refs or run log.

    Args:
        findings: the well-formed findings an agent returned.
        version_cid: the version the agent read; its saved paragraphs and
            reference list are the corpus.
        run_log: the sandbox run log for ``log_line`` evidence, or ``None``
            when the code was not run.
        pdf_cid: the manuscript PDF, when hidden-text blocks were part of the
            agent's input.

    Returns:
        A :class:`VerificationResult`: the findings kept, and one
        ``"finding <n>: <reason>"`` string per rejected finding.

    Raises:
        TypeError: if an item of ``findings`` is not a :class:`Finding`.
    """
    return EvidenceVerifier(
        version_cid, run_log=run_log, pdf_cid=pdf_cid
    ).verify(findings)
