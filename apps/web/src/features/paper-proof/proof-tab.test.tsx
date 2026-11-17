// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkError } from "../../lib/api";
import { TOAST_REGION_ID } from "../ui-kit";
import { buildPaper, bytesOf } from "./proof-fixtures";
import { LOCAL_PRESERVATION } from "./preservation";
import { ProofTab } from "./proof-tab";
import type { ProofSource, SignedRecord } from "./source";
import type { RecordProofInfo } from "./anchor";

const paper = buildPaper({ authors: 3, versions: 2 });
const V2 = `${paper.shortId}/v2`;
const NODE = "https://node.example";

const ANCHORED: RecordProofInfo = {
  seq: 12,
  anchor: {
    status: "anchored",
    anchoredAt: "2027-03-02T04:00:00Z",
    chain: "8453",
    batch: "18211",
    txUrl: "https://basescan.org/tx/0xabc",
  },
};

function sourceOf(records: readonly SignedRecord[] = paper.records, extra: Partial<ProofSource> = {}) {
  const loadRecords = vi.fn(async () => records);
  return {
    source: { loadRecords, loadPreservation: async () => LOCAL_PRESERVATION, ...extra } as ProofSource,
    loadRecords,
  };
}

/** The node holds exactly the paper's files. */
const holdsFiles: ProofSource["loadFile"] = async (cid) => {
  const manifests = paper.records.filter((record) => record.type === "manifest");
  for (const manifest of manifests) {
    const hit = (manifest.body as { files: Array<{ cid: string; path: string }> }).files.find(
      (file) => file.cid === cid,
    );
    if (hit) return paper.files.find((file) => file.path === hit.path)!.bytes;
  }
  return null;
};

const verdictOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".pt-verdict")!;
const lines = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".pt-item")).map((item) => ({
    key: item.dataset.key,
    state: item.dataset.state,
    text: item.querySelector(".pt-item__text")!.textContent,
  }));

async function renderTab(
  props: Partial<React.ComponentProps<typeof ProofTab>> & { source: ProofSource },
) {
  const view = render(<ProofTab schId={V2} nodeUrl={NODE} {...props} />);
  await waitFor(() => expect(verdictOf(view.container).dataset.state).not.toBe("checking"));
  return view;
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  document.getElementById(TOAST_REGION_ID)?.remove();
  vi.restoreAllMocks();
});

describe("while it checks", () => {
  it("says it is checking in the browser, and is busy", () => {
    const pending = { loadRecords: () => new Promise<SignedRecord[]>(() => {}) };
    const { container } = render(<ProofTab schId={V2} source={pending} nodeUrl={NODE} />);

    const verdict = verdictOf(container);
    expect(verdict.getAttribute("role")).toBe("status");
    expect(verdict.dataset.state).toBe("checking");
    expect(verdict.textContent).toContain("Checking in your browser…");
    expect(container.querySelector("section")!.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".pt-checklist")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".pt-button")!.disabled).toBe(true);
  });

  it("keeps the same live region from 'Checking…' to the verdict, so the verdict is announced", async () => {
    let finish!: (records: SignedRecord[]) => void;
    const slow = {
      loadRecords: () => new Promise<SignedRecord[]>((resolve) => (finish = resolve)),
    };
    const { container } = render(<ProofTab schId={V2} source={slow} nodeUrl={NODE} />);
    const before = verdictOf(container);

    await act(async () => finish(paper.records));
    await waitFor(() => expect(before.dataset.state).toBe("anchor_pending"));

    expect(verdictOf(container)).toBe(before);
    expect(before.textContent).toContain("Verified · 8 author signatures across 2 versions");
  });
});

