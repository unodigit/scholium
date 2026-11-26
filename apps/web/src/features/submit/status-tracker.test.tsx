// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeVersionChecks, type VersionChecks } from "./checks";
import type { ConsentReport, TrackerEntry } from "./consents";
import { StatusTracker } from "./status-tracker";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

afterEach(cleanup);

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ADA = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const entry = (over: Partial<TrackerEntry>): TrackerEntry => ({
  key: over.name ?? "x",
  name: "Ada Lovelace",
  monogram: "AL",
  detail: null,
  status: "waiting",
  isYou: false,
  roles: [],
  ...over,
});

const mei = (over: Partial<TrackerEntry> = {}): TrackerEntry =>
  entry({ key: ME, name: "Mei Chen", monogram: "MC", detail: "did:key:z6MkhaXg…ta2doK", isYou: true, ...over });
const ada = (over: Partial<TrackerEntry> = {}): TrackerEntry => entry({ key: ADA, ...over });

function report(over: Partial<ConsentReport> = {}): ConsentReport {
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiversion",
    state: "awaiting_consent",
    declinedBy: null,
    count: 2,
    waiting: 2,
    signed: 0,
    declined: 0,
    authors: [],
    ...over,
  };
}

function checks(over: Partial<VersionChecks> = {}): VersionChecks {
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiversion",
    state: "held",
    checksRan: true,
    files: [
      { path: "paper.pdf", cid: "bafkreipdf", role: "pdf", status: "passed", failedChecks: [], detail: null },
    ],
    referencesTotal: 10,
    referencesUnresolved: 0,
    similarityPct: 2,
    metadataMatch: true,
    signedTitle: null,
    firstPageTitle: null,
    checkedAt: null,
    ...over,
  };
}

