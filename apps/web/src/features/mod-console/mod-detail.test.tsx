// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";
import { PUBLIC_RECORD_NOTICE, type ModeratedPaper } from "./decision";
import { ModDetail } from "./mod-detail";

const VERSION = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";

const PAPER: ModeratedPaper = {
  versionCid: VERSION,
  paperCid: "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4",
  shortId: "sch:5jmi-pmva-4lmr",
  versionId: "sch:5jmi-pmva-4lmr/v2",
  version: 2,
  title: "Sparse attention without the quadratic cost",
  abstract: "We remove the quadratic term and evaluate on three benchmarks.",
  authors: [
    {
      did: "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
      name: "Mei Zhang",
      affiliation: "Harbour University",
    },
    {
      did: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
      name: "Rafael Silva",
      affiliation: null,
    },
  ],
  categories: ["cs.AI", "cs.LG"],
  licence: "CC-BY-4.0",
  changeNote: "Expanded the evaluation.",
  manifestCid: "bafyreidjpnwems6u37wwjmckcpcgjiiq5lfghta2ujf3ogs22kcxws7vli",
};

const CLAUSES = [
  {
    id: "MOD-01",
    title: "Out of scope",
    text: "A submission outside every open category is rejected.",
  },
] as const;

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

describe("ModDetail loading", () => {
  it("shows a loading line first and fetches the version and its clauses", async () => {
    const loadPaper = vi.fn(async () => PAPER);
    const loadClauses = vi.fn(async () => [...CLAUSES]);

    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={loadPaper}
        loadClauses={loadClauses}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading the paper…");

    await screen.findByRole("heading", {
      name: "Sparse attention without the quadratic cost",
    });
    expect(loadPaper).toHaveBeenCalledTimes(1);
    expect(loadPaper).toHaveBeenCalledWith(VERSION);
    expect(loadClauses).toHaveBeenCalledTimes(1);
  });
});

describe("ModDetail paper beside form", () => {
  it("shows the paper's title, authors, abstract, categories and version", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
      />,
    );

    const heading = await screen.findByRole("heading", {
      name: "Sparse attention without the quadratic cost",
    });
    const pane = heading.closest("article") as HTMLElement;

    expect(within(pane).getByText("Mei Zhang, Rafael Silva")).toBeTruthy();
    expect(within(pane).getByText("cs.AI, cs.LG")).toBeTruthy();
    expect(within(pane).getByText("sch:5jmi-pmva-4lmr/v2")).toBeTruthy();
    // The licence reads by its full name; the id is what the record carries.
    expect(within(pane).getByText("Creative Commons Attribution 4.0")).toBeTruthy();
    expect(
      within(pane).getByText(
        "We remove the quadratic term and evaluate on three benchmarks.",
      ),
    ).toBeTruthy();
    expect(within(pane).getByText(/Expanded the evaluation/)).toBeTruthy();
    expect(
      within(pane).getByRole("button", {
        name: "View the signed version record",
      }),
    ).toBeTruthy();
  });

  it("puts the decision form beside the paper, with the required fields and the statement", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
      />,
    );

    await screen.findByRole("heading", { name: "Record your decision" });

    expect(screen.getByRole("heading", { level: 1, name: "Moderation decision" })).toBeTruthy();
    const form = screen.getByRole("heading", { name: "Record your decision" }).closest("form") as HTMLElement;
    expect(within(form).getByLabelText(/^Action/)).toBeTruthy();
    expect(within(form).getByLabelText(/^Policy clause/)).toBeTruthy();
    expect(within(form).getByLabelText(/^Reason shown to the author/)).toBeTruthy();
    expect(
      within(form).getByRole("heading", {
        name: "Preview of what the author will see",
      }),
    ).toBeTruthy();
    expect(within(form).getByText(PUBLIC_RECORD_NOTICE)).toBeTruthy();

    // The paper and the form are siblings in the detail grid.
    const grid = form.closest(".mc-detail-grid") as HTMLElement;
    expect(grid.querySelector(".mc-paper-card")).not.toBeNull();
    expect(grid.querySelector(".mc-decision-card")).not.toBeNull();
  });

  it("links back to the queue", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
      />,
    );

    await screen.findByRole("heading", { name: "Record your decision" });
    expect(
      screen.getAllByRole("link", { name: /Back to the queue/ })[0].getAttribute("href"),
    ).toBe("/mod");
  });
});

describe("ModDetail access", () => {
  it("asks a visitor with no session to sign in and makes no request", async () => {
    const loadPaper = vi.fn(async () => PAPER);
    const loadClauses = vi.fn(async () => [...CLAUSES]);

    render(
      <ModDetail
        versionCid={VERSION}
        signedIn={false}
        loadPaper={loadPaper}
        loadClauses={loadClauses}
      />,
    );

    const notice = await screen.findByRole("alert");
    expect(
      within(notice).getByRole("heading", { name: "Sign in to continue" }),
    ).toBeTruthy();
    expect(
      within(notice).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe(`/signin?next=${encodeURIComponent(`/mod/${VERSION}`)}`);
    expect(loadPaper).not.toHaveBeenCalled();
    expect(loadClauses).not.toHaveBeenCalled();
  });

  it("reads the session from the token store when it is not pinned", async () => {
    const loadPaper = vi.fn(async () => PAPER);

    render(
      <ModDetail
        versionCid={VERSION}
        loadPaper={loadPaper}
        loadClauses={async () => [...CLAUSES]}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to continue" }),
    ).toBeTruthy();
    expect(loadPaper).not.toHaveBeenCalled();

    cleanup();
    tokenStore.set({ accessToken: "an-access-token" });
    render(
      <ModDetail
        versionCid={VERSION}
        loadPaper={loadPaper}
        loadClauses={async () => [...CLAUSES]}
      />,
    );
    await screen.findByRole("heading", {
      name: "Sparse attention without the quadratic cost",
    });
    expect(loadPaper).toHaveBeenCalledTimes(1);
  });

  it("repeats the caller's tier when the API answers 403", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={async () => {
          throw new ApiError(403, { status: 403, caller_tier: 2 });
        }}
        loadClauses={async () => [...CLAUSES]}
      />,
    );

    const notice = await screen.findByRole("alert");
    expect(
      within(notice).getByRole("heading", { name: "Moderators only" }),
    ).toBeTruthy();
    expect(notice.textContent).toContain("Your account is tier 2.");
    expect(within(notice).queryByRole("button")).toBeNull();
  });
});

describe("ModDetail failures", () => {
  it("shows a retryable notice when the paper cannot be loaded, and retrying recovers", async () => {
    const loadPaper = vi
      .fn<() => Promise<ModeratedPaper>>()
      .mockRejectedValueOnce(new NetworkError("http://api.invalid/v1/records/x"))
      .mockResolvedValueOnce(PAPER);

    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={loadPaper}
        loadClauses={async () => [...CLAUSES]}
      />,
    );

    const notice = await screen.findByRole("alert");
    expect(
      within(notice).getByRole("heading", { name: "Couldn’t load this paper" }),
    ).toBeTruthy();
    expect(notice.textContent).toContain("could not reach the API");

    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));

    await screen.findByRole("heading", {
      name: "Sparse attention without the quadratic cost",
    });
    expect(loadPaper).toHaveBeenCalledTimes(2);
  });

  it("says a version is not on this server rather than showing an empty paper", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        loadPaper={async () => {
          throw new ApiError(404, { status: 404 });
        }}
        loadClauses={async () => [...CLAUSES]}
      />,
    );

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("not on this server");
    expect(screen.queryByText("Not listed")).toBeNull();
  });
});
