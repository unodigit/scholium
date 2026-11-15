import { describe, expect, it } from "vitest";

import {
  ADVISORY_BANNER,
  AGENT_ORDER,
  agentTitle,
  confidenceLabel,
  evidenceAnchor,
  evidenceLabel,
  findingCount,
  findingCountLabel,
  parseAiReport,
  parseVerdict,
  severityLabel,
  sortAgentGroups,
  verdictLabel,
  type AiAgentGroup,
} from "./ai-report";

/**
 * `parseAiReport` reads what `GET /v1/papers/{id}/ai-reviews` sends
 * (`apps/api/.../ai_review/router.py`). The endpoint's own tests pin that
 * shape; these pin that the tab reads it — and that a payload it does not
 * recognise degrades to labels instead of an exception or a blank panel.
 */

/** A response as the endpoint sends it today, covering every field the UI reads. */
function apiPayload(): Record<string, unknown> {
  return {
    paper: "sch:k3f9-q2xz-7mwd",
    shortId: "sch:k3f9-q2xz-7mwd",
    version: 2,
    n: 2,
    reviewCid: "bafyrei…q7x2",
    review_cid: "bafyrei…q7x2",
    advisory: true,
    label: ADVISORY_BANNER,
    models: [{ name: "claude-3", version: "claude-3", provider: "anthropic" }],
    promptSetHash: "a".repeat(64),
    prompt_set_hash: "a".repeat(64),
    agents: [
      {
        agent: "integrity",
        findings: [
          {
            finding_id: "3",
            agent: "integrity",
            claim: "Needs a human check: possible figure reuse (Fig. 3 and Fig. 5).",
            severity: "major",
            confidence: "medium",
            evidence: { span: "Figure 5 repeats the plot of Figure 3", paragraph_id: "p12" },
            needs_human_check: true,
          },
        ],
      },
      { agent: "methodology", findings: [] },
      { agent: "literature", findings: [] },
      {
        agent: "reproducibility",
        findings: [
          {
            id: "1",
            agent: "reproducibility",
            claim: "The stated accuracy is not reachable from the released code.",
            severity: "critical",
            confidence: "high",
            evidence: { log_line: "step 4: KeyError 'weights'" },
            also_reported_by: ["methodology"],
            agents_disagree: true,
          },
          {
            findingId: "2",
            agent: "reproducibility",
            claim: "Reference 4 does not exist in the bibliography.",
            severity: "minor",
            confidence: "low",
            evidence: { reference_id: "ref:4" },
          },
        ],
      },
    ],
    rebuttals: [
      {
        id: 7,
        review_cid: "bafyrei…q7x2",
        finding_id: "1",
        author_did: "did:key:z6Mk…ab12",
        text: "The weights are downloaded by setup.sh; see the reproduction log.",
        created_at: "2027-03-04T10:00:00",
      },
    ],
    assessments: [
      {
        id: 11,
        review_cid: "bafyrei…q7x2",
        finding_id: "2",
        reviewer_did: "did:key:z6Mk…cd34",
        verdict: "wrong",
        created_at: "2027-03-05T09:00:00",
      },
      {
        id: 12,
        review_cid: "bafyrei…q7x2",
        finding_id: "1",
        reviewer_did: "did:key:z6Mk…cd34",
        verdict: "confirmed",
        created_at: "2027-03-05T09:30:00",
      },
    ],
  };
}

