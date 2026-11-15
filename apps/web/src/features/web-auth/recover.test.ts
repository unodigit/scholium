// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { MemoryTokenStorage, apiErrorFrom } from "../../lib/api";

import { utf8Encode } from "./encoding";
import {
  RECOVERY_APPROVAL_THRESHOLD,
  RECOVERY_CANCEL_REASON,
  RECOVERY_REQUEST_NOT_FOUND_TYPE,
  RECOVERY_STORAGE_KEY,
  RecoveryError,
  approvalProgressText,
  approvalsRemaining,
  cancelRecoveryRequest,
  clearPersistedRecovery,
  fetchRecoveryStatus,
  formatRecoveryDeadline,
  formatSafetyWindowRemaining,
  isCancellable,
  isOrcid,
  isRecoveryError,
  isRecoveryStatusUnavailable,
  loadPersistedRecovery,
  mergeRecoveryStatus,
  normalizeOrcid,
  openRecoveryRequest,
  parseOpenedRecovery,
  parseRecoveryInstant,
  parseRecoveryStatus,
  parseRecoveryStatusUpdate,
  placeholderRecovery,
  recoveryRequestPath,
  savePersistedRecovery,
  safetyWindowRemainingMs,
  type RecoveryClient,
  type RecoverySnapshot,
} from "./recover";

/** Canonical Ed25519 did:key (the same fixture the onboarding tests use). */
const NEW_KEY = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";

/** A valid ORCID iD. */
const ORCID = "0000-0002-1825-0097";

/** A fixed clock: 15 November 2026, 00:00 UTC. */
const NOW = Date.parse("2026-11-15T00:00:00Z");

/** A fake API client with mock methods the tests can assert on. */
function fakeClient(
  get: (path: string) => unknown = () => ({}),
  post: (path: string, body?: unknown) => unknown = () => ({}),
) {
  return {
    get: vi.fn(async (path: string) => get(path)),
    post: vi.fn(async (path: string, body?: unknown) => post(path, body)),
  } as unknown as RecoveryClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    ...placeholderRecovery("rec_1", ORCID, () => NOW),
    ...overrides,
  };
}

describe("ORCID iD", () => {
  it("accepts a bare iD", () => {
    expect(normalizeOrcid(ORCID)).toBe(ORCID);
    expect(isOrcid(ORCID)).toBe(true);
  });

  it("accepts a pasted profile URL, surrounding space and a lowercase check digit", () => {
    expect(normalizeOrcid("  https://orcid.org/0000-0002-1825-009x ")).toBe(
      "0000-0002-1825-009X",
    );
    expect(normalizeOrcid("http://sandbox.orcid.org/0000-0002-1825-0097")).toBe(ORCID);
  });

  it("refuses anything that is not an iD", () => {
    expect(normalizeOrcid("0000-0002-1825-009")).toBeNull();
    expect(normalizeOrcid("mei@example.edu")).toBeNull();
    expect(normalizeOrcid("")).toBeNull();
    expect(isOrcid("0000-0002-1825-0097 extra")).toBe(false);
  });
});

