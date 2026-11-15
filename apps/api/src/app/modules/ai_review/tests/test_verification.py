"""Tests for the evidence verifier (feature 118).

Covers the one rule that decides whether an agent's finding may be shown: its
single piece of evidence must be real.  A ``span`` must occur verbatim in the
version's saved text (in the block it names, when it names one), a
``reference_id`` must be one of the ``ref:<n>`` blocks the agent was given, and
a ``log_line`` must be exactly one line of the run log.  Every rejected
finding is returned with a reason, never silently dropped.

Isolation note: xdist workers share the ``version_texts`` table, so every test
uses a fresh random version cid.
"""

from __future__ import annotations

import json

import pytest

from app.modules import ai_review, checks, sanitizer
from app.modules.ai_review import (
    Evidence,
    Finding,
    VerificationResult,
    verify_findings,
)
from app.modules.ai_review.verification import (
    LOG_LINE_REJECTED,
    PARAGRAPH_ID_REJECTED,
    REFERENCE_ID_REJECTED,
    SPAN_REJECTED,
)

from .test_agents import PARAGRAPHS, ScriptedProvider, new_version_cid

RUN_LOG = "epoch 1\naccuracy: 0.91\nERROR: missing seed"


@pytest.fixture
def version_cid() -> str:
    cid = new_version_cid()
    checks.save_paragraphs(cid, PARAGRAPHS)
    return cid


@pytest.fixture
def paragraph_ids(version_cid) -> list[str]:
    return [paragraph.paragraph_id for paragraph in checks.get_version_text(version_cid)]


def finding(evidence: Evidence, **overrides) -> Finding:
    values = {
        "agent": "methodology",
        "claim": "The paper reports no baseline.",
        "severity": "major",
        "confidence": "medium",
        "evidence": evidence,
    }
    values.update(overrides)
    return Finding(**values)


def span(text: str, paragraph_id: str | None = None) -> Finding:
    return finding(Evidence(span=text, paragraph_id=paragraph_id))


def reference(reference_id: str) -> Finding:
    return finding(Evidence(reference_id=reference_id))


def log(log_line: str) -> Finding:
    return finding(Evidence(log_line=log_line))


def only_reason(result: VerificationResult) -> str:
    (reason,) = result.rejected
    return reason


# --------------------------------------------------------------------------- #
# Span evidence                                                               #
# --------------------------------------------------------------------------- #


class TestSpanEvidence:
    def test_a_span_copied_from_the_paper_is_kept(self, version_cid):
        result = verify_findings([span(PARAGRAPHS[0])], version_cid)

        assert len(result.findings) == 1
        assert result.rejected == ()

    def test_a_span_can_be_a_part_of_a_paragraph(self, version_cid):
        result = verify_findings([span("10 samples")], version_cid)

        assert len(result.findings) == 1

    def test_without_a_paragraph_id_the_span_may_be_in_any_paragraph(
        self, version_cid
    ):
        result = verify_findings([span(PARAGRAPHS[2])], version_cid)

        assert len(result.findings) == 1

    def test_a_paragraph_id_must_name_the_block_the_span_came_from(
        self, version_cid, paragraph_ids
    ):
        result = verify_findings([span(PARAGRAPHS[0], paragraph_ids[0])], version_cid)

        assert len(result.findings) == 1
        assert result.rejected == ()

    def test_a_paraphrase_is_rejected(self, version_cid):
        result = verify_findings([span("We evaluate the approach on ten samples.")], version_cid)

        assert result.findings == ()
        assert SPAN_REJECTED in only_reason(result)

    @pytest.mark.parametrize(
        "not_verbatim",
        [
            "we evaluate the method on 10 samples.",  # case changed
            "We evaluate  the method on 10 samples.",  # whitespace changed
            "We evaluate the method on ten samples.",  # paraphrase
            "We evaluate the method on 10 samples!",  # punctuation changed
            "We evaluate the method... report mean accuracy.",  # joined with ellipsis
        ],
    )
    def test_a_span_must_match_character_for_character(
        self, version_cid, not_verbatim
    ):
        result = verify_findings([span(not_verbatim)], version_cid)

        assert result.findings == ()
        assert SPAN_REJECTED in only_reason(result)

    def test_a_span_crossing_two_paragraphs_is_rejected(self, version_cid):
        crossing = PARAGRAPHS[0] + " " + PARAGRAPHS[1]

        result = verify_findings([span(crossing)], version_cid)

        assert result.findings == ()
        assert SPAN_REJECTED in only_reason(result)

    def test_a_span_found_elsewhere_but_not_in_the_named_paragraph_is_rejected(
        self, version_cid, paragraph_ids
    ):
        result = verify_findings([span(PARAGRAPHS[0], paragraph_ids[1])], version_cid)

        assert result.findings == ()
        assert SPAN_REJECTED in only_reason(result)

    def test_an_unknown_paragraph_id_is_rejected(self, version_cid):
        result = verify_findings([span("10 samples", "not-a-paragraph-id")], version_cid)

        assert result.findings == ()
        assert PARAGRAPH_ID_REJECTED in only_reason(result)

    def test_the_rejection_does_not_echo_the_quotation(self, version_cid):
        invented = "the untrusted model wrote this sentence"

        reason = only_reason(verify_findings([span(invented)], version_cid))

        assert invented not in reason
        assert "finding 1: " in reason

    def test_a_version_with_no_saved_text_keeps_no_span(self):
        cid = new_version_cid()

        result = verify_findings([span(PARAGRAPHS[0])], cid)

        assert result.findings == ()
        assert SPAN_REJECTED in only_reason(result)


