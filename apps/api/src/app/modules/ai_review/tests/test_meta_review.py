"""Tests for the meta-reviewer's final findings list (feature 120).

Covers: findings that make the same point on the same evidence are one final
finding naming every reporting agent; findings the agents rated differently
are flagged while a single group's most severe severity and least confident
confidence are kept; integrity findings always end with "Needs a human check."
and no final claim states fraud, plagiarism or another accusation; and the
final list is ordered most severe first.
"""

from __future__ import annotations

import pytest

from app.modules import ai_review
from app.modules.ai_review import (
    AgentReport,
    Evidence,
    Finding,
    MetaReviewResult,
    finalize_findings,
    meta_review,
)

SPAN = "We evaluate the method on 10 samples."


def finding(
    agent: str = "methodology",
    claim: str = "Ten samples are too few for the stated conclusion.",
    *,
    severity: str = "major",
    confidence: str = "high",
    evidence: Evidence | None = None,
    **overrides,
) -> Finding:
    return Finding(
        agent=agent,
        claim=claim,
        severity=severity,
        confidence=confidence,
        evidence=evidence or Evidence(span=SPAN, paragraph_id="p1"),
        **overrides,
    )


def report(agent: str, *findings: Finding) -> AgentReport:
    return AgentReport(
        agent=agent,
        findings=findings,
        dropped=(),
        provider="fake",
        model="fake-1",
        prompt_set_hash="0" * 64,
    )


# --------------------------------------------------------------------------- #
# Merging duplicates                                                          #
# --------------------------------------------------------------------------- #


class TestMergingDuplicates:
    def test_the_same_point_on_the_same_evidence_is_one_finding(self):
        result = finalize_findings(
            [
                finding("methodology"),
                finding("literature"),
            ]
        )

        assert len(result.findings) == 1
        merged = result.findings[0]
        assert merged.agent == "methodology"
        assert merged.agents == ("methodology", "literature")
        assert merged.also_reported_by == ("literature",)
        assert result.merged == ("finding 2: duplicate of finding 1",)

    def test_a_reworded_claim_about_the_same_evidence_merges(self):
        result = finalize_findings(
            [
                finding(
                    "integrity",
                    "Ten samples are too few to support the conclusion.",
                ),
                finding(
                    "literature",
                    "Ten samples are too few to support the stated conclusion.",
                ),
            ]
        )

        assert len(result.findings) == 1
        assert result.findings[0].agents == ("integrity", "literature")
        assert result.merged == ("finding 2: duplicate of finding 1",)

    def test_a_loosely_related_point_on_the_same_evidence_stays_separate(self):
        # Same quotation, but two different problems: neither may be hidden.
        result = finalize_findings(
            [
                finding("methodology", "The sample size is small."),
                finding("literature", "The effect size is small."),
            ]
        )

        assert len(result.findings) == 2
        assert result.merged == ()

    def test_different_points_on_the_same_evidence_stay_separate(self):
        result = finalize_findings(
            [
                finding("methodology", "The abstract reports 84 participants."),
                finding("integrity", "The quoted sentence is machine-garbled."),
            ]
        )

        assert len(result.findings) == 2
        assert result.merged == ()

    def test_the_same_claim_on_different_evidence_stays_separate(self):
        result = finalize_findings(
            [
                finding("methodology", evidence=Evidence(span="first")),
                finding("literature", evidence=Evidence(span="second")),
            ]
        )

        assert len(result.findings) == 2
        assert result.merged == ()

    def test_opposite_claims_on_the_same_evidence_stay_separate(self):
        result = finalize_findings(
            [
                finding("methodology", "The paper reports a baseline."),
                finding("literature", "The paper reports no baseline."),
            ]
        )

        assert len(result.findings) == 2
        assert result.merged == ()

    def test_claims_with_different_numbers_stay_separate(self):
        result = finalize_findings(
            [
                finding("methodology", "Table 2 reports 48 participants."),
                finding("literature", "Table 2 reports 84 participants."),
            ]
        )

        assert len(result.findings) == 2
        assert result.merged == ()

    def test_a_span_with_and_without_a_paragraph_id_merge_and_keep_the_id(self):
        result = finalize_findings(
            [
                finding(evidence=Evidence(span=SPAN)),
                finding("literature", evidence=Evidence(span=SPAN, paragraph_id="p1")),
            ]
        )

        assert len(result.findings) == 1
        assert result.findings[0].evidence.paragraph_id == "p1"

    def test_the_same_span_in_two_paragraphs_does_not_merge(self):
        result = finalize_findings(
            [
                finding(evidence=Evidence(span="Yes.", paragraph_id="p1")),
                finding(
                    "literature", evidence=Evidence(span="Yes.", paragraph_id="p2")
                ),
            ]
        )

        assert len(result.findings) == 2

    @pytest.mark.parametrize(
        "evidence",
        [
            {"reference_id": "ref:3"},
            {"log_line": "Error: out of memory"},
        ],
    )
    def test_reference_and_log_evidence_merge_too(self, evidence):
        result = finalize_findings(
            [
                finding("literature", evidence=Evidence(**evidence)),
                finding("literature", evidence=Evidence(**evidence)),
            ]
        )

        assert len(result.findings) == 1

    def test_an_agent_repeating_itself_is_merged(self):
        result = finalize_findings([finding("methodology"), finding("methodology")])

        assert len(result.findings) == 1
        assert result.findings[0].also_reported_by == ()

    def test_three_agents_merge_into_one_finding(self):
        result = finalize_findings(
            [
                finding("methodology"),
                finding("literature"),
                finding("integrity"),
            ]
        )

        assert len(result.findings) == 1
        assert result.findings[0].agents == ("methodology", "literature", "integrity")

    def test_merging_keeps_the_most_severe_severity(self):
        result = finalize_findings(
            [
                finding("methodology", severity="minor"),
                finding("literature", severity="critical"),
            ]
        )

        assert result.findings[0].severity == "critical"

    def test_merging_keeps_the_least_confident_confidence(self):
        result = finalize_findings(
            [
                finding("methodology", confidence="high"),
                finding("literature", confidence="low"),
            ]
        )

        assert result.findings[0].confidence == "low"

    def test_the_first_agents_claim_is_kept(self):
        result = finalize_findings(
            [
                finding("methodology", "Ten samples are too few for the conclusion."),
                finding("literature", "Ten samples are too few for the stated conclusion."),
            ]
        )

        assert result.findings[0].claim == "Ten samples are too few for the conclusion."


