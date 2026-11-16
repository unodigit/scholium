// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

let pathnameValue = "/p/6sel-2dio-orm6";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
}));

import { tokenStore } from "../../lib/api";
import PaperNotFoundBoundary from "../../app/(paper-page)/p/[id]/not-found";
import type { ConsentReport } from "../submit/consents";
import { PaperAccess, PaperAccessView } from "./paper-access";
import {
  ALICE,
  BARE_ID,
  CHECKS_BODY,
  MANIFEST_RECORD_BODY,
  TEXT_BODY,
  consentsBody,
  decisionEntry,
  json,
  notFound,
  stubApi,
  versionEntry,
} from "./paper-page-fixtures";
import { fakePdf } from "./pdf-fixtures";
import {
  latestDecision,
  loadUnlistedPdf,
  pickUnlistedVersion,
  unlistedBanner,
  type AccessView,
} from "./unlisted-paper";

/**
 * The hydrated retry on a 404 paper page: the server render holds no token, so
 * a paper that is in moderation, held, or awaiting co-author consent answers
 * 404 even for its own author (the access token lives in browser memory).
 * After the page runs, the not-found boundary restores the session and asks
 * again with the signed-in reader's token: authors and moderators then see the
 * paper with a status banner and their actions, a tombstoned paper shows the
 * removed-content state, and everyone else keeps the not-found page.
 */

const OKAFOR = "did:key:z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr";

/** An unsigned JWT with the given claims: the page never checks the signature. */
function accessToken(claims: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function signIn(did: string): void {
  act(() => {
    tokenStore.set({ accessToken: accessToken({ sub: did, tier: 2 }) });
  });
}

/** The node as an author's held paper sees it: catalog 404, records public. */
function stubHeldPaper({
  state = "held",
  records = [versionEntry(), decisionEntry("hold")],
  // The node serves an unlisted version's text to an author's (or a
  // moderator's) token and answers everyone else with the unknown-version 404.
  text = () => json(TEXT_BODY),
}: {
  state?: string;
  records?: readonly unknown[];
  text?: () => Response;
} = {}): ReturnType<typeof stubApi> {
  return stubApi({
    paper: () => notFound(),
    records: () => json(records),
    consents: () => json(consentsBody(state)),
    text,
  });
}

/** The view data the retry assembles for a held v2. */
function heldView(
  state = "held",
  text = "Multi-agent systems increasingly choose between candidate plans.",
): AccessView {
  const entries = [versionEntry(), decisionEntry("hold")];
  const version = pickUnlistedVersion(entries, null);
  if (version === null) throw new Error("the fixtures carry no version record");
  return {
    version,
    banner: unlistedBanner(state, latestDecision(entries)),
    consents: consentsBody(state) as ConsentReport,
    text: {
      versionCid: version.versionCid,
      paragraphs: [{ id: "para-1", text }],
    },
  };
}

afterEach(() => {
  cleanup();
  act(() => {
    tokenStore.clear();
  });
  vi.unstubAllGlobals();
});

describe("before the page runs", () => {
  it("is the honest not-found page, for crawlers and shared links", () => {
    stubApi({ paper: () => notFound() });

    const html = renderToStaticMarkup(
      <PaperAccess address={{ id: BARE_ID, version: null }} />,
    );

    expect(html).toContain("Paper unavailable");
    expect(html).toContain("No paper with that id is listed on this node.");
    expect(html).toContain("Back to search");
    // Nothing about the author's paper leaks into the first HTML.
    expect(html).not.toContain("Can a Meta-Agent");
  });

  it("is what the /p/{id} not-found boundary renders, and the retry swaps it", async () => {
    stubHeldPaper();
    pathnameValue = `/p/${BARE_ID}`;

    signIn(ALICE);
    render(<PaperNotFoundBoundary />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Can a Meta-Agent Choose the Safer Branch?",
      }),
    ).toBeTruthy();
    pathnameValue = "/p/6sel-2dio-orm6";
  });
});

