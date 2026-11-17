// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionAccepted, DecisionSigner, DecisionSubmitter } from "./decision";
import type { ModeratedRecord } from "./record";
import { RecordDecisionForm } from "./record-decision-form";

/**
 * A record that is not a paper version is decided with the same signed
 * `moderation.decision` the paper form uses: the target is the flagged record,
 * and the action is one of the two the record's type accepts — dismiss the
 * flag (`dismiss`) or hide the record (`hide`). The paper actions are refused
 * by the API with a 422, so the form never offers them.
 */

const POST: ModeratedRecord = {
  cid: "bafyreidiscussionpostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  type: "discussion.post",
  authorDid: "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
  created: "2027-05-04T09:30:00Z",
  title: null,
  paperCid: "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4",
  paperShortId: "sch:5jmi-pmva-4lmr",
  paperTitle: "Sparse attention without the quadratic cost",
  versionCid: "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey",
  versionId: "sch:5jmi-pmva-4lmr/v2",
  text: "This figure is copied from another paper.",
  quote: null,
  targetCid: "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey",
  body: {},
};

const CLAUSES = [
  { id: "MOD-09", title: "Spam and promotion", text: "Advertising is rejected." },
  { id: "MOD-05", title: "Unlawful content", text: "Unlawful content is delisted." },
] as const;

const ACCEPTED: DecisionAccepted = {
  id: "bafyreidecisionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shortId: null,
  target: POST.cid,
  action: "hide",
  clause: "MOD-09",
  state: "hidden",
  anchor: "pending",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fill(action: string, reason = "The post is advertising with no scholarly content.") {
  fireEvent.change(screen.getByLabelText(/^Action/), { target: { value: action } });
  fireEvent.change(screen.getByLabelText(/^Policy clause/), { target: { value: "MOD-09" } });
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
}

describe("RecordDecisionForm", () => {
  it("offers the decisions that fit a post, named after it", () => {
    render(<RecordDecisionForm record={POST} clauses={[...CLAUSES]} />);

    const action = screen.getByLabelText(/^Action/) as HTMLSelectElement;
    expect(Array.from(action.options).map((option) => option.value)).toEqual([
      "",
      "dismiss",
      "hide",
    ]);
    expect(
      within(action).getByRole("option", { name: /Dismiss the flag \(leave the post as it is\)/ }),
    ).toBeTruthy();
    expect(
      within(action).getByRole("option", { name: "Hide the post from public reads" }),
    ).toBeTruthy();
    // The paper actions say nothing true about a post, and the API refuses
    // each with a 422 -- the takedown included (a hide is the reversible one).
    for (const refused of ["list", "hold", "reclassify", "reject", "delist", "tombstone"]) {
      expect(Array.from(action.options).map((option) => option.value)).not.toContain(refused);
    }
  });

  it("previews the outcome for the record, not for a paper listing", () => {
    render(<RecordDecisionForm record={POST} clauses={[...CLAUSES]} />);
    fill("hide");

    expect(
      screen.getByText(
        "The post is hidden from public reads with the reason below, and the flag is settled.",
      ),
    ).toBeTruthy();
  });

  it("previews the dismiss outcome: the post is left as it is", () => {
    render(<RecordDecisionForm record={POST} clauses={[...CLAUSES]} />);
    fill("dismiss");

    expect(
      screen.getByText("The post stays as it is, and the flag is settled."),
    ).toBeTruthy();
  });

  it("refuses to sign without an action, a clause and a reason", () => {
    const signDecision = vi.fn<DecisionSigner>();
    render(
      <RecordDecisionForm
        record={POST}
        clauses={[...CLAUSES]}
        signDecision={signDecision}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect(screen.getByText("Choose an action.")).toBeTruthy();
    expect(screen.getByText("Choose the policy clause this decision cites.")).toBeTruthy();
    expect(screen.getByText("Write the reason the author will see.")).toBeTruthy();
    expect(signDecision).not.toHaveBeenCalled();
  });

  it("signs a decision whose target is the flagged record and publishes it", async () => {
    const signDecision = vi.fn<DecisionSigner>(async (body) => ({
      v: 1,
      id: ACCEPTED.id,
      type: "moderation.decision",
      author: POST.authorDid,
      created: "2027-05-04T10:00:00Z",
      prev: null,
      body,
      proofs: [],
      sig: "a-signature",
    }));
    const submitDecision = vi.fn<DecisionSubmitter>(async () => ({
      ...ACCEPTED,
      action: "hide",
    }));

    render(
      <RecordDecisionForm
        record={POST}
        clauses={[...CLAUSES]}
        signDecision={signDecision}
        submitDecision={submitDecision}
      />,
    );

    fill("hide");
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect(await screen.findByRole("heading", { name: "Decision published" })).toBeTruthy();
    expect(signDecision).toHaveBeenCalledTimes(1);
    expect(signDecision.mock.calls[0]![0]).toMatchObject({
      target: POST.cid,
      action: "hide",
      clause: "MOD-09",
      reason: "The post is advertising with no scholarly content.",
    });
    expect(submitDecision).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "View the signed record" }),
    ).toBeTruthy();
  });
});
