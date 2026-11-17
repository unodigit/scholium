// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, tokenStore } from "../../lib/api";
import { PasskeyCancelledError, type SignedRecord } from "../web-auth";
import { normalizeConsentVersion, type ConsentVersion } from "./consent-version";
import type { ConsentReport } from "./consents";

/** The PDF.js stand-in the viewer's default (token-carrying) loader wraps. */
const pdfjs = vi.hoisted(() => ({
  current: null as null | import("../paper-page/pdf-fixtures").FakePdf,
}));

vi.mock("../paper-page/pdf-render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../paper-page/pdf-render")>();
  const { fakePdf } = await import("../paper-page/pdf-fixtures");
  pdfjs.current = fakePdf({ pages: 1 });
  return { ...actual, loadPdfjs: async () => pdfjs.current!.loadPdf() };
});

// Imported after the mock so `loadPdfjsWithSession` wraps the stand-in.
const { ConsentPage } = await import("./consent-page");
type ConsentPageProps = import("./consent-page").ConsentPageProps;

afterEach(() => {
  cleanup();
  tokenStore.clear();
  pdfjs.current?.getDocument.mockClear();
});

const A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const B = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const C = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSRPnE";
const GENESIS = "bafyreigenesis7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const VERSION_CID = "bafyreiversion7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

function loadedVersion(over: Partial<ConsentVersion> = {}): ConsentVersion {
  const base = normalizeConsentVersion(
    {
      v: 1,
      type: "paper.version",
      author: A,
      created: "2026-11-14T05:33:00Z",
      prev: GENESIS,
      body: {
        paper: GENESIS,
        n: 2,
        title: "Sparse Probing of Reward Models",
        abstract: "We probe reward models for the features they use.",
        authors: [
          { did: A, position: 1, name: "Mei Chen", creditRoles: ["Conceptualization"] },
          { did: B, position: 2, name: "Rafael Silva", creditRoles: ["Software", "Validation"] },
          { did: C, position: 3 },
        ],
        manifest: "bafyreimanifest",
        licence: "CC-BY-4.0",
        changeNote: "Fixed the proof of Lemma 2.",
        categories: ["cs.AI", "cs.LG"],
      },
      proofs: [],
    },
    VERSION_CID,
  );
  return {
    ...base,
    files: [
      { path: "paper.pdf", cid: PDF, size: 2 * 1024 * 1024, mediaType: "application/pdf", role: "manuscript" },
      { path: "notes.txt", cid: null, size: null, mediaType: null, role: null },
    ],
    ...over,
  };
}

function report(state: string, rows: Array<[string, string]>, over: Partial<ConsentReport> = {}): ConsentReport {
  const count = (status: string) => rows.filter(([, s]) => s === status).length;
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 2,
    versionCid: VERSION_CID,
    state,
    count: rows.length,
    waiting: count("waiting"),
    signed: count("signed"),
    declined: count("declined"),
    authors: rows.map(([did, status], index) => ({
      did,
      position: index + 1,
      status,
      consentCid: status === "waiting" ? null : `bafyreiconsentrecord${index}`,
    })),
    ...over,
  };
}

const WAITING = report("awaiting_consent", [[A, "signed"], [B, "waiting"], [C, "waiting"]]);

function signedRecord(did: string, type: string, body: Record<string, unknown>, prev: string | null): SignedRecord {
  return { v: 1, type, id: "bafyreinewconsent", author: did, created: "2026-11-16T10:00:00Z", prev, body, proofs: [], sig: "c2ln" };
}

interface Harness {
  loadVersion: ReturnType<typeof vi.fn>;
  fetchConsents: ReturnType<typeof vi.fn>;
  sign: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
}

/** Renders the page as `did`, against a server whose report is `current`. */
function renderPage(
  did: string | null,
  current: ConsentReport | Error = WAITING,
  props: Partial<ConsentPageProps> = {},
): Harness {
  const loadVersion = vi.fn().mockResolvedValue(loadedVersion());
  const fetchConsents = vi.fn(async () => {
    if (current instanceof Error) {
      throw current;
    }
    return current;
  });
  const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null) =>
    signedRecord(did ?? A, type, body, prev),
  );
  const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id, state: "accepted" }));
  render(
    <ConsentPage
      version={VERSION_CID}
      did={did}
      loadVersion={loadVersion}
      fetchConsents={fetchConsents}
      pollMs={0}
      sign={sign}
      submit={submit}
      {...props}
    />,
  );
  return { loadVersion, fetchConsents, sign, submit };
}