describe("the paper's author", () => {
  it("sees their held paper with its banner, reason and actions", async () => {
    stubHeldPaper();

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Can a Meta-Agent Choose the Safer Branch?",
      }),
    ).toBeTruthy();

    // The status tracker below has status regions of its own; the banner is
    // the one that carries the word.
    const banner = screen.getByText("Held from listing").closest('[role="status"]');
    if (banner === null) throw new Error("the banner is not a status region");
    expect(banner.textContent).toContain("Held from listing");
    expect(banner.textContent).toContain("Outside the category's scope.");
    expect(banner.textContent).toContain("You can appeal once.");

    // The author actions appear once their consent read has answered.
    expect(await screen.findByRole("link", { name: "New version" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issue notice" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "File an appeal" })).toBeTruthy(),
    );

    // The text was fetched with the token and is on the page.
    expect(screen.getByText(/Multi-agent systems increasingly/)).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("CC BY 4.0")).toBeTruthy();
  });

  it("is told the paper is in moderation while it waits", async () => {
    stubHeldPaper({ state: "moderation", records: [versionEntry()] });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("In moderation")).toBeTruthy();
  });

  it("is told the paper is awaiting co-author consent", async () => {
    stubHeldPaper({ state: "awaiting_consent", records: [versionEntry()] });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("Awaiting co-author consent")).toBeTruthy();
  });

  it("reaches their held version at /p/{id}/v{n}, which says so until the retry knows better", async () => {
    stubHeldPaper();
    const message = "This paper has no listed version 2 on this node.";

    signIn(ALICE);
    const { container } = render(
      <PaperAccess address={{ id: BARE_ID, version: 2 }} message={message} />,
    );

    // The first render is the version route's own sentence, not the id's.
    expect(container.textContent).toContain(message);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Can a Meta-Agent Choose the Safer Branch?",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Held from listing")).toBeTruthy();
    expect(container.textContent).not.toContain(message);
  });

  it("reads the address from the pathname when none is given", async () => {
    stubHeldPaper();

    signIn(ALICE);
    render(<PaperAccess />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Can a Meta-Agent Choose the Safer Branch?" }),
    ).toBeTruthy();
  });
});

describe("a moderator", () => {
  it("sees the held paper and its banner, but is offered no author actions", async () => {
    // The node's text read is the gate: it answers 200 to a moderator (tier 4)
    // as to an author. A moderator is not on the byline, so the author
    // actions (New version, Issue notice, File an appeal) are not theirs.
    stubHeldPaper();

    signIn("did:key:z6MkkModeratorDecisionSigner000000000000000000000");
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Can a Meta-Agent Choose the Safer Branch?",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Held from listing")).toBeTruthy();
    expect(screen.getByText(/Multi-agent systems increasingly/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Issue notice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });
});

