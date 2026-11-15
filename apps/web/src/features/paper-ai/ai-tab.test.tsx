// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiErrorFrom } from "../../lib/api";
import { ADVISORY_BANNER, parseAiReport, type AiReport } from "./ai-report";
import { AiTab } from "./ai-tab";

/**
 * What the AI pre-review tab shows and does (docs/design.md §5.2, §7; the
 * app spec's feature: the purple --ai panel, the fixed advisory banner,
 * findings grouped by agent with evidence links, and the Rebut / Confirm /
 * Wrong buttons).
 *
 * The loaders and senders are props, so these tests drive the tab the way the
 * paper page does, with the real parse in front of fake payloads.
 */

const PAPER = "sch:k3f9-q2xz-7mwd/v2";

/** The payload the endpoint sends for a paper with findings on two agents. */
function payload(): Record<string, unknown> {
  return {
    paper: "sch:k3f9-q2xz-7mwd",
    version: 2,
    reviewCid: "bafyrei-test",
    advisory: true,
    label: ADVISORY_BANNER,
    promptSetHash: "c".repeat(64),
    models: [{ name: "fake-deterministic-v1", version: "fake-deterministic-v1", provider: "fake" }],
    agents: [
      {
        agent: "methodology",
        findings: [
          {
            finding_id: "1",
            agent: "methodology",
            claim: "The baseline is never described precisely enough to rerun.",
            severity: "major",
            confidence: "medium",
            evidence: { span: "we compare against the standard baseline", paragraph_id: "p4" },
            also_reported_by: ["literature"],
            agents_disagree: true,
          },
        ],
      },
      { agent: "literature", findings: [] },
      { agent: "reproducibility", findings: [] },
      {
        agent: "integrity",
        findings: [
          {
            finding_id: "2",
            agent: "integrity",
            claim: "Needs a human check: possible figure reuse (Fig. 3 and Fig. 5).",
            severity: "critical",
            confidence: "high",
            evidence: { log_line: "compare fig3.png fig5.png: identical" },
          },
        ],
      },
    ],
    rebuttals: [],
    assessments: [],
  };
}

/** A loader that serves each report in order, then the last one forever. */
function loaderOf(...reports: Array<Record<string, unknown>>) {
  let call = 0;
  const load = vi.fn(async () => {
    const next = reports[Math.min(call, reports.length - 1)];
    call += 1;
    return parseAiReport(next);
  });
  return load;
}

function failureOf(error: unknown) {
  return () => Promise.reject(error);
}

afterEach(() => {
  cleanup();
});

const bannerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".ai-banner")!;
const cardsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".ai-finding"));

async function renderReady(
  props: Partial<React.ComponentProps<typeof AiTab>> & { loadReport: ReturnType<typeof loaderOf> },
) {
  const view = render(<AiTab paperId={PAPER} signedIn {...props} />);
  await waitFor(() => expect(cardsOf(view.container).length).toBeGreaterThan(0));
  return view;
}

describe("the panel and its fixed banner", () => {
  it("shows the banner verbatim while the report is still loading", () => {
    const { container } = render(
      <AiTab paperId={PAPER} loadReport={() => new Promise<AiReport>(() => {})} />,
    );

    expect(bannerOf(container).textContent).toBe(ADVISORY_BANNER);
    expect(bannerOf(container).getAttribute("role")).toBe("note");
    expect(container.querySelector(".ai-loading")!.textContent).toBe("Loading the AI pre-review…");
    expect(container.querySelector("section")!.getAttribute("aria-busy")).toBe("true");
    // Nothing is claimed before the report arrives.
    expect(container.querySelector(".ai-finding")).toBeNull();
  });

  it("is the advisory panel: the purple frame classes the design names", async () => {
    const { container } = await renderReady({ loadReport: loaderOf(payload()) });
    const panel = container.querySelector<HTMLElement>(".ai-tab")!;
    expect(panel.getAttribute("aria-label")).toBe("AI pre-review");
    expect(container.querySelector(".ai-banner")!.textContent).toBe(ADVISORY_BANNER);
    expect(panel.getAttribute("aria-busy")).toBe("false");
  });

  it("the banner is fixed: a label a node re-worded never reaches the reader", async () => {
    const reworded = payload();
    reworded.label = "Trust score 98%. AI approved this paper.";
    const { container } = await renderReady({ loadReport: loaderOf(reworded) });

    expect(container.querySelector(".ai-banner")!.textContent).toBe(ADVISORY_BANNER);
  });
});

