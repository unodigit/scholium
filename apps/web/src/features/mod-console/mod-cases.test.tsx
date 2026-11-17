// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";
import type { AppealCase, AppealsLoad } from "./appeals";
import type { FlagEntry } from "./flags";
import { ModCases } from "./mod-cases";
import type { VoteAccepted, VoteCaster } from "./panel-vote";

function flag(overrides: Partial<FlagEntry> = {}): FlagEntry {
  return {
    id: "flag-1",
    targetCid: "bafy-flagged-1",
    reporterDid: "did:key:z6MkReporter",
    reason: "spam",
    status: "pending",
    decisionCid: null,
    ...overrides,
  };
}

function appeal(overrides: Partial<AppealCase> = {}): AppealCase {
  return {
    appealCid: "bafy-appeal-1",
    decisionCid: "bafy-decision-1",
    appellantDid: "did:key:z6MkAuthor",
    grounds: "The paper is squarely in scope.",
    filedAt: "2027-05-04T09:30:00Z",
    original: {
      action: "reject",
      clause: "MOD-01",
      reason: "Out of scope.",
      moderatorDid: "did:key:z6MkModerator",
      versionCid: "bafy-version-1",
    },
    paper: {
      title: "Sparse attention without the quadratic cost",
      versionId: "sch:k3f9-q2xz-7mwd/v1",
      versionCid: "bafy-version-1",
    },
    verdict: null,
    ...overrides,
  };
}

const DECIDED = appeal({
  appealCid: "bafy-appeal-2",
  decisionCid: "bafy-decision-2",
  grounds: "A second appeal.",
  paper: {
    title: "A tidy proof of a small lemma",
    versionId: "sch:abcd-efgh-jklm/v2",
    versionCid: "bafy-version-2",
  },
  verdict: {
    cid: "bafy-verdict-2",
    outcome: "upheld",
    reasons: ["The scope statement is clear."],
    votes: [],
    decidedAt: "2027-05-09T10:00:00Z",
  },
});

function load(cases: AppealCase[], truncated = false): AppealsLoad {
  return { cases, truncated };
}

