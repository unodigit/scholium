"""Tests for the finding shape and parsing an agent's reply (feature 117).

Covers: findings with claim, severity, confidence and exactly one kind of
evidence (span, reference_id or log_line); a reply that is not a JSON
``findings`` list is an error; malformed findings are dropped with a reason
instead of being kept or silently lost.
"""

from __future__ import annotations

import json

import pytest

from app.modules import ai_review
from app.modules.ai_review import (
    AgentOutputError,
    Evidence,
    Finding,
    parse_findings,
)


def finding(**overrides) -> dict:
    base = {
        "claim": "The paper reports no baseline.",
        "severity": "major",
        "confidence": "medium",
        "evidence": {"span": "We compare nothing.", "paragraph_id": "p1"},
    }
    base.update(overrides)
    return base


def without(*keys: str) -> dict:
    """A well-formed finding with ``keys`` removed."""
    return {key: value for key, value in finding().items() if key not in keys}


def reply(*findings: dict) -> str:
    return json.dumps({"findings": list(findings)})


# --------------------------------------------------------------------------- #
# Evidence and Finding                                                        #
# --------------------------------------------------------------------------- #


class TestEvidence:
    @pytest.mark.parametrize(
        ("kwargs", "kind"),
        [
            ({"span": "quoted"}, "span"),
            ({"span": "quoted", "paragraph_id": "p1"}, "span"),
            ({"reference_id": "ref:3"}, "reference_id"),
            ({"log_line": "ERROR: ModuleNotFoundError"}, "log_line"),
        ],
    )
    def test_exactly_one_kind(self, kwargs, kind):
        evidence = Evidence(**kwargs)

        assert evidence.kind == kind
        assert evidence.value == kwargs[kind]
        assert kind in evidence.to_dict()

    def test_kinds_are_the_three_from_the_spec(self):
        assert ai_review.EVIDENCE_KINDS == ("span", "reference_id", "log_line")

    def test_no_evidence_is_rejected(self):
        with pytest.raises(ValueError, match="exactly one"):
            Evidence()

    def test_blank_evidence_is_rejected(self):
        with pytest.raises(ValueError, match="exactly one"):
            Evidence(span="   ")

    def test_two_kinds_are_rejected(self):
        with pytest.raises(ValueError, match="exactly one"):
            Evidence(span="quoted", reference_id="ref:0")

    def test_paragraph_id_needs_a_span(self):
        with pytest.raises(ValueError, match="paragraph_id"):
            Evidence(reference_id="ref:0", paragraph_id="p1")

    def test_to_dict_keeps_only_the_keys_that_are_set(self):
        assert Evidence(span="quoted").to_dict() == {"span": "quoted"}
        assert Evidence(span="quoted", paragraph_id="p1").to_dict() == {
            "span": "quoted",
            "paragraph_id": "p1",
        }


class TestFinding:
    def test_to_dict_is_json_ready_with_an_evidence_object(self):
        item = Finding(
            agent="methodology",
            claim="No baseline.",
            severity="major",
            confidence="high",
            evidence=Evidence(span="quoted", paragraph_id="p1"),
        )

        assert item.to_dict() == {
            "agent": "methodology",
            "claim": "No baseline.",
            "severity": "major",
            "confidence": "high",
            "evidence": {"span": "quoted", "paragraph_id": "p1"},
        }
        assert json.loads(json.dumps(item.to_dict())) == item.to_dict()

    def test_scales(self):
        assert ai_review.SEVERITIES == ("info", "minor", "major", "critical")
        assert ai_review.CONFIDENCES == ("low", "medium", "high")

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"claim": ""},
            {"claim": "   "},
            {"severity": "severe"},
            {"confidence": "certain"},
        ],
    )
    def test_invalid_values_are_rejected(self, kwargs):
        values = {
            "agent": "integrity",
            "claim": "A claim.",
            "severity": "minor",
            "confidence": "low",
            "evidence": Evidence(span="quoted"),
        }
        values.update(kwargs)

        with pytest.raises(ValueError):
            Finding(**values)


# --------------------------------------------------------------------------- #
# parse_findings                                                              #
# --------------------------------------------------------------------------- #