describe("a paper that verifies", () => {
  it("shows the plain lines: the five of design.md §5.3 plus the ledger and preservation", async () => {
    const { source } = sourceOf(paper.records, { loadFile: holdsFiles });
    const { container } = await renderTab({ source });

    expect(lines(container)).toEqual([
      { key: "authors", state: "pass", text: "Passed: Signed by all 3 listed authors" },
      {
        key: "history",
        state: "pass",
        text: expect.stringMatching(/^Passed: Version history is intact \(v1 → v2\)/),
      },
      { key: "files", state: "pass", text: "Passed: Files match what the authors signed (1 file)" },
      {
        key: "ledger",
        state: "pending",
        text: "Pending: Recorded in the node's public log (entry number not reported)",
      },
      {
        key: "anchor",
        state: "pending",
        text: "Pending: Timestamp anchor pending: anchoring is not enabled on this node yet",
      },
      { key: "retraction", state: "pass", text: "Passed: No retraction or correction on record" },
      {
        key: "preservation",
        state: "pending",
        // The line carries its follow-up link, so the text ends with it.
        text: expect.stringMatching(/^Pending: Preserved: 1 of 1 local copy Network details$/),
      },
    ]);
  });

  it("carries the counts, and the anchor state follows the indicator", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    const verdict = verdictOf(container);

    expect(verdict.dataset.state).toBe("anchor_pending");
    expect(verdict.dataset.tone).toBe("pending");
    expect(verdict.textContent).toContain("Verified · 8 author signatures across 2 versions");
    expect(verdict.textContent).toContain("Anchoring is not enabled on this node yet");
    expect(verdict.textContent).not.toContain("within the hour");
    expect(container.querySelector("section")!.getAttribute("aria-busy")).toBe("false");
  });

  it("links the preservation line to /network in this tab, not a new one", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });

    const network = container.querySelector<HTMLAnchorElement>('.pt-item[data-key="preservation"] .pt-link')!;
    expect(network.textContent).toContain("Network details");
    expect(network.getAttribute("href")).toBe("/network");
    expect(network.getAttribute("target")).toBeNull();
    expect(network.getAttribute("rel")).toBeNull();
    // The external-link markers belong to the transaction link only.
    expect(network.textContent).not.toContain("↗");
  });

  it("is green, with a safe link to the transaction, once anchored", async () => {
    const { source } = sourceOf(paper.records, { loadRecordProof: async () => ANCHORED });
    const { container } = await renderTab({ source });
    const verdict = verdictOf(container);

    expect(verdict.dataset.state).toBe("verified");
    expect(verdict.dataset.tone).toBe("verified");
    expect(verdict.textContent).toContain("Verified in your browser");
    expect(verdict.textContent).toContain("Verified · 8 author signatures across 2 versions");

    const link = container.querySelector<HTMLAnchorElement>('.pt-item[data-key="anchor"] .pt-link')!;
    expect(link.textContent).toContain("View transaction");
    expect(link.getAttribute("href")).toBe("https://basescan.org/tx/0xabc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(lines(container)[4].text).toContain("Timestamp anchored: 2 Mar 2027 04:00 UTC");
    expect(lines(container)[3].text).toContain("Recorded in the node's public log (entry #12)");
  });

  it("gives every line an icon of its own shape and hides the icons from assistive technology", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    for (const icon of container.querySelectorAll(".pt-item__icon, .pt-verdict__icon")) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
    const shapes = Array.from(container.querySelectorAll(".pt-item__icon")).map((icon) => icon.innerHTML);
    // pass ≠ pending: the amber line cannot be mistaken for a green one without colour.
    expect(shapes[0]).toBe(shapes[1]);
    expect(shapes[3]).not.toBe(shapes[0]);
  });

  it("warns, rather than fails, when the files themselves were not compared", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    expect(lines(container)[2]).toMatchObject({ key: "files", state: "warn" });
    expect(lines(container)[2].text).toContain("not compared here");
    expect(verdictOf(container).dataset.state).toBe("anchor_pending");
  });
});

