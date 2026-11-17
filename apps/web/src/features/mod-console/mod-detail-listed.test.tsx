// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { DecisionForm } from "./decision-form";
import type { ModeratedPaper } from "./decision";
import { ModDetail } from "./mod-detail";

const VERSION = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";

const PAPER: ModeratedPaper = {
  versionCid: VERSION,
  paperCid: "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4",
  shortId: "sch:5jmi-pmva-4lmr",
  versionId: "sch:5jmi-pmva-4lmr/v2",
  version: 2,
  title: "Sparse attention without the quadratic cost",
  abstract: "We remove the quadratic term.",
  authors: [],
  categories: ["cs.AI"],
  licence: "CC-BY-4.0",
  changeNote: null,
  manifestCid: null,
};

const CLAUSES = [{ id: "MOD-01", title: "Out of scope", text: "Rejected." }] as const;

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

function actionLabels(): string[] {
  const select = screen.getByLabelText(/^Action/) as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.textContent ?? "");
}

describe("the decision form for a flag on a listed paper", () => {
  it("does not offer List, and offers Dismiss (keep listed), Hold and the takedown", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={4} versionState="listed" />);

    const labels = actionLabels();
    expect(labels).not.toContain("List the paper");
    expect(labels).toContain("Dismiss the flag (keep the paper listed)");
    expect(labels).toContain("Hold from listing");
    expect(labels).toContain("Legal takedown (tombstone)");
  });

  it("offers List while the paper is still waiting for its first decision", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={4} versionState="moderation" />);

    expect(actionLabels()).toContain("List the paper");
    expect(actionLabels()).toContain("Dismiss the flag");
  });

  it("offers List when the state is not known", () => {
    render(<DecisionForm versionCid={VERSION} clauses={CLAUSES} tier={4} />);

    expect(actionLabels()).toContain("List the paper");
  });
});

describe("the moderation item page", () => {
  it("reads the paper's state and leaves List out for a listed paper", async () => {
    const loadVersionState = vi.fn(async () => "listed");

    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        tier={4}
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
        loadVersionState={loadVersionState}
      />,
    );

    await screen.findByRole("heading", { name: "Record your decision" });
    expect(loadVersionState).toHaveBeenCalledWith(VERSION);
    expect(actionLabels()).not.toContain("List the paper");
    expect(actionLabels()).toContain("Dismiss the flag (keep the paper listed)");
  });

  it("offers List for a paper waiting in moderation", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        tier={4}
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
        loadVersionState={async () => "moderation"}
      />,
    );

    await screen.findByRole("heading", { name: "Record your decision" });
    expect(actionLabels()).toContain("List the paper");
  });

  it("still shows the form when the state cannot be read", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        tier={4}
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
        loadVersionState={async () => {
          throw new Error("offline");
        }}
      />,
    );

    await screen.findByRole("heading", { name: "Record your decision" });
    expect(actionLabels()).toContain("List the paper");
  });

  it("shows the licence by its full name, not its id", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        tier={4}
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
        loadVersionState={async () => null}
      />,
    );

    const heading = await screen.findByRole("heading", { name: PAPER.title });
    const pane = heading.closest("article") as HTMLElement;

    expect(within(pane).getByText("Creative Commons Attribution 4.0")).toBeTruthy();
    expect(within(pane).queryByText("CC-BY-4.0")).toBeNull();
  });

  it("prints a licence id it does not know as itself rather than guessing", async () => {
    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        tier={4}
        loadPaper={async () => ({ ...PAPER, licence: "LicenseRef-Custom-1" })}
        loadClauses={async () => [...CLAUSES]}
        loadVersionState={async () => null}
      />,
    );

    const heading = await screen.findByRole("heading", { name: PAPER.title });
    expect(within(heading.closest("article") as HTMLElement).getByText("LicenseRef-Custom-1")).toBeTruthy();
  });
});