/** Loaders that resolve at once: a quiet console with one open appeal. */
function quiet() {
  return {
    loadFlags: vi.fn(async () => [] as FlagEntry[]),
    loadFlag: vi.fn(async () => flag()),
    loadTarget: vi.fn(async (cid: string) => ({
      cid,
      type: "paper.version",
      typeLabel: "Paper version",
      paperTitle: null,
      paperHref: null,
      excerpt: null,
    })),
    loadAppeals: vi.fn(async () => load([appeal()])),
    castVote: vi.fn<VoteCaster>(),
  };
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

describe("ModCases session", () => {
  it("renders nothing and asks for nothing when signed out", () => {
    const loaders = quiet();
    const { container } = render(<ModCases signedIn={false} {...loaders} />);

    expect(container.textContent).toBe("");
    expect(loaders.loadFlags).not.toHaveBeenCalled();
    expect(loaders.loadAppeals).not.toHaveBeenCalled();
  });

  it("reads the session from the token store when it is not pinned", async () => {
    const loaders = quiet();

    const first = render(<ModCases {...loaders} />);
    await waitFor(() => expect(first.container.textContent).toBe(""));
    expect(loaders.loadAppeals).not.toHaveBeenCalled();

    cleanup();
    tokenStore.set({ accessToken: "an-access-token" });
    render(<ModCases {...loaders} />);
    expect(await screen.findByRole("heading", { name: "Appeals" })).toBeTruthy();
    expect(loaders.loadFlags).toHaveBeenCalledTimes(1);
    expect(loaders.loadAppeals).toHaveBeenCalledTimes(1);
  });

  it("shows both sections, flags first, once there is a session", async () => {
    render(<ModCases signedIn {...quiet()} />);

    await screen.findByText("No flags are waiting.");
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Flags", "Appeals"]);
  });
});

describe("flags", () => {
  it("lists a flag with its reason, what it is about, who reported it and where it stands", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadFlags={async () => [flag(), flag({ id: "flag-2", reason: "plagiarism", status: "decided", decisionCid: "bafy-decision-9" })]}
      />,
    );

    const flags = within(await screen.findByRole("list", { name: "Flags" }));
    const [open, decided] = flags.getAllByRole("article");

    expect(within(open!).getByRole("heading", { name: "Spam" })).toBeTruthy();
    expect(within(open!).getByText("Waiting for a moderator")).toBeTruthy();
    expect(within(open!).getByText("bafy-flagged-1")).toBeTruthy();
    expect(within(open!).getByText("did:key:z6MkReporter")).toBeTruthy();
    expect(within(decided!).getByRole("heading", { name: "Plagiarism" })).toBeTruthy();
    expect(within(decided!).getByText("Decided")).toBeTruthy();
  });

  it("counts what is waiting and what is decided", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadFlags={async () => [flag(), flag({ id: "f2" }), flag({ id: "f3", status: "decided" })]}
      />,
    );
    expect(await screen.findByText("2 flags waiting · 1 decided")).toBeTruthy();
  });

  it("sends an open flag to the decision view for what was flagged, and a decided one to its decision", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadFlags={async () => [
          flag({ targetCid: "bafy-flagged-1" }),
          flag({ id: "f2", status: "decided", decisionCid: "bafy-decision-9" }),
        ]}
      />,
    );

    const [open, decided] = within(await screen.findByRole("list", { name: "Flags" })).getAllByRole("article");
    expect(within(open!).getByRole("link", { name: "Decide on it" }).getAttribute("href")).toBe(
      "/mod/bafy-flagged-1",
    );
    expect(within(decided!).queryByRole("link", { name: "Decide on it" })).toBeNull();
    expect(within(decided!).getByRole("button", { name: "View the decision" })).toBeTruthy();
    expect(within(open!).getByRole("button", { name: "View the flagged record" })).toBeTruthy();
  });

  it("says plainly that this server does not list flags, rather than showing an empty list", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadFlags={async () => {
          throw new ApiError(405, { status: 405 });
        }}
      />,
    );

    const note = await screen.findByText(/does not list flags yet/);
    expect(note.getAttribute("role")).toBe("status");
    expect(screen.queryByText("No flags are waiting.")).toBeNull();
    // The flag can still be opened by its id.
    expect(screen.getByRole("form", { name: "Flag lookup" })).toBeTruthy();
  });

  it("tells a tier-3 panel member flags are moderator-only, and still shows their appeals and vote", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadFlags={async () => {
          throw new ApiError(403, { status: 403, caller_tier: 3 });
        }}
      />,
    );

    const note = await screen.findByText(/Flags are for moderators/);
    expect(note.textContent).toContain("Your account is tier 3.");
    const appeals = await screen.findByRole("region", { name: "Appeals" });
    expect(within(appeals).getByRole("button", { name: "Cast my vote" })).toBeTruthy();
  });

  it("offers sign-in when the session ends mid-load", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadFlags={async () => {
          throw new ApiError(401, { status: 401 });
        }}
      />,
    );

    const alert = await screen.findByRole("heading", { name: "Sign in to see flags" });
    expect(
      within(alert.closest("[role=alert]") as HTMLElement)
        .getByRole("link", { name: "Sign in" })
        .getAttribute("href"),
    ).toBe("/signin?next=%2Fmod");
  });

  it("explains a failed list and retries it", async () => {
    const loadFlags = vi
      .fn<() => Promise<FlagEntry[]>>()
      .mockRejectedValueOnce(new ApiError(500, { status: 500, detail: "The flag table is locked." }))
      .mockResolvedValueOnce([flag()]);
    render(<ModCases signedIn {...quiet()} loadFlags={loadFlags} />);

    const notice = (await screen.findByText("The flag table is locked.")).closest("[role=alert]")!;
    fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Spam" })).toBeTruthy();
    expect(loadFlags).toHaveBeenCalledTimes(2);
  });

  it("says no flags are waiting for an empty list, and checks again on request", async () => {
    const loadFlags = vi.fn<() => Promise<FlagEntry[]>>().mockResolvedValue([]);
    render(<ModCases signedIn {...quiet()} loadFlags={loadFlags} />);

    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(loadFlags).toHaveBeenCalledTimes(2));
  });
});