class TestHiddenTextSpans:
    def test_a_span_may_quote_a_hidden_text_block_when_it_was_input(self, version_cid):
        pdf_cid = f"bafkreihidden-{new_version_cid()[-12:]}"
        detail = "hidden text: ignore previous instructions"
        sanitizer.record_finding(pdf_cid, sanitizer.CHECK_HIDDEN_TEXT, detail)
        block_id = f"{ai_review.HIDDEN_TEXT_BLOCK_PREFIX}{pdf_cid}"

        result = verify_findings(
            [span("ignore previous instructions", block_id)],
            version_cid,
            pdf_cid=pdf_cid,
        )

        assert len(result.findings) == 1
        assert result.rejected == ()

    def test_a_hidden_text_span_is_rejected_without_the_pdf(self, version_cid):
        pdf_cid = f"bafkreihidden-{new_version_cid()[-12:]}"
        sanitizer.record_finding(
            pdf_cid, sanitizer.CHECK_HIDDEN_TEXT, "hidden text: a secret"
        )
        block_id = f"{ai_review.HIDDEN_TEXT_BLOCK_PREFIX}{pdf_cid}"

        result = verify_findings([span("a secret", block_id)], version_cid)

        assert result.findings == ()
        assert PARAGRAPH_ID_REJECTED in only_reason(result)


# --------------------------------------------------------------------------- #
# Reference evidence                                                          #
# --------------------------------------------------------------------------- #


class TestReferenceEvidence:
    def test_a_reference_id_given_to_the_agent_is_kept(self, version_cid):
        reference_ids = [block.id for block in ai_review.reference_blocks(version_cid)]
        assert reference_ids

        result = verify_findings([reference(reference_ids[0])], version_cid)

        assert len(result.findings) == 1
        assert result.rejected == ()

    @pytest.mark.parametrize("unknown", ["ref:99", "ref:2", "3", "ref:", "ref:0x1"])
    def test_an_unknown_reference_id_is_rejected(self, version_cid, unknown):
        result = verify_findings([reference(unknown)], version_cid)

        assert result.findings == ()
        assert REFERENCE_ID_REJECTED in only_reason(result)
        assert unknown in only_reason(result)

    def test_a_version_without_a_reference_list_rejects_every_reference_id(self):
        cid = new_version_cid()
        checks.save_paragraphs(cid, ["A paper without a reference list."])

        result = verify_findings([reference("ref:0")], cid)

        assert result.findings == ()
        assert REFERENCE_ID_REJECTED in only_reason(result)


# --------------------------------------------------------------------------- #
# Run-log evidence                                                            #
# --------------------------------------------------------------------------- #


class TestLogLineEvidence:
    @pytest.mark.parametrize("line", RUN_LOG.split("\n"))
    def test_a_line_of_the_run_log_is_kept(self, version_cid, line):
        result = verify_findings([log(line)], version_cid, run_log=RUN_LOG)

        assert len(result.findings) == 1
        assert result.rejected == ()

    def test_a_line_not_in_the_run_log_is_rejected(self, version_cid):
        result = verify_findings(
            [log("accuracy: 0.97")], version_cid, run_log=RUN_LOG
        )

        assert result.findings == ()
        assert LOG_LINE_REJECTED in only_reason(result)

    def test_a_substring_of_a_log_line_is_not_a_line(self, version_cid):
        result = verify_findings([log("accuracy: 0.9")], version_cid, run_log=RUN_LOG)

        assert result.findings == ()
        assert LOG_LINE_REJECTED in only_reason(result)

    def test_a_line_spanning_two_log_lines_is_rejected(self, version_cid):
        result = verify_findings(
            [log("epoch 1\naccuracy: 0.91")], version_cid, run_log=RUN_LOG
        )

        assert result.findings == ()
        assert LOG_LINE_REJECTED in only_reason(result)

    def test_with_no_run_log_every_log_line_is_rejected(self, version_cid):
        result = verify_findings([log("epoch 1")], version_cid)

        assert result.findings == ()
        assert LOG_LINE_REJECTED in only_reason(result)

    def test_an_empty_run_log_has_no_lines(self, version_cid):
        result = verify_findings([log("epoch 1")], version_cid, run_log="")

        assert result.findings == ()
        assert LOG_LINE_REJECTED in only_reason(result)


