// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChecksVersionRef, FileSafety, VersionChecks } from "./checks";
import { ChecksStep } from "./checks-step";

const REF: ChecksVersionRef = { paper: "sch:abcd-efgh-ijkl", version: 1 };
const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const ZIP = "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy";

afterEach(cleanup);

function file(overrides: Partial<FileSafety> = {}): FileSafety {
  return {
    path: "paper.pdf",
    cid: PDF,
    role: "pdf",
    status: "passed",
    failedChecks: [],
    detail: null,
    ...overrides,
  };
}

function checks(overrides: Partial<VersionChecks> = {}): VersionChecks {
  return {
    paper: REF.paper,
    version: REF.version,
    versionCid: "bafyreiexample",
    state: "moderation",
    files: [file()],
    referencesTotal: 10,
    referencesUnresolved: 0,
    similarityPct: 4.2,
    metadataMatch: true,
    signedTitle: "Sparse Probing of Reward Models",
    firstPageTitle: null,
    checkedAt: null,
    ...overrides,
  };
}

function results(): HTMLElement {
  return screen.getByRole("region", { name: "What the node found" });
}

/** Render the step against a fixed report; the caller waits for a value it expects. */
function renderReport(
  report: VersionChecks,
  props: Partial<React.ComponentProps<typeof ChecksStep>> = {},
): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn().mockResolvedValue(report);
  render(<ChecksStep checksFor={REF} fetchChecks={fetcher} pollMs={0} {...props} />);
  return fetcher;
}

describe("ChecksStep — the four results", () => {
  it("shows file safety, references, similarity and metadata with a word for every verdict", async () => {
    renderReport(checks());
    await screen.findByText("All 4 checks passed.");

    expect(screen.getByRole("heading", { level: 2, name: "Checks" })).toBeTruthy();
    const region = results();
    expect(within(region).getByText("File safety")).toBeTruthy();
    expect(within(region).getByText("References")).toBeTruthy();
    expect(within(region).getByText("Similarity")).toBeTruthy();
    expect(within(region).getByText("Metadata match")).toBeTruthy();

    expect(within(region).getByText("The file passed the safety scan")).toBeTruthy();
    expect(within(region).getByText("10 of 10 references resolved")).toBeTruthy();
    expect(within(region).getByText("Low overlap: 4.2%")).toBeTruthy();
    expect(within(region).getByText("Title found on page 1")).toBeTruthy();

    // The chip says it in words; the icon is never the only signal.
    expect(within(region).getByText("Matched")).toBeTruthy();
    expect(within(region).getByText("Resolved")).toBeTruthy();
    expect(within(region).getByText("Low overlap").tagName).toBe("SPAN");
  });

  it("lists every file with its own scan verdict", async () => {
    renderReport(
      checks({
        state: "scanning",
        files: [file(), file({ path: "code.zip", cid: ZIP, role: "code", status: "scanning" })],
      }),
    );

    const rows = await screen.findByRole("list", { name: "Files and their safety scan" });
    await within(rows).findByText("Scanning");
    const items = within(rows).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("paper.pdf"),
      expect.stringContaining("code.zip"),
    ]);
    expect(within(rows).getByText("Passed")).toBeTruthy();
    expect(within(rows).getByText("Scanning")).toBeTruthy();
  });

  it("names the failing check and offers the place to replace the file", async () => {
    const onFixFiles = vi.fn();
    const onFixDetails = vi.fn();
    renderReport(
      checks({
        state: "held",
        files: [file({ status: "failed", failedChecks: ["javascript", "hidden_text"] })],
        metadataMatch: false,
        signedTitle: "Sparse Probing of Reward Models",
      }),
      { onFixFiles, onFixDetails },
    );

    await screen.findByText("Title not found on page 1");
    const region = results();
    expect(within(region).getByText("The file failed the safety scan")).toBeTruthy();
    expect(
      within(region).getByText(
        "paper.pdf failed the safety scan: JavaScript and hidden or near-invisible text.",
      ),
    ).toBeTruthy();
    expect(within(region).getAllByText("Needs fixing")).toHaveLength(2);

    fireEvent.click(within(region).getByRole("button", { name: "Replace in Files" }));
    expect(onFixFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(within(region).getByRole("button", { name: "Edit the title" }));
    expect(onFixDetails).toHaveBeenCalledTimes(1);
  });

  it("shows unresolved references and high overlap as signals, not blockers", async () => {
    const onContinue = vi.fn();
    renderReport(
      checks({ referencesTotal: 10, referencesUnresolved: 4, similarityPct: 42 }),
      { onContinue },
    );

    await screen.findByText("High overlap: 42%");
    const region = results();
    expect(within(region).getByText("6 of 10 references resolved")).toBeTruthy();
    expect(within(region).getByText("Unresolved")).toBeTruthy();
    expect(
      within(region).getByText("Unresolved references do not stop submission; they are shown to you and to moderators."),
    ).toBeTruthy();

    const next = screen.getByRole("button", { name: "Continue to Sign" });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(next);
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ referencesUnresolved: 4 }));
  });
});

describe("ChecksStep — waiting, errors and continuing", () => {
  it("shows the four checks as not run, with the draft files, before a version exists", () => {
    render(<ChecksStep files={[{ path: "paper.pdf", cid: PDF, role: "pdf" }]} />);

    expect(screen.getByText(/The checks run on the signed version/)).toBeTruthy();
    expect(screen.getAllByText("Not run yet")).toHaveLength(4);
    const rows = screen.getByRole("list", { name: "Files and their safety scan" });
    expect(within(rows).getByText("paper.pdf")).toBeTruthy();
    expect(within(rows).getByText("Not scanned yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue to Sign" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Checks have not run yet. They start when the version is signed.")).toBeTruthy();
  });

  it("says the checks start after consent when the version is waiting for co-authors", async () => {
    renderReport(
      checks({
        state: "awaiting_consent",
        files: [file({ status: "pending" })],
        referencesTotal: null,
        referencesUnresolved: null,
        similarityPct: null,
        metadataMatch: null,
      }),
    );
    expect(
      (await screen.findAllByText("Checks start once every co-author has consented.")).length,
    ).toBeGreaterThan(0);
  });

  it("disables Continue while a check is still running", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      checks({ state: "scanning", files: [file({ status: "scanning" })], similarityPct: null }),
    );
    render(<ChecksStep checksFor={REF} fetchChecks={fetcher} pollMs={0} onContinue={vi.fn()} />);

    await screen.findByText("2 of 4 checks passed. Still running.");
    expect((screen.getByRole("button", { name: "Continue to Sign" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Checks are still running. This page updates by itself.").length).toBeGreaterThan(0);
  });

  it("keeps the last results when a refresh fails, and offers Check again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(checks())
      .mockRejectedValueOnce(new Error("offline"));
    render(<ChecksStep checksFor={REF} fetchChecks={fetcher} pollMs={0} />);

    expect(await screen.findByText("All 4 checks passed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not check this version. Trying again shortly.");
    expect(screen.getByText("All 4 checks passed.")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("says it is asking the node while the first request is in flight", () => {
    const fetcher = vi.fn(() => new Promise<VersionChecks>(() => undefined));
    render(<ChecksStep checksFor={REF} fetchChecks={fetcher} pollMs={0} />);
    expect(screen.getByText("Asking the node for this version's checks…")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "What the node found" }).getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("goes back to Authors", async () => {
    const onBack = vi.fn();
    renderReport(checks(), { onBack });
    await screen.findByText("All 4 checks passed.");
    fireEvent.click(screen.getByRole("button", { name: "Back to Authors" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
