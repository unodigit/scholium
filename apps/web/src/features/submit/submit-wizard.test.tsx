// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatAllowedAt, type EligibilityFacts } from "./eligibility";
import { SubmitWizard } from "./submit-wizard";
import { MemorySubmitDraftStorage } from "./submit-draft-storage";
import { WizardRail } from "./wizard-rail";
import { WIZARD_STEPS, nextStep, stepIndex } from "./wizard-steps";
import type { ManagerDeps } from "./upload-manager";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

afterEach(cleanup);

describe("wizard steps", () => {
  it("are Files, Details, Authors, Checks, Sign, in that order", () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual(["Files", "Details", "Authors", "Checks", "Sign"]);
  });

  it("know their position and what follows", () => {
    expect(stepIndex("authors")).toBe(2);
    expect(nextStep("files")).toMatchObject({ id: "details", label: "Details" });
    expect(nextStep("sign")).toBeNull();
  });
});

describe("WizardRail", () => {
  it("lists all five steps and marks the current one", () => {
    render(<WizardRail current="files" />);
    const rail = screen.getByRole("navigation", { name: "Submission progress" });
    const items = within(rail).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0].getAttribute("aria-current")).toBe("step");
    expect(items.slice(1).every((item) => item.getAttribute("aria-current") === null)).toBe(true);
  });

  it("says in words which steps are done, current and ahead, so colour is never the only signal", () => {
    render(<WizardRail current="authors" />);
    const items = within(screen.getByRole("navigation")).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "current",
      "ahead",
      "ahead",
    ]);
    expect(items[0].textContent).toContain("(done)");
    expect(items[3].textContent).toContain("(not started)");
    expect(items[2].textContent).not.toMatch(/\(done\)|\(not started\)/);
  });
});