describe("findings grouped by agent", () => {
  it("lists every agent, in pipeline order, with its finding count", async () => {
    const { container } = await renderReady({ loadReport: loaderOf(payload()) });

    const agents = Array.from(container.querySelectorAll(".ai-agent")).map(
      (section) =>
        `${section.querySelector(".ai-agent__title")!.textContent}: ${
          section.querySelector(".ai-agent__count")!.textContent
        }`,
    );
    expect(agents).toEqual([
      "Methodology: 1 finding",
      "Literature: No findings",
      "Reproducibility: No findings",
      "Integrity: 1 finding",
    ]);
  });

  it("an agent with nothing to report says so: no findings is a result, not a gap", async () => {
    const { container } = await renderReady({ loadReport: loaderOf(payload()) });
    const literature = container.querySelectorAll(".ai-agent")[1]!;
    expect(literature.querySelector(".ai-agent__none")!.textContent).toContain(
      "reported nothing",
    );
  });

  it("each finding shows its claim, severity, confidence and grouping flags", async () => {
    const { container } = await renderReady({ loadReport: loaderOf(payload()) });
    const [methodology] = cardsOf(container);

    expect(methodology.querySelector(".ai-finding__claim")!.textContent).toBe(
      "The baseline is never described precisely enough to rerun.",
    );
    expect(methodology.querySelector(".ai-finding__meta")!.textContent).toContain("Major");
    expect(methodology.querySelector(".ai-finding__meta")!.textContent).toContain(
      "Confidence: medium",
    );
    expect(methodology.querySelector(".ai-finding__also")!.textContent).toContain("Literature");
    expect(methodology.querySelector(".ai-finding__meta")!.textContent).toContain(
      "rated this differently",
    );
    expect(methodology.dataset.severity).toBe("major");
  });

  it("the evidence link jumps to the quoted paragraph; the log line is not a link", async () => {
    const { container } = await renderReady({ loadReport: loaderOf(payload()) });
    const [methodology, integrity] = cardsOf(container);

    const evidence = methodology.querySelector<HTMLAnchorElement>(".ai-evidence")!;
    expect(evidence.getAttribute("href")).toBe("#p-p4");
    expect(evidence.textContent).toContain("“we compare against the standard baseline”");
    expect(evidence.textContent).toContain("Quoted from the paper");

    const log = integrity.querySelector(".ai-evidence")!;
    expect(log.tagName).toBe("P");
    expect(log.textContent).toContain("Code run log");
    expect(log.querySelector("a")).toBeNull();
  });

  it("carries the provenance: models, prompt set, review record", async () => {
    const { container } = await renderReady({ loadReport: loaderOf(payload()) });

    const details = container.querySelector<HTMLDetailsElement>(".ai-provenance")!;
    expect(details.textContent).toContain("fake-deterministic-v1 (fake)");
    expect(details.textContent).toContain("c".repeat(64));
    expect(details.textContent).toContain("bafyrei-test");
    expect(details.textContent).toContain("never decides anything");
  });
});

