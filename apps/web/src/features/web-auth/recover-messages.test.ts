// @vitest-environment node
import { describe, expect, it } from "vitest";

import { NetworkError, apiErrorFrom } from "../../lib/api";

import { DeviceKeyError, PasskeyCancelledError } from "./errors";
import * as recoveryMessages from "./recover-messages";
import {
  RECOVERY_ACCOUNT_NOT_FOUND_TYPE,
  RECOVERY_GUARDIANS_NOT_SET_TYPE,
  RecoveryError,
  placeholderRecovery,
  type RecoverySnapshot,
} from "./recover";
import {
  RECOVER_ACCOUNT_NOT_FOUND_MESSAGE,
  RECOVER_CANCEL_NOTE,
  RECOVER_FALLBACK_MESSAGE,
  RECOVER_GUARDIANS_NOT_SET_MESSAGE,
  RECOVER_HOW_IT_WORKS,
  RECOVER_ORCID_INVALID_MESSAGE,
  RECOVER_SAFETY_WINDOW_HEADING,
  RECOVER_SAFETY_WINDOW_PENDING_NOTE,
  RECOVER_STATUS_UNAVAILABLE_NOTE,
  RECOVER_WRONG_DEVICE_MESSAGE,
  describeRecoveryError,
  formatRecoveryDeadlineLocal,
  recoveryAccountLabel,
  recoveryProgressLine,
  recoveryProgressNote,
  recoveryStatusLabel,
  safetyWindowNote,
} from "./recover-messages";

const ORCID = "0000-0002-1825-0097";
const NOW = Date.parse("2026-11-15T00:00:00Z");

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return { ...placeholderRecovery("rec_1", ORCID, () => NOW), ...overrides };
}

describe("the page's copy", () => {
  it("uses the design's exact phrases for progress and the safety window", () => {
    expect(RECOVER_HOW_IT_WORKS).toContain("2 of 3 approvals");
    expect(RECOVER_HOW_IT_WORKS).toContain("72-hour safety window");
    expect(RECOVER_SAFETY_WINDOW_HEADING).toBe("72-hour safety window");
    expect(RECOVER_STATUS_UNAVAILABLE_NOTE).toMatch(/guardians/);
  });

  it("says the account itself is told about a recovery, not only its guardians", () => {
    expect(RECOVER_HOW_IT_WORKS).toContain("You and your guardians are notified");
    expect(RECOVER_SAFETY_WINDOW_PENDING_NOTE).toContain("you and your guardians");
  });

  it("points an account without guardians at the page that sets them", () => {
    expect(RECOVER_GUARDIANS_NOT_SET_MESSAGE).toContain("/me/security");
    expect(RECOVER_GUARDIANS_NOT_SET_MESSAGE).not.toContain("Settings");
  });

  it("names each status in plain language", () => {
    expect(recoveryStatusLabel("pending")).toBe("Waiting for guardians");
    expect(recoveryStatusLabel("contest")).toBe("Safety window open");
    expect(recoveryStatusLabel("finalized")).toBe("Recovery complete");
    expect(recoveryStatusLabel("cancelled")).toBe("Cancelled");
  });
});

describe("the account being recovered", () => {
  it("names it by profile name, with the ORCID iD secondary", () => {
    // The person knows their own name; the iD is how the API identified the
    // account, so it follows the name rather than standing in for it.
    expect(recoveryAccountLabel("Mei Okafor", ORCID)).toBe(
      `Mei Okafor (${ORCID})`,
    );
  });

  it("falls back to the ORCID iD when no profile name can be read", () => {
    expect(recoveryAccountLabel(null, ORCID)).toBe(ORCID);
    expect(recoveryAccountLabel("", ORCID)).toBe(ORCID);
    expect(recoveryAccountLabel("   ", ORCID)).toBe(ORCID);
  });

  it("uses whichever identifier exists", () => {
    expect(recoveryAccountLabel("Mei Okafor", "")).toBe("Mei Okafor");
    expect(recoveryAccountLabel(null, "")).toBe("the account you identified");
  });
});

