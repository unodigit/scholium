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
import { announceAppealFiled } from "./appeal-dialog";
import { PaperAccess, PaperAccessView } from "./paper-access";
import { bannerWithAppeal } from "./paper-access-view";
import {
  ALICE,
  BARE_ID,
  CHECKS_BODY,
  GENESIS_CID,
  GENESIS_SHORT_ID,
  MANIFEST_RECORD_BODY,
  TEXT_BODY,
  VERSION_CID,
  consentsBody,
  decisionEntry,
  entry,
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

/** A signed `appeal` of the held decision: what `POST /v1/appeals` appends. */
function appealEntry(seq = 11, target = "bafyrei-decision-10"): unknown {
  return entry(
    "appeal",
    `bafyrei-appeal-${seq}`,
    seq,
    {
      target,
      grounds: "The paper is in scope; MOD-01 applies to a different field.",
      paper: GENESIS_CID,
    },
  );
}

/** The panel's node-signed `appeal.decision` for the appeal above. */
function verdictEntry(outcome: string, seq = 12): unknown {
  return entry(
    "appeal.decision",
    `bafyrei-verdict-${seq}`,
    seq,
    {
      target: "bafyrei-appeal-11",
      outcome,
      reasons: ["The paper is in scope of MOD-01."],
    },
    "did:key:z6MkNodeDecisionSigner00000000000000000000000",
  );
}

/** The `release` the node appends when a panel overturns the held decision. */
function releaseEntry(seq = 13): unknown {
  return entry(
    "moderation.decision",
    `bafyrei-release-${seq}`,
    seq,
    {
      target: VERSION_CID,
      action: "release",
      state: "moderation",
      clause: "MOD-01",
      reason: "Appeal bafyrei-appeal-11 was overturned by the panel.",
      paper: GENESIS_CID,
      appeal: "bafyrei-appeal-11",
      appeal_restoration: "bafyrei-appeal-11",
    },
    "did:key:z6MkNodeDecisionSigner00000000000000000000000",
  );
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

  it("titles the browser tab with the paper once it renders, not with the server's 'Paper unavailable'", async () => {
    // The server answered 404 for this paper (it holds no token), so the tab
    // starts out titled for a page with no paper.
    document.title = "Paper unavailable · Scholium";
    stubHeldPaper();

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    // Until the retry knows better, the title stays honest.
    expect(document.title).toBe("Paper unavailable · Scholium");
    await screen.findByRole("heading", {
      level: 1,
      name: "Can a Meta-Agent Choose the Safer Branch?",
    });

    expect(document.title).toBe("Can a Meta-Agent Choose the Safer Branch? · v2 · Scholium");
  });

  it("keeps 'Paper unavailable' for a reader who may not see the paper", async () => {
    document.title = "Paper unavailable · Scholium";
    stubHeldPaper({ text: () => notFound() });

    signIn(OKAFOR);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    await waitFor(() => expect(screen.queryByText(/Checking whether you can read/)).toBeNull());
    expect(document.title).toBe("Paper unavailable · Scholium");
  });
});

describe("the status stepper of a held paper", () => {
  /** The tracker's stage, once the author's view has rendered it. */
  async function stage(key: string): Promise<HTMLElement> {
    const list = await screen.findByRole("list", { name: "Submission status" });
    const item = list.querySelector<HTMLElement>(`[data-stage="${key}"]`);
    if (item === null) throw new Error(`the stepper has no ${key} stage`);
    return item;
  }

  const stateWord = (item: HTMLElement): string | undefined =>
    item.querySelector(".sw-status-tracker__state")?.textContent ?? undefined;

  it("shows Moderation as Held, an attention state, with Listed still ahead", async () => {
    stubHeldPaper();

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    const moderation = await stage("moderation");
    expect(moderation.dataset.state).toBe("attention");
    expect(stateWord(moderation)).toBe("Held");
    expect(moderation.getAttribute("aria-current")).toBe("step");

    // Not "In progress": a held paper is waiting for a person, not on its way.
    const listed = await stage("listed");
    expect(listed.dataset.state).toBe("upcoming");
    expect(stateWord(listed)).toBe("Not started");
    expect(listed.getAttribute("aria-current")).toBeNull();

    // What came before the hold is still done.
    expect((await stage("scan")).dataset.state).toBe("done");
  });

  it("still shows a paper in moderation as in progress", async () => {
    stubHeldPaper({ state: "moderation", records: [versionEntry()] });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    const moderation = await stage("moderation");
    expect(moderation.dataset.state).toBe("current");
    expect(stateWord(moderation)).toBe("In progress");
    expect((await stage("listed")).dataset.state).toBe("upcoming");
  });
});