describe("technical details", () => {
  it("is collapsed when all is well, and holds the ids, the checks and the offline command", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    const details = container.querySelector<HTMLDetailsElement>(".pt-details")!;

    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Technical details");

    const rows = Object.fromEntries(
      Array.from(details.querySelectorAll<HTMLElement>(".pt-tech__row")).map((row) => [
        row.dataset.key,
        row.querySelector<HTMLElement>(".pt-tech__label")!.textContent,
      ]),
    );
    expect(rows).toMatchObject({
      version: "Version record",
      manifest: "Manifest",
      paper: "Paper record",
      anchor: "Anchor",
      "signer-1": "Signer 1",
    });

    expect(Array.from(details.querySelectorAll(".pt-check__name")).map((n) => n.textContent)).toEqual([
      "chain",
      "signatures",
      "prev_hashes",
      "consents",
      "manifests",
      "supersession",
    ]);
    // The "How to verify" item of the Download menu sends readers here, so the
    // section has both commands: the archive they downloaded (no network) and
    // the online form. The archive name matches the menu's own command.
    const offline = details.querySelector<HTMLElement>(".pt-offline")!;
    expect(offline.textContent).toContain("Offline check");
    const commands = Array.from(offline.querySelectorAll<HTMLElement>(".pt-copy__value")).map(
      (value) => value.textContent,
    );
    expect(commands).toEqual([
      `scholium verify sch-${paper.shortId.replace(/^sch:/, "")}.car`,
      `scholium verify ${V2} --node ${NODE}`,
    ]);
  });

  it("shows long ids shortened, with the whole id as the tooltip and the button's name", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    const button = container.querySelector<HTMLButtonElement>('[data-key="version"] .pt-copy')!;

    expect(button.querySelector(".pt-copy__value")!.textContent).toMatch(/^bafyrei….{4}$/);
    expect(button.title).toBe(paper.versionIds[1]);
    expect(button.getAttribute("aria-label")).toBe(`Copy Version record: ${paper.versionIds[1]}`);
  });

  it("copies the whole value, says 'Copied', and shows a tick", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    const button = container.querySelector<HTMLButtonElement>('[data-key="version"] .pt-copy')!;

    fireEvent.click(button);

    await waitFor(() => expect(button.dataset.copied).toBe("true"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(paper.versionIds[1]);
    expect(document.getElementById(TOAST_REGION_ID)!.textContent).toBe("Copied");
  });

  it("copies the offline command exactly as shown", async () => {
    const { source } = sourceOf();
    const { container } = await renderTab({ source });

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '.pt-offline [aria-label^="Copy the online command"]',
      )!,
    );

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`scholium verify ${V2} --node ${NODE}`),
    );
  });

  it("does not claim a copy the browser refused", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    // jsdom has no `document.execCommand`, so the legacy fallback refuses too.
    expect(typeof document.execCommand).not.toBe("function");
    const { source } = sourceOf();
    const { container } = await renderTab({ source });
    const button = container.querySelector<HTMLButtonElement>('[data-key="version"] .pt-copy')!;

    fireEvent.click(button);

    await waitFor(() => expect(document.getElementById(TOAST_REGION_ID)?.textContent).toBe("Couldn't copy"));
    expect(button.dataset.copied).toBe("false");
  });
});

describe("a paper that does not match what the authors signed", () => {
  const altered = paper.records.map((record) =>
    record.id === paper.versionIds[1]
      ? { ...record, body: { ...(record.body as object), title: "Altered after signing" } }
      : record,
  );

  it("is 'Verification failed', red, and opens the findings", async () => {
    const { source } = sourceOf(altered);
    const { container } = await renderTab({ source });
    const verdict = verdictOf(container);

    expect(verdict.dataset.state).toBe("failed");
    expect(verdict.dataset.tone).toBe("critical");
    expect(verdict.textContent).toContain("Verification failed");
    expect(verdict.textContent).toContain("Do not rely on it");
    expect(container.querySelector<HTMLDetailsElement>(".pt-details")!.open).toBe(true);
  });

  it("says which line failed, in words, with the finding under it", async () => {
    const { source } = sourceOf(altered);
    const { container } = await renderTab({ source });
    const authors = container.querySelector<HTMLElement>('[data-key="authors"]')!;

    expect(authors.dataset.state).toBe("fail");
    expect(authors.querySelector(".pt-item__text")!.textContent).toBe(
      "Failed: A record was altered, or its signature does not match its author",
    );
    expect(authors.querySelector(".pt-item__details")!.textContent).toMatch(
      /id does not match the hash of its content/,
    );
    // Words, not colour: the technical list says FAILED too.
    expect(container.querySelector('.pt-check[data-passed="false"] .pt-check__result')!.textContent).toBe(
      "FAILED",
    );
  });

  it("fails on a file whose bytes are not the signed ones", async () => {
    const { source } = sourceOf(paper.records, {
      loadFile: async () => bytesOf("not the manuscript"),
    });
    const { container } = await renderTab({ source });

    expect(verdictOf(container).dataset.state).toBe("failed");
    expect(lines(container)[2]).toMatchObject({ key: "files", state: "fail" });
  });
});