describe("opening a recovery request", () => {
  it("posts the iD and the new key without an access token", async () => {
    const client = fakeClient(undefined, () => ({
      request_id: "rec_42",
      status: "pending",
      guardians_notified: 5,
    }));

    const opened = await openRecoveryRequest({
      orcid: ORCID,
      newPublicKey: NEW_KEY,
      client,
      now: () => NOW,
    });

    expect(client.post).toHaveBeenCalledWith(
      "/recovery/requests",
      { orcid: ORCID, new_public_key: NEW_KEY },
      { auth: false },
    );
    expect(opened).toEqual({
      requestId: "rec_42",
      status: "pending",
      approvals: 0,
      threshold: RECOVERY_APPROVAL_THRESHOLD,
      guardiansNotified: 5,
      contestUntil: null,
      orcid: ORCID,
      newPublicKey: NEW_KEY,
      openedAt: "2026-11-15T00:00:00.000Z",
    });
  });

  it("refuses a bad iD before anything leaves the device", async () => {
    const client = fakeClient();
    await expect(
      openRecoveryRequest({ orcid: "not-an-orcid", newPublicKey: NEW_KEY, client }),
    ).rejects.toMatchObject({ code: "invalid-orcid" });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("refuses a key that is not a canonical Ed25519 did:key", async () => {
    const client = fakeClient();
    await expect(
      openRecoveryRequest({ orcid: ORCID, newPublicKey: "did:web:example", client }),
    ).rejects.toMatchObject({ code: "invalid-public-key" });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("requires the reply to name the request", () => {
    expect(() => parseOpenedRecovery({ status: "pending" })).toThrow(RecoveryError);
    expect(() => parseOpenedRecovery("nope")).toThrow(RecoveryError);
  });

  it("reads the API's aliases for count, threshold and key", () => {
    const opened = parseOpenedRecovery({
      requestId: "rec_7",
      state: "contest",
      approvals: [{ guardian: "did:key:z6MkA" }, { guardian: "did:key:z6MkB" }],
      required_approvals: 3,
      guardian_count: 5,
      safetyWindowEndsAt: "2026-11-18T09:00:00",
      newKey: NEW_KEY,
    });

    expect(opened).toEqual({
      requestId: "rec_7",
      status: "contest",
      approvals: 2,
      threshold: 3,
      guardiansNotified: 5,
      contestUntil: "2026-11-18T09:00:00.000Z",
    });
  });

  it("reads a numeric approval count as well as a list", () => {
    const opened = parseOpenedRecovery({ request_id: "rec_8", approvals_count: "2" });
    expect(opened.approvals).toBe(2);
    expect(opened.threshold).toBe(3);
  });
});

describe("reading progress", () => {
  it("asks the request's own path without an access token", async () => {
    const client = fakeClient(() => ({ status: "pending", approvals: 2 }));
    const update = await fetchRecoveryStatus("rec_1/2", client);

    expect(client.get).toHaveBeenCalledWith("/recovery/requests/rec_1%2F2", {
      auth: false,
    });
    expect(update).toEqual({ status: "pending", approvals: 2 });
  });

  it("keeps optional members absent so the page can keep what it knows", () => {
    expect(parseRecoveryStatusUpdate({})).toEqual({});
    expect(parseRecoveryStatusUpdate({ status: "cancelled" })).toEqual({
      status: "cancelled",
    });
  });

  it("reads a finished contest window as contest from counts alone", () => {
    const current = snapshot();
    const merged = mergeRecoveryStatus(current, {
      approvals: 3,
      contestUntil: "2026-11-18T09:00:00.000Z",
    });
    expect(merged.status).toBe("contest");
    expect(merged.approvals).toBe(3);
  });

  it("does not invent a status when a partial reply says nothing", () => {
    const current = snapshot({ status: "pending" });
    const merged = mergeRecoveryStatus(current, { approvals: 2 });
    expect(merged.status).toBe("pending");
    expect(merged.threshold).toBe(current.threshold);
    expect(merged.contestUntil).toBeNull();
  });

  it("treats a missing status route as 'no news', not an error", () => {
    expect(isRecoveryStatusUnavailable(apiErrorFrom(405, {}))).toBe(true);
    expect(isRecoveryStatusUnavailable(apiErrorFrom(501, {}))).toBe(true);
    expect(isRecoveryStatusUnavailable(apiErrorFrom(404, {}))).toBe(true);
    expect(
      isRecoveryStatusUnavailable(
        apiErrorFrom(404, { type: RECOVERY_REQUEST_NOT_FOUND_TYPE }),
      ),
    ).toBe(false);
    expect(isRecoveryStatusUnavailable(apiErrorFrom(500, {}))).toBe(false);
    expect(isRecoveryStatusUnavailable(new Error("offline"))).toBe(false);
  });
});

describe("progress and the 72-hour safety window", () => {
  it("writes progress as the design does", () => {
    expect(approvalProgressText(2, 3)).toBe("2 of 3 approvals");
    expect(approvalProgressText(0, 3)).toBe("0 of 3 approvals");
  });

  it("never runs the meter past its end", () => {
    expect(approvalProgressText(5, 3)).toBe("3 of 3 approvals");
    expect(approvalProgressText(-1, 3)).toBe("0 of 3 approvals");
  });

  it("counts the approvals still needed", () => {
    expect(approvalsRemaining(snapshot({ approvals: 2, threshold: 3 }))).toBe(1);
    expect(approvalsRemaining(snapshot({ approvals: 3, threshold: 3 }))).toBe(0);
  });

  it("formats the deadline in UTC", () => {
    expect(formatRecoveryDeadline("2026-11-18T09:00:00Z")).toBe(
      "18 Nov 2026, 09:00 UTC",
    );
    expect(formatRecoveryDeadline("not a date")).toBeNull();
    expect(formatRecoveryDeadline(null)).toBeNull();
  });

  it("reads a zone-less API timestamp as UTC", () => {
    expect(parseRecoveryInstant("2026-11-18T09:00:00")).toBe(
      "2026-11-18T09:00:00.000Z",
    );
  });

  it("computes the time left and floors it at zero", () => {
    const end = "2026-11-18T09:00:00Z";
    expect(safetyWindowRemainingMs(end, Date.parse(end) - 60_000)).toBe(60_000);
    expect(safetyWindowRemainingMs(end, Date.parse(end) + 1)).toBe(0);
    expect(safetyWindowRemainingMs(null, NOW)).toBeNull();
    expect(safetyWindowRemainingMs("nope", NOW)).toBeNull();
  });

  it("describes the time left in words", () => {
    expect(formatSafetyWindowRemaining(68 * 3_600_000)).toBe("about 2 days 20 hours");
    expect(formatSafetyWindowRemaining(48 * 3_600_000)).toBe("about 2 days");
    expect(formatSafetyWindowRemaining(2 * 3_600_000)).toBe("about 2 hours");
    expect(formatSafetyWindowRemaining(60_000)).toBe("about a minute");
    expect(formatSafetyWindowRemaining(0)).toBe("the safety window has closed");
  });

  it("allows a cancel until the window closes", () => {
    expect(isCancellable(snapshot({ status: "pending" }))).toBe(true);
    expect(isCancellable(snapshot({ status: "contest" }))).toBe(true);
    expect(isCancellable(snapshot({ status: "finalized" }))).toBe(false);
    expect(isCancellable(snapshot({ status: "cancelled" }))).toBe(false);
  });
});

describe("cancelling a recovery", () => {
  it("signs the request id with the device key and posts the signature", async () => {
    const client = fakeClient();
    const signer = { signWithPasskey: vi.fn(async () => new Uint8Array([1, 2, 3])) };

    await cancelRecoveryRequest({
      requestId: "rec_1",
      signer,
      client,
    });

    expect(signer.signWithPasskey).toHaveBeenCalledTimes(1);
    const [data, options] = (
      signer.signWithPasskey as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(Array.from(data as Uint8Array)).toEqual(Array.from(utf8Encode("rec_1")));
    expect(options).toMatchObject({ reason: RECOVERY_CANCEL_REASON });
    expect(client.post).toHaveBeenCalledWith(
      "/recovery/requests/rec_1/cancel",
      { signature: "AQID" },
      { auth: false },
    );
  });

  it("lets a dismissed passkey prompt through as the signer's error", async () => {
    const client = fakeClient();
    const signer = {
      signWithPasskey: vi.fn(async () => {
        throw new Error("cancel closed");
      }),
    };
    await expect(
      cancelRecoveryRequest({ requestId: "rec_1", signer, client }),
    ).rejects.toThrow("cancel closed");
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("remembering the request", () => {
  it("round-trips a snapshot", () => {
    const storage = new MemoryTokenStorage();
    const stored = snapshot({
      status: "contest",
      approvals: 3,
      contestUntil: "2026-11-18T09:00:00.000Z",
      guardiansNotified: 5,
    });

    savePersistedRecovery(storage, stored);
    expect(loadPersistedRecovery(storage)).toEqual(stored);
  });

  it("reads junk as no request", () => {
    const storage = new MemoryTokenStorage();
    storage.setItem(RECOVERY_STORAGE_KEY, "{not json");
    expect(loadPersistedRecovery(storage)).toBeNull();

    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ orcid: ORCID }));
    expect(loadPersistedRecovery(storage)).toBeNull();

    storage.setItem(
      RECOVERY_STORAGE_KEY,
      JSON.stringify({ requestId: "rec_1", status: "nonsense", approvals: "2" }),
    );
    expect(loadPersistedRecovery(storage)).toMatchObject({
      requestId: "rec_1",
      status: "pending",
      approvals: 2,
      threshold: RECOVERY_APPROVAL_THRESHOLD,
    });
  });

  it("clears the remembered request", () => {
    const storage = new MemoryTokenStorage();
    savePersistedRecovery(storage, snapshot());
    clearPersistedRecovery(storage);
    expect(loadPersistedRecovery(storage)).toBeNull();
  });

  it("tolerates storage that throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadPersistedRecovery(storage)).toBeNull();
    expect(() => savePersistedRecovery(storage, snapshot())).not.toThrow();
    expect(() => clearPersistedRecovery(storage)).not.toThrow();
  });
});

describe("status names and paths", () => {
  it("accepts the spellings a node may use", () => {
    expect(parseRecoveryStatus("pending")).toBe("pending");
    expect(parseRecoveryStatus("SAFETY_WINDOW")).toBe("contest");
    expect(parseRecoveryStatus("completed")).toBe("finalized");
    expect(parseRecoveryStatus("canceled")).toBe("cancelled");
    expect(parseRecoveryStatus("weird")).toBeNull();
    expect(parseRecoveryStatus(3)).toBeNull();
  });

  it("builds the request path with the id encoded", () => {
    expect(recoveryRequestPath("rec 1")).toBe("/recovery/requests/rec%201");
  });

  it("identifies its own errors", () => {
    expect(isRecoveryError(new RecoveryError("invalid-response", "x"))).toBe(true);
    expect(isRecoveryError(new Error("x"))).toBe(false);
  });
});