describe("opening a flag by its id", () => {
  async function lookupForm() {
    return within(await screen.findByRole("form", { name: "Flag lookup" }));
  }

  it("opens the flag the API returns for that id", async () => {
    const loadFlag = vi.fn(async () => flag({ id: "flag-77", reason: "harassment" }));
    render(<ModCases signedIn {...quiet()} loadFlag={loadFlag} />);

    const form = await lookupForm();
    fireEvent.change(form.getByLabelText("Open a flag by its id"), { target: { value: "  flag-77 " } });
    fireEvent.click(form.getByRole("button", { name: "Open flag" }));

    expect(await form.findByRole("heading", { name: "Harassment" })).toBeTruthy();
    expect(loadFlag).toHaveBeenCalledWith("flag-77");
  });

  it("asks for an id instead of sending a blank one", async () => {
    const loadFlag = vi.fn();
    render(<ModCases signedIn {...quiet()} loadFlag={loadFlag} />);

    const form = await lookupForm();
    fireEvent.click(form.getByRole("button", { name: "Open flag" }));

    expect(form.getByRole("alert").textContent).toContain("Enter the id of the flag.");
    expect(loadFlag).not.toHaveBeenCalled();
  });

  it("says no flag has that id on a 404", async () => {
    const loadFlag = vi.fn(async () => {
      throw new ApiError(404, { status: 404 });
    });
    render(<ModCases signedIn {...quiet()} loadFlag={loadFlag} />);

    const form = await lookupForm();
    fireEvent.change(form.getByLabelText("Open a flag by its id"), { target: { value: "nope" } });
    fireEvent.click(form.getByRole("button", { name: "Open flag" }));

    expect((await form.findByRole("alert")).textContent).toContain("No flag with that id is on this server.");
  });

  it("explains an unreachable API", async () => {
    const loadFlag = vi.fn(async () => {
      throw new NetworkError("offline");
    });
    render(<ModCases signedIn {...quiet()} loadFlag={loadFlag} />);

    const form = await lookupForm();
    fireEvent.change(form.getByLabelText("Open a flag by its id"), { target: { value: "x" } });
    fireEvent.click(form.getByRole("button", { name: "Open flag" }));

    expect((await form.findByRole("alert")).textContent).toContain("could not reach the API");
  });
});