describe("a check that could not run", () => {
  it("is 'Could not check', grey, never red, and says it is not a failure", async () => {
    const source: ProofSource = {
      loadRecords: async () => {
        throw new NetworkError("https://node.example/v1/sync/range");
      },
    };
    const { container } = await renderTab({ source });
    const verdict = verdictOf(container);

    expect(verdict.dataset.state).toBe("cannot_verify");
    expect(verdict.dataset.tone).toBe("neutral");
    expect(verdict.textContent).toContain("Could not check");
    expect(verdict.textContent).toContain("You may be offline. This is not a failure.");
    expect(container.querySelector(".pt-checklist")).toBeNull();
  });

  it("opens the offline command, which is the way forward", async () => {
    const source: ProofSource = { loadRecords: async () => [] };
    const { container } = await renderTab({ source });

    expect(container.querySelector<HTMLDetailsElement>(".pt-details")!.open).toBe(true);
    // Both ways forward are shown: the archive (no network) and the node.
    const values = Array.from(
      container.querySelectorAll<HTMLElement>(".pt-offline .pt-copy__value"),
    ).map((value) => value.textContent);
    expect(values).toEqual([
      `scholium verify sch-${paper.shortId.replace(/^sch:/, "")}.car`,
      `scholium verify ${paper.shortId}/v2 --node ${NODE}`,
    ]);
    expect(container.querySelector(".pt-checks")).toBeNull();
  });
});

describe("re-running the check", () => {
  it("checks again, and the button is off while it runs", async () => {
    // The second run is held open so "while it runs" can be observed.
    let release: (() => void) | null = null;
    let hold: Promise<void> | null = null;
    const loadRecords = vi.fn(async () => {
      if (hold !== null) await hold;
      return paper.records;
    });
    const { container } = await renderTab({ source: { loadRecords } });
    const button = container.querySelector<HTMLButtonElement>(".pt-button")!;
    expect(button.textContent).toBe("Re-run check");
    expect(button.disabled).toBe(false);

    hold = new Promise<void>((resolve) => (release = resolve));
    fireEvent.click(button);
    await waitFor(() => expect(verdictOf(container).dataset.state).toBe("checking"));
    expect(button.disabled).toBe(true);
    expect(container.querySelector(".pt-checklist")).toBeNull();

    await act(async () => release!());
    await waitFor(() => expect(verdictOf(container).dataset.state).toBe("anchor_pending"));
    expect(loadRecords).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
  });

  it("shows the new answer when the node's answer changed", async () => {
    let records: readonly SignedRecord[] = [];
    const loadRecords = vi.fn(async () => records);
    const { container } = await renderTab({ source: { loadRecords } });
    expect(verdictOf(container).dataset.state).toBe("cannot_verify");

    records = paper.records;
    fireEvent.click(container.querySelector<HTMLButtonElement>(".pt-button")!);

    await waitFor(() => expect(verdictOf(container).dataset.state).toBe("anchor_pending"));
  });
});