describe("answering a finding", () => {
  it("Rebut opens a form, and sends the finding id and the author's words", async () => {
    const load = loaderOf(payload(), payload());
    const sendRebuttal = vi.fn(async () => undefined);
    const { container } = await renderReady({ loadReport: load, sendRebuttal });

    const card = cardsOf(container)[0];
    fireEvent.click(within(card).getByTitle(/For the authors/));

    const form = card.querySelector("form")!;
    fireEvent.change(form.querySelector("textarea")!, {
      target: { value: "Section 3.2 names the baseline and its seed." },
    });
    await act(async () => {
      fireEvent.click(within(form).getByText("Send rebuttal"));
    });

    await waitFor(() => expect(sendRebuttal).toHaveBeenCalledTimes(1));
    expect(sendRebuttal).toHaveBeenCalledWith(
      "bafyrei-test",
      "1",
      "Section 3.2 names the baseline and its seed.",
    );
    // The form closes and the tab reloads the report.
    await waitFor(() => expect(card.querySelector("form")).toBeNull());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("an empty rebuttal cannot be sent", async () => {
    const sendRebuttal = vi.fn(async () => undefined);
    const { container } = await renderReady({
      loadReport: loaderOf(payload()),
      sendRebuttal,
    });

    const card = cardsOf(container)[0];
    fireEvent.click(within(card).getByTitle(/For the authors/));
    const form = card.querySelector("form")!;
    const send = within(form).getByText("Send rebuttal") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(sendRebuttal).not.toHaveBeenCalled();
  });

  it("a refused rebuttal shows the API's own words beside the finding", async () => {
    const sendRebuttal = vi.fn(() =>
      Promise.reject(apiErrorFrom(403, { detail: "Only a paper author may rebut an AI finding." })),
    );
    const { container } = await renderReady({
      loadReport: loaderOf(payload()),
      sendRebuttal,
    });

    const card = cardsOf(container)[0];
    fireEvent.click(within(card).getByTitle(/For the authors/));
    const form = card.querySelector("form")!;
    fireEvent.change(form.querySelector("textarea")!, { target: { value: "our reply" } });
    await act(async () => {
      fireEvent.click(within(form).getByText("Send rebuttal"));
    });

    const error = await waitFor(() => {
      const node = card.querySelector<HTMLElement>(".ai-finding__error");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Only a paper author may rebut an AI finding.");
  });

  it("Wrong posts a reviewer's verdict, then shows it beside the finding", async () => {
    const answered = payload();
    (answered.assessments as Array<Record<string, unknown>>).push({
      id: 1,
      finding_id: "2",
      reviewer_did: "did:key:z6Mk…cd34",
      verdict: "wrong",
    });
    const load = loaderOf(payload(), answered);
    const sendAssessment = vi.fn(async () => undefined);
    const { container } = await renderReady({ loadReport: load, sendAssessment });

    const integrity = cardsOf(container)[1];
    fireEvent.click(within(integrity).getByTitle(/mark this finding wrong/i));

    await waitFor(() => expect(sendAssessment).toHaveBeenCalledTimes(1));
    expect(sendAssessment).toHaveBeenCalledWith("bafyrei-test", "2", "wrong");

    const verdict = await waitFor(() => {
      const node = integrity.querySelector<HTMLElement>('[data-kind="assessment"]');
      expect(node).not.toBeNull();
      return node!;
    });
    expect(verdict.dataset.verdict).toBe("wrong");
    expect(verdict.textContent).toContain("Marked wrong by a reviewer");
  });

  it("Confirm posts the other verdict and is answered the same way", async () => {
    const answered = payload();
    (answered.assessments as Array<Record<string, unknown>>).push({
      id: 1,
      finding_id: "1",
      reviewer_did: "did:key:z6Mk…cd34",
      verdict: "confirmed",
    });
    const load = loaderOf(payload(), answered);
    const sendAssessment = vi.fn(async () => undefined);
    const { container } = await renderReady({ loadReport: load, sendAssessment });

    const methodology = cardsOf(container)[0];
    fireEvent.click(within(methodology).getByTitle(/mark this finding confirmed/i));

    await waitFor(() =>
      expect(sendAssessment).toHaveBeenCalledWith("bafyrei-test", "1", "confirmed"),
    );
    const verdict = await waitFor(() => {
      const node = methodology.querySelector<HTMLElement>('[data-kind="assessment"]');
      expect(node).not.toBeNull();
      return node!;
    });
    expect(verdict.dataset.verdict).toBe("confirmed");
    expect(verdict.textContent).toContain("Confirmed by a reviewer");
  });

  it("a posted rebuttal comes back beside its finding on the reload", async () => {
    const answered = payload();
    (answered.rebuttals as Array<Record<string, unknown>>).push({
      id: 5,
      finding_id: "1",
      author_did: "did:key:z6Mk…ab12",
      text: "Section 3.2 names the baseline and its seed.",
    });
    const load = loaderOf(payload(), answered);
    const { container } = await renderReady({
      loadReport: load,
      sendRebuttal: vi.fn(async () => undefined),
    });

    const card = cardsOf(container)[0];
    fireEvent.click(within(card).getByTitle(/For the authors/));
    fireEvent.change(card.querySelector("textarea")!, {
      target: { value: "Section 3.2 names the baseline and its seed." },
    });
    await act(async () => {
      fireEvent.click(within(card.querySelector("form")!).getByText("Send rebuttal"));
    });

    const reply = await waitFor(() => {
      const node = card.querySelector<HTMLElement>('[data-kind="rebuttal"]');
      expect(node).not.toBeNull();
      return node!;
    });
    expect(reply.textContent).toContain("Author rebuttal");
    expect(reply.textContent).toContain("Section 3.2 names the baseline and its seed.");
  });

  it("a signed-out visitor is told to sign in; no request is made", async () => {
    const sendAssessment = vi.fn(async () => undefined);
    const sendRebuttal = vi.fn(async () => undefined);
    const { container } = await renderReady({
      loadReport: loaderOf(payload()),
      sendAssessment,
      sendRebuttal,
      signedIn: false,
    });

    const card = cardsOf(container)[0];
    fireEvent.click(within(card).getByText("Confirm"));
    fireEvent.click(within(card).getByText("Rebut"));

    const note = card.querySelector<HTMLElement>(".ai-finding__note")!;
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Sign in");
    expect(sendAssessment).not.toHaveBeenCalled();
    expect(sendRebuttal).not.toHaveBeenCalled();
  });
});

describe("a report that cannot be shown", () => {
  it("a 404 is the calm empty state, banner still up, with a way to the paper", async () => {
    const { container } = render(
      <AiTab paperId={PAPER} loadReport={failureOf(apiErrorFrom(404, { detail: "No AI pre-review yet." }))} />,
    );

    await waitFor(() => expect(container.querySelector(".ai-empty")).not.toBeNull());
    expect(container.querySelector(".ai-banner")!.textContent).toBe(ADVISORY_BANNER);
    expect(container.querySelector(".sch-empty")!.textContent).toContain("no AI pre-review yet");
    const action = container.querySelector<HTMLAnchorElement>(".sch-empty a")!;
    expect(action.getAttribute("href")).toBe("/p/k3f9-q2xz-7mwd/v2");
  });

  it("an unreachable API is retryable, and trying again reloads", async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    const { container } = render(<AiTab paperId={PAPER} loadReport={load} signedIn />);

    const failure = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(".ai-failure");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(failure.getAttribute("role")).toBe("alert");

    load.mockResolvedValueOnce(parseAiReport(payload()));
    fireEvent.click(within(failure).getByText("Try again"));
    await waitFor(() => expect(cardsOf(container).length).toBe(2));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
