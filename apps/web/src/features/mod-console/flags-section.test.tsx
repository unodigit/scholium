// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FlagEntry } from "./flags";
import { FlagCard } from "./flags-section";

/**
 * A flag card in `/mod` says what was flagged, not only its cid: the record
 * type, the owning paper's title and a short excerpt, read from the public
 * signed record the flag names (bug spec verify1 #3).
 */

const FLAG: FlagEntry = {
  id: "flag-post-1",
  targetCid: "bafyreidiscussionpostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  reporterDid: "did:key:z6MkReporter000000000000000000000000000000000",
  reason: "spam",
  status: "pending",
  decisionCid: null,
};

const SUMMARY = {
  cid: FLAG.targetCid,
  type: "discussion.post",
  typeLabel: "Discussion post",
  paperTitle: "Sparse attention without the quadratic cost",
  paperHref: `/p/${encodeURIComponent("sch:5jmi-pmva-4lmr")}`,
  excerpt: "This figure is copied from another paper.",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FlagCard", () => {
  it("shows the record type, the owning paper and a short excerpt", async () => {
    render(<FlagCard flag={FLAG} loadTarget={async () => SUMMARY} />);

    const card = await screen.findByRole("article");
    expect(await within(card).findByText("Discussion post")).toBeTruthy();
    expect(
      within(card).getByRole("link", {
        name: "Sparse attention without the quadratic cost",
      }).getAttribute("href"),
    ).toBe(SUMMARY.paperHref);
    expect(
      within(card).getByText("“This figure is copied from another paper.”"),
    ).toBeTruthy();
    // The cid stays as the exact identity of the record.
    expect(within(card).getByText(FLAG.targetCid)).toBeTruthy();
  });

  it("keeps the card readable when the record cannot be read", async () => {
    render(
      <FlagCard
        flag={FLAG}
        loadTarget={async () => {
          throw new Error("not on this node");
        }}
      />,
    );

    const card = await screen.findByRole("article");
    expect(within(card).getByRole("heading", { name: "Spam or advertising" })).toBeTruthy();
    expect(within(card).getByText(FLAG.targetCid)).toBeTruthy();
    expect(within(card).queryByText("Discussion post")).toBeNull();
  });
});
