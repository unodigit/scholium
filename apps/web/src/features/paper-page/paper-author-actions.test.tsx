// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { PaperHeader } from "./paper-header";
import { loadPaperPageData, type PaperPageData } from "./paper-page-data";
import {
  ALICE,
  BARE_ID,
  BOB,
  HAPPY,
  SHORT_ID,
  VERSION_CID,
  json,
  stubApi,
} from "./paper-page-fixtures";

/**
 * The paper page's author actions (PUB-6, PUB-7, MOD-2): for a consented
 * author of the paper the header offers New version, Issue notice and — when
 * the latest moderation decision is a hold or reject — File an appeal.
 * Everyone else sees the header exactly as before.
 *
 * The viewer comes from the real token store and the paper from the route's
 * real loader, so this is the screen an author opens at /p/{id}.
 */

const OKAFOR = "did:key:z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr";
const MODERATOR = "did:key:z6MkkModeratorDecisionSigner000000000000000000000";

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

function signIn(did: string, tier = 2): void {
  act(() => {
    tokenStore.set({ accessToken: accessToken({ sub: did, tier }) });
  });
}

/** A copy of the consent report with the given statuses. */
function consents(statuses: Record<string, string>): Response {
  const authors = [ALICE, BOB].map((did, index) => ({
    did,
    author: did,
    position: index + 1,
    status: statuses[did] ?? "signed",
    decision: (statuses[did] ?? "signed") === "signed" ? "accept" : null,
    consentCid: null,
    role: null,
    creditRoles: null,
  }));
  return json({
    paper: SHORT_ID,
    version: 2,
    versionCid: VERSION_CID,
    state: "listed",
    declinedBy: null,
    count: authors.length,
    waiting: authors.filter((entry) => entry.status === "waiting").length,
    signed: authors.filter((entry) => entry.status === "signed").length,
    declined: authors.filter((entry) => entry.status === "declined").length,
    authors,
  });
}

/** One `moderation.decision` log entry for the paper. */
function decision(action: string, seq = 10): unknown {
  return {
    seq,
    record_cid: `bafyrei-decision-${seq}`,
    record_type: "moderation.decision",
    author_did: MODERATOR,
    body: {
      action,
      target: VERSION_CID,
      clause: "MOD-01",
      reason: "Outside the category's scope.",
    },
    raw: "",
    sig: null,
    prev_hash: "",
    entry_hash: "",
    received_at: "2027-03-05T10:00:00Z",
    origin_node: null,
  };
}

interface NodeOptions {
  readonly consents?: Response;
  readonly records?: readonly unknown[];
}

/** `stubApi` plus the paper's consent report and its records. */
function stubNode({
  consents: report = consents({}),
  records = [decision("hold")],
}: NodeOptions = {}): void {
  stubApi(HAPPY);
  const reads = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      if (/\/papers\/[^/]+\/v\/\d+\/consents$/.test(path)) {
        return report;
      }
      if (/\/export\/paper\/[^/]+\/records$/.test(path)) {
        return json(records);
      }
      return reads(input, init);
    }),
  );
}

async function loadData(): Promise<PaperPageData> {
  return loadPaperPageData({ id: BARE_ID, version: null });
}

afterEach(() => {
  cleanup();
  act(() => {
    tokenStore.clear();
  });
  vi.unstubAllGlobals();
});

describe("a consented author of the paper", () => {
  it("is offered New version, Issue notice and, after a hold, File an appeal", async () => {
    stubNode();
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await waitFor(() => expect(screen.getByRole("link", { name: "New version" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Issue notice" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "File an appeal" })).toBeTruthy());
  });

  it("offers them for a byline author when the node has no consent report", async () => {
    // A listed paper has every co-author's consent (PUB-3); a 404 from the
    // consents read cannot contradict the byline.
    stubNode({ consents: json({ title: "Not Found", status: 404 }, 404) });
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Issue notice" })).toBeTruthy());
  });

  it("links New version to the existing new-version form", async () => {    stubNode();
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    const link = await screen.findByRole("link", { name: "New version" });
    expect(link.getAttribute("href")).toBe(
      `/submit/new-version/${encodeURIComponent(SHORT_ID)}`,
    );
  });

  it("offers File an appeal after a reject, too", async () => {
    stubNode({ records: [decision("reject")] });
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "File an appeal" })).toBeTruthy());
  });

  it("does not offer an appeal when the latest decision listed the paper", async () => {
    stubNode({ records: [decision("hold", 5), decision("list", 9)] });
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await screen.findByRole("button", { name: "Issue notice" });
    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });

  it("does not offer a second appeal once one is already filed", async () => {
    stubNode({
      records: [
        decision("hold", 10),
        {
          seq: 11,
          record_cid: "bafyrei-appeal",
          record_type: "appeal",
          author_did: ALICE,
          body: { target: "bafyrei-decision-10", grounds: "The clause does not apply." },
        },
      ],
    });
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await screen.findByRole("button", { name: "Issue notice" });
    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });
});

describe("everyone else", () => {
  it("shows nothing new to a signed-in reader who is not on the byline", async () => {
    stubNode();
    signIn(OKAFOR, 3);
    render(<PaperHeader data={await loadData()} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("link", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Issue notice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });

  it("shows nothing new to a signed-out reader", async () => {
    stubNode();
    render(<PaperHeader data={await loadData()} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("link", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Issue notice" })).toBeNull();
  });

  it("shows nothing to a byline author who has not consented", async () => {
    stubNode({ consents: consents({ [ALICE]: "waiting" }) });
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("link", { name: "New version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Issue notice" })).toBeNull();
  });

  it("shows nothing to a byline author who declined", async () => {
    stubNode({ consents: consents({ [ALICE]: "declined" }) });
    signIn(ALICE);
    render(<PaperHeader data={await loadData()} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Issue notice" })).toBeNull();
  });
});

describe("the server's HTML", () => {
  it("is unchanged: no author action is in the first response", async () => {
    stubNode();
    const html = renderToStaticMarkup(<PaperHeader data={await loadData()} />);

    expect(html).not.toContain("New version");
    expect(html).not.toContain("Issue notice");
    expect(html).not.toContain("File an appeal");
  });
});
