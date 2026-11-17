// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import { initialAuthors } from "./authors";
import type { ConsentReport } from "./consents";
import type { ChecksVersionRef, FetchChecks, VersionChecks } from "./checks";
import { SignStep } from "./sign-step";
import type { SignedRecord } from "../web-auth";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

afterEach(cleanup);

function notFound(): ApiError {
  return new ApiError(404, { type: "about:blank", title: "Not Found", status: 404 });
}

function signed(type: string): SignedRecord {
  return {
    v: 1,
    type,
    id: `bafyrei-${type}`,
    author: ME,
    created: "2026-11-16T12:00:00Z",
    prev: null,
    body: {},
    proofs: [],
    sig: "sig",
  };
}

function consents(): ConsentReport {
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiversion",
    state: "awaiting_consent",
    declinedBy: null,
    count: 1,
    waiting: 1,
    signed: 0,
    declined: 0,
    authors: [{ did: ME, position: 1, status: "waiting" }],
  };
}

function checksReport(): VersionChecks {
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiversion",
    state: "moderation",
    files: [
      {
        path: "paper.pdf",
        cid: PDF,
        role: "pdf",
        status: "passed",
        failedChecks: [],
        detail: null,
      },
    ],
    referencesTotal: 10,
    referencesUnresolved: 2,
    similarityPct: 4.2,
    metadataMatch: true,
    signedTitle: null,
    firstPageTitle: null,
    checkedAt: null,
  };
}