/** The decision section; waits for the version to load, since not every state has a button to wait for. */
const decisionPanel = () => screen.findByRole("region", { name: "Your decision" });
const acceptButton = () => screen.findByRole("button", { name: "Accept authorship" });

describe("ConsentPage — reviewing the version", () => {
  it("shows what the co-author is being named on", async () => {
    renderPage(B);
    await acceptButton();

    expect(screen.getByRole("heading", { level: 1, name: "Review and sign" })).toBeTruthy();
    const article = screen.getByRole("article");
    expect(within(article).getByRole("heading", { level: 2, name: "Sparse Probing of Reward Models" })).toBeTruthy();
    expect(article.textContent).toContain("Version 2 · signed by Mei Chen on 14 Nov 2026");
    expect(within(article).getByText("We probe reward models for the features they use.")).toBeTruthy();
    expect(within(within(article).getByRole("list", { name: "Categories" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "cs.AI",
      "cs.LG",
    ]);
    expect(article.textContent).toContain("CC BY 4.0");
    expect(article.textContent).toContain("Fixed the proof of Lemma 2.");
    const record = within(article).getByRole("link", { name: "View record" });
    expect(record.getAttribute("href")).toMatch(new RegExp(`/v1/records/${VERSION_CID}$`));
  });

  it("writes the version's signing date in the reader's zone", async () => {
    // 00:45 on 18 Nov in AEDT is still 17 Nov in UTC; the co-author was named
    // on the version on the 18th (bug_spec_verify6).
    const created = "2026-11-17T13:45:00Z";
    const when = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(created));
    renderPage(B, WAITING, {
      loadVersion: vi.fn().mockResolvedValue(loadedVersion({ created })),
    });
    await acceptButton();

    const article = screen.getByRole("article");
    expect(article.textContent).toContain(`on ${when}`);
    if (when !== "17 Nov 2026") {
      expect(article.textContent).not.toContain("on 17 Nov 2026");
    }
  });

  it("lists each author with their roles and status, and marks which one is you", async () => {
    renderPage(B);
    await acceptButton();

    const tracker = screen.getByRole("region", { name: "Co-author consents" });
    const rows = within(tracker).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["signed", "waiting", "waiting"]);
    expect(rows[0].textContent).toContain("Mei Chen");
    expect(rows[0].textContent).toContain("Signed");
    expect(rows[1].textContent).toContain("Rafael Silva (you)");
    expect(rows[1].textContent).toContain("Software, Validation");
    expect(within(tracker).getByRole("status").textContent).toBe("1 of 3 signed · 2 waiting");
  });

  it("shows the signer and every author by profile name when the signed record carries none", async () => {
    // Ana added Rafael by DID, so neither byline entry carries a name; without
    // a profile lookup the page would say "signed by did:key:…" and list DIDs.
    const unnamed = loadedVersion({
      authors: [
        { did: A, position: 1, name: null, orcid: null, creditRoles: ["Conceptualization"] },
        { did: B, position: 2, name: null, orcid: null, creditRoles: ["Software"] },
      ],
    });
    const fetchProfileName = vi.fn(async (did: string) =>
      did === A ? "Ana Ruiz" : did === B ? "Rafael Silva" : null,
    );

    renderPage(A, report("awaiting_consent", [[A, "waiting"], [B, "waiting"]]), {
      loadVersion: vi.fn().mockResolvedValue(unnamed),
      fetchProfileName,
    });
    await acceptButton();

    expect(screen.getByRole("article").textContent).toContain("signed by Ana Ruiz");
    const tracker = screen.getByRole("region", { name: "Co-author consents" });
    const rows = within(tracker).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Ana Ruiz");
    expect(rows[1].textContent).toContain("Rafael Silva");
    // The name is the primary text; the DID may only appear shortened beneath it.
    expect(tracker.textContent).not.toContain(A);
    expect(tracker.textContent).not.toContain(B);
  });

  it("shows the PDF in the viewer, not as a plain link that would fetch it without a token", async () => {
    tokenStore.set({ accessToken: "coauthor-access-token" });
    renderPage(B);
    await acceptButton();

    const files = screen.getByRole("region", { name: "Files" });
    // The file row links to the viewer on this page; no row points straight at
    // `/v1/content`, which a co-author's browser would fetch without a token.
    const pdf = within(files).getByRole("link", { name: "paper.pdf" });
    expect(pdf.getAttribute("href")).toBe("#cp-pdf");
    expect(
      within(within(files).getByRole("list", { name: "Files of version 2" }))
        .queryAllByRole("link")
        .some((link) => (link.getAttribute("href") ?? "").includes("/v1/content/")),
    ).toBe(false);
    expect(files.textContent).toContain("manuscript · 2.0 MB");
    // A file with no id is named but cannot be opened.
    expect(within(files).queryByRole("link", { name: "notes.txt" })).toBeNull();
    expect(within(files).getByText("notes.txt")).toBeTruthy();
    expect(files.textContent).toContain("Files open once the server’s safety scan has passed.");

    // The existing viewer draws the PDF, and its default loader hands PDF.js
    // the co-author's bearer token: the bytes of a version awaiting consent
    // are not public.
    expect(within(files).getByRole("region", { name: "PDF of this version" })).toBeTruthy();
    await waitFor(() => expect(pdfjs.current?.getDocument).toHaveBeenCalledTimes(1));
    expect(pdfjs.current?.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(new RegExp(`/v1/content/${PDF}$`)),
        httpHeaders: { Authorization: "Bearer coauthor-access-token" },
      }),
    );
    expect(await within(files).findByRole("img", { name: "Page 1 of 1" })).toBeTruthy();
  });

  it("says so when the file list could not be loaded, and still lets the version be read", async () => {
    renderPage(B, WAITING, { loadVersion: vi.fn().mockResolvedValue(loadedVersion({ files: null })) });
    await acceptButton();
    expect(screen.getByRole("region", { name: "Files" }).textContent).toContain("could not be loaded or checked");
    expect(screen.getByRole("article")).toBeTruthy();
  });

  it("shows a loading state, then asks the server for the consent report of that paper and version", async () => {
    const { fetchConsents } = renderPage(B);
    expect(screen.getByRole("status").textContent).toBe("Loading the version…");
    await acceptButton();
    expect(fetchConsents).toHaveBeenCalledWith({ paper: GENESIS, version: 2 }, expect.anything());
  });

  it("explains a version that failed to load and lets the reader try again", async () => {
    const loadVersion = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(404, { status: 404 }))
      .mockResolvedValue(loadedVersion());
    renderPage(B, WAITING, { loadVersion });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no paper version for this link");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await acceptButton();
    expect(loadVersion).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses a link that cannot name a version without asking the server anything", () => {
    const { loadVersion, fetchConsents } = renderPage(B, WAITING, { version: "../../x" });
    expect(screen.getByRole("alert").textContent).toMatch(/not a paper version/);
    expect(loadVersion).not.toHaveBeenCalled();
    expect(fetchConsents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /authorship/ })).toBeNull();
  });
});