describe("progress copy", () => {
  it("writes 2 of 3 approvals", () => {
    expect(recoveryProgressLine(snapshot({ approvals: 2, threshold: 3 }))).toBe(
      "2 of 3 approvals",
    );
  });

  it("counts down the approvals still needed", () => {
    expect(recoveryProgressNote(snapshot({ approvals: 0, threshold: 3 }))).toContain(
      "3 more guardian approvals",
    );
    expect(recoveryProgressNote(snapshot({ approvals: 2, threshold: 3 }))).toContain(
      "1 more guardian approval",
    );
    expect(recoveryProgressNote(snapshot({ status: "contest", approvals: 3 }))).toContain(
      "safety window is open",
    );
    expect(recoveryProgressNote(snapshot({ status: "cancelled" }))).toContain(
      "current key stays active",
    );
    expect(recoveryProgressNote(snapshot({ status: "finalized" }))).toContain(
      "recovery is complete",
    );
  });
});

describe("safety-window copy", () => {
  it("explains what opens the window while approvals are pending", () => {
    const note = safetyWindowNote(snapshot({ status: "pending" }), NOW);
    expect(note).toContain("72-hour safety window");
    expect(note).toContain("cancel link");
  });

  it("tells the requester what happens at the threshold, in local time", () => {
    const note = safetyWindowNote(
      snapshot({
        status: "contest",
        approvals: 3,
        threshold: 3,
        contestUntil: "2026-11-18T00:00:00Z",
      }),
      NOW,
      { timeZone: "UTC" },
    );
    expect(note).toContain("Approved by 3 of 5 guardians.");
    expect(note).toContain("Your new passkey takes over on 18 Nov 2026, 00:00 UTC");
    expect(note).toContain("until then your old key still works");
    expect(note).toContain("only you can cancel");
  });

  it("says only the account holder can cancel during the window", () => {
    const note = safetyWindowNote(
      snapshot({
        status: "contest",
        approvals: 3,
        threshold: 3,
        contestUntil: "2026-11-18T00:00:00Z",
      }),
      NOW,
      { timeZone: "UTC" },
    );
    expect(note).toContain("only you can cancel");
    expect(note).not.toContain("any guardian");
  });

  it("still explains the window when no deadline came back", () => {
    const note = safetyWindowNote(snapshot({ status: "contest", contestUntil: null }), NOW);
    expect(note).toContain("72-hour safety window");
  });

  it("says a cancelled request has no running window", () => {
    expect(safetyWindowNote(snapshot({ status: "cancelled" }), NOW)).toContain(
      "no safety window is running",
    );
  });

  it("says a completed recovery has passed its window", () => {
    expect(safetyWindowNote(snapshot({ status: "finalized" }), NOW)).toContain(
      "safety window has closed",
    );
  });
});

describe("who can cancel", () => {
  /** Every string of recovery copy the page can show. */
  function everyRecoveryMessage(): string[] {
    const constants = Object.entries(recoveryMessages)
      .filter(
        ([name, value]) =>
          name.startsWith("RECOVER_") && typeof value === "string",
      )
      .map(([, value]) => value as string);
    const notes = (["pending", "contest", "finalized", "cancelled"] as const).flatMap(
      (status) => [
        recoveryProgressNote(snapshot({ status })),
        safetyWindowNote(
          snapshot({ status, contestUntil: "2026-11-18T00:00:00Z" }),
          NOW,
          { timeZone: "UTC" },
        ),
      ],
    );
    return [...constants, ...notes];
  }

  it("never sends a guardian a cancel link or the right to cancel", () => {
    // Only the account holder can cancel a recovery; a guardian's cancel is
    // refused with 403 (round 16 D1). No copy may say otherwise.
    for (const text of everyRecoveryMessage()) {
      expect(text).not.toMatch(/guardians?[^.]*\bcan cancel\b/i);
      expect(text).not.toMatch(/cancel link (goes|is sent|reaches)[^.]*guardians?/i);
    }
  });

  it("says the account holder cancels and the guardians hear the outcome", () => {
    expect(RECOVER_SAFETY_WINDOW_PENDING_NOTE).toContain(
      "Only the account holder can use the cancel link",
    );
    expect(RECOVER_SAFETY_WINDOW_PENDING_NOTE).toContain("how it ends");
    expect(RECOVER_CANCEL_NOTE).toContain("Only the account holder can cancel");
    expect(RECOVER_CANCEL_NOTE).toContain("how it ends");
  });
});