/** Render the step with everything injected, then press Sign and submit. */
async function signAndSubmit(fetchChecks: FetchChecks): Promise<void> {
  render(
    <SignStep
      files={[
        { id: "1", path: "paper.pdf", size: 2, mediaType: "application/pdf", role: "pdf", cid: PDF },
      ]}
      details={{
        title: "Sparse Probing of Reward Models",
        abstract: "",
        categories: ["cs.AI"],
        licence: "CC-BY-4.0",
      }}
      authors={[]}
      signRecord={vi
        .fn()
        .mockImplementation((type: string) => Promise.resolve(signed(type)))}
      submitRecord={vi
        .fn()
        .mockImplementation((record: SignedRecord) =>
          Promise.resolve({ id: record.id, shortId: "sch:abcd-efgh-ijkl" }),
        )}
      fetchConsents={vi.fn().mockResolvedValue(consents())}
      fetchChecks={fetchChecks}
      pollMs={0}
      checksPollMs={10}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
  await screen.findByText("Status", { selector: ".sw-status-tracker__title" });
}

describe("SignStep — the status tracker's checks", () => {
  it("says Checks pending while the route answers 404, then shows the advisory report", async () => {
    // The first ask 404s (the version is being scanned); the retry lands the
    // report, and the tracker shows it without blocking anything.
    let landReport: ((report: VersionChecks) => void) | undefined;
    const fetchChecks = vi.fn(
      (_ref: ChecksVersionRef, _signal?: AbortSignal): Promise<VersionChecks> => {
        if (fetchChecks.mock.calls.length === 1) {
          return Promise.reject(notFound());
        }
        return new Promise<VersionChecks>((resolve) => {
          landReport = resolve;
        });
      },
    );
    await signAndSubmit(fetchChecks);

    expect(await screen.findByText(/Checks pending/)).toBeTruthy();
    await vi.waitFor(() => expect(landReport).toBeDefined());

    await act(async () => {
      landReport?.(checksReport());
    });
    const region = await screen.findByRole("region", { name: "Automated checks" });
    expect(within(region).getByText("File safety")).toBeTruthy();
    expect(within(region).getByText("References")).toBeTruthy();
    expect(within(region).getByText("Similarity")).toBeTruthy();
    expect(within(region).getByText("Metadata match")).toBeTruthy();
    expect(within(region).getByText("8 of 10 references resolved")).toBeTruthy();
    expect(within(region).getByText("3 of 4 checks passed, 1 to fix or look at.")).toBeTruthy();
    expect(fetchChecks).toHaveBeenCalledWith(
      { paper: "sch:abcd-efgh-ijkl", version: 1 },
      expect.anything(),
    );
  });

  it("keeps saying Checks pending for as long as the route answers 404", async () => {
    const fetchChecks: FetchChecks = vi.fn().mockImplementation(() => Promise.reject(notFound()));
    await signAndSubmit(fetchChecks);

    expect(await screen.findByText(/Checks pending/)).toBeTruthy();
    // The advisory rows are not invented while the node has nothing to say.
    expect(screen.queryByText("File safety")).toBeNull();
    expect(screen.queryByText("3 of 4 checks passed")).toBeNull();
  });
});

const FILE = (id: string) => ({
  id,
  path: `${id}.pdf`,
  size: 2,
  mediaType: "application/pdf",
  role: "pdf" as const,
  cid: PDF,
});

const DETAILS = {
  title: "Sparse Probing of Reward Models",
  abstract: "",
  categories: ["cs.AI"],
  licence: "CC-BY-4.0",
};

/** The submitting author, as the wizard builds them once the device key is read. */
const submitter = (name = "") => [{ ...initialAuthors(ME)[0], name }];

type SignProps = Partial<React.ComponentProps<typeof SignStep>>;

function renderSign(props: SignProps = {}): void {
  render(
    <SignStep
      files={[FILE("paper")]}
      details={DETAILS}
      authors={submitter()}
      signRecord={vi.fn().mockImplementation((type: string) => Promise.resolve(signed(type)))}
      submitRecord={vi
        .fn()
        .mockImplementation((record: SignedRecord) => Promise.resolve({ id: record.id, shortId: "sch:abcd-efgh-ijkl" }))}
      fetchConsents={vi.fn().mockResolvedValue(consents())}
      fetchChecks={vi.fn().mockRejectedValue(notFound())}
      pollMs={0}
      checksPollMs={0}
      {...props}
    />,
  );
}

function problem(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError(status, { status, title: "x", ...body });
}

describe("SignStep — the summary card's wording", () => {
  it("counts files with the right noun: '1 file', '2 files'", () => {
    renderSign({ files: [FILE("a")] });
    expect(screen.getByText("1 file", { selector: ".sw-summary__files" })).toBeTruthy();
    cleanup();
    renderSign({ files: [FILE("a"), FILE("b")] });
    expect(screen.getByText("2 files", { selector: ".sw-summary__files" })).toBeTruthy();
  });

  it("shows the submitter by profile name, with the DID as secondary text and never in full", () => {
    renderSign({ authors: submitter(), submitterName: "Mei Chen" });
    const row = within(screen.getByRole("list", { name: "Authors" })).getAllByRole("listitem")[0];
    expect(row.querySelector(".sw-summary__author-name")?.textContent).toBe("Mei Chen (you)");
    expect(row.querySelector(".sw-summary__author-did")?.textContent).toBe("did:key:z6MkhaXg…ta2doK");
    expect(row.textContent).not.toContain(ME);
  });

  it("does not print a full DID when the profile has no name either", () => {
    renderSign({ authors: submitter(), submitterName: null });
    const row = within(screen.getByRole("list", { name: "Authors" })).getAllByRole("listitem")[0];
    expect(row.querySelector(".sw-summary__author-name")?.textContent).toBe("You");
    expect(row.querySelector(".sw-summary__author-did")?.textContent).toBe("did:key:z6MkhaXg…ta2doK");
    expect(row.textContent).not.toContain(ME);
  });

  it("leaves the signed byline alone: the display name is not written into the record", async () => {
    const signRecord = vi.fn().mockImplementation((type: string) => Promise.resolve(signed(type)));
    renderSign({ authors: submitter(), submitterName: "Mei Chen", signRecord });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    await screen.findByText("Status", { selector: ".sw-status-tracker__title" });
    const genesis = signRecord.mock.calls.find(([type]) => type === "paper.genesis");
    expect(genesis?.[1].authors).toEqual([{ did: ME, creditRoles: [], position: 1 }]);
  });
});

describe("SignStep — refusals in plain language", () => {
  async function refusedWith(error: unknown): Promise<string> {
    renderSign({ submitRecord: vi.fn().mockRejectedValue(error) });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    return (await screen.findByRole("alert")).textContent ?? "";
  }

  it("explains the weekly limit with the viewer's date, not 'paper.genesis' and an ISO timestamp", async () => {
    const text = await refusedWith(
      problem(429, {
        type: "urn:scholium:problem:genesis-rate-limited",
        detail:
          "A tier-2 account younger than 90 days may start one paper per week; " +
          "the next paper.genesis is allowed at 2026-11-24T12:00:00Z.",
        next_allowed_at: "2026-11-24T12:00:00Z",
      }),
    );
    expect(text).toMatch(/one new paper a week/i);
    expect(text).toContain("2026");
    expect(text).not.toContain("paper.genesis");
    expect(text).not.toContain("2026-11-24T12:00:00Z");
    expect(text).not.toMatch(/T12:00/);
  });

  it("names the categories the author is not endorsed in", async () => {
    const text = await refusedWith(
      problem(403, {
        type: "urn:scholium:problem:category-not-endorsed",
        detail: "A paper.genesis record needs an active endorsement in every category it lists.",
        unendorsed_categories: ["cs.AI"],
      }),
    );
    expect(text).toMatch(/not endorsed in cs\.AI/);
    expect(text).not.toContain("paper.genesis");
  });

  it("keeps the passkey and network messages as they were", async () => {
    expect(await refusedWith(new Error("Passkey prompt was dismissed."))).toBe("Passkey prompt was dismissed.");
  });
});

describe("SignStep — the status tracker after submitting", () => {
  it("offers 'Sign your consent' to the submitter, who is still listed as waiting", async () => {
    renderSign({ authors: submitter("Mei Chen") });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    // The link is drawn from the signed version id at once and re-pointed at
    // the report's version id as soon as it lands; wait for the report's own,
    // which is the one that is authoritative once the node has answered.
    await screen.findByRole("link", { name: "Sign your consent" });
    await vi.waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Sign your consent" }).getAttribute("href"),
      ).toBe("/consent/bafyreiversion"),
    );
  });

  it("shows the submitter by name in the tracker, with the DID as secondary text", async () => {
    renderSign({ authors: submitter(), submitterName: "Mei Chen" });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    await screen.findByText("Status", { selector: ".sw-status-tracker__title" });
    const row = await screen.findByText("Mei Chen", { selector: ".sw-tracker__name" });
    expect(row.textContent).toContain("(you)");
    expect(document.querySelector(".sw-status-tracker")?.textContent).not.toContain(ME);
  });
});