class TestParseFindings:
    def test_a_well_formed_reply_gives_findings_with_the_callers_agent(self):
        findings, dropped = parse_findings("methodology", reply(finding()))

        assert dropped == ()
        assert findings == (
            Finding(
                agent="methodology",
                claim="The paper reports no baseline.",
                severity="major",
                confidence="medium",
                evidence=Evidence(span="We compare nothing.", paragraph_id="p1"),
            ),
        )

    def test_each_kind_of_evidence_is_parsed(self):
        findings, dropped = parse_findings(
            "literature",
            reply(
                finding(evidence={"span": "quoted", "paragraph_id": "p9"}),
                finding(evidence={"reference_id": "ref:4"}),
                finding(evidence={"log_line": "Traceback (most recent call last):"}),
            ),
        )

        assert dropped == ()
        assert [item.evidence.kind for item in findings] == [
            "span",
            "reference_id",
            "log_line",
        ]
        assert findings[1].evidence.reference_id == "ref:4"
        assert findings[2].evidence.log_line == "Traceback (most recent call last):"

    def test_an_empty_findings_list_is_a_valid_reply(self):
        assert parse_findings("integrity", '{"findings": []}') == ((), ())

    def test_agent_in_the_reply_is_ignored(self):
        findings, _ = parse_findings("integrity", reply(finding(agent="methodology")))

        assert findings[0].agent == "integrity"

    def test_severity_and_confidence_are_case_insensitive(self):
        findings, dropped = parse_findings(
            "methodology", reply(finding(severity=" Major ", confidence="HIGH"))
        )

        assert dropped == ()
        assert (findings[0].severity, findings[0].confidence) == ("major", "high")

    def test_claim_is_trimmed_but_span_is_kept_verbatim(self):
        findings, _ = parse_findings(
            "methodology",
            reply(finding(claim="  A claim.  ", evidence={"span": " spaced  out "})),
        )

        assert findings[0].claim == "A claim."
        assert findings[0].evidence.span == " spaced  out "

    def test_unused_evidence_keys_may_be_null_or_empty(self):
        findings, dropped = parse_findings(
            "literature",
            reply(
                finding(evidence={"span": None, "reference_id": "ref:1", "log_line": ""}),
            ),
        )

        assert dropped == ()
        assert findings[0].evidence.reference_id == "ref:1"

    def test_reply_in_a_code_fence(self):
        text = "```json\n" + reply(finding()) + "\n```"

        findings, dropped = parse_findings("methodology", text)

        assert len(findings) == 1
        assert dropped == ()

    def test_reply_with_prose_around_the_object(self):
        text = "Here is my review:\n" + reply(finding()) + "\nHope this helps."

        findings, _ = parse_findings("methodology", text)

        assert len(findings) == 1

    def test_prose_with_a_stray_brace_before_the_object(self):
        text = "Note {this} first. " + reply(finding())

        findings, _ = parse_findings("methodology", text)

        assert len(findings) == 1

    def test_a_bare_list_of_findings_is_accepted(self):
        findings, _ = parse_findings("methodology", json.dumps([finding()]))

        assert len(findings) == 1

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "I could not find any problems.",
            "fake provider deterministic response\nmodel: fake-deterministic-v1",
            "{not json}",
            "42",
            '"findings"',
            '{"result": []}',
            '{"findings": "none"}',
            '{"findings": null}',
        ],
    )
    def test_a_reply_without_a_findings_list_is_an_error(self, text):
        with pytest.raises(AgentOutputError):
            parse_findings("methodology", text)

    def test_deeply_nested_reply_is_an_error_not_a_crash(self):
        with pytest.raises(AgentOutputError):
            parse_findings("methodology", "[" * 100_000)

    def test_a_non_string_reply_is_an_error(self):
        with pytest.raises(AgentOutputError):
            parse_findings("methodology", None)  # type: ignore[arg-type]

    def test_agent_output_error_is_a_value_error(self):
        assert issubclass(AgentOutputError, ValueError)


class TestDroppedFindings:
    @pytest.mark.parametrize(
        ("broken", "reason"),
        [
            (without("claim"), "missing claim"),
            (finding(claim=""), "missing claim"),
            (finding(claim=7), "missing claim"),
            (finding(severity="urgent"), "severity must be one of"),
            (finding(severity=None), "severity must be one of"),
            (without("severity"), "severity must be one of"),
            (finding(confidence=0.9), "confidence must be one of"),
            (finding(confidence="certain"), "confidence must be one of"),
            (without("confidence"), "confidence must be one of"),
            (finding(evidence=None), "evidence must be an object"),
            (finding(evidence="p1"), "evidence must be an object"),
            (finding(evidence={}), "exactly one of"),
            (finding(evidence={"span": ""}), "exactly one of"),
            (finding(evidence={"paragraph_id": "p1"}), "exactly one of"),
            (finding(evidence={"unknown": "x"}), "exactly one of"),
            (
                finding(evidence={"span": "a", "reference_id": "ref:1"}),
                "exactly one of",
            ),
            (finding(evidence={"span": 12}), "non-empty string"),
            (finding(evidence={"span": "   "}), "non-empty string"),
            (
                finding(evidence={"reference_id": "ref:1", "paragraph_id": "p1"}),
                "paragraph_id is only valid with a span",
            ),
            (
                finding(evidence={"span": "a", "paragraph_id": 5}),
                "paragraph_id must be a non-empty string",
            ),
        ],
    )
    def test_malformed_finding_is_dropped_with_a_reason(self, broken, reason):
        findings, dropped = parse_findings(
            "methodology", reply(finding(claim="Kept."), broken)
        )

        assert [item.claim for item in findings] == ["Kept."]
        assert len(dropped) == 1
        assert dropped[0].startswith("finding 2: ")
        assert reason in dropped[0]

    def test_a_finding_without_evidence_is_dropped(self):
        findings, dropped = parse_findings("methodology", reply(without("evidence")))

        assert findings == ()
        assert dropped == ("finding 1: missing evidence",)

    def test_a_finding_that_is_not_an_object_is_dropped(self):
        findings, dropped = parse_findings(
            "methodology", json.dumps({"findings": ["text", 3, None, finding()]})
        )

        assert len(findings) == 1
        assert dropped == (
            "finding 1: finding must be an object",
            "finding 2: finding must be an object",
            "finding 3: finding must be an object",
        )

    def test_every_malformed_finding_is_reported(self):
        findings, dropped = parse_findings(
            "methodology",
            reply(
                finding(severity="x"),
                finding(),
                finding(evidence={}),
            ),
        )

        assert len(findings) == 1
        assert [text.split(":")[0] for text in dropped] == ["finding 1", "finding 3"]
