import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  actionOptionLabel,
  loadVersionState,
  offeredActions,
} from "./decision";

/**
 * "List the paper" for a paper that is already listed changes nothing and
 * still tells the authors "Your paper was listed." (the API treats a move to
 * the state a version already has as a no-op, and notifies). A flag on a listed
 * paper is answered with Dismiss (keep it listed), Hold, or the takedown.
 */
describe("offeredActions for a listed paper", () => {
  it("leaves out List, and keeps Dismiss, Hold and the takedown", () => {
    const actions = offeredActions(4, "listed");

    expect(actions).not.toContain("list");
    expect(actions).toContain("dismiss");
    expect(actions).toContain("hold");
    expect(actions).toContain("tombstone");
  });

  it("keeps the actions that still mean something for a listed paper", () => {
    expect(offeredActions(4, "listed")).toEqual([
      "hold",
      "reclassify",
      "reject",
      "delist",
      "dismiss",
      "tombstone",
    ]);
  });

  it("still withholds the takedown below tier 4", () => {
    expect(offeredActions(3, "listed")).not.toContain("tombstone");
    expect(offeredActions(3, "listed")).not.toContain("list");
  });

  it("offers List for any state that is not listed, and when the state is unknown", () => {
    for (const state of ["moderation", "held", "rejected", null, undefined]) {
      expect(offeredActions(4, state)).toContain("list");
    }
    expect(offeredActions(4)).toContain("list");
  });
});

describe("actionOptionLabel", () => {
  it("says Dismiss keeps a listed paper listed", () => {
    expect(actionOptionLabel("dismiss", "listed")).toBe(
      "Dismiss the flag (keep the paper listed)",
    );
  });

  it("leaves every other label as it was", () => {
    expect(actionOptionLabel("dismiss")).toBe("Dismiss the flag");
    expect(actionOptionLabel("dismiss", "moderation")).toBe("Dismiss the flag");
    expect(actionOptionLabel("hold", "listed")).toBe("Hold from listing");
  });
});

describe("loadVersionState", () => {
  it("reads the state of a paper version from GET /moderation/targets/{cid}", async () => {
    const get = vi.fn(async () => ({ cid: "bafy-v", kind: "version", state: "listed" }));

    await expect(loadVersionState("bafy-v", { get } as never)).resolves.toBe("listed");
    expect(get).toHaveBeenCalledWith("/moderation/targets/bafy-v", { cache: "no-store" });
  });

  it("is unknown for a record that has no state", async () => {
    const get = vi.fn(async () => ({ cid: "bafy-p", kind: "record", state: null }));

    await expect(loadVersionState("bafy-p", { get } as never)).resolves.toBeNull();
  });

  it("is unknown, not a failure, when the API cannot say", async () => {
    // The API is the gate on every action; not knowing the state must never
    // stop a moderator deciding, so every action is offered as before.
    const get = vi.fn(async () => {
      throw new ApiError(404, { status: 404 });
    });

    await expect(loadVersionState("bafy-v", { get } as never)).resolves.toBeNull();
  });
});