describe("telling the paper page", () => {
  it("reports 'checking' and then the verdict, with the outcome", async () => {
    const onStateChange = vi.fn();
    const { source } = sourceOf();
    await renderTab({ source, onStateChange });

    await waitFor(() => expect(onStateChange).toHaveBeenCalledTimes(2));
    expect(onStateChange.mock.calls[0]).toEqual(["checking", null]);
    expect(onStateChange.mock.calls[1][0]).toBe("anchor_pending");
    expect(onStateChange.mock.calls[1][1]).toMatchObject({ state: "anchor_pending", schId: V2 });
  });

  it("does not restart the check when only the callback changes", async () => {
    const { source, loadRecords } = sourceOf();
    const view = await renderTab({ source, onStateChange: vi.fn() });
    view.rerender(<ProofTab schId={V2} source={source} nodeUrl={NODE} onStateChange={vi.fn()} />);
    await act(async () => {});
    expect(loadRecords).toHaveBeenCalledTimes(1);
  });

  it("does not restart the check for an inline authorities list with the same members", async () => {
    const { source, loadRecords } = sourceOf();
    const view = await renderTab({ source, authorities: ["did:key:a"] });
    view.rerender(<ProofTab schId={V2} source={source} nodeUrl={NODE} authorities={["did:key:a"]} />);
    await act(async () => {});
    expect(loadRecords).toHaveBeenCalledTimes(1);
  });

  it("checks again for a different paper version", async () => {
    const { source, loadRecords } = sourceOf();
    const view = await renderTab({ source });
    view.rerender(<ProofTab schId={`${paper.shortId}/v1`} source={source} nodeUrl={NODE} />);
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(verdictOf(view.container).dataset.state).toBe("anchor_pending"));
  });
});

describe("leaving mid-check", () => {
  it("aborts the request and reports nothing afterwards", async () => {
    let signal: AbortSignal | undefined;
    let finish!: (records: SignedRecord[]) => void;
    const onStateChange = vi.fn();
    const source: ProofSource = {
      loadRecords: (_ref, given) => {
        signal = given;
        return new Promise<SignedRecord[]>((resolve) => (finish = resolve));
      },
    };
    const view = render(<ProofTab schId={V2} source={source} nodeUrl={NODE} onStateChange={onStateChange} />);
    expect(signal?.aborted).toBe(false);

    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => finish(paper.records));
    expect(onStateChange.mock.calls.map((call) => call[0])).toEqual(["checking"]);
  });
});

describe("under React StrictMode (next.config.js sets reactStrictMode)", () => {
  it("settles on the verdict even though development runs the effect twice", async () => {
    const onStateChange = vi.fn();
    const signals: AbortSignal[] = [];
    const loadRecords = vi.fn(async (_ref: unknown, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return paper.records;
    });
    const { container } = render(
      <StrictMode>
        <ProofTab schId={V2} source={{ loadRecords }} nodeUrl={NODE} onStateChange={onStateChange} />
      </StrictMode>,
    );

    await waitFor(() => expect(verdictOf(container).dataset.state).toBe("anchor_pending"));
    expect(container.querySelector("section")!.getAttribute("aria-busy")).toBe("false");
    expect(lines(container)).toHaveLength(7);
    // The first run was abandoned, the second one is the answer.
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[signals.length - 1].aborted).toBe(false);
    // Exactly one verdict is reported, and it is the last thing reported.
    const reported = onStateChange.mock.calls.map((call) => call[0]);
    expect(reported.filter((state) => state !== "checking")).toEqual(["anchor_pending"]);
    expect(reported[reported.length - 1]).toBe("anchor_pending");
  });
});

describe("a link that is not a paper id", () => {
  it("shows a notice, not a crash, and checks nothing", () => {
    const { source, loadRecords } = sourceOf();
    const { container } = render(<ProofTab schId="sch:aaaa-bbbb-cccc" source={source} />);

    const notice = container.querySelector(".pt-notice")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("That is not a paper id");
    expect(container.querySelector(".pt-verdict")).toBeNull();
    expect(loadRecords).not.toHaveBeenCalled();
  });
});
