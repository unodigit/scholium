// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import type { SignedRecord } from "../web-auth";
import { DecisionForm } from "./decision-form";
import type { DecisionAccepted, DecisionBody } from "./decision";

/**
 * The tombstone (legal takedown) action in the decision form: offered to tier
 * 4 only, and published only with a legal reason.
 */

const CLAUSES = [
  { id: "MOD-01", title: "Out of scope", text: "A submission outside every open category is rejected." },
  { id: "MOD-05", title: "Legal takedown", text: "Content is removed on a legal order." },
] as const;

const VERSION = "bafyversion";

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

const actionSelect = () => screen.getByLabelText(/^Action/) as HTMLSelectElement;
const clauseSelect = () => screen.getByLabelText(/^Policy clause/) as HTMLSelectElement;
const actionValues = () => Array.from(actionSelect().options).map((option) => option.value);

/** An unsigned JWT-shaped access token whose claims carry `tier`. */
function tokenForTier(tier: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ sub: "did:key:z6MkMod", tier })}.sig`;
}

describe("offering the tombstone action", () => {
  it("is offered to a tier-4 moderator", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={4} />);

    expect(actionValues()).toContain("tombstone");
    expect(screen.getByRole("option", { name: "Legal takedown (tombstone)" })).toBeTruthy();
  });

  it("is not offered below tier 4, or when the tier is not known", () => {
    for (const tier of [3, 2, null] as const) {
      render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={tier} />);
      expect(actionValues()).not.toContain("tombstone");
      cleanup();
    }
  });

  it("reads the tier from the signed-in account's token when none is given", async () => {
    tokenStore.set({ accessToken: tokenForTier(4) });
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} />);

    await waitFor(() => expect(actionValues()).toContain("tombstone"));
  });

  it("is not offered to a signed-in account whose token says tier 3", async () => {
    tokenStore.set({ accessToken: tokenForTier(3) });
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} />);

    // Let the viewer's effect run, then check nothing was added.
    await waitFor(() => expect(actionSelect()).toBeTruthy());
    expect(actionValues()).not.toContain("tombstone");
  });
});

describe("choosing the tombstone action", () => {
  function chooseTombstone(): void {
    fireEvent.change(actionSelect(), { target: { value: "tombstone" } });
  }

  it("asks for the legal reason, and warns that the files are removed for good", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={4} />);
    chooseTombstone();

    const reason = screen.getByLabelText(/^Legal reason/) as HTMLTextAreaElement;
    expect(reason.required).toBe(true);
    expect(screen.getByText(/deletes the version.s files/i)).toBeTruthy();
  });

  it("does not sign a tombstone with no legal reason", async () => {
    const signDecision = vi.fn();
    render(
      <DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={4} signDecision={signDecision} />,
    );
    chooseTombstone();
    fireEvent.change(clauseSelect(), { target: { value: "MOD-05" } });

    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/legal reason/i);
    expect(signDecision).not.toHaveBeenCalled();
  });

  it("signs and submits a tombstone of the version with its legal reason", async () => {
    const signDecision = vi.fn(
      async (body: DecisionBody): Promise<SignedRecord> => ({
        v: 1,
        type: "moderation.decision",
        id: "bafydecision",
        author: "did:key:z6MkMod",
        created: "2026-11-17T00:00:00Z",
        prev: null,
        body,
        proofs: [],
        sig: "signature",
      }),
    );
    const submitDecision = vi.fn(
      async (record: SignedRecord): Promise<DecisionAccepted> => ({
        id: record.id,
        shortId: null,
        target: VERSION,
        action: "tombstone",
        clause: "MOD-05",
        state: "tombstoned",
        anchor: "pending",
      }),
    );
    render(
      <DecisionForm
        versionCid={VERSION}
        clauses={CLAUSES}
        tier={4}
        signDecision={signDecision}
        submitDecision={submitDecision}
      />,
    );
    chooseTombstone();
    fireEvent.change(clauseSelect(), { target: { value: "MOD-05" } });
    fireEvent.change(screen.getByLabelText(/^Legal reason/), {
      target: { value: "Court order 2026/114." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign decision" }));

    await waitFor(() => expect(submitDecision).toHaveBeenCalledTimes(1));
    expect(signDecision).toHaveBeenCalledWith({
      target: VERSION,
      action: "tombstone",
      clause: "MOD-05",
      reason: "Court order 2026/114.",
    });
    expect(await screen.findByRole("heading", { name: "Decision published" })).toBeTruthy();
  });
});
