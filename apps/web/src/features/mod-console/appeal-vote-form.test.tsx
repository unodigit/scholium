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

import { ApiError, NetworkError } from "../../lib/api";
import { AppealVoteForm } from "./appeal-vote-form";
import {
  PANEL_RECORD_NOTICE,
  type VoteAccepted,
  type VoteCaster,
} from "./panel-vote";

const APPEAL = "bafy-appeal-1";

function accepted(overrides: Partial<VoteAccepted> = {}): VoteAccepted {
  return {
    appealCid: APPEAL,
    outcome: "overturned",
    votes: 1,
    decisionCid: null,
    decidedOutcome: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function outcomeSelect(): HTMLSelectElement {
  return screen.getByLabelText(/Outcome/) as HTMLSelectElement;
}

function reasonsBox(): HTMLTextAreaElement {
  return screen.getByLabelText(/Your reasons/) as HTMLTextAreaElement;
}

function fill(outcome = "overturned", reasons = "The paper is in scope of MOD-01.") {
  fireEvent.change(outcomeSelect(), { target: { value: outcome } });
  fireEvent.change(reasonsBox(), { target: { value: reasons } });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Cast my vote" }));
}

describe("AppealVoteForm fields", () => {
  it("asks for a required outcome and required reasons", () => {
    render(<AppealVoteForm appealCid={APPEAL} castVote={vi.fn()} />);

    expect(outcomeSelect().required).toBe(true);
    expect(reasonsBox().required).toBe(true);
    const options = within(outcomeSelect())
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Choose an outcome…",
      "Uphold the decision",
      "Overturn the decision",
      "Modify the decision",
      "Send it back to the moderators",
    ]);
    expect(outcomeSelect().value).toBe("");
  });

  it("states that the panel's decision is a public signed record", () => {
    render(<AppealVoteForm appealCid={APPEAL} castVote={vi.fn()} />);
    expect(screen.getByText(PANEL_RECORD_NOTICE)).toBeTruthy();
  });

  it("says two of three drawn members decide and that the server checks the seat", () => {
    render(<AppealVoteForm appealCid={APPEAL} castVote={vi.fn()} />);
    const lede = screen.getByText(/members are drawn for each appeal/);
    expect(lede.textContent).toContain("3 members");
    expect(lede.textContent).toContain("When 2 back the same outcome");
    expect(lede.textContent).toContain("checks your seat");
  });

  it("explains the chosen outcome in one line", () => {
    render(<AppealVoteForm appealCid={APPEAL} castVote={vi.fn()} />);
    fireEvent.change(outcomeSelect(), { target: { value: "remanded" } });
    expect(
      screen.getByText(/moderators should decide again, taking your reasons into account/),
    ).toBeTruthy();
  });
});

describe("AppealVoteForm validation", () => {
  it("names each missing field and sends nothing", () => {
    const castVote = vi.fn<VoteCaster>();
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    submit();

    const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alerts).toEqual([
      "Choose the outcome you back.",
      "Give your reasons. They are published with the decision.",
    ]);
    expect(outcomeSelect().getAttribute("aria-invalid")).toBe("true");
    expect(reasonsBox().getAttribute("aria-invalid")).toBe("true");
    expect(castVote).not.toHaveBeenCalled();
  });

  it("clears a field's message as soon as it is fixed", () => {
    render(<AppealVoteForm appealCid={APPEAL} castVote={vi.fn()} />);
    submit();

    fireEvent.change(outcomeSelect(), { target: { value: "upheld" } });

    expect(screen.queryByText("Choose the outcome you back.")).toBeNull();
    expect(screen.getByText(/Give your reasons/)).toBeTruthy();
  });

  it("treats whitespace-only reasons as missing", () => {
    const castVote = vi.fn<VoteCaster>();
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);
    fill("upheld", "   ");
    submit();

    expect(screen.getByRole("alert").textContent).toContain("Give your reasons");
    expect(castVote).not.toHaveBeenCalled();
  });
});

