// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { PUBLIC_RECORD_NOTICE, shortenDid } from "./decision";
import type { FlagEntry } from "./flags";
import { ModDetail } from "./mod-detail";

/**
 * A flag can be filed against a discussion post, an annotation or a review,
 * not only a paper version. `/mod/{cid}` must read the signed record, show
 * what was flagged beside the flags against it and a decision form that suits
 * that record; it must never dead-end on "This record is a discussion.post,
 * not a paper version." (bug spec verify1 #3).
 */

const POST_CID = "bafyreidiscussionpostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAPER_CID = "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4";
const SHORT_ID = "sch:5jmi-pmva-4lmr";
const PAPER_TITLE = "Sparse attention without the quadratic cost";
const POSTER = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb";

const CLAUSES = [
  {
    id: "MOD-09",
    title: "Spam and promotion",
    text: "Submissions whose primary purpose is advertising are rejected.",
  },
] as const;

const POST = {
  kind: "record" as const,
  record: {
    cid: POST_CID,
    type: "discussion.post",
    authorDid: POSTER,
    created: "2027-05-04T09:30:00Z",
    title: null,
    paperCid: PAPER_CID,
    paperShortId: SHORT_ID,
    paperTitle: PAPER_TITLE,
    versionCid: "bafyreiversionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    versionId: `${SHORT_ID}/v2`,
    text: "This figure is copied from another paper.",
    quote: null,
    targetCid: "bafyreiversionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    body: { target: "bafyreiversionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  },
};

const FLAG: FlagEntry = {
  id: "flag-post-1",
  targetCid: POST_CID,
  reporterDid: "did:key:z6MkReporter000000000000000000000000000000000",
  reason: "spam",
  status: "pending",
  decisionCid: null,
};

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPost() {
  const loadTarget = async (cid: string) => ({
    cid,
    type: "discussion.post",
    typeLabel: "Discussion post",
    paperTitle: PAPER_TITLE,
    paperHref: `/p/${encodeURIComponent(SHORT_ID)}`,
    excerpt: POST.record.text,
  });

  render(
    <ModDetail
      versionCid={POST_CID}
      signedIn
      loadItem={async () => POST}
      loadClauses={async () => [...CLAUSES]}
      loadFlags={async () => [FLAG]}
      loadTarget={loadTarget}
    />,
  );
}

describe("ModDetail for a flagged discussion post", () => {
  it("shows the post instead of the paper-version error", async () => {
    renderPost();

    expect(
      await screen.findByRole("heading", { name: "Discussion post" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Couldn’t load this paper/)).toBeNull();
    expect(
      screen.queryByText(/This record is a discussion\.post, not a paper version/),
    ).toBeNull();
  });

  it("reads the record with the default loader, not just a paper version", async () => {
    const envelopes: Record<string, unknown> = {
      [POST_CID]: {
        v: 1,
        type: "discussion.post",
        author: POSTER,
        created: "2027-05-04T09:30:00Z",
        prev: null,
        body: {
          target: POST.record.versionCid,
          anchor: POST.record.versionCid,
          text: POST.record.text,
          parent: null,
        },
        proofs: [],
        id: POST_CID,
        sig: "a-signature",
      },
      [POST.record.versionCid]: {
        v: 1,
        type: "paper.version",
        author: POSTER,
        created: "2027-05-01T09:30:00Z",
        prev: null,
        body: { paper: PAPER_CID, n: 2, title: PAPER_TITLE },
        proofs: [],
        id: POST.record.versionCid,
        sig: "a-signature",
      },
      [PAPER_CID]: {
        v: 1,
        type: "paper.genesis",
        author: POSTER,
        created: "2027-04-30T09:30:00Z",
        prev: null,
        body: {
          title: PAPER_TITLE,
          categories: ["cs.AI"],
          licence: "CC-BY-4.0",
        },
        proofs: [],
        id: PAPER_CID,
        sig: "a-signature",
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      for (const [cid, envelope] of Object.entries(envelopes)) {
        if (url.includes(`/v1/records/${cid}`)) {
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (url.includes("/v1/moderation/policies") || url.includes("/v1/flags")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ModDetail versionCid={POST_CID} signedIn />);

    expect(
      await screen.findByRole("heading", { name: "Discussion post" }),
    ).toBeTruthy();
    expect(screen.getByText(POST.record.text!)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: PAPER_TITLE }).getAttribute("href"),
    ).toBe(`/p/${encodeURIComponent(SHORT_ID)}`);
    expect(screen.queryByText(/Couldn’t load this paper/)).toBeNull();
  });

  it("shows the author pseudonym, the text and a link to the owning paper", async () => {
    renderPost();

    const pane = (
      await screen.findByRole("heading", { name: "Discussion post" })
    ).closest("article") as HTMLElement;

    expect(within(pane).getByText(shortenDid(POSTER))).toBeTruthy();
    expect(
      within(pane).getByText("This figure is copied from another paper."),
    ).toBeTruthy();
    const paper = within(pane).getByRole("link", { name: PAPER_TITLE });
    expect(paper.getAttribute("href")).toBe(`/p/${encodeURIComponent(SHORT_ID)}`);
  });

  it("shows the flags filed against the record", async () => {
    renderPost();

    const flags = within(
      await screen.findByRole("region", { name: "Flags against this record" }),
    );
    expect(await flags.findByRole("heading", { name: "Spam or advertising" })).toBeTruthy();
    expect(flags.getByText(shortenDid(FLAG.reporterDid!))).toBeTruthy();
  });

  it("offers a decision form whose actions fit the record", async () => {
    renderPost();

    const form = (
      await screen.findByRole("heading", { name: "Record a decision" })
    ).closest("form") as HTMLElement;

    const action = within(form).getByLabelText(/^Action/) as HTMLSelectElement;
    const options = Array.from(action.options).map((option) => option.value);
    expect(options).toEqual(["", "dismiss", "hide"]);
    expect(within(form).getByLabelText(/^Policy clause/)).toBeTruthy();
    expect(within(form).getByLabelText(/^Reason/)).toBeTruthy();
    expect(within(form).getByText(PUBLIC_RECORD_NOTICE)).toBeTruthy();
  });
});

describe("ModDetail for a flagged review", () => {
  it("shows the review and a decision form rather than an error", async () => {
    render(
      <ModDetail
        versionCid="bafyreireviewaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        signedIn
        loadItem={async () => ({
          kind: "record",
          record: {
            ...POST.record,
            cid: "bafyreireviewaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            type: "review.formal",
            authorDid: "did:key:z6MkReviewer00000000000000000000000000000000",
            text: "The evaluation omits the baseline.",
            quote: null,
          },
        })}
        loadClauses={async () => [...CLAUSES]}
        loadFlags={async () => []}
        loadTarget={async (cid) => ({
          cid,
          type: "review.formal",
          typeLabel: "Review",
          paperTitle: PAPER_TITLE,
          paperHref: `/p/${encodeURIComponent(SHORT_ID)}`,
          excerpt: "The evaluation omits the baseline.",
        })}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Review" })).toBeTruthy();
    expect(
      screen.getByText("The evaluation omits the baseline."),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Record a decision" }),
    ).toBeTruthy();
  });
});