describe("everyone else", () => {
  it("keeps the not-found page for a signed-in reader who may not see it", async () => {
    const fetchMock = stubHeldPaper({ text: () => notFound() });

    signIn(OKAFOR);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    // The retry settles (the text read answered) and the notice stands.
    await waitFor(() => {
      const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
      expect(paths.some((path) => path.endsWith("/text"))).toBe(true);
    });
    expect(
      await screen.findByText("No paper with that id is listed on this node."),
    ).toBeTruthy();
    expect(screen.queryByText(/Can a Meta-Agent/)).toBeNull();
    expect(screen.queryByRole("link", { name: "New version" })).toBeNull();
    // The "checking" line is for the question while it is open, not after.
    await waitFor(() =>
      expect(screen.queryByText(/Checking whether you can read/)).toBeNull(),
    );
  });

  it("asks for nothing private when there is no session", async () => {
    const fetchMock = stubHeldPaper();

    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    // The public records read runs (it is what spots a tombstone); the
    // token-gated text read never does.
    await waitFor(() => {
      const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
      expect(paths.some((path) => path.endsWith("/records"))).toBe(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.some((path) => path.endsWith("/text"))).toBe(false);
    expect(
      screen.getByText("No paper with that id is listed on this node."),
    ).toBeTruthy();
  });
});

describe("a tombstoned paper", () => {
  it("renders the removed-content state from the public decision", async () => {
    stubApi({
      paper: () => notFound(),
      records: () => json([
        versionEntry(),
        decisionEntry("tombstone", 12, {
          clause: "MOD-05",
          reason: "Unlawful content.",
        }),
      ]),
    });

    // A takedown is a public fact: no session is needed to see the state.
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    expect(
      await screen.findByText("Content removed for legal reasons"),
    ).toBeTruthy();
    expect(screen.getByText(/Removed on 5 March 2027/)).toBeTruthy();
    expect(screen.getByText(/The record of its existence remains/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Policy MOD-05" }).getAttribute("href"),
    ).toBe("/policies#MOD-05");
    expect(screen.queryByText("No paper with that id is listed")).toBeNull();
  });

  it("renders the state when only the text read says 451, claiming nothing the log does not hold", async () => {
    // The log records a hold, not a takedown: the 451 is all there is to go
    // on. The marker must not borrow the hold's date, clause or reason.
    stubHeldPaper({
      records: [versionEntry(), decisionEntry("hold", 10, { clause: "MOD-01" })],
      text: () =>
        json(
          {
            title: "Unavailable for legal reasons",
            status: 451,
            detail: "Its content has been removed by moderation.",
          },
          451,
        ),
    });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    expect(
      await screen.findByText("Content removed for legal reasons"),
    ).toBeTruthy();
    expect(screen.getByText(/The record of its existence remains/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Can a Meta-Agent Choose the Safer Branch?",
    );
    // Nothing is borrowed from the hold: no date, no policy link.
    expect(screen.queryByText(/ on 5 March 2027/)).toBeNull();
    expect(screen.queryByRole("link", { name: /^Policy/ })).toBeNull();
  });
});

describe("the author's view of the paper", () => {
  it("shows the advisory checks report", async () => {
    stubApi({ checks: () => json(CHECKS_BODY) });

    render(<PaperAccessView view={heldView()} />);

    expect(await screen.findByText("Automated checks")).toBeTruthy();
    expect(await screen.findByText("File safety")).toBeTruthy();
    expect(screen.getByText("References")).toBeTruthy();
  });

  it("says when the checks report is not there yet", async () => {
    stubApi({ checks: () => notFound() });

    render(<PaperAccessView view={heldView()} />);

    expect(await screen.findByText("Checks pending")).toBeTruthy();
  });

  it("opens the PDF with the reader's token, on demand", async () => {
    stubApi({
      record: (cid) =>
        json(cid === "bafyrei-manifest" ? MANIFEST_RECORD_BODY : notFound()),
    });
    const pdf = fakePdf();

    render(<PaperAccessView view={heldView()} loadPdf={pdf.loadPdf} />);

    const toggle = screen.getByRole("button", { name: /^PDF/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(pdf.getDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://localhost:8000/v1/content/bafkrei-pdf",
        }),
      ),
    );
  });

  it("says when the version has no PDF to open", async () => {
    stubApi({ record: () => notFound() });

    render(<PaperAccessView view={heldView()} loadPdf={fakePdf().loadPdf} />);

    fireEvent.click(screen.getByRole("button", { name: /^PDF/ }));
    expect(await screen.findByText(/no PDF/i)).toBeTruthy();
  });
});

describe("loadUnlistedPdf", () => {
  it("finds the PDF behind the manifest record the version signed", async () => {
    stubApi({
      record: (cid) =>
        json(cid === "bafyrei-manifest" ? MANIFEST_RECORD_BODY : notFound()),
    });

    const pdf = await loadUnlistedPdf("bafyrei-manifest");

    expect(pdf?.name).toBe("paper.pdf");
    expect(pdf?.url).toBe("http://localhost:8000/v1/content/bafkrei-pdf");
  });

  it("is null without a manifest to read, and never throws", async () => {
    stubApi({ record: () => notFound() });

    expect(await loadUnlistedPdf(null)).toBeNull();
    expect(await loadUnlistedPdf("bafyrei-manifest")).toBeNull();
  });
});