# --------------------------------------------------------------------------- #
# Flagging disagreement                                                       #
# --------------------------------------------------------------------------- #


class TestDisagreements:
    def test_different_severities_are_flagged(self):
        result = finalize_findings(
            [
                finding("methodology", severity="minor"),
                finding("literature", severity="critical"),
            ]
        )

        assert result.findings[0].agents_disagree is True
        (note,) = result.disagreements
        assert note.startswith("finding 1: agents disagree on severity")
        assert "methodology=minor/high" in note
        assert "literature=critical/high" in note

    def test_different_confidences_are_flagged(self):
        result = finalize_findings(
            [
                finding("methodology", confidence="high"),
                finding("literature", confidence="low"),
            ]
        )

        assert result.findings[0].agents_disagree is True
        (note,) = result.disagreements
        assert "disagree on confidence" in note

    def test_different_severity_and_confidence_both_named(self):
        result = finalize_findings(
            [
                finding("methodology", severity="minor", confidence="high"),
                finding("literature", severity="critical", confidence="low"),
            ]
        )

        (note,) = result.disagreements
        assert "disagree on severity and confidence" in note

    def test_agents_that_agree_are_not_flagged(self):
        result = finalize_findings([finding("methodology"), finding("literature")])

        assert result.findings[0].agents_disagree is False
        assert result.disagreements == ()

    def test_one_agent_is_never_flagged(self):
        result = finalize_findings([finding("methodology", severity="critical")])

        assert result.findings[0].agents_disagree is False
        assert result.disagreements == ()

    def test_flagged_exposes_the_contested_findings(self):
        result = finalize_findings(
            [
                finding("methodology", severity="minor"),
                finding("literature", severity="major"),
                finding(
                    "integrity",
                    "A different problem entirely.",
                    evidence=Evidence(span="another quotation", paragraph_id="p2"),
                ),
            ]
        )

        assert result.flagged == tuple(
            item for item in result.findings if item.agents_disagree
        )
        assert len(result.flagged) == 1


# --------------------------------------------------------------------------- #
# Wording                                                                     #
# --------------------------------------------------------------------------- #