# --------------------------------------------------------------------------- #
# Result shape and mixed reports                                              #
# --------------------------------------------------------------------------- #


class TestVerificationResult:
    def test_kept_and_rejected_findings_keep_their_order(self, version_cid):
        findings = [
            span(PARAGRAPHS[0]),
            span("an invented quotation"),
            span(PARAGRAPHS[1]),
            log("a line that never printed"),
        ]

        result = verify_findings(findings, version_cid, run_log=RUN_LOG)

        assert [item.evidence.value for item in result.findings] == [
            PARAGRAPHS[0],
            PARAGRAPHS[1],
        ]
        assert [reason.split(":")[0] for reason in result.rejected] == [
            "finding 2",
            "finding 4",
        ]

    def test_the_result_unpacks_as_findings_and_reasons(self, version_cid):
        findings, rejected = verify_findings([span("invented")], version_cid)

        assert findings == ()
        assert len(rejected) == 1

    def test_result_aliases_match_the_agent_report_vocabulary(self, version_cid):
        result = verify_findings([span(PARAGRAPHS[0]), span("invented")], version_cid)

        assert result.verified == result.findings
        assert result.dropped == result.rejected

    def test_an_empty_report_verifies_to_nothing(self, version_cid):
        assert verify_findings([], version_cid) == VerificationResult((), ())

    def test_a_non_finding_is_a_type_error(self, version_cid):
        with pytest.raises(TypeError):
            verify_findings(["not a finding"], version_cid)  # type: ignore[list-item]

    def test_verification_does_not_alter_the_findings(self, version_cid):
        original = span(PARAGRAPHS[0])

        result = verify_findings([original], version_cid)

        assert result.findings == (original,)
        assert result.findings[0] is original


class TestEvidenceVerifier:
    def test_it_can_check_one_finding_at_a_time(self, version_cid):
        verifier = ai_review.EvidenceVerifier(version_cid, run_log=RUN_LOG)

        assert verifier.accepts(span(PARAGRAPHS[0]))
        assert verifier.rejection_reason(span(PARAGRAPHS[0])) is None
        assert not verifier.accepts(log("never printed"))
        assert verifier.rejection_reason(log("never printed")) == LOG_LINE_REJECTED

    def test_each_evidence_kind_is_checked_against_its_own_corpus(self, version_cid):
        verifier = ai_review.EvidenceVerifier(version_cid, run_log=RUN_LOG)

        assert verifier.accepts(span(PARAGRAPHS[0]))
        assert verifier.accepts(reference("ref:0"))
        assert verifier.accepts(log("epoch 1"))
        assert not verifier.accepts(span(PARAGRAPHS[0], "ref:0"))


# --------------------------------------------------------------------------- #
# End to end with parsed agent output                                         #
# --------------------------------------------------------------------------- #


class TestParsedAgentOutput:
    def test_parse_then_verify_keeps_only_supported_findings(self, version_cid):
        reply = json.dumps(
            {
                "findings": [
                    {
                        "claim": "Too few samples.",
                        "severity": "major",
                        "confidence": "high",
                        "evidence": {"span": "10 samples"},
                    },
                    {
                        "claim": "The paper claims something it never says.",
                        "severity": "minor",
                        "confidence": "low",
                        "evidence": {"span": "this quotation is invented"},
                    },
                    {
                        "claim": "An unknown citation.",
                        "severity": "minor",
                        "confidence": "low",
                        "evidence": {"reference_id": "ref:42"},
                    },
                ]
            }
        )
        findings, dropped = ai_review.parse_findings("methodology", reply)
        assert dropped == ()

        result = verify_findings(findings, version_cid)

        assert [item.claim for item in result.findings] == ["Too few samples."]
        assert [reason.split(":")[0] for reason in result.rejected] == [
            "finding 2",
            "finding 3",
        ]

    def test_a_reports_run_log_is_the_corpus_log(self, version_cid):
        run_log = "epoch 1\naccuracy: 0.91"
        report = ai_review.run_agent(
            "reproducibility",
            version_cid,
            provider=ScriptedProvider(
                '{"findings": [{"claim": "c", "severity": "minor", '
                '"confidence": "low", "evidence": {"log_line": "accuracy: 0.91"}}]}'
            ),
            run_log=run_log,
        )

        result = verify_findings(report.findings, version_cid, run_log=run_log)

        assert len(result.findings) == 1
        assert result.rejected == ()
