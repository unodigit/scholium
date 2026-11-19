// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PaperHeader } from "./paper-header";
import { loadPaperPageData } from "./paper-page-data";
import { BARE_ID, HAPPY, PAPER_BODY, json, stubApi } from "./paper-page-fixtures";

/**
 * The banner above the title for a notice a paper carries.
 *
 * A withdrawal is the authors taking the paper back: the paper stays listed
 * and its files stay downloadable (`submissions/notices.py` changes no
 * status), so it must never borrow the legal-removal banner's words. That
 * banner belongs to content moderators tombstoned.
 */

const WITHDRAWAL_CID = "bafyrei-withdrawal-notice";
const TOMBSTONE_CID = "bafyrei-tombstone-notice";

afterEach(cleanup);

/** Render the header for a paper whose notices are `notices`. */
async function renderHeader(notices: readonly unknown[]): Promise<ReturnType<typeof render>> {
  stubApi({
    ...HAPPY,
    paper: () => json({ ...PAPER_BODY, notices }),
  });
  const data = await loadPaperPageData({ id: BARE_ID, version: null });
  const view = render(<PaperHeader data={data} />);
  // The preservation fact is a client island: let its read settle.
  await act(async () => {});
  return view;
}

/** The banner that announces `label`, as the page rendered it. */
function bannerFor(label: string): HTMLElement {
  const banner = screen.getByText(label).closest(".sch-decision");
  if (!(banner instanceof HTMLElement)) throw new Error(`no banner for ${label}`);
  return banner;
}

describe("a withdrawal notice", () => {
  it("is announced as a withdrawal, never as a legal removal", async () => {
    await renderHeader([
      {
        id: WITHDRAWAL_CID,
        kind: "withdrawal",
        reason: "The dataset was mislabelled, so the conclusions no longer stand.",
      },
    ]);

    const banner = bannerFor("Withdrawn by the authors");

    expect(banner.dataset.kind).toBe("withdrawn");
    // A fact about the authors' decision, not a fault state (design.md §5.2).
    expect(banner.dataset.tone).toBe("neutral");
    expect(banner.className).not.toContain("critical");

    expect(banner.textContent).toContain("Withdrawn by the authors");
    expect(banner.textContent).toContain(
      "The authors withdrew this paper. It stays available as part of the record.",
    );
    // Principle 6: the decision shows its own reason and links to its record.
    expect(banner.textContent).toContain(
      "The dataset was mislabelled, so the conclusions no longer stand.",
    );
    expect(within(banner).getByRole("button", { name: "View record" })).toBeTruthy();

    // The lie the bug reported: no legal takedown ever happened.
    expect(screen.queryByText("Content removed for legal reasons")).toBeNull();
    expect(screen.queryByText("The record of its existence remains.")).toBeNull();
  });

  it.each(["withdrawal", "withdrawn"])(
    "maps the API's %s kind to the withdrawal banner",
    async (kind) => {
      await renderHeader([{ id: WITHDRAWAL_CID, kind, reason: "Taken back." }]);

      expect(screen.getByText("Withdrawn by the authors")).toBeTruthy();
      expect(screen.queryByText("Content removed for legal reasons")).toBeNull();
    },
  );

  it("keeps the plain sentence when the notice carries no reason", async () => {
    await renderHeader([{ id: WITHDRAWAL_CID, kind: "withdrawal", reason: "" }]);

    const banner = bannerFor("Withdrawn by the authors");
    expect(banner.textContent).toContain(
      "The authors withdrew this paper. It stays available as part of the record.",
    );
  });
});

describe("a withdrawal and a tombstone on one paper", () => {
  it("renders each with its own kind, side by side", async () => {
    const view = await renderHeader([
      { id: WITHDRAWAL_CID, kind: "withdrawal", reason: "The authors stepped back." },
      {
        id: TOMBSTONE_CID,
        kind: "tombstone",
        reason: "Unlawful in the node's operating jurisdiction",
      },
    ]);

    const withdrawn = view.container.querySelector<HTMLElement>('[data-kind="withdrawn"]');
    const legal = view.container.querySelector<HTMLElement>('[data-kind="removed_legal"]');

    expect(withdrawn).not.toBeNull();
    expect(legal).not.toBeNull();

    // The withdrawal keeps the paper's own facts; no tombstone promise.
    expect(withdrawn?.textContent).toContain("Withdrawn by the authors");
    expect(withdrawn?.textContent).not.toContain("Content removed for legal reasons");
    expect(withdrawn?.textContent).not.toContain("The record of its existence remains.");

    // The tombstone is still the legal-removal banner.
    expect(legal?.textContent).toContain("Content removed for legal reasons");
    expect(legal?.textContent).toContain("The record of its existence remains.");
    expect(legal?.dataset.tone).toBe("neutral");

    // Both decisions show their record, one link each.
    expect(screen.getAllByRole("button", { name: "View record" })).toHaveLength(2);
  });
});

describe("a paper whose status itself records a removal", () => {
  it("still shows the legal-removal banner", async () => {
    stubApi({
      ...HAPPY,
      paper: () => json({ ...PAPER_BODY, status: "tombstoned", notices: [] }),
    });
    const data = await loadPaperPageData({ id: BARE_ID, version: null });
    render(<PaperHeader data={data} />);
    await act(async () => {});

    const banner = bannerFor("Content removed for legal reasons");
    expect(banner.dataset.kind).toBe("removed_legal");
  });
});