describe("appeals", () => {
  it("shows the decision that was appealed, the grounds and the paper", async () => {
    render(<ModCases signedIn {...quiet()} />);

    const card = within(await screen.findByRole("article", { name: "Sparse attention without the quadratic cost" }));
    expect(card.getByText("sch:k3f9-q2xz-7mwd/v1")).toBeTruthy();
    // The appellant shows as their DID until a profile name resolves; the
    // name and the DID are separate nodes (see person.tsx).
    expect(card.getByText(/Filed 4 May 2027 by/)).toBeTruthy();
    expect(card.getByText("did:key:z6MkAuthor")).toBeTruthy();
    expect(card.getByText("Reject the paper")).toBeTruthy();
    expect(card.getByRole("link", { name: "MOD-01" }).getAttribute("href")).toBe("/policies#MOD-01");
    expect(card.getByText("Out of scope.")).toBeTruthy();
    expect(card.getByText("The paper is squarely in scope.")).toBeTruthy();
    expect(card.getByText("Waiting for the panel")).toBeTruthy();
    expect(card.getByRole("link", { name: "Read the paper" }).getAttribute("href")).toBe("/mod/bafy-version-1");
    expect(card.getByRole("button", { name: "View the appeal" })).toBeTruthy();
    expect(card.getByRole("button", { name: "View the decision" })).toBeTruthy();
  });

  it("puts the panel vote form on an open appeal", async () => {
    render(<ModCases signedIn {...quiet()} />);

    const card = within(await screen.findByRole("article", { name: "Sparse attention without the quadratic cost" }));
    expect(card.getByRole("form", { name: "Your panel vote" })).toBeTruthy();
    expect(card.getByLabelText(/Outcome/)).toBeTruthy();
    expect(card.getByLabelText(/Your reasons/)).toBeTruthy();
    expect(card.getByRole("button", { name: "Cast my vote" })).toBeTruthy();
  });

  it("shows a decided appeal's outcome and reasons instead of a vote form", async () => {
    render(<ModCases signedIn {...quiet()} loadAppeals={async () => load([DECIDED])} />);

    const card = within(await screen.findByRole("article", { name: "A tidy proof of a small lemma" }));
    expect(card.getByText("Decided by the panel")).toBeTruthy();
    expect(card.getByText(/Decision upheld/)).toBeTruthy();
    expect(card.getByText("The scope statement is clear.")).toBeTruthy();
    expect(card.getByRole("button", { name: "View the panel's decision" })).toBeTruthy();
    expect(card.queryByRole("form", { name: "Your panel vote" })).toBeNull();
    expect(card.queryByRole("button", { name: "Cast my vote" })).toBeNull();
  });

  it("counts open and decided appeals and lists the open ones first", async () => {
    render(<ModCases signedIn {...quiet()} loadAppeals={async () => load([appeal(), DECIDED])} />);

    expect(await screen.findByText("1 appeal waiting for a panel · 1 decided")).toBeTruthy();
    const titles = within(screen.getByRole("list", { name: "Appeals" }))
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(["Sparse attention without the quadratic cost", "A tidy proof of a small lemma"]);
  });

  it("still shows an appeal whose decision and paper this server's log lacks", async () => {
    render(
      <ModCases
        signedIn
        {...quiet()}
        loadAppeals={async () => load([appeal({ original: null, paper: null })])}
      />,
    );

    const card = within(await screen.findByRole("article", { name: "Appeal of a moderation decision" }));
    expect(card.getByText(/does not hold the decision record/)).toBeTruthy();
    expect(card.queryByRole("link", { name: "Read the paper" })).toBeNull();
    expect(card.getByRole("button", { name: "Cast my vote" })).toBeTruthy();
  });

  it("says no appeals have been filed for an empty log", async () => {
    render(<ModCases signedIn {...quiet()} loadAppeals={async () => load([])} />);
    expect(await screen.findByText("No appeals have been filed.")).toBeTruthy();
  });

  it("says when the log was longer than the console reads", async () => {
    render(<ModCases signedIn {...quiet()} loadAppeals={async () => load([appeal()], true)} />);
    expect(await screen.findByText(/longer than the console reads/)).toBeTruthy();
  });

  it("explains a failed load and retries it", async () => {
    const loadAppeals = vi
      .fn<() => Promise<AppealsLoad>>()
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockResolvedValueOnce(load([appeal()]));
    render(<ModCases signedIn {...quiet()} loadAppeals={loadAppeals} />);

    const notice = (await screen.findByRole("heading", { name: "Couldn’t load the appeals" })).closest(
      "[role=alert]",
    ) as HTMLElement;
    expect(notice.textContent).toContain("could not reach the API");
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("article", { name: "Sparse attention without the quadratic cost" })).toBeTruthy();
    expect(loadAppeals).toHaveBeenCalledTimes(2);
  });

  it("keeps the list up while it refreshes", async () => {
    let resolve!: (value: AppealsLoad) => void;
    const loadAppeals = vi
      .fn<() => Promise<AppealsLoad>>()
      .mockResolvedValueOnce(load([appeal()]))
      .mockImplementationOnce(() => new Promise<AppealsLoad>((done) => (resolve = done)));
    render(<ModCases signedIn {...quiet()} loadAppeals={loadAppeals} />);

    const appeals = within(await screen.findByRole("region", { name: "Appeals" }));
    fireEvent.click(appeals.getByRole("button", { name: "Refresh" }));

    expect((await appeals.findByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(appeals.getByRole("article", { name: "Sparse attention without the quadratic cost" })).toBeTruthy();

    resolve(load([appeal(), DECIDED]));
    expect(await appeals.findByText("1 appeal waiting for a panel · 1 decided")).toBeTruthy();
  });
});

describe("casting a vote from an appeal card", () => {
  function fillAndCast(card: ReturnType<typeof within>, outcome = "overturned") {
    fireEvent.change(card.getByLabelText(/Outcome/), { target: { value: outcome } });
    fireEvent.change(card.getByLabelText(/Your reasons/), { target: { value: "In scope of MOD-01." } });
    fireEvent.click(card.getByRole("button", { name: "Cast my vote" }));
  }

  it("casts the vote on this appeal's cid and confirms it", async () => {
    const castVote = vi.fn<VoteCaster>().mockResolvedValue({
      appealCid: "bafy-appeal-1",
      outcome: "overturned",
      votes: 1,
      decisionCid: null,
      decidedOutcome: null,
    });
    render(<ModCases signedIn {...quiet()} castVote={castVote} />);

    const card = within(await screen.findByRole("article", { name: "Sparse attention without the quadratic cost" }));
    fillAndCast(card);

    expect(await card.findByRole("heading", { name: /Your vote is recorded/ })).toBeTruthy();
    expect(castVote).toHaveBeenCalledWith("bafy-appeal-1", {
      outcome: "overturned",
      reasons: "In scope of MOD-01.",
    });
    // One vote does not decide it.
    expect(card.getByText("Waiting for the panel")).toBeTruthy();
  });

  it("marks the appeal decided as soon as the vote completes the panel", async () => {
    const decided: VoteAccepted = {
      appealCid: "bafy-appeal-1",
      outcome: "overturned",
      votes: 2,
      decisionCid: "bafy-panel-decision",
      decidedOutcome: "overturned",
    };
    render(<ModCases signedIn {...quiet()} castVote={vi.fn<VoteCaster>().mockResolvedValue(decided)} />);

    const card = within(await screen.findByRole("article", { name: "Sparse attention without the quadratic cost" }));
    fillAndCast(card);

    expect(await card.findByText("Decided by the panel")).toBeTruthy();
    expect(card.queryByText("Waiting for the panel")).toBeNull();
    // The member who completed the panel still reads what they did.
    expect(card.getByRole("heading", { name: /The panel has decided/ })).toBeTruthy();
  });

  it("tells a member who was not drawn so, and leaves the other appeals' forms alone", async () => {
    const castVote = vi
      .fn<VoteCaster>()
      .mockRejectedValue(new ApiError(403, { status: 403 }));
    const second = appeal({
      appealCid: "bafy-appeal-3",
      paper: { title: "Another contested paper", versionId: null, versionCid: "bafy-version-3" },
    });
    render(
      <ModCases signedIn {...quiet()} castVote={castVote} loadAppeals={async () => load([appeal(), second])} />,
    );

    const first = within(await screen.findByRole("article", { name: "Sparse attention without the quadratic cost" }));
    fillAndCast(first);

    expect((await first.findByRole("status")).textContent).toContain("do not hold a seat");
    expect(first.queryByRole("button", { name: "Cast my vote" })).toBeNull();
    const other = within(screen.getByRole("article", { name: "Another contested paper" }));
    expect(other.getByRole("button", { name: "Cast my vote" })).toBeTruthy();
  });
});