describe("an appeal the author has filed", () => {
  /** The banner's own status region, not the tracker's below it. */
  async function banner(): Promise<HTMLElement> {
    const word = await screen.findByText("Held from listing");
    const region = word.closest('[role="status"]');
    if (region === null) throw new Error("the banner is not a status region");
    return region as HTMLElement;
  }

  it("says the appeal is filed and awaiting a panel, after a reload", async () => {
    // The appeal is in the paper's public records: a full page load must read
    // it from there, not remember it from the dialog that filed it.
    stubHeldPaper({
      records: [versionEntry(), decisionEntry("hold", 10), appealEntry()],
    });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    const region = await banner();
    expect(region.textContent).toContain("Outside the category's scope.");
    expect(region.textContent).toContain(
      "Appeal filed on 5 March 2027 — awaiting panel.",
    );
    // The invitation is for a paper no one has appealed, and there is exactly
    // one appeal: neither the sentence nor the action may still be offered.
    expect(region.textContent).not.toContain("You can appeal once.");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull(),
    );
  });

  it("says what the panel decided, once it has", async () => {
    stubHeldPaper({
      records: [
        versionEntry(),
        decisionEntry("hold", 10),
        appealEntry(),
        verdictEntry("upheld"),
      ],
    });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    const region = await banner();
    expect(region.textContent).toContain(
      "Appeal filed on 5 March 2027 — the panel upheld the decision on 5 March 2027.",
    );
    expect(region.textContent).not.toContain("You can appeal once.");
  });

  it("says an overturn on the banner the release restores", async () => {
    // An overturn appends a `release` that puts the version back in moderation;
    // the hold is no longer the standing decision, so the appeal is joined
    // through the release record's `appeal` field.
    stubHeldPaper({
      state: "moderation",
      records: [
        versionEntry(),
        decisionEntry("hold", 10),
        appealEntry(),
        verdictEntry("overturned"),
        releaseEntry(),
      ],
    });

    signIn(ALICE);
    render(<PaperAccess address={{ id: BARE_ID, version: null }} />);

    const word = await screen.findByText("In moderation");
    const region = word.closest('[role="status"]');
    if (region === null) throw new Error("the banner is not a status region");
    expect(region.textContent).toContain(
      "Appeal filed on 5 March 2027 — the panel overturned the decision on 5 March 2027.",
    );
    expect(region.textContent).not.toContain("You can appeal once.");
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

describe("an appeal filed while the page is open", () => {
  function filedAppeal() {
    return {
      appealCid: "bafyrei-appeal-record",
      decisionCid: "bafyrei-decision-10",
      filedAt: "2027-03-05T10:00:00Z",
      outcome: null,
      verdictCid: null,
      decidedAt: null,
    };
  }

  it("updates the banner immediately, to the state a reload would show", async () => {
    stubApi({ checks: () => json(CHECKS_BODY) });
    render(<PaperAccessView view={heldView()} />);

    const word = await screen.findByText("Held from listing");
    const banner = word.closest('[role="status"]') as HTMLElement;
    expect(banner.textContent).toContain("You can appeal once.");

    act(() => {
      announceAppealFiled(GENESIS_SHORT_ID, filedAppeal());
    });

    expect(banner.textContent).toContain(
      "Appeal filed on 5 March 2027 — awaiting panel.",
    );
    expect(banner.textContent).not.toContain("You can appeal once.");
  });

  it("ignores an appeal filed on another paper", async () => {
    stubApi({ checks: () => json(CHECKS_BODY) });
    render(<PaperAccessView view={heldView()} />);

    const word = await screen.findByText("Held from listing");
    const banner = word.closest('[role="status"]') as HTMLElement;

    act(() => {
      announceAppealFiled("sch:another-paper-xx", filedAppeal());
    });

    expect(banner.textContent).toContain("You can appeal once.");
  });
});

describe("the appeal banner's dates", () => {
  it("writes them in the reader's zone, not the UTC date", () => {
    // 00:45 on 18 Nov in AEDT is still 17 Nov in UTC: the author filed the
    // appeal on their 18th and the banner must say so (bug_spec_verify6).
    const entries = [versionEntry(), decisionEntry("hold", 10)];
    const decision = latestDecision(entries);
    const banner = unlistedBanner("held", decision);
    const filedAt = "2026-11-17T13:45:00Z";
    const shown = bannerWithAppeal(banner, decision, {
      appealCid: "bafyrei-appeal-11",
      decisionCid: decision?.decisionCid ?? "",
      filedAt,
      outcome: null,
      verdictCid: null,
      decidedAt: null,
    });

    const when = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(filedAt));
    expect(shown.detail).toContain(`Appeal filed on ${when} — awaiting panel.`);
    if (when !== "17 November 2026") {
      expect(shown.detail).not.toContain("17 November 2026");
    }
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
