"""The meta-reviewer: the final findings list (feature 120).

The four specialist agents answer independently (feature 117), and every
finding they return has had its evidence checked (feature 118).  Their
reports still overlap, rate the same quotation differently and use wording a
reader must not see in an advisory report.  This module is the last pass: it
turns the specialists' findings into the list a report is shown with::

    from app.modules import ai_review

    result = ai_review.meta_review(reports)      # one AgentReport per agent
    result.findings                              # the final list
    result.merged                                # notes on merged duplicates
    result.disagreements                         # notes on flagged disagreement

Three rules are applied, in code rather than by asking a model: a wording
guarantee must not depend on a model following instructions.

Merging duplicates
    Findings that point at the same evidence and make the same point are one
    finding.  Evidence is the same when it is the same kind and the same
    quoted span, reference id or log line; a span named with a
    ``paragraph_id`` matches the same span named without one, and the merged
    finding keeps the explicit id.  Two claims make the same point when their
    word sets are identical or closely overlap (Jaccard similarity at least
    :data:`DUPLICATE_SIMILARITY`, common words ignored).  The first finding
    in the input keeps its claim and agent; the final finding lists the other
    reporting agents in ``also_reported_by``.  Merging never hides an
    assessment: the most severe severity and the least confident confidence
    of the merged group are kept, so a duplicate cannot downgrade another
    agent's finding.

Flagging disagreement
    When agents merged into one finding rated it differently — a different
    severity or confidence — the final finding carries
    ``agents_disagree=True`` and a note in :attr:`MetaReviewResult.disagreements`,
    so a person can see that the agents did not agree.  A finding reported by
    one agent is never flagged.

Wording
    An integrity finding always contains "Needs a human check." exactly once:
    a claim that does not already state it gets it appended, and one that
    does — at the end, or at the start as in the design's example — keeps its
    placement with the suffix canonicalized.  Any final claim — from any
    agent — that states fraud, plagiarism, fabrication, falsification,
    misconduct or cheating is replaced by a neutral sentence: a report may
    point to an irregularity for a person to check, but it never announces a
    finding of wrongdoing.  The finding keeps its evidence, so the reader can
    still see what is being pointed at.

The final list is ordered most severe first, keeping input order among equal
severities.  Inputs are not modified; a finding is replaced by a new one only
when its claim, evidence or metadata changes.  This module writes no record
and no status; it only builds the list a caller may keep.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import NamedTuple

from .agents import AgentReport
from .findings import CONFIDENCES, SEVERITIES, Evidence, Finding

__all__ = [
    "DUPLICATE_SIMILARITY",
    "HUMAN_CHECK",
    "NEUTRAL_CLAIM",
    "MetaReviewResult",
    "finalize_findings",
    "meta_review",
]

#: The sentence every integrity finding ends with, exactly as the design says.
HUMAN_CHECK = "Needs a human check."

#: What an accusatory claim is replaced with.  It states no conclusion.
NEUTRAL_CLAIM = "Possible integrity concern in the quoted text."

#: How close two claims' word sets must be, on the same evidence, to merge.
#: Deliberately high: a missed merge shows two similar findings, while a false
#: merge hides one agent's concern, which is the worse failure.
DUPLICATE_SIMILARITY = 0.75

# Word stems from the integrity prompt's forbidden list, plus fraud.  Matching
# the stem catches fraud/fraudulent, plagiarism/plagiarised, fabrication/
# fabricated, falsification/falsified, misconduct, cheating/cheated.
_ACCUSATION = re.compile(
    r"\b(?:fraud\w*|plagiar\w*|fabricat\w*|falsif\w*|misconduct\w*|cheat\w*)\b",
    re.IGNORECASE,
)

# "needs a human check", optionally with its full stop, at the end of a claim,
# or anywhere in it: the design's own example places it at the start.
_HUMAN_CHECK_AT_END = re.compile(r"needs\s+a\s+human\s+check\.?\s*$", re.IGNORECASE)
_HUMAN_CHECK_ANYWHERE = re.compile(r"needs\s+a\s+human\s+check", re.IGNORECASE)

# Numbers and negations decide what a finding says, so two claims that differ
# in either never merge, however similar the rest of their words are.
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_NEGATION = re.compile(
    r"\b(?:no|not|never|none|without|cannot|can't|isn't|aren't|wasn't|"
    r"weren't|doesn't|don't|didn't|won't|fail(?:s|ed)?|lack(?:s|ed|ing)?|"
    r"absent|missing)\b",
    re.IGNORECASE,
)

# Function words ignored when comparing claims.  Negations and qualifiers
# ("no", "not", "only", "too") stay: dropping them would merge "has a baseline"
# with "has no baseline".
_STOPWORDS = frozenset(
    "a an and are as at be been being but by can could did do does for from "
    "had has have how if in into is it its may might must of on or our should "
    "so some such than that the their them then there these they this those "
    "to under up was were what when where which while who why will with would".split()
)

_SEVERITY_RANK = {severity: rank for rank, severity in enumerate(SEVERITIES)}
_CONFIDENCE_RANK = {confidence: rank for rank, confidence in enumerate(CONFIDENCES)}


class MetaReviewResult(NamedTuple):
    """The final findings and what the meta-reviewer did to get them.

    Unpacks as ``(findings, merged, disagreements)`` and also exposes the
    fields by name, matching
    :class:`~app.modules.ai_review.verification.VerificationResult`.
    """

    #: The final list, most severe first, duplicate groups merged.
    findings: tuple[Finding, ...]
    #: One note per duplicate discarded, numbering the input finding from 1
    #: (``"finding 3: duplicate of finding 1"``).
    merged: tuple[str, ...]
    #: One note per final finding whose reporting agents disagreed
    #: (``"finding 1: agents disagree on severity (...)"``).
    disagreements: tuple[str, ...]

    @property
    def flagged(self) -> tuple[Finding, ...]:
        """The final findings the agents disagreed about."""
        return tuple(finding for finding in self.findings if finding.agents_disagree)


def _tokens(claim: str) -> frozenset[str]:
    """The significant words of a claim, ignoring a trailing human-check note."""
    text = _HUMAN_CHECK_AT_END.sub("", claim).lower()
    words = re.findall(r"[a-z0-9]+", text)
    significant = [word for word in words if word not in _STOPWORDS]
    # A claim made only of function words still has to compare as something.
    return frozenset(significant or words)


def _same_claim(first: str, second: str) -> bool:
    """Whether two claims make the same point."""
    if set(_NUMBER.findall(first)) != set(_NUMBER.findall(second)):
        return False
    if bool(_NEGATION.search(first)) != bool(_NEGATION.search(second)):
        return False
    first_words = _tokens(first)
    second_words = _tokens(second)
    if not first_words or not second_words:
        return first_words == second_words
    if first_words == second_words:
        return True
    overlap = len(first_words & second_words) / len(first_words | second_words)
    return overlap >= DUPLICATE_SIMILARITY


def _same_evidence(first: Finding, second: Finding) -> bool:
    """Whether two findings point at the same place in the paper or run log."""
    one, two = first.evidence, second.evidence
    if one.kind != two.kind or one.value != two.value:
        return False
    if one.kind != "span":
        # reference_id and log_line carry no paragraph id.
        return True
    # The same quotation is the same evidence; an explicit paragraph id only
    # makes the link more precise, so it matches the same span named without.
    return (
        one.paragraph_id == two.paragraph_id
        or one.paragraph_id is None
        or two.paragraph_id is None
    )


def _merged_evidence(members: list[Finding]) -> Evidence:
    """The members' shared evidence, preferring one with a paragraph id."""
    for member in members:
        if member.evidence.paragraph_id is not None:
            return member.evidence
    return members[0].evidence


