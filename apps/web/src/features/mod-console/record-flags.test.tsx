// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import type { FlagEntry } from "./flags";
import { RecordFlags } from "./record-flags";

const TARGET = "bafyreidiscussionpostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const FLAG: FlagEntry = {
  id: "flag-post-1",
  targetCid: TARGET,
  reporterDid: "did:key:z6MkReporter000000000000000000000000000000000",
  reason: "spam",
  status: "pending",
  decisionCid: null,
};

const SUMMARY = {
  cid: TARGET,
  type: "discussion.post",
  typeLabel: "Discussion post",
  paperTitle: "Sparse attention without the quadratic cost",
  paperHref: "/p/sch%3A5jmi-pmva-4lmr",
  excerpt: "This figure is copied from another paper.",
};

async function loadTarget() {
  return SUMMARY;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RecordFlags", () => {
  it("loads the flags against the record and says what each is about", async () => {
    const loadFlags = vi.fn(async () => [FLAG]);
    render(
      <RecordFlags targetCid={TARGET} loadFlags={loadFlags} loadTarget={loadTarget} />,
    );

    const region = within(
      await screen.findByRole("region", { name: "Flags against this record" }),
    );
    expect(await region.findByRole("heading", { name: "Spam" })).toBeTruthy();
    expect(await region.findByText("Discussion post")).toBeTruthy();
    expect(loadFlags).toHaveBeenCalledWith(TARGET);
  });

  it("says plainly when no flag names the record", async () => {
    render(
      <RecordFlags targetCid={TARGET} loadFlags={async () => []} loadTarget={loadTarget} />,
    );

    expect(
      await screen.findByText("No flags are recorded against this record."),
    ).toBeTruthy();
  });

  it("reads a forbidden answer as a note, not a fault", async () => {
    render(
      <RecordFlags
        targetCid={TARGET}
        loadFlags={async () => {
          throw new ApiError(403, { status: 403, caller_tier: 3 });
        }}
        loadTarget={loadTarget}
      />,
    );

    expect(await screen.findByText(/Flags are for moderators/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).toBeNull();
  });

  it("explains a failed load and retries it", async () => {
    const loadFlags = vi
      .fn<() => Promise<readonly FlagEntry[]>>()
      .mockRejectedValueOnce(new ApiError(500, { status: 500, detail: "The flag table is locked." }))
      .mockResolvedValueOnce([FLAG]);

    render(
      <RecordFlags targetCid={TARGET} loadFlags={loadFlags} loadTarget={loadTarget} />,
    );

    expect(await screen.findByText("The flag table is locked.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Spam" })).toBeTruthy();
    expect(loadFlags).toHaveBeenCalledTimes(2);
  });

  it("reloads when a decision was published", async () => {
    const loadFlags = vi.fn(async () => [FLAG]);
    const view = render(
      <RecordFlags targetCid={TARGET} loadFlags={loadFlags} loadTarget={loadTarget} />,
    );

    await screen.findByRole("heading", { name: "Spam" });
    expect(loadFlags).toHaveBeenCalledTimes(1);

    view.rerender(
      <RecordFlags
        targetCid={TARGET}
        loadFlags={loadFlags}
        loadTarget={loadTarget}
        refreshKey={1}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Spam" })).toBeTruthy();
    expect(loadFlags).toHaveBeenCalledTimes(2);
  });
});