describe("SubmitWizard", () => {
  it("shows the heading, the rail at step 1 and the Files step", () => {
    render(<SubmitWizard signedIn />);
    expect(screen.getByRole("heading", { level: 1, name: "Submit a paper" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Submission progress" }))
        .getAllByRole("listitem")[0]
        .getAttribute("aria-current"),
    ).toBe("step");
    expect(screen.getByRole("complementary", { name: "Size limits" })).toBeTruthy();
  });

  it("offers sign-in, returning to /submit, to someone who is signed out", () => {
    render(<SubmitWizard signedIn={false} />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/signin?next=%2Fsubmit");
  });

  it("does not nag someone who is signed in", () => {
    render(<SubmitWizard signedIn />);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });
});

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

/** A fingerprinter and uploader the test drives by hand, so no network is needed. */
function fakeManagerDeps(): {
  deps: ManagerDeps;
  uploads: { callbacks: Parameters<NonNullable<ManagerDeps["startUpload"]>>[2] }[];
  hashes: { resolve: (cid: string) => void }[];
} {
  const uploads: { callbacks: Parameters<NonNullable<ManagerDeps["startUpload"]>>[2] }[] = [];
  const hashes: { resolve: (cid: string) => void }[] = [];
  const deps: ManagerDeps = {
    startUpload: (_file, _init, callbacks) => {
      uploads.push({ callbacks });
      return { stop: vi.fn(async () => undefined) };
    },
    fingerprint: () =>
      new Promise<string>((resolve) => {
        hashes.push({ resolve });
      }),
  };
  return { deps, uploads, hashes };
}

describe("SubmitWizard — Files to Details and back", () => {
  it("opens step 2 after Files, and Back finds the same files", async () => {
    const { deps, uploads, hashes } = fakeManagerDeps();
    render(<SubmitWizard signedIn managerDeps={deps} />);

    fireEvent.change(screen.getByLabelText("Choose paper files"), {
      target: { files: [new File(["x"], "paper.pdf", { type: "application/pdf" })] },
    });
    await act(async () => {
      uploads[0].callbacks.onSuccess({ cid: CID, url: null });
      hashes[0].resolve(CID);
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Details" }));

    expect(screen.getByRole("heading", { level: 2, name: "Details" })).toBeTruthy();
    const steps = (): HTMLElement[] =>
      within(screen.getByRole("navigation", { name: "Submission progress" })).getAllByRole("listitem");
    expect(steps()[0].getAttribute("data-state")).toBe("done");
    expect(steps()[1].getAttribute("aria-current")).toBe("step");
    // The Files step is out of the way while Details is open.
    expect(screen.queryByRole("heading", { level: 2, name: "Files" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));

    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
    expect(screen.getByText("paper.pdf", { selector: ".sw-file__name" })).toBeTruthy();
    expect(steps()[0].getAttribute("aria-current")).toBe("step");
  });
});

describe("SubmitWizard — Authors to Checks and back", () => {
  /** Drive the wizard to step 3 with one finished PDF and the required details. */
  async function openAuthors(props: Partial<React.ComponentProps<typeof SubmitWizard>> = {}): Promise<void> {
    await openDetails(props);
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
  }

  /** Give the submitter a CRediT role, which is the last thing step 3 needs. */
  function chooseSubmitterRole(): void {
    fireEvent.click(
      within(screen.getByRole("group", { name: "CRediT roles for You" })).getByRole("button", {
        name: /^Conceptualization/,
      }),
    );
  }

  it("opens step 4 after Authors, with the rail on Checks", async () => {
    await openAuthors({ submitterDid: ME });
    chooseSubmitterRole();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));

    expect(screen.getByRole("heading", { level: 2, name: "Checks" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Authors" })).toBeNull();
    expect(railSteps().map((step) => step.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "done",
      "current",
      "ahead",
    ]);
    expect(railSteps()[3].getAttribute("aria-current")).toBe("step");

    // Before a version exists the step names what will be checked and which
    // files will be scanned, rather than inventing results.
    expect(screen.getByText("File safety")).toBeTruthy();
    expect(screen.getByText("References")).toBeTruthy();
    expect(screen.getByText("Similarity")).toBeTruthy();
    expect(screen.getByText("Metadata match")).toBeTruthy();
    expect(screen.getByText("paper.pdf", { selector: ".sw-check__file-name" })).toBeTruthy();
    expect(screen.getByText(/The checks run on the signed version/)).toBeTruthy();
  });

  it("keeps the authors and the files when stepping back to Authors", async () => {
    await openAuthors({ submitterDid: ME });
    chooseSubmitterRole();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));

    fireEvent.click(screen.getByRole("button", { name: "Back to Authors" }));

    expect(screen.getByRole("heading", { level: 2, name: "Authors" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "CRediT roles for You" }))
        .getByRole("button", { name: /^Conceptualization/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // The draft files are still there too.
    fireEvent.click(screen.getByRole("button", { name: "Back to Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));
    expect(screen.getByText("paper.pdf", { selector: ".sw-file__name" })).toBeTruthy();
  });

  it("opens step 5, Sign, from step 4 before any version (and so any check result) exists", async () => {
    // The checks run on the signed version, so a draft has no report to wait
    // for: waiting for one would deadlock the wizard (checks are advisory,
    // PRD PUB-4/MOD-1 — they never block signing).
    await openAuthors({ submitterDid: ME });
    chooseSubmitterRole();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));

    const next = screen.getByRole("button", { name: "Continue to Sign" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);

    expect(screen.getByRole("heading", { level: 2, name: "Sign" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign and submit" })).toBeTruthy();
    expect(railSteps()[4].getAttribute("aria-current")).toBe("step");
  });

  it("shows the version's live results when the wizard is given one", async () => {
    const report = {
      paper: "sch:abcd-efgh-ijkl",
      version: 1,
      versionCid: "bafyreiexample",
      state: "moderation",
      files: [
        {
          path: "paper.pdf",
          cid: CID,
          role: "pdf",
          status: "passed" as const,
          failedChecks: [],
          detail: null,
        },
      ],
      referencesTotal: 10,
      referencesUnresolved: 0,
      similarityPct: 4.2,
      metadataMatch: true,
      signedTitle: "Sparse Probing of Reward Models",
      firstPageTitle: null,
      checkedAt: null,
    };
    const fetchChecks = vi.fn().mockResolvedValue(report);

    await openAuthors({
      submitterDid: ME,
      checksFor: { paper: "sch:abcd-efgh-ijkl", version: 1 },
      fetchChecks,
      checksPollMs: 0,
    });
    chooseSubmitterRole();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));

    expect(await screen.findByText("All 4 checks passed.")).toBeTruthy();
    expect(screen.getByText("10 of 10 references resolved")).toBeTruthy();
    expect(fetchChecks).toHaveBeenCalledWith({ paper: "sch:abcd-efgh-ijkl", version: 1 }, expect.anything());
  });
});

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ADA = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const railSteps = (): HTMLElement[] =>
  within(screen.getByRole("navigation", { name: "Submission progress" })).getAllByRole("listitem");

/** Drive the wizard to step 2 with one finished PDF. */
async function openDetails(props: Partial<React.ComponentProps<typeof SubmitWizard>> = {}): Promise<void> {
  const { deps, uploads, hashes } = fakeManagerDeps();
  render(<SubmitWizard signedIn managerDeps={deps} {...props} />);
  fireEvent.change(screen.getByLabelText("Choose paper files"), {
    target: { files: [new File(["x"], "paper.pdf", { type: "application/pdf" })] },
  });
  await act(async () => {
    uploads[0].callbacks.onSuccess({ cid: CID, url: null });
    hashes[0].resolve(CID);
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue to Details" }));
}

function fillDetails(): void {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sparse Probing of Reward Models" } });
  fireEvent.change(screen.getByLabelText("Abstract"), { target: { value: "We study whether sparse probes work." } });
  fireEvent.click(screen.getByRole("button", { name: /^cs\.AI/ }));
}

describe("SubmitWizard — Details to Authors and back", () => {
  it("opens step 3 after Details, with the rail on Authors and the submitter first", async () => {
    await openDetails({ submitterDid: ME });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));

    expect(screen.getByRole("heading", { level: 2, name: "Authors" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Details" })).toBeNull();
    expect(railSteps().map((step) => step.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "current",
      "ahead",
      "ahead",
    ]);
    expect(railSteps()[2].getAttribute("aria-current")).toBe("step");
    const byline = screen.getByRole("list", { name: "Authors, in byline order" });
    expect(within(byline).getByText("You")).toBeTruthy();
    expect(within(byline).getByText(/DID · did:key:z6MkhaXg/)).toBeTruthy();
  });

  it("keeps the details and the author list when stepping back and forward", async () => {
    await openDetails({ submitterDid: ME });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));

    fireEvent.change(screen.getByLabelText("DID, ORCID iD or email"), { target: { value: ADA } });
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Add co-author" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "CRediT roles for Ada Lovelace" })).getByRole("button", {
        name: /^Software/,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to Details" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Sparse Probing of Reward Models");
    expect(railSteps()[1].getAttribute("aria-current")).toBe("step");

    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    const byline = screen.getByRole("list", { name: "Authors, in byline order" });
    expect(within(byline).getByText("Ada Lovelace")).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "CRediT roles for Ada Lovelace" }))
        .getByRole("button", { name: /^Software/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("is still on Files, intact, after going back all the way", async () => {
    await openDetails({ submitterDid: ME });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));
    expect(screen.getByText("paper.pdf", { selector: ".sw-file__name" })).toBeTruthy();
  });

  it("says the submitter has no DID yet when none is known", async () => {
    await openDetails({ submitterDid: null });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    expect(screen.getByText("No DID yet")).toBeTruthy();
  });

  it("passes an ORCID/email lookup through to the step", async () => {
    const resolveAuthor = vi.fn(async () => ({ did: ADA, name: "Ada Lovelace" }));
    await openDetails({ submitterDid: ME, resolveAuthor });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    fireEvent.change(screen.getByLabelText("DID, ORCID iD or email"), { target: { value: "ada@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Add co-author" }));
    expect(resolveAuthor).toHaveBeenCalledWith({ kind: "email", value: "ada@example.org" });
    expect(await screen.findByText("Matched to an account")).toBeTruthy();
  });
});

describe("SubmitWizard — eligibility is explained before any upload", () => {
  const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
    tier: 2,
    endorsedCategories: ["cs.AI"],
    nextAllowedAt: null,
    name: "Mei Chen",
    ...over,
  });
  const askApi = (over: Partial<EligibilityFacts> = {}) => vi.fn().mockResolvedValue(facts(over));
  const eligibilityRegion = (): Promise<HTMLElement> =>
    screen.findByRole("status", { name: "Submission eligibility" });

  it("says on opening /submit that a Member cannot submit yet, and how to get endorsed", async () => {
    render(
      <SubmitWizard
        signedIn
        submitterDid={ME}
        fetchEligibility={askApi({ tier: 1, endorsedCategories: [] })}
      />,
    );
    const region = await screen.findByText(/needs an Author account/);
    const notice = region.closest("[role='status']") as HTMLElement;
    expect(notice.textContent).toMatch(/Member/);
    expect(within(notice).getByRole("link", { name: "How to get endorsed" }).getAttribute("href")).toBe(
      `/u/${encodeURIComponent(ME)}`,
    );
    // It is said at step 1, with nothing uploaded yet.
    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
    expect(screen.queryByText("paper.pdf", { selector: ".sw-file__name" })).toBeNull();
  });

  it("states the weekly limit with the next allowed date in the viewer's locale", async () => {
    const next = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    render(<SubmitWizard signedIn submitterDid={ME} fetchEligibility={askApi({ nextAllowedAt: next })} />);
    const region = await eligibilityRegion();
    await vi.waitFor(() => expect(region.textContent).toMatch(/one new paper a week/i));
    expect(region.textContent).toContain(formatAllowedAt(next));
    expect(region.textContent).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(region.textContent).not.toContain("paper.genesis");
  });

  it("blocks the wizard before any upload when the weekly limit applies", async () => {
    const next = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    render(<SubmitWizard signedIn submitterDid={ME} fetchEligibility={askApi({ nextAllowedAt: next })} />);
    const region = await eligibilityRegion();
    await vi.waitFor(() => expect(region.textContent).toMatch(/one new paper a week/i));

    // No drop zone and no Continue: the author cannot spend an upload on a
    // paper the node will refuse at signing.
    expect(screen.queryByRole("heading", { level: 2, name: "Files" })).toBeNull();
    expect(screen.queryByLabelText("Choose paper files")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue to Details" })).toBeNull();
  });

  it("checks the categories as they are chosen, beside the picker rather than above the page", async () => {
    await openDetails({ submitterDid: ME, fetchEligibility: askApi({ endorsedCategories: ["cs.CL"] }) });
    const region = await eligibilityRegion();
    // Nothing is chosen yet, so nothing is wrong yet.
    expect(region.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /^cs\.AI/ }));
    const categories = screen.getByRole("group", { name: "Categories" });
    const warning = await within(categories).findByText(/not endorsed in cs\.AI/);
    expect((warning.closest("[data-blocker='categories']") as HTMLElement).textContent).toMatch(/cs\.CL/);
    // It sits directly under the chips it is about, not below every group.
    expect(screen.getByRole("button", { name: /^cs\.AI/ }).closest(".sw-chip-row")?.nextElementSibling).toBe(
      warning.closest(".sw-category-warning"),
    );
    // The warning no longer sits off-screen above the steps.
    expect(region.textContent).toBe("");

    // Choosing it again clears the problem.
    fireEvent.click(screen.getByRole("button", { name: /^cs\.AI/ }));
    await vi.waitFor(() => expect(within(categories).queryByText(/not endorsed in cs\.AI/)).toBeNull());
  });

  it("says nothing to someone who can submit", async () => {
    const fetchEligibility = askApi();
    render(<SubmitWizard signedIn submitterDid={ME} fetchEligibility={fetchEligibility} />);
    const region = await eligibilityRegion();
    await vi.waitFor(() => expect(fetchEligibility).toHaveBeenCalled());
    expect(region.textContent).toBe("");
  });

  it("does not block the wizard when eligibility cannot be read: the node still decides at signing", async () => {
    const fetchEligibility = vi.fn().mockRejectedValue(new Error("offline"));
    render(<SubmitWizard signedIn submitterDid={ME} fetchEligibility={fetchEligibility} />);
    const region = await eligibilityRegion();
    await vi.waitFor(() => expect(fetchEligibility).toHaveBeenCalled());
    expect(region.textContent).toBe("");
    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
  });

  it("does not ask the API on behalf of someone who is signed out", async () => {
    const fetchEligibility = askApi();
    render(<SubmitWizard signedIn={false} fetchEligibility={fetchEligibility} />);
    await screen.findByRole("link", { name: "Sign in" });
    expect(fetchEligibility).not.toHaveBeenCalled();
  });

  it("carries the profile name to the Sign step, where the summary shows it with the DID beneath", async () => {
    await openDetails({ submitterDid: ME, fetchEligibility: askApi({ name: "Mei Chen" }) });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "CRediT roles for You" })).getByRole("button", {
        name: /^Conceptualization/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Sign" }));

    const row = within(screen.getByRole("list", { name: "Authors" })).getAllByRole("listitem")[0];
    await vi.waitFor(() => expect(row.querySelector(".sw-summary__author-name")?.textContent).toBe("Mei Chen (you)"));
    expect(row.querySelector(".sw-summary__author-did")?.textContent).toBe("did:key:z6MkhaXg…ta2doK");
    expect(row.textContent).not.toContain(ME);
  });
});

describe("SubmitWizard — after signing", () => {
  it("turns the header into 'Submitted – version 1' without a draft status", async () => {
    const signRecord = vi.fn().mockImplementation((type: string) =>
      Promise.resolve({
        v: 1,
        type,
        id: `bafyrei-${type}`,
        author: ME,
        created: "2026-11-16T12:00:00Z",
        prev: null,
        body: {},
        proofs: [],
        sig: "sig",
      }),
    );
    const submitRecord = vi.fn().mockImplementation((record: { id: string }) =>
      Promise.resolve({ id: record.id, shortId: "sch:abcd-efgh-ijkl" }),
    );
    const fetchConsents = vi.fn().mockResolvedValue({
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
    });

    await openDetails({ submitterDid: ME, signRecord, submitRecord, fetchConsents });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "CRediT roles for You" })).getByRole("button", {
        name: /^Conceptualization/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Sign" }));

    // The autosave badge is on screen before the paper is signed.
    await screen.findByText("Draft saved");

    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    await screen.findByText("Status", { selector: ".sw-status-tracker__title" });

    expect(screen.getByRole("heading", { level: 1, name: "Submitted – version 1" })).toBeTruthy();
    expect(screen.queryByText("Draft saved")).toBeNull();
    expect(screen.queryByText(/You are signing version 1/)).toBeNull();
  });
});

describe("SubmitWizard — the stored draft once the paper is signed", () => {
  const TITLE = "Sparse Probing of Reward Models";

  const signRecord = () =>
    vi.fn().mockImplementation((type: string) =>
      Promise.resolve({
        v: 1,
        type,
        id: `bafyrei-${type}`,
        author: ME,
        created: "2026-11-16T12:00:00Z",
        prev: null,
        body: {},
        proofs: [],
        sig: "sig",
      }),
    );

  const fetchConsents = () =>
    vi.fn().mockResolvedValue({
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
    });

  /** Accepts every record, like a node that is up. */
  const acceptAll = () =>
    vi.fn().mockImplementation((record: { id: string }) =>
      Promise.resolve({ id: record.id, shortId: "sch:abcd-efgh-ijkl" }),
    );

  /** Accepts paper.genesis and the manifest, then refuses paper.version. */
  const refuseLastRecord = () => {
    const accepted = acceptAll();
    return vi.fn().mockImplementation((record: { id: string; type?: string }) =>
      record.type === "paper.version" ? Promise.reject(new Error("node unavailable")) : accepted(record),
    );
  };

  /** Fill the wizard through to the Sign step, with the draft saved on the way. */
  async function openSign(props: Partial<React.ComponentProps<typeof SubmitWizard>>): Promise<void> {
    await openDetails({ submitterDid: ME, fetchConsents: fetchConsents(), ...props });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authors" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "CRediT roles for You" })).getByRole("button", {
        name: /^Conceptualization/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checks" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Sign" }));
    await screen.findByText("Draft saved");
  }

  /** Open /submit again over the same store and let the restore finish. */
  async function reopen(storage: MemorySubmitDraftStorage): Promise<void> {
    cleanup();
    const get = vi.spyOn(storage, "get");
    render(<SubmitWizard signedIn submitterDid={ME} draftStorage={storage} />);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {
      await get.mock.results[0].value;
    });
  }

  it("clears the stored draft once the version is signed, so /submit starts empty", async () => {
    const storage = new MemorySubmitDraftStorage();
    await openSign({ draftStorage: storage, signRecord: signRecord(), submitRecord: acceptAll() });
    // The paper is a draft until it is signed.
    expect(await storage.get()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    await screen.findByText("Status", { selector: ".sw-status-tracker__title" });

    await vi.waitFor(async () => expect(await storage.get()).toBeNull());

    // Opening /submit again shows an empty wizard, not the paper just submitted.
    await reopen(storage);
    expect(screen.getByRole("heading", { level: 1, name: "Submit a paper" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Sign" })).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.queryByText("paper.pdf", { selector: ".sw-file__name" })).toBeNull();
  });

  it("does not save the submitted paper again after clearing it", async () => {
    const storage = new MemorySubmitDraftStorage();
    const put = vi.spyOn(storage, "put");
    await openSign({ draftStorage: storage, signRecord: signRecord(), submitRecord: acceptAll() });
    const savesBeforeSigning = put.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    await screen.findByText("Status", { selector: ".sw-status-tracker__title" });
    await vi.waitFor(async () => expect(await storage.get()).toBeNull());

    // Let any pending effect run: nothing may write the draft back.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(put).toHaveBeenCalledTimes(savesBeforeSigning);
    expect(await storage.get()).toBeNull();
  });

  it("keeps the draft when the last record is refused, so the author can try again", async () => {
    const storage = new MemorySubmitDraftStorage();
    await openSign({ draftStorage: storage, signRecord: signRecord(), submitRecord: refuseLastRecord() });

    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    // The wizard stays on Sign and says what went wrong.
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { level: 1, name: "Submit a paper" })).toBeTruthy();

    const kept = await storage.get();
    expect(kept).not.toBeNull();
    expect(kept?.details.title).toBe(TITLE);

    // Opening /submit again brings the draft back, on the step it was left.
    await reopen(storage);
    expect(await screen.findByRole("heading", { level: 2, name: "Sign" })).toBeTruthy();
    expect(screen.getByText(TITLE)).toBeTruthy();
  });
});