const stage = (key: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-stage="${key}"]`);
  if (found === null) throw new Error(`no ${key} stage`);
  return found;
};

describe("StatusTracker — a stepper, not run-on text", () => {
  it("is an ordered list of the stages, in the order a version goes through them", () => {
    render(<StatusTracker submitted trackerEntries={[mei(), ada()]} report={report()} />);
    const list = screen.getByRole("list", { name: "Submission status" });
    expect(list.tagName).toBe("OL");
    const labels = within(list)
      .getAllByRole("listitem", { hidden: false })
      .filter((item) => item.hasAttribute("data-stage"))
      .map((item) => item.querySelector(".sw-status-tracker__label")?.textContent);
    expect(labels).toEqual([
      "Submitted",
      "Co-author consents",
      "Scan",
      "Moderation",
      "Listed",
      "AI pre-review",
    ]);
  });

  it("keeps each stage's label, count, state and detail in separate elements", () => {
    render(<StatusTracker submitted trackerEntries={[mei(), ada()]} report={report()} />);
    // The run-on bug: "Submitted✓", "Co-author consents (0/2)0 of 2 signed",
    // "Moderationtarget 48 h". Every piece is now its own element.
    const submitted = stage("submitted");
    expect(submitted.querySelector(".sw-status-tracker__label")?.textContent).toBe("Submitted");
    expect(submitted.querySelector(".sw-status-tracker__state")?.textContent).toBe("Done");

    const consents = stage("consents");
    expect(consents.querySelector(".sw-status-tracker__label")?.textContent).toBe("Co-author consents");
    expect(consents.querySelector(".sw-status-tracker__count")?.textContent).toBe("0/2");
    expect(consents.querySelector(".sw-status-tracker__detail")?.textContent).toBe("0 of 2 signed · 2 waiting");

    const moderation = stage("moderation");
    expect(moderation.querySelector(".sw-status-tracker__label")?.textContent).toBe("Moderation");
    expect(moderation.querySelector(".sw-status-tracker__detail")?.textContent).toBe("Target: 48 hours");
  });

  it("lists every author with their own state inside the consents stage", () => {
    render(
      <StatusTracker
        submitted
        trackerEntries={[mei({ status: "signed" }), ada({ status: "waiting" })]}
        report={report({ signed: 1, waiting: 1 })}
      />,
    );
    const rows = within(stage("consents")).getAllByRole("listitem").filter((li) => li.hasAttribute("data-status"));
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["signed", "waiting"]);
    expect(rows[0].textContent).toContain("Mei Chen (you)");
    expect(within(rows[0]).getByText("Signed")).toBeTruthy();
    expect(within(rows[1]).getByText("Waiting")).toBeTruthy();
    expect(stage("consents").querySelector(".sw-status-tracker__count")?.textContent).toBe("1/2");
  });

  it("shows the person by name with the DID as secondary text", () => {
    render(<StatusTracker submitted trackerEntries={[mei()]} report={report({ count: 1 })} />);
    const row = within(stage("consents")).getAllByRole("listitem").find((li) => li.hasAttribute("data-status"))!;
    expect(row.querySelector(".sw-tracker__name")?.textContent).toContain("Mei Chen");
    expect(row.querySelector(".sw-tracker__detail")?.textContent).toBe("did:key:z6MkhaXg…ta2doK");
    expect(row.textContent).not.toContain(ME);
  });

  it("marks the first unfinished stage as the current step, and the rest as upcoming", () => {
    render(<StatusTracker submitted trackerEntries={[mei(), ada()]} report={report()} />);
    expect(["submitted", "consents", "scan", "moderation", "listed", "ai"].map((k) => stage(k).dataset.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(stage("consents").getAttribute("aria-current")).toBe("step");
    expect(stage("scan").getAttribute("aria-current")).toBeNull();
  });

  it("follows the version through scanning, moderation and listing", () => {
    const done = [mei({ status: "signed" }), ada({ status: "signed" })];
    const states = (state: string): (string | undefined)[] => {
      const { unmount } = render(
        <StatusTracker submitted trackerEntries={done} report={report({ state, signed: 2, waiting: 0 })} />,
      );
      const result = ["consents", "scan", "moderation", "listed"].map((k) => stage(k).dataset.state);
      unmount();
      return result;
    };
    expect(states("scanning")).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(states("moderation")).toEqual(["done", "done", "current", "upcoming"]);
    expect(states("listed")).toEqual(["done", "done", "done", "done"]);
  });

  it("says a stage's state in words, so colour is never the only signal", () => {
    render(<StatusTracker submitted trackerEntries={[mei(), ada()]} report={report()} />);
    expect(stage("submitted").querySelector(".sw-status-tracker__state")?.textContent).toBe("Done");
    expect(stage("consents").querySelector(".sw-status-tracker__state")?.textContent).toBe("In progress");
    expect(stage("scan").querySelector(".sw-status-tracker__state")?.textContent).toBe("Not started");
  });

  it("flags a decline as needing attention rather than as progress", () => {
    render(
      <StatusTracker
        submitted
        trackerEntries={[mei({ status: "signed" }), ada({ status: "declined" })]}
        report={report({ state: "draft", signed: 1, declined: 1, waiting: 0 })}
      />,
    );
    expect(stage("consents").dataset.state).toBe("attention");
    expect(stage("consents").querySelector(".sw-status-tracker__state")?.textContent).toBe("Needs attention");
  });
});

describe("StatusTracker — the viewer's own consent", () => {
  it("links to the consent page when the viewer still owes a consent", () => {
    render(<StatusTracker submitted trackerEntries={[mei(), ada()]} report={report()} />);
    const link = within(stage("consents")).getByRole("link", { name: "Sign your consent" });
    expect(link.getAttribute("href")).toBe("/consent/bafyreiversion");
  });

  it("uses the version id it was given while no consent report has arrived yet", () => {
    render(<StatusTracker submitted trackerEntries={[mei()]} versionCid="bafyreisigned" />);
    expect(screen.getByRole("link", { name: "Sign your consent" }).getAttribute("href")).toBe("/consent/bafyreisigned");
  });

  it("offers no link once the viewer has signed", () => {
    render(
      <StatusTracker submitted trackerEntries={[mei({ status: "signed" }), ada()]} report={report({ signed: 1, waiting: 1 })} />,
    );
    expect(screen.queryByRole("link", { name: "Sign your consent" })).toBeNull();
  });

  it("offers no link to someone who is not an author, or when the version is back in draft", () => {
    const { unmount } = render(<StatusTracker submitted trackerEntries={[ada()]} report={report({ count: 1 })} />);
    expect(screen.queryByRole("link", { name: "Sign your consent" })).toBeNull();
    unmount();

    render(<StatusTracker submitted trackerEntries={[mei()]} report={report({ state: "draft", count: 1, declined: 1 })} />);
    expect(screen.queryByRole("link", { name: "Sign your consent" })).toBeNull();
  });

  it("offers no link when it has no version to point at", () => {
    render(<StatusTracker submitted trackerEntries={[mei()]} />);
    expect(screen.queryByRole("link", { name: "Sign your consent" })).toBeNull();
  });
});

describe("StatusTracker — a version the safety scan held", () => {
  const done = [mei({ status: "signed" }), ada({ status: "signed" })];
  const held = report({ state: "held", signed: 2, waiting: 0 });
  const scanHeld = checks({
    state: "held",
    checksRan: false,
    files: [
      {
        path: "code.zip",
        cid: "bafkreizip",
        role: "code",
        status: "failed",
        failedChecks: ["av_unavailable"],
        detail: null,
      },
    ],
    referencesTotal: null,
    referencesUnresolved: null,
    similarityPct: null,
    metadataMatch: null,
  });

  const renderHeld = (reportChecks: VersionChecks): void => {
    render(
      <StatusTracker
        submitted
        trackerEntries={done}
        report={held}
        paper="sch:abcd-efgh-ijkl"
        checks={reportChecks}
      />,
    );
  };

  it("names the failed file on the Scan step and offers a new version, not a hold to appeal", () => {
    renderHeld(scanHeld);

    const scan = stage("scan");
    expect(scan.dataset.state).toBe("attention");
    expect(scan.dataset.done).toBe("false");
    expect(scan.querySelector(".sw-status-tracker__state")?.textContent).toBe("Needs fixing");
    expect(scan.querySelector(".sw-status-tracker__detail")?.textContent).toBe(
      "code.zip failed the safety scan: a malware scan that could not run (the antivirus is unavailable).",
    );
    const link = within(scan).getByRole("link", { name: "Publish a new version" });
    expect(link.getAttribute("href")).toBe("/submit/new-version/sch%3Aabcd-efgh-ijkl");

    // Moderation never happened: it is not where the version waits.
    const moderation = stage("moderation");
    expect(moderation.dataset.state).toBe("upcoming");
    expect(moderation.dataset.done).toBe("false");
    expect(moderation.querySelector(".sw-status-tracker__state")?.textContent).toBe("Not reached");
    expect(moderation.textContent).not.toContain("Held");
  });

  it("names every failed file, one sentence each", () => {
    renderHeld(
      checks({
        checksRan: false,
        files: [
          {
            path: "code.zip",
            cid: "bafkreizip",
            role: "code",
            status: "failed",
            failedChecks: ["av_unavailable"],
            detail: null,
          },
          {
            path: "paper.pdf",
            cid: "bafkreipdf",
            role: "pdf",
            status: "failed",
            failedChecks: ["javascript"],
            detail: null,
          },
        ],
      }),
    );

    expect(stage("scan").querySelector(".sw-status-tracker__detail")?.textContent).toBe(
      "code.zip failed the safety scan: a malware scan that could not run (the antivirus is unavailable). " +
        "paper.pdf failed the safety scan: JavaScript.",
    );
  });

  it("says the advisory checks did not run rather than that they are pending", () => {
    renderHeld(scanHeld);

    expect(screen.queryByText(/Checks pending/)).toBeNull();
    const rows = new Map(
      [...document.querySelectorAll<HTMLElement>("[data-check]")].map((row) => [row.dataset.check, row]),
    );
    expect(rows.get("files")?.textContent).toContain("Needs fixing");
    for (const id of ["references", "similarity", "metadata"]) {
      expect(rows.get(id)?.textContent).toContain("Not run: the version was held at the safety scan");
    }
  });

  it("leaves a moderator's hold unchanged: the scan passed and moderation is where it waits", () => {
    renderHeld(checks());

    expect(stage("scan").dataset.state).toBe("done");
    expect(stage("scan").querySelector(".sw-status-tracker__state")?.textContent).toBe("Done");
    expect(stage("moderation").dataset.state).toBe("attention");
    expect(stage("moderation").querySelector(".sw-status-tracker__state")?.textContent).toBe("Held");
    expect(stage("moderation").querySelector(".sw-status-tracker__detail")?.textContent).toBe(
      "Not listed while the hold stands",
    );
  });
});

describe("StatusTracker — a version waiting for the node's antivirus", () => {
  const done = [mei({ status: "signed" }), ada({ status: "signed" })];
  const scanning = report({ state: "scanning", signed: 2, waiting: 0 });

  // The checks answer for a waiting version (round 27): the scan could not
  // run, so no file failed and the advisory checks have not run. Normalized
  // from the node's own payload, so this is the shape the tracker really gets.
  const waitingChecks = (): VersionChecks =>
    normalizeVersionChecks(
      {
        state: "scanning",
        scanWaiting: true,
        scan_waiting: true,
        waitingReason: "antivirus_unavailable",
        checksRan: false,
        files: [
          { path: "paper.pdf", cid: "bafkreipdf", role: "pdf", status: "passed", failedChecks: [], detail: null },
          {
            path: "bundle.zip",
            cid: "bafkreizip",
            role: "code",
            status: "waiting",
            failedChecks: ["av_unavailable"],
            detail: "the antivirus is unavailable",
          },
        ],
        referencesTotal: null,
        referencesUnresolved: null,
        similarityPct: null,
        metadataMatch: null,
      },
      { paper: "sch:abcd-efgh-ijkl", version: 1 },
    );

  const renderWaiting = (checksReport: VersionChecks): void => {
    render(
      <StatusTracker
        submitted
        trackerEntries={done}
        report={scanning}
        paper="sch:abcd-efgh-ijkl"
        checks={checksReport}
      />,
    );
  };

  it("says the node is waiting, with nothing for the author to do", () => {
    renderWaiting(waitingChecks());

    const scan = stage("scan");
    expect(scan.dataset.state).toBe("current");
    expect(scan.dataset.done).toBe("false");
    expect(scan.querySelector(".sw-status-tracker__state")?.textContent).toBe("Waiting");
    expect(scan.querySelector(".sw-status-tracker__detail")?.textContent).toBe(
      "Waiting for the safety scan: this node's antivirus is unavailable. " +
        "The scan runs again automatically; you don't need to do anything.",
    );
    // Nothing failed, so there is nothing to fix and no new version to publish.
    expect(scan.textContent).not.toContain("Needs fixing");
    expect(scan.textContent).not.toContain("failed the safety scan");
    expect(within(scan).queryByRole("link", { name: "Publish a new version" })).toBeNull();
    // The step is still polling, exactly as for a scan in progress.
    expect(scan.getAttribute("aria-current")).toBe("step");
  });

  it("keeps Moderation at Not reached while the scan waits", () => {
    renderWaiting(waitingChecks());

    const moderation = stage("moderation");
    expect(moderation.dataset.done).toBe("false");
    expect(moderation.querySelector(".sw-status-tracker__state")?.textContent).toBe("Not reached");
    expect(moderation.textContent).not.toContain("Held");
  });

  it("describes the file safety wait without calling the checks held", () => {
    renderWaiting(waitingChecks());

    const rows = new Map(
      [...document.querySelectorAll<HTMLElement>("[data-check]")].map((row) => [row.dataset.check, row]),
    );
    expect(rows.get("files")?.textContent).toContain("Waiting for the safety scan");
    expect(document.querySelector(".sw-tracker__summary")?.textContent).toBe("Waiting for the safety scan.");
    for (const id of ["references", "similarity", "metadata"]) {
      expect(rows.get(id)?.textContent).toContain("Not run yet");
      expect(rows.get(id)?.textContent).not.toContain("held at the safety scan");
    }
  });

  it("leaves a real scan hold as Needs fixing and offers a new version", () => {
    renderWaiting(
      checks({
        state: "held",
        checksRan: false,
        scanWaiting: false,
        files: [
          {
            path: "bundle.zip",
            cid: "bafkreizip",
            role: "code",
            status: "failed",
            failedChecks: ["too_large_to_scan"],
            detail: null,
          },
        ],
        referencesTotal: null,
        referencesUnresolved: null,
        similarityPct: null,
        metadataMatch: null,
      }),
    );

    const scan = stage("scan");
    expect(scan.querySelector(".sw-status-tracker__state")?.textContent).toBe("Needs fixing");
    expect(scan.querySelector(".sw-status-tracker__detail")?.textContent).toBe(
      "bundle.zip failed the safety scan: too large for the malware scan.",
    );
    expect(within(scan).getByRole("link", { name: "Publish a new version" })).toBeTruthy();
  });
});

describe("StatusTracker — styling", () => {
  it("has a rule in submit.css for every class it draws with", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "submit.css"), "utf8");
    render(<StatusTracker submitted trackerEntries={[mei(), ada()]} report={report()} versionCid="bafyreiversion" checks={null} />);

    const classes = new Set<string>();
    for (const element of document.querySelectorAll("[class]")) {
      for (const name of element.classList) classes.add(name);
    }
    // Icon and avatar classes belong to shared pieces with their own rules;
    // the point is that the tracker's own `sw-status-tracker*` parts are styled.
    const own = [...classes].filter((name) => name.startsWith("sw-status-tracker"));
    expect(own.length).toBeGreaterThan(6);
    const unstyled = own.filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
    expect(unstyled).toEqual([]);
  });
});
