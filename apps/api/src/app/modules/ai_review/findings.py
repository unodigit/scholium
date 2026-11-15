"""The shape of an agent's findings, and parsing them from a model reply (feature 117).

An agent answers with one JSON object::

    {"findings": [
        {"claim": "...", "severity": "major", "confidence": "medium",
         "evidence": {"span": "...", "paragraph_id": "..."}}
    ]}

Every finding has

``claim``
    one sentence stating the problem;
``severity``
    one of :data:`SEVERITIES` (``info``, ``minor``, ``major``, ``critical``);
``confidence``
    one of :data:`CONFIDENCES` (``low``, ``medium``, ``high``), the scale the
    design uses for AI findings;
``evidence``
    exactly one of

    ``span``
        text quoted from the paper, with the optional ``paragraph_id`` of
        the data block it was copied from;
    ``reference_id``
        the id of a reference-list data block (``ref:<n>``, see
        :data:`~app.modules.ai_review.agent_input.REFERENCE_BLOCK_PREFIX`);
    ``log_line``
        a line of the sandbox run log.

This module checks only the *shape*.  Whether a span really occurs in the
paper, a reference id exists or a log line is in the run log is checked
against the paper itself by the evidence verifier
(:mod:`app.modules.ai_review.verification`, feature 118); a parsed
:class:`Finding` is a well-formed claim, not a verified one.

The model's reply is untrusted text.  A reply that is not a JSON object with a
``findings`` list raises :class:`~app.modules.ai_review.errors.AgentOutputError`.
A finding in that list that lacks a field, has an unknown severity or
confidence, or carries no evidence (or more than one kind) is dropped, and
the reason is returned beside the findings so a drop is never silent.  The
``agent`` of a finding is set by the caller, never read from the reply.

A specialist's finding carries only these five fields.  The meta-reviewer
(feature 120) adds the optional metadata a *final* finding also has:
``also_reported_by`` names the other agents that reported the same point,
``agents_disagree`` says the agents rated it differently, and
``needs_human_check`` marks an integrity observation.  Those fields default
to empty or ``False`` and :meth:`Finding.to_dict` omits them then, so a
specialist's finding keeps the shape the agents return.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Optional

from .errors import AgentOutputError

__all__ = [
    "CONFIDENCES",
    "EVIDENCE_KINDS",
    "SEVERITIES",
    "Evidence",
    "Finding",
    "parse_findings",
]

#: How much a problem weakens the paper, least to most.
SEVERITIES: tuple[str, ...] = ("info", "minor", "major", "critical")

#: How sure the agent is that the problem is real, least to most.
CONFIDENCES: tuple[str, ...] = ("low", "medium", "high")

#: The kinds of evidence; a finding carries exactly one.
EVIDENCE_KINDS: tuple[str, ...] = ("span", "reference_id", "log_line")

_FENCE = re.compile(r"^```[A-Za-z0-9_-]*[ \t]*\n(?P<body>.*?)\n?```[ \t]*$", re.DOTALL)


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


@dataclass(frozen=True)
class Evidence:
    """What a finding rests on: one quoted span, reference id or log line."""

    span: Optional[str] = None
    reference_id: Optional[str] = None
    log_line: Optional[str] = None
    #: Id of the data block a ``span`` was copied from (``span`` only).
    paragraph_id: Optional[str] = None

    def __post_init__(self) -> None:
        present = [kind for kind in EVIDENCE_KINDS if _text(getattr(self, kind))]
        if len(present) != 1:
            raise ValueError(
                "evidence needs exactly one of "
                f"{', '.join(EVIDENCE_KINDS)}; got {len(present)}"
            )
        if self.paragraph_id is not None and not _text(self.span):
            raise ValueError("paragraph_id is only valid with a span")

    @property
    def kind(self) -> str:
        """Which of :data:`EVIDENCE_KINDS` this evidence is."""
        return next(kind for kind in EVIDENCE_KINDS if _text(getattr(self, kind)))

    @property
    def value(self) -> str:
        """The quoted span, reference id or log line."""
        return getattr(self, self.kind)

    def to_dict(self) -> dict[str, str]:
        """The evidence object as stored in a record: only the keys that are set."""
        data = {self.kind: self.value}
        if self.paragraph_id is not None:
            data["paragraph_id"] = self.paragraph_id
        return data


@dataclass(frozen=True)
class Finding:
    """One advisory finding of one agent."""

    agent: str
    claim: str
    severity: str
    confidence: str
    evidence: Evidence
    #: Other agents that reported the same finding (set by the meta-reviewer).
    also_reported_by: tuple[str, ...] = ()
    #: Whether the reporting agents rated this finding differently.
    agents_disagree: bool = False
    #: Whether this is an integrity observation phrased for a human to check.
    needs_human_check: bool = False

    def __post_init__(self) -> None:
        if not self.claim or not self.claim.strip():
            raise ValueError("claim must not be empty")
        if self.severity not in SEVERITIES:
            raise ValueError(f"severity must be one of {', '.join(SEVERITIES)}")
        if self.confidence not in CONFIDENCES:
            raise ValueError(f"confidence must be one of {', '.join(CONFIDENCES)}")
        others = tuple(self.also_reported_by)
        if any(not isinstance(agent, str) or not agent.strip() for agent in others):
            raise ValueError("also_reported_by must contain agent names")
        if len(set(others)) != len(others):
            raise ValueError("also_reported_by must not repeat an agent")
        if self.agent in others:
            raise ValueError("also_reported_by must not repeat the finding's agent")
        if self.also_reported_by is not others:
            object.__setattr__(self, "also_reported_by", others)

    @property
    def agents(self) -> tuple[str, ...]:
        """Every agent that reported this finding, ``agent`` first."""
        return (self.agent, *self.also_reported_by)

    def to_dict(self) -> dict[str, Any]:
        """The finding as a JSON-ready dict, with an ``evidence`` object.

        The meta-reviewer's optional metadata appears only when it was set,
        so a specialist's finding has exactly the five fields agents return.
        """
        data: dict[str, Any] = {
            "agent": self.agent,
            "claim": self.claim,
            "severity": self.severity,
            "confidence": self.confidence,
            "evidence": self.evidence.to_dict(),
        }
        if self.also_reported_by:
            data["also_reported_by"] = list(self.also_reported_by)
        if self.agents_disagree:
            data["agents_disagree"] = True
        if self.needs_human_check:
            data["needs_human_check"] = True
        return data


def _load_json(text: str) -> Any:
    """The JSON value in a model reply, tolerating a code fence or leading prose."""
    stripped = text.strip()
    candidates = [stripped]
    fenced = _FENCE.match(stripped)
    if fenced:
        candidates.append(fenced.group("body").strip())
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (ValueError, RecursionError):
            pass
    # Prose before the object: decode from the first "{" that starts a value.
    decoder = json.JSONDecoder()
    start = stripped.find("{")
    while start != -1:
        try:
            value, _ = decoder.raw_decode(stripped, start)
        except (ValueError, RecursionError):
            start = stripped.find("{", start + 1)
            continue
        if isinstance(value, dict) and "findings" in value:
            return value
        start = stripped.find("{", start + 1)
    raise AgentOutputError("agent reply contains no JSON object with a 'findings' list")


def _parse_evidence(raw: Any) -> Evidence:
    if not isinstance(raw, dict):
        raise ValueError("evidence must be an object")
    # null and "" mean "not this kind": models fill unused keys that way.
    kinds = [kind for kind in EVIDENCE_KINDS if raw.get(kind) not in (None, "")]
    if len(kinds) != 1:
        raise ValueError(
            f"evidence needs exactly one of {', '.join(EVIDENCE_KINDS)}; "
            f"got {len(kinds)}"
        )
    kind = kinds[0]
    value = _text(raw[kind])
    if value is None:
        raise ValueError(f"evidence {kind} must be a non-empty string")
    paragraph_id = raw.get("paragraph_id")
    if paragraph_id is not None:
        if kind != "span":
            raise ValueError("paragraph_id is only valid with a span")
        paragraph_id = _text(paragraph_id)
        if paragraph_id is None:
            raise ValueError("evidence paragraph_id must be a non-empty string")
    return Evidence(**{kind: value}, paragraph_id=paragraph_id)


def _parse_finding(agent: str, raw: Any) -> Finding:
    if not isinstance(raw, dict):
        raise ValueError("finding must be an object")
    claim = _text(raw.get("claim"))
    if claim is None:
        raise ValueError("missing claim")
    severity = raw.get("severity")
    severity = severity.strip().lower() if isinstance(severity, str) else None
    if severity not in SEVERITIES:
        raise ValueError(f"severity must be one of {', '.join(SEVERITIES)}")
    confidence = raw.get("confidence")
    confidence = confidence.strip().lower() if isinstance(confidence, str) else None
    if confidence not in CONFIDENCES:
        raise ValueError(f"confidence must be one of {', '.join(CONFIDENCES)}")
    if "evidence" not in raw:
        raise ValueError("missing evidence")
    return Finding(
        agent=agent,
        claim=claim.strip(),
        severity=severity,
        confidence=confidence,
        evidence=_parse_evidence(raw["evidence"]),
    )


def parse_findings(agent: str, text: str) -> tuple[tuple[Finding, ...], tuple[str, ...]]:
    """Parse an agent's reply into ``(findings, dropped)``.

    Args:
        agent: the agent the reply came from; stamped on every finding.
        text: the model's reply.

    Returns:
        The well-formed findings in reply order, and one reason string per
        malformed finding that was dropped (``"finding 2: missing evidence"``,
        numbering from 1).

    Raises:
        AgentOutputError: if ``text`` is not a JSON object with a ``findings``
            list (a bare JSON list of findings is accepted too).
    """
    if not isinstance(text, str):
        raise AgentOutputError(f"agent reply must be a string, got {type(text).__name__}")
    value = _load_json(text)
    raw_findings = value.get("findings") if isinstance(value, dict) else value
    if not isinstance(raw_findings, list):
        raise AgentOutputError("agent reply has no 'findings' list")
    findings: list[Finding] = []
    dropped: list[str] = []
    for number, raw in enumerate(raw_findings, start=1):
        try:
            findings.append(_parse_finding(agent, raw))
        except ValueError as exc:
            dropped.append(f"finding {number}: {exc}")
    return tuple(findings), tuple(dropped)