describe("AppealVoteForm casting", () => {
  it("sends the appeal id and the chosen outcome and reasons", async () => {
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(accepted());
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill("overturned", "The paper is in scope of MOD-01.");
    submit();

    await screen.findByRole("heading", { name: /Your vote is recorded/ });
    expect(castVote).toHaveBeenCalledWith(APPEAL, {
      outcome: "overturned",
      reasons: "The paper is in scope of MOD-01.",
    });
  });

  it("disables the form while the vote is in flight, so it cannot be sent twice", async () => {
    let resolve!: (value: VoteAccepted) => void;
    const castVote = vi.fn<VoteCaster>(
      () => new Promise<VoteAccepted>((done) => (resolve = done)),
    );
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill();
    submit();

    const busy = await screen.findByRole("button", { name: "Recording your vote…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(outcomeSelect().disabled).toBe(true);
    fireEvent.click(busy);
    expect(castVote).toHaveBeenCalledTimes(1);

    resolve(accepted());
    await screen.findByRole("heading", { name: /Your vote is recorded/ });
  });

  it("says how many of the three have voted and that two decide", async () => {
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(accepted({ votes: 2 }));
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill();
    submit();

    const status = await screen.findByText(/You voted/);
    expect(status.textContent).toContain("You voted to overturn the decision");
    expect(status.textContent).toContain("2 of 3 members have voted");
    expect(status.textContent).toContain("2 matching votes decide the appeal");
    expect(screen.getByText(PANEL_RECORD_NOTICE)).toBeTruthy();
  });

  it("says when the vote was recorded, with the outcome as a verb", async () => {
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(
      accepted({ outcome: "upheld", votedAt: "2026-11-18T09:30:00Z" }),
    );
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill("upheld");
    submit();

    const status = await screen.findByText(/You voted/);
    expect(status.textContent).toContain("You voted to uphold the decision on 18 Nov 2026");
  });

  it("does not claim a count the API did not send", async () => {
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(accepted({ votes: null }));
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill();
    submit();

    const status = await screen.findByText(/You voted/);
    expect(status.textContent).not.toMatch(/of 3 members/);
  });

  it("reports the panel's decision and links to the signed record when the vote decides it", async () => {
    const onDecided = vi.fn();
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(
      accepted({
        votes: 2,
        decisionCid: "bafy-panel-decision",
        decidedOutcome: "overturned",
      }),
    );
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} onDecided={onDecided} />);

    fill();
    submit();

    expect(await screen.findByRole("heading", { name: /The panel has decided/ })).toBeTruthy();
    expect(screen.getByText(/2 members agree/).textContent).toContain("Decision overturned");
    expect(screen.getByRole("button", { name: "View the panel's decision" })).toBeTruthy();
    // The panel has decided: there is nothing left to change.
    expect(screen.queryByRole("button", { name: "Change my vote" })).toBeNull();
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it("does not tell the card the appeal is decided when it is not", async () => {
    const onDecided = vi.fn();
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(accepted());
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} onDecided={onDecided} />);

    fill();
    submit();

    await screen.findByRole("heading", { name: /Your vote is recorded/ });
    expect(onDecided).not.toHaveBeenCalled();
  });

  it("lets a member change their vote until the panel decides, keeping what they wrote", async () => {
    const castVote = vi.fn<VoteCaster>().mockResolvedValue(accepted());
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);
    fill("overturned", "First thoughts.");
    submit();

    fireEvent.click(await screen.findByRole("button", { name: "Change my vote" }));

    expect(outcomeSelect().value).toBe("overturned");
    expect(reasonsBox().value).toBe("First thoughts.");

    fireEvent.change(outcomeSelect(), { target: { value: "upheld" } });
    submit();
    await waitFor(() => expect(castVote).toHaveBeenCalledTimes(2));
    expect(castVote).toHaveBeenLastCalledWith(APPEAL, {
      outcome: "upheld",
      reasons: "First thoughts.",
    });
  });
});

describe("AppealVoteForm refusals", () => {
  it("replaces the form with a plain note when the account holds no seat (403)", async () => {
    const castVote = vi.fn<VoteCaster>().mockRejectedValue(
      new ApiError(403, { status: 403, type: "urn:scholium:problem:vote-not-authorized" }),
    );
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill();
    submit();

    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("do not hold a seat on this appeal's panel");
    // Not a fault: no alert, and no form left to fill in.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cast my vote" })).toBeNull();
  });

  it("asks to sign in again when the session has ended (401), keeping the form", async () => {
    const castVote = vi.fn<VoteCaster>().mockRejectedValue(new ApiError(401, { status: 401 }));
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill("upheld", "Keep it.");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("session has ended");
    expect(within(alert).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Fmod",
    );
    expect(reasonsBox().value).toBe("Keep it.");
  });

  it("keeps the form and what was written when no panel is seated yet (409)", async () => {
    const castVote = vi.fn<VoteCaster>().mockRejectedValue(new ApiError(409, { status: 409 }));
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill("modified", "Change the clause.");
    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("No panel has been seated");
    expect(outcomeSelect().value).toBe("modified");
    expect(reasonsBox().value).toBe("Change the clause.");
    expect((screen.getByRole("button", { name: "Cast my vote" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("lets the member try again after a failed attempt", async () => {
    const castVote = vi
      .fn<VoteCaster>()
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockResolvedValueOnce(accepted());
    render(<AppealVoteForm appealCid={APPEAL} castVote={castVote} />);

    fill();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("could not reach the API");

    submit();
    await screen.findByRole("heading", { name: /Your vote is recorded/ });
    expect(castVote).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