describe("parseAiReport", () => {
  it("reads the report's identity: version, review cid, prompt set, models", () => {
    const report = parseAiReport(apiPayload());

    expect(report.paperId).toBe("sch:k3f9-q2xz-7mwd");
    expect(report.version).toBe(2);
    expect(report.reviewCid).toBe("bafyrei…q7x2");
    expect(report.advisory).toBe(true);
    expect(report.promptSetHash).toBe("a".repeat(64));
    expect(report.models).toEqual([
      { name: "claude-3", version: "claude-3", provider: "anthropic" },
    ]);
  });

  it("groups findings by agent, the four specialists in pipeline order first", () => {
    const report = parseAiReport(apiPayload());

    expect(report.agents.map((group) => group.agent)).toEqual([...AGENT_ORDER]);
    // The payload led with integrity; the display still leads with methodology.
    expect(report.agents[0]).toMatchObject({ agent: "methodology", findings: [] });
    expect(report.agents[2].findings).toHaveLength(2); // reproducibility
    expect(report.agents[3].findings).toHaveLength(1); // integrity
    expect(findingCount(report)).toBe(3);
  });

  it("reads a finding's id from any of the endpoint's spellings", () => {
    const report = parseAiReport(apiPayload());
    const ids = report.agents.flatMap((group) => group.findings.map((finding) => finding.id));

    expect(ids.sort()).toEqual(["1", "2", "3"]);
  });

  it("keeps each finding's evidence: span, reference id and log line", () => {
    const report = parseAiReport(apiPayload());
    const findings = report.agents.flatMap((group) => group.findings);

    const span = findings.find((finding) => finding.id === "3")!;
    expect(span.evidence).toEqual({
      kind: "span",
      value: "Figure 5 repeats the plot of Figure 3",
      paragraphId: "p12",
    });

    const reference = findings.find((finding) => finding.id === "2")!;
    expect(reference.evidence).toEqual({
      kind: "reference_id",
      value: "ref:4",
      paragraphId: null,
    });

    const log = findings.find((finding) => finding.id === "1")!;
    expect(log.evidence).toEqual({
      kind: "log_line",
      value: "step 4: KeyError 'weights'",
      paragraphId: null,
    });
  });

  it("attaches the rebuttals and assessments to their findings by id", () => {
    const report = parseAiReport(apiPayload());
    const findings = report.agents.flatMap((group) => group.findings);

    const withRebuttal = findings.find((finding) => finding.id === "1")!;
    expect(withRebuttal.rebuttals).toHaveLength(1);
    expect(withRebuttal.rebuttals[0]).toMatchObject({
      findingId: "1",
      authorDid: "did:key:z6Mk…ab12",
      text: "The weights are downloaded by setup.sh; see the reproduction log.",
    });
    expect(withRebuttal.assessments.map((entry) => entry.verdict)).toEqual(["confirmed"]);

    const markedWrong = findings.find((finding) => finding.id === "2")!;
    expect(markedWrong.assessments.map((entry) => entry.verdict)).toEqual(["wrong"]);
    expect(markedWrong.rebuttals).toEqual([]);
  });

  it("keeps the meta-reviewer's flags: also reported by, disagreement, human check", () => {
    const report = parseAiReport(apiPayload());
    const findings = report.agents.flatMap((group) => group.findings);

    const merged = findings.find((finding) => finding.id === "1")!;
    expect(merged.alsoReportedBy).toEqual(["methodology"]);
    expect(merged.agentsDisagree).toBe(true);
    expect(merged.needsHumanCheck).toBe(false);

    const integrity = findings.find((finding) => finding.id === "3")!;
    expect(integrity.needsHumanCheck).toBe(true);
  });

  it("an agent nobody knows keeps its own group, after the specialists", () => {
    const payload = apiPayload();
    const agents = payload.agents as Array<Record<string, unknown>>;
    agents.push({
      agent: "future-agent",
      findings: [{ claim: "A new agent's point", evidence: { span: "quoted" } }],
    });

    const report = parseAiReport(payload);
    expect(report.agents.map((group) => group.agent)).toEqual([
      ...AGENT_ORDER,
      "future-agent",
    ]);
    // The finding has no id of its own; its position gives it a stable one.
    expect(report.agents[4].findings[0].id).toBe("1");
  });

  it("never throws: junk degrades to an empty, still-showable report", () => {
    for (const junk of [null, 42, "nope", [], {}, { agents: "yes" }, { agents: [null, 7] }]) {
      const report = parseAiReport(junk);
      expect(report.advisory).toBe(true);
      expect(report.agents).toEqual([]);
      expect(findingCount(report)).toBe(0);
    }
  });

  it("a flat findings list still groups by the agent that reported each one", () => {
    const report = parseAiReport({
      findings: [
        { agent: "literature", claim: "A", evidence: { span: "a" } },
        { agent: "methodology", claim: "B", evidence: { span: "b" } },
      ],
    });

    expect(report.agents.map((group) => group.agent)).toEqual([
      "methodology",
      "literature",
    ]);
    expect(report.agents[0].findings[0].claim).toBe("B");
  });
});

describe("parseVerdict", () => {
  it("accepts the endpoint's spellings, and nothing else", () => {
    expect(parseVerdict("confirmed")).toBe("confirmed");
    expect(parseVerdict("Confirmed")).toBe("confirmed");
    expect(parseVerdict("confirm")).toBe("confirmed");
    expect(parseVerdict("wrong")).toBe("wrong");
    expect(parseVerdict("incorrect")).toBe("wrong");
    expect(parseVerdict(true)).toBe("confirmed");
    expect(parseVerdict("maybe")).toBeNull();
    expect(parseVerdict(4)).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});

describe("display copy", () => {
  it("titles agents", () => {
    expect(agentTitle("methodology")).toBe("Methodology");
    expect(agentTitle("reproducibility")).toBe("Reproducibility");
    expect(agentTitle("future-agent")).toBe("Future-agent");
  });

  it("labels severity, confidence, counts and verdicts in the design's voice", () => {
    expect(severityLabel("major")).toBe("Major");
    expect(confidenceLabel("medium")).toBe("Confidence: medium");
    expect(findingCountLabel(0)).toBe("No findings");
    expect(findingCountLabel(1)).toBe("1 finding");
    expect(findingCountLabel(4)).toBe("4 findings");
    expect(verdictLabel("confirmed")).toBe("Confirmed by a reviewer");
    expect(verdictLabel("wrong")).toBe("Marked wrong by a reviewer");
  });

  it("names evidence by its kind, and links only a span with its paragraph id", () => {
    expect(evidenceLabel({ kind: "span", value: "s", paragraphId: null })).toBe(
      "Quoted from the paper",
    );
    expect(evidenceLabel({ kind: "reference_id", value: "ref:2", paragraphId: null })).toBe(
      "Reference",
    );
    expect(evidenceLabel({ kind: "log_line", value: "l", paragraphId: null })).toBe(
      "Code run log",
    );

    expect(evidenceAnchor({ kind: "span", value: "s", paragraphId: "p12" })).toBe("#p-p12");
    // Without a paragraph there is nowhere to jump to.
    expect(evidenceAnchor({ kind: "span", value: "s", paragraphId: null })).toBeNull();
    expect(evidenceAnchor({ kind: "reference_id", value: "ref:2", paragraphId: null })).toBeNull();
  });

  it("sorts groups with the specialists first, in pipeline order", () => {
    const groups: AiAgentGroup[] = [
      { agent: "zz-agent", title: "Zz-agent", findings: [] },
      { agent: "integrity", title: "Integrity", findings: [] },
      { agent: "methodology", title: "Methodology", findings: [] },
    ];
    expect(sortAgentGroups(groups).map((group) => group.agent)).toEqual([
      "methodology",
      "integrity",
      "zz-agent",
    ]);
  });
});