def _phrase_claim(claim: str, *, integrity: bool) -> str:
    """The claim as the final list shows it (see the module's wording rule)."""
    claim = claim.strip()
    if _ACCUSATION.search(claim):
        claim = NEUTRAL_CLAIM
    if integrity:
        if _HUMAN_CHECK_AT_END.search(claim):
            claim = _HUMAN_CHECK_AT_END.sub(HUMAN_CHECK, claim).strip()
        elif not _HUMAN_CHECK_ANYWHERE.search(claim):
            # Keep a model's prefix or mid-sentence phrasing (the design's
            # example starts with it) instead of stating it twice.
            claim = f"{claim} {HUMAN_CHECK}"
    return claim


def _ratings_text(values: list[tuple[str, str]]) -> str:
    """One agent's ratings, sorted, as ``major/high``."""
    return ", ".join(
        sorted({f"{severity}/{confidence}" for severity, confidence in values})
    )


def _disagreement_note(
    cluster: list[tuple[int, Finding]],
) -> str | None:
    """A note when the agents behind one finding rated it differently."""
    ratings: dict[str, list[tuple[str, str]]] = {}
    for _, finding in cluster:
        ratings.setdefault(finding.agent, []).append(
            (finding.severity, finding.confidence)
        )
    if len(ratings) < 2:
        return None
    severities = {severity for values in ratings.values() for severity, _ in values}
    confidences = {confidence for values in ratings.values() for _, confidence in values}
    if len(severities) == 1 and len(confidences) == 1:
        return None
    fields = []
    if len(severities) > 1:
        fields.append("severity")
    if len(confidences) > 1:
        fields.append("confidence")
    by_agent = "; ".join(
        f"{agent}={_ratings_text(values)}" for agent, values in ratings.items()
    )
    number = cluster[0][0]
    return f"finding {number}: agents disagree on {' and '.join(fields)} ({by_agent})"