describe("formatRecoveryDeadlineLocal", () => {
  it("writes a deadline in the reader's own zone, not UTC", () => {
    expect(
      formatRecoveryDeadlineLocal("2026-11-18T00:00:00Z", { timeZone: "UTC" }),
    ).toBe("18 Nov 2026, 00:00 UTC");
    expect(
      formatRecoveryDeadlineLocal("2026-11-18T00:00:00Z", { timeZone: "Asia/Tokyo" }),
    ).toBe("18 Nov 2026, 09:00 GMT+9");
  });

  it("returns null for an unreadable deadline", () => {
    expect(formatRecoveryDeadlineLocal(null)).toBeNull();
    expect(formatRecoveryDeadlineLocal("not-a-date")).toBeNull();
  });
});

describe("describeRecoveryError", () => {
  it("explains a dismissed passkey prompt and how to retry", () => {
    expect(describeRecoveryError(new PasskeyCancelledError())).toMatch(/prompt was closed/);
    expect(describeRecoveryError(new DeviceKeyError("passkey-failed", "no"))).toMatch(
      /couldn't confirm/,
    );
  });

  it("explains an unsupported browser and blocked storage", () => {
    expect(describeRecoveryError(new DeviceKeyError("unsupported", "no"))).toMatch(
      /can't create the passkey/,
    );
    expect(describeRecoveryError(new DeviceKeyError("storage-unavailable", "no"))).toMatch(
      /blocking local storage/,
    );
  });

  it("explains that this device cannot cancel for the old key", () => {
    expect(describeRecoveryError(new DeviceKeyError("not-found", "no"))).toBe(
      RECOVER_WRONG_DEVICE_MESSAGE,
    );
    expect(describeRecoveryError(apiErrorFrom(401, { detail: "no" }))).toBe(
      RECOVER_WRONG_DEVICE_MESSAGE,
    );
  });

  it("tells a refused guardian that only the account holder can cancel", () => {
    expect(
      describeRecoveryError(
        apiErrorFrom(403, { detail: "Not authorized to cancel this recovery request." }),
      ),
    ).toBe("Only the account holder can cancel this recovery.");
  });

  it("explains an ORCID iD that names no account", () => {
    expect(
      describeRecoveryError(apiErrorFrom(404, { type: RECOVERY_ACCOUNT_NOT_FOUND_TYPE })),
    ).toBe(RECOVER_ACCOUNT_NOT_FOUND_MESSAGE);
    expect(describeRecoveryError(apiErrorFrom(404, {}))).toBe(
      RECOVER_ACCOUNT_NOT_FOUND_MESSAGE,
    );
  });

  it("explains an account with no guardians", () => {
    expect(
      describeRecoveryError(apiErrorFrom(409, { type: RECOVERY_GUARDIANS_NOT_SET_TYPE })),
    ).toBe(RECOVER_GUARDIANS_NOT_SET_MESSAGE);
    expect(describeRecoveryError(apiErrorFrom(409, {}))).toBe(
      RECOVER_GUARDIANS_NOT_SET_MESSAGE,
    );
  });

  it("keeps the API's own 422 explanation", () => {
    expect(
      describeRecoveryError(
        apiErrorFrom(422, {
          title: "Unprocessable Content",
          detail: "That ORCID iD is malformed.",
        }),
      ),
    ).toBe("That ORCID iD is malformed.");
  });

  it("explains rate limits, outages and offline browsers", () => {
    expect(describeRecoveryError(apiErrorFrom(429, {}))).toMatch(/Too many attempts/);
    expect(describeRecoveryError(apiErrorFrom(503, {}))).toMatch(/having trouble/);
    expect(describeRecoveryError(new NetworkError("http://api.invalid"))).toMatch(
      /Can't reach Scholium/,
    );
  });

  it("explains a bad iD, a bad key and a malformed reply", () => {
    expect(describeRecoveryError(new RecoveryError("invalid-orcid", "x"))).toBe(
      RECOVER_ORCID_INVALID_MESSAGE,
    );
    expect(describeRecoveryError(new RecoveryError("invalid-public-key", "x"))).toMatch(
      /couldn't be used/,
    );
    expect(describeRecoveryError(new RecoveryError("invalid-response", "x"))).toMatch(
      /unexpected reply/,
    );
  });

  it("falls back for anything unexpected", () => {
    expect(describeRecoveryError(new Error("boom"))).toBe(RECOVER_FALLBACK_MESSAGE);
    expect(describeRecoveryError(undefined)).toBe(RECOVER_FALLBACK_MESSAGE);
  });
});