describe("ConsentPage — who can answer", () => {
  it("offers accept and decline to a listed author who has not answered, saying what they are accepting", async () => {
    renderPage(B);
    await acceptButton();
    const panel = await decisionPanel();
    expect(within(panel).getByText("You are listed as author 2 of 3, for Software, Validation.")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Decline authorship" })).toBeTruthy();
    expect(panel.textContent).toContain("You’re signing with your passkey. Scholium never sees your key.");
  });

  it("sends a device with no key to sign in, coming back to this page afterwards", async () => {
    renderPage(null);
    const panel = await decisionPanel();
    await within(panel).findByText(/no signing key/);
    expect(within(panel).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      `/signin?next=${encodeURIComponent(`/consent/${VERSION_CID}`)}`,
    );
    expect(within(panel).getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe("/onboarding");
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();
  });

  it("does not offer a key the version does not list the chance to sign", async () => {
    renderPage("did:key:z6MkstrangerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    const panel = await decisionPanel();
    await within(panel).findByText(/is not one of this version’s authors/);
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();
  });

  it("shows an answer already on record and never offers a second one", async () => {
    renderPage(A);
    const panel = await decisionPanel();
    await within(panel).findByText("You accepted authorship of this version.");
    expect(within(panel).getByText("Signed")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "View record" }).getAttribute("href")).toMatch(/\/v1\/records\/bafyreiconsentrecord0$/);
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();
  });

  it("shows a decline as a decline, and what it did to the version", async () => {
    renderPage(B, report("draft", [[A, "signed"], [B, "declined"], [C, "waiting"]], { declinedBy: B }));
    const panel = await decisionPanel();
    await within(panel).findByText("You declined authorship of this version.");
    expect(within(panel).getByText("Declined")).toBeTruthy();
    expect(panel.textContent).toContain("back in draft");
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();
    // The tracker's own notice names who declined.
    expect(screen.getByText(/Rafael Silva declined authorship, so this version is back in draft/)).toBeTruthy();
  });

  it("closes the decision to an author who was still waiting when someone else declined", async () => {
    renderPage(C, report("draft", [[A, "signed"], [B, "declined"], [C, "waiting"]], { declinedBy: B }));
    const panel = await decisionPanel();
    await within(panel).findByText(/Rafael Silva declined authorship, so this version is back in draft and is not asking for signatures now/);
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();
  });

  it("switches signing off, and says why, when who has signed cannot be read", async () => {
    const { fetchConsents } = renderPage(B, new Error("down"));
    const panel = await decisionPanel();
    await within(panel).findByText(/Signing is switched off until it is known/);
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();

    fetchConsents.mockClear();
    fireEvent.click(within(panel).getByRole("button", { name: "Try again now" }));
    await waitFor(() => expect(fetchConsents).toHaveBeenCalledTimes(1));
  });

  it("waits for the report before offering anything", async () => {
    let release: (value: ConsentReport) => void = () => undefined;
    const fetchConsents = vi.fn(() => new Promise<ConsentReport>((resolve) => (release = resolve)));
    renderPage(B, WAITING, { fetchConsents });
    await screen.findByRole("heading", { level: 2, name: "Your decision" });
    expect(within(await decisionPanel()).getByRole("status").textContent).toBe("Checking who can sign…");
    expect(screen.queryByRole("button", { name: "Accept authorship" })).toBeNull();

    release(WAITING);
    await acceptButton();
  });
});

describe("ConsentPage — accepting", () => {
  it("signs a coauthor.consent for this version behind the passkey and submits it", async () => {
    const { sign, submit, fetchConsents } = renderPage(B);
    fireEvent.click(await acceptButton());

    const panel = await decisionPanel();
    await within(panel).findByText("You accepted authorship of this version.");
    expect(sign).toHaveBeenCalledWith(
      "coauthor.consent",
      { version: VERSION_CID, role: "Software, Validation", decision: "accept" },
      null,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ type: "coauthor.consent", author: B });
    expect(within(panel).getByRole("link", { name: "View record" }).getAttribute("href")).toMatch(/\/v1\/records\/bafyreinewconsent$/);
    expect(within(panel).queryByRole("button", { name: /authorship/ })).toBeNull();
    // The report is read again, so the tracker catches up with the answer.
    await waitFor(() => expect(fetchConsents.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("sends the optional comment with the answer", async () => {
    const { sign } = renderPage(B);
    await acceptButton();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: "  Glad to be on this one.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Accept authorship" }));

    await screen.findByText("You accepted authorship of this version.");
    expect(sign.mock.calls[0][1]).toMatchObject({ comment: "Glad to be on this one." });
  });

  it("says the comment is public and bounds it", async () => {
    renderPage(B);
    await acceptButton();
    const comment = screen.getByLabelText(/Comment/) as HTMLTextAreaElement;
    expect(comment.maxLength).toBe(500);
    expect(screen.getByText(/Public: it is part of your signed record/)).toBeTruthy();
  });

  it("signs once however many times the button is pressed while the passkey prompt is open", async () => {
    let finish: (record: SignedRecord) => void = () => undefined;
    const sign = vi.fn(() => new Promise<SignedRecord>((resolve) => (finish = resolve)));
    const { submit } = renderPage(B, WAITING, { sign });
    const accept = await acceptButton();

    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(await within(await decisionPanel()).findByText("Waiting for your passkey…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept authorship" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Decline authorship" }) as HTMLButtonElement).disabled).toBe(true);

    finish(signedRecord(B, "coauthor.consent", {}, null));
    await screen.findByText("You accepted authorship of this version.");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps the buttons and says nothing was sent when the passkey prompt is dismissed", async () => {
    const sign = vi.fn().mockRejectedValue(new PasskeyCancelledError());
    const { submit } = renderPage(B, WAITING, { sign });
    fireEvent.click(await acceptButton());

    expect((await screen.findByRole("alert")).textContent).toMatch(/Signing was cancelled, so nothing was sent/);
    expect(submit).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Accept authorship" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends an expired session to sign in", async () => {
    const submit = vi.fn().mockRejectedValue(new ApiError(401, { status: 401 }));
    renderPage(B, WAITING, { submit });
    fireEvent.click(await acceptButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your session has ended");
    expect(within(alert).getByRole("link", { name: "Sign in" }).getAttribute("href")).toContain("/signin?next=");
  });

  it("reads the report again after a failure whose outcome is unknown, and shows the answer if it landed", async () => {
    // The request fails, but the server did record the answer.
    let answered = false;
    const fetchConsents = vi.fn(async () =>
      answered ? report("awaiting_consent", [[A, "signed"], [B, "signed"], [C, "waiting"]]) : WAITING,
    );
    const submit = vi.fn(async () => {
      answered = true;
      throw new ApiError(503, { status: 503 });
    });
    renderPage(B, WAITING, { submit, fetchConsents });
    fireEvent.click(await acceptButton());

    await within(await decisionPanel()).findByText("You accepted authorship of this version.");
    expect(within(screen.getByRole("region", { name: "Co-author consents" })).getByRole("status").textContent).toBe(
      "2 of 3 signed · 1 waiting",
    );
  });
});

describe("ConsentPage — declining", () => {
  it("asks first, and signs nothing until the author confirms", async () => {
    const { sign } = renderPage(B);
    fireEvent.click(await screen.findByRole("button", { name: "Decline authorship" }));

    const confirm = screen.getByRole("group", { name: "Decline authorship of this version?" });
    expect(confirm.textContent).toContain("The version goes back to draft for every author");
    expect(document.activeElement).toBe(within(confirm).getByRole("heading", { level: 3 }));
    expect(screen.queryByRole("button", { name: "Accept authorship" })).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it("goes back to the choice, with focus on the button it came from, when the author keeps reviewing", async () => {
    const { sign } = renderPage(B);
    fireEvent.click(await screen.findByRole("button", { name: "Decline authorship" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep reviewing" }));

    expect(screen.queryByRole("group", { name: /Decline authorship of this version/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Accept authorship" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Decline authorship" })));
    expect(sign).not.toHaveBeenCalled();
  });

  it("signs a decline, with the comment, once confirmed, and says the version is back in draft", async () => {
    const { sign, submit } = renderPage(B);
    await acceptButton();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: "I did not agree to this version." } });
    fireEvent.click(screen.getByRole("button", { name: "Decline authorship" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, decline" }));

    const panel = await decisionPanel();
    await within(panel).findByText("You declined authorship of this version.");
    expect(sign).toHaveBeenCalledWith(
      "coauthor.consent",
      { version: VERSION_CID, role: "Software, Validation", decision: "decline", comment: "I did not agree to this version." },
      null,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(panel.textContent).toContain("back in draft");
    expect(within(panel).getByText("Declined")).toBeTruthy();
  });

  it("returns to the choice with the reason when a confirmed decline fails", async () => {
    const sign = vi.fn().mockRejectedValue(new PasskeyCancelledError());
    renderPage(B, WAITING, { sign });
    fireEvent.click(await screen.findByRole("button", { name: "Decline authorship" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, decline" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled/);
    expect(screen.getByRole("button", { name: "Decline authorship" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Decline authorship of this version/ })).toBeNull();
  });
});

describe("ConsentPage — an author with no CRediT role listed", () => {
  it("accepts as Author and does not talk about roles", async () => {
    const loadVersion = vi.fn().mockResolvedValue(loadedVersion());
    const { sign } = renderPage(C, WAITING, { loadVersion });
    fireEvent.click(await acceptButton());

    await screen.findByText("You accepted authorship of this version.");
    expect(sign.mock.calls[0][1]).toMatchObject({ role: "Author" });
  });

  it("describes the position without a role clause", async () => {
    renderPage(C);
    await acceptButton();
    expect(within(await decisionPanel()).getByText("You are listed as author 3 of 3.")).toBeTruthy();
  });
});