def _finalize(
    numbered: list[tuple[int, Finding]],
) -> MetaReviewResult:
    """Merge, flag and reorder already-validated findings."""
    # Bucket by evidence first, then split each bucket into claims.  A greedy
    # scan is enough: a report holds at most a few dozen findings.
    buckets: list[list[tuple[int, Finding]]] = []
    for number, finding in numbered:
        for bucket in buckets:
            if _same_evidence(bucket[0][1], finding):
                bucket.append((number, finding))
                break
        else:
            buckets.append([(number, finding)])

    final: list[Finding] = []
    merged: list[str] = []
    disagreements: list[str] = []
    for bucket in buckets:
        clusters: list[list[tuple[int, Finding]]] = []
        for item in bucket:
            for cluster in clusters:
                if _same_claim(cluster[0][1].claim, item[1].claim):
                    cluster.append(item)
                    break
            else:
                clusters.append([item])
        for cluster in clusters:
            kept_number = cluster[0][0]
            for number, _ in cluster[1:]:
                merged.append(f"finding {number}: duplicate of finding {kept_number}")
            members = [finding for _, finding in cluster]
            agents: list[str] = []
            for member in members:
                if member.agent not in agents:
                    agents.append(member.agent)
            primary = members[0]
            integrity = "integrity" in agents
            note = _disagreement_note(cluster)
            if note is not None:
                disagreements.append(note)
            final.append(
                Finding(
                    agent=primary.agent,
                    claim=_phrase_claim(primary.claim, integrity=integrity),
                    # Keep the group's most severe rating and least confident
                    # confidence: merging never understates a duplicate.
                    severity=max(
                        (member.severity for member in members),
                        key=lambda severity: _SEVERITY_RANK[severity],
                    ),
                    confidence=min(
                        (member.confidence for member in members),
                        key=lambda confidence: _CONFIDENCE_RANK[confidence],
                    ),
                    evidence=_merged_evidence(members),
                    also_reported_by=tuple(
                        agent for agent in agents if agent != primary.agent
                    ),
                    agents_disagree=note is not None,
                    needs_human_check=integrity,
                )
            )

    # Most severe first; input order is kept among equal severities.
    final.sort(key=lambda finding: -_SEVERITY_RANK[finding.severity])
    return MetaReviewResult(tuple(final), tuple(merged), tuple(disagreements))


def finalize_findings(findings: Iterable[Finding]) -> MetaReviewResult:
    """Build the final findings list from findings that are already verified.

    Args:
        findings: the verified findings of one or more agents, in report order.

    Returns:
        A :class:`MetaReviewResult`: the merged, flagged final list ordered
        most severe first, one note per discarded duplicate and one note per
        flagged disagreement.

    Raises:
        TypeError: if an item of ``findings`` is not a :class:`Finding`.
    """
    numbered: list[tuple[int, Finding]] = []
    for number, finding in enumerate(findings, start=1):
        if not isinstance(finding, Finding):
            raise TypeError(
                f"findings must be Finding objects, got {type(finding).__name__}"
            )
        numbered.append((number, finding))
    return _finalize(numbered)


def meta_review(reports: Iterable[AgentReport]) -> MetaReviewResult:
    """Build the final findings list from the specialist agents' reports.

    This is :func:`finalize_findings` over every report's findings, in report
    order.

    Args:
        reports: one :class:`~app.modules.ai_review.agents.AgentReport` per
            agent whose verified findings are part of the report.

    Returns:
        A :class:`MetaReviewResult` as from :func:`finalize_findings`.

    Raises:
        TypeError: if an item of ``reports`` is not an
            :class:`~app.modules.ai_review.agents.AgentReport`.
    """
    findings: list[Finding] = []
    for number, report in enumerate(reports, start=1):
        if not isinstance(report, AgentReport):
            raise TypeError(
                "reports must be AgentReport objects, got "
                f"{type(report).__name__} at position {number}"
            )
        findings.extend(report.findings)
    return finalize_findings(findings)