class TestWording:
    def test_an_integrity_finding_ends_with_the_human_check_phrase(self):
        (final,) = finalize_findings(
            [
                finding(
                    "integrity",
                    "Table 2 reports 48 participants while the abstract reports 84.",
                )
            ]
        ).findings

        assert final.claim.endswith(ai_review.HUMAN_CHECK)
        assert final.needs_human_check is True

    def test_the_phrase_is_not_added_twice(self):
        (final,) = finalize_findings(
            [finding("integrity", "Table 2 and the abstract disagree. Needs a human check.")]
        ).findings

        assert final.claim.lower().count("needs a human check") == 1
        assert final.claim.endswith(ai_review.HUMAN_CHECK)

    def test_the_phrase_is_canonicalized(self):
        (final,) = finalize_findings(
            [finding("integrity", "Table 2 and the abstract disagree. needs a human check")]
        ).findings

        assert final.claim.endswith(ai_review.HUMAN_CHECK)

    def test_the_design_example_prefix_is_not_stated_twice(self):
        claim = "Needs a human check: possible figure reuse (Fig. 3 and Fig. 5)."

        (final,) = finalize_findings([finding("integrity", claim)]).findings

        assert final.claim == claim
        assert final.claim.lower().count("needs a human check") == 1

    @pytest.mark.parametrize(
        "accusation",
        [
            "The authors committed fraud.",
            "The authors committed fraud. Needs a human check.",
            "Plagiarism was detected in Figure 3.",
            "Table 2 contains a fabricated number.",
            "The reference list shows falsification.",
            "This is scientific misconduct.",
            "The text cheats by hiding a condition.",
        ],
    )
    def test_an_integrity_claim_never_states_fraud_or_plagiarism(self, accusation):
        (final,) = finalize_findings([finding("integrity", accusation)]).findings

        assert final.claim == f"{ai_review.NEUTRAL_CLAIM} {ai_review.HUMAN_CHECK}"
        assert not any(
            word in final.claim.lower()
            for word in ("fraud", "plagiar", "fabricat", "falsif", "misconduct", "cheat")
        )

    def test_a_neutral_integrity_claim_keeps_its_wording(self):
        claim = "Table 2 reports 48 participants while the abstract reports 84."

        (final,) = finalize_findings([finding("integrity", claim)]).findings

        assert final.claim == f"{claim} {ai_review.HUMAN_CHECK}"

    def test_an_accusatory_claim_from_another_agent_is_also_neutralized(self):
        (final,) = finalize_findings(
            [finding("methodology", "The authors fabricated the result.")]
        ).findings

        assert final.claim == ai_review.NEUTRAL_CLAIM
        assert final.needs_human_check is False

    def test_a_neutral_claim_from_another_agent_is_unchanged(self):
        claim = "Ten samples are too few for the stated conclusion."

        (final,) = finalize_findings([finding("methodology", claim)]).findings

        assert final.claim == claim

    def test_a_merged_integrity_finding_is_phrased_and_flagged(self):
        result = finalize_findings(
            [
                finding("methodology", "Table 2 and the abstract disagree."),
                finding("integrity", "Table 2 and the abstract disagree."),
            ]
        )

        (final,) = result.findings
        assert final.claim.endswith(ai_review.HUMAN_CHECK)
        assert final.needs_human_check is True

    def test_a_specialist_finding_keeps_exactly_its_five_fields(self):
        item = finding("methodology")

        assert item.to_dict() == {
            "agent": "methodology",
            "claim": item.claim,
            "severity": "major",
            "confidence": "high",
            "evidence": {"span": SPAN, "paragraph_id": "p1"},
        }

    def test_final_metadata_is_serialized(self):
        (final,) = finalize_findings(
            [
                finding("methodology", severity="minor"),
                finding("integrity", severity="major"),
            ]
        ).findings

        item = final.to_dict()
        assert item["also_reported_by"] == ["integrity"]
        assert item["agents_disagree"] is True
        assert item["needs_human_check"] is True


# --------------------------------------------------------------------------- #
# The final list                                                              #
# --------------------------------------------------------------------------- #


class TestFinalList:
    def test_findings_are_ordered_most_severe_first_and_stable(self):
        result = finalize_findings(
            [
                finding("methodology", "Minor point.", severity="info",
                        evidence=Evidence(span="a")),
                finding("methodology", "Critical point.", severity="critical",
                        evidence=Evidence(span="b")),
                finding("methodology", "Major point.", severity="major",
                        evidence=Evidence(span="c")),
                finding("literature", "Another major point.", severity="major",
                        evidence=Evidence(span="d")),
            ]
        )

        assert [item.severity for item in result.findings] == [
            "critical",
            "major",
            "major",
            "info",
        ]
        # Equal severities keep input order.
        assert [item.claim for item in result.findings[1:3]] == [
            "Major point.",
            "Another major point.",
        ]

    def test_no_findings_gives_an_empty_result(self):
        result = finalize_findings([])

        assert result == MetaReviewResult((), (), ())

    def test_a_result_unpacks_as_findings_merged_and_disagreements(self):
        findings, merged, disagreements = finalize_findings([finding()])

        assert findings == (finding(),)
        assert merged == ()
        assert disagreements == ()

    def test_finalizing_does_not_modify_the_input(self):
        original = finding("integrity", "The authors committed fraud.")

        finalize_findings([original])

        assert original.claim == "The authors committed fraud."

    def test_a_non_finding_is_rejected(self):
        with pytest.raises(TypeError, match="Finding"):
            finalize_findings([object()])  # type: ignore[list-item]

    def test_meta_review_collects_every_report_in_order(self):
        first = finding("methodology", evidence=Evidence(span="first"))
        second = finding("literature", evidence=Evidence(span="second"))

        result = meta_review([report("methodology", first), report("literature", second)])

        assert [item.claim for item in result.findings] == [
            first.claim,
            second.claim,
        ]

    def test_meta_review_rejects_a_bare_finding(self):
        with pytest.raises(TypeError, match="AgentReport"):
            meta_review([finding()])  # type: ignore[list-item]

    def test_the_package_exposes_the_meta_review_api(self):
        assert ai_review.meta_review is meta_review
        assert ai_review.finalize_findings is finalize_findings
        for name in ("MetaReviewResult", "HUMAN_CHECK", "NEUTRAL_CLAIM", "meta_review"):
            assert name in ai_review.__all__
