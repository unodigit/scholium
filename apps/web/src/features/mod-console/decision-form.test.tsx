// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import { PasskeyCancelledError, type SignedRecord } from "../web-auth";
import { DecisionForm } from "./decision-form";
import { PUBLIC_RECORD_NOTICE, type DecisionBody } from "./decision";

const CLAUSES = [
  {
    id: "MOD-01",
    title: "Out of scope",
    text: "A submission outside every open category is rejected.",
  },
  {
    id: "MOD-02",
    title: "Plagiarism and unattributed overlap",
    text: "A submission must attribute every source it draws on.",
  },
] as const;

const VERSION = "bafyversion";

function record(body: Record<string, unknown>): SignedRecord {
  return {
    v: 1,
    type: "moderation.decision",
    id: "bafydecision",
    author: "did:key:z6MkModerator",
    created: "2026-11-14T06:00:00Z",
    prev: null,
    body,
    proofs: [],
    sig: "signature",
  };
}

afterEach(cleanup);

function actionSelect(): HTMLSelectElement {
  return screen.getByLabelText(/^Action/) as HTMLSelectElement;
}

function clauseSelect(): HTMLSelectElement {
  return screen.getByLabelText(/^Policy clause/) as HTMLSelectElement;
}

function reasonBox(): HTMLTextAreaElement {
  return screen.getByLabelText(/^Reason shown to the author/) as HTMLTextAreaElement;
}

function fillValidDecision(reason = "The overlap is unattributed."): void {
  fireEvent.change(actionSelect(), { target: { value: "reject" } });
  fireEvent.change(clauseSelect(), { target: { value: "MOD-02" } });
  fireEvent.change(reasonBox(), { target: { value: reason } });
}

describe("DecisionForm fields", () => {
  it("shows a required action, policy clause and reason", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} />);

    expect(actionSelect().required).toBe(true);
    expect(clauseSelect().required).toBe(true);
    expect(reasonBox().required).toBe(true);

    // Every clause is offered, id first so the moderator knows what is signed.
    const options = Array.from(clauseSelect().options).map((option) => option.value);
    expect(options).toEqual(["", "MOD-01", "MOD-02"]);
    expect(screen.getByRole("option", { name: "MOD-02 — Plagiarism and unattributed overlap" })).toBeTruthy();
  });

  it("states, word for word, that the decision is a public signed record", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} />);

    expect(screen.getByText(PUBLIC_RECORD_NOTICE)).toBeTruthy();
    expect(screen.getByText("This decision is a public signed record.")).toBeTruthy();
  });

  it("has an author preview that fills in as the decision is written", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} />);

    expect(
      screen.getByRole("heading", {
        name: "Preview of what the author will see",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Choose an action to preview/)).toBeTruthy();

    fireEvent.change(actionSelect(), { target: { value: "reject" } });
    fireEvent.change(clauseSelect(), { target: { value: "MOD-02" } });
    fireEvent.change(reasonBox(), { target: { value: "The overlap is unattributed." } });

    const preview = screen
      .getByRole("heading", { name: "Preview of what the author will see" })
      .closest("section") as HTMLElement;

    expect(preview.textContent).toContain("Your paper has not been listed.");
    expect(preview.textContent).toContain("The overlap is unattributed.");
    expect(preview.textContent).toContain("Plagiarism and unattributed overlap");
    expect(preview.textContent).toContain("You can appeal once.");

    const policy = preview.querySelector("a");
    expect(policy?.getAttribute("href")).toBe("/policies#MOD-02");
    expect(policy?.textContent).toBe("MOD-02");
  });

  it("offers a category only for a reclassification", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} />);
    expect(screen.queryByLabelText(/^New category/)).toBeNull();

    fireEvent.change(actionSelect(), { target: { value: "reclassify" } });
    const category = screen.getByLabelText(/^New category/) as HTMLInputElement;
    expect(category.required).toBe(true);

    fireEvent.change(category, { target: { value: "cs.LG" } });
    expect(screen.getByText("Your paper has been reclassified to cs.LG.")).toBeTruthy();

    fireEvent.change(actionSelect(), { target: { value: "hold" } });
    expect(screen.queryByLabelText(/^New category/)).toBeNull();
  });
});

describe("DecisionForm validation", () => {
  it("will not sign an empty decision and says what is missing", () => {
    const sign = vi.fn();
    render(
      <DecisionForm versionCid={VERSION} clauses={CLAUSES} signDecision={sign} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect(screen.getByText("Choose an action.")).toBeTruthy();
    expect(
      screen.getByText("Choose the policy clause this decision cites."),
    ).toBeTruthy();
    expect(screen.getByText("Write the reason the author will see.")).toBeTruthy();
    expect(sign).not.toHaveBeenCalled();
  });

  it("requires a category for a reclassification", () => {
    const sign = vi.fn();
    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={[
          ...CLAUSES,
          { id: "MOD-10", title: "Misclassification", text: "Move it." },
        ]}
        signDecision={sign}
      />,
    );

    fireEvent.change(actionSelect(), { target: { value: "reclassify" } });
    fireEvent.change(clauseSelect(), { target: { value: "MOD-10" } });
    fireEvent.change(reasonBox(), { target: { value: "Wrong category." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect(screen.getByText("Name the category the paper moves to.")).toBeTruthy();
    expect(sign).not.toHaveBeenCalled();
  });

  it("cannot record a decision when the node has published no clauses", () => {
    render(<DecisionForm versionCid={VERSION} clauses={[]} />);

    expect(
      (screen.getByRole("button", { name: "Sign decision" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/No policy clauses are published/)).toBeTruthy();
  });
});

describe("DecisionForm submission", () => {
  it("signs the trimmed body and publishes it, then links to the record", async () => {
    const sign = vi.fn(async (body: DecisionBody) => record(body));
    const submit = vi.fn(async (_record: SignedRecord) => ({
      id: "bafydecision",
      shortId: "sch:5jmi-pmva-4lmr/v2",
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      state: "rejected",
      anchor: "pending",
    }));

    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={CLAUSES}
        signDecision={sign}
        submitDecision={submit}
      />,
    );

    fillValidDecision("  The overlap is unattributed.  ");
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect(
      await screen.findByRole("heading", { name: "Decision published" }),
    ).toBeTruthy();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith({
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      reason: "The overlap is unattributed.",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      type: "moderation.decision",
      body: {
        target: VERSION,
        action: "reject",
        clause: "MOD-02",
        reason: "The overlap is unattributed.",
      },
    });

    expect(screen.getByText(PUBLIC_RECORD_NOTICE)).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.getByText("The overlap is unattributed.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "View the signed record" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to the queue" }).getAttribute("href"),
    ).toBe("/mod");
  });

  it("includes the new category in a reclassification", async () => {
    const sign = vi.fn(async (body: DecisionBody) => record(body));
    const submit = vi.fn(async () => ({
      id: "bafydecision",
      shortId: null,
      target: VERSION,
      action: "reclassify",
      clause: "MOD-10",
      state: "moderation",
      anchor: "pending",
    }));

    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={[
          ...CLAUSES,
          { id: "MOD-10", title: "Misclassification", text: "Move it." },
        ]}
        signDecision={sign}
        submitDecision={submit}
      />,
    );

    fireEvent.change(actionSelect(), { target: { value: "reclassify" } });
    fireEvent.change(screen.getByLabelText(/^New category/), {
      target: { value: " cs.LG " },
    });
    fireEvent.change(clauseSelect(), { target: { value: "MOD-10" } });
    fireEvent.change(reasonBox(), { target: { value: "Wrong category." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    await screen.findByRole("heading", { name: "Decision published" });
    expect(sign).toHaveBeenCalledWith({
      target: VERSION,
      action: "reclassify",
      clause: "MOD-10",
      reason: "Wrong category.",
      category: "cs.LG",
    });
    expect(
      screen.getByText("Still waiting for a decision"),
    ).toBeTruthy();
  });

  it("says nothing was published when the passkey prompt is dismissed", async () => {
    const sign = vi.fn(async () => {
      throw new PasskeyCancelledError();
    });
    const submit = vi.fn();

    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={CLAUSES}
        signDecision={sign}
        submitDecision={submit}
      />,
    );

    fillValidDecision();
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect(
      await screen.findByText(
        "Signing was cancelled, so the decision was not published.",
      ),
    ).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Decision published" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign decision" })).toBeTruthy();
  });

  it("shows the API's refusal and keeps the form for a retry", async () => {
    const sign = vi.fn(async (body: DecisionBody) => record(body));
    const submit = vi.fn(async () => {
      throw new ApiError(403, { status: 403 });
    });

    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={CLAUSES}
        signDecision={sign}
        submitDecision={submit}
      />,
    );

    fillValidDecision();
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Only a moderator (trust tier 4) can record a decision.",
    );
    expect(screen.getByRole("button", { name: "Sign decision" })).toBeTruthy();
  });

  it("makes the passkey wait visible and disables a second submit", async () => {
    let finish: (value: SignedRecord) => void = () => {};
    const sign = vi.fn(
      () =>
        new Promise<SignedRecord>((resolve) => {
          finish = resolve;
        }),
    );
    const submit = vi.fn(async () => ({
      id: "bafydecision",
      shortId: null,
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      state: "rejected",
      anchor: "pending",
    }));

    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={CLAUSES}
        signDecision={sign}
        submitDecision={submit}
      />,
    );

    fillValidDecision();
    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    const busy = await screen.findByRole("button", {
      name: "Waiting for your passkey…",
    });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(sign).toHaveBeenCalledTimes(1);

    finish(record({ target: VERSION }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });
});
