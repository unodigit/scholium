import { describe, expect, it, vi } from "vitest";

import { ApiError, MemoryTokenStorage, NetworkError } from "../../lib/api";
import { ONBOARDING_STORAGE_KEY, type DeviceKeySummary } from "../web-auth";

import { DashboardError } from "./dashboard";
import {
  GUARDIAN_SCHEME,
  GUARDIAN_THRESHOLD,
  GUARDIAN_TOTAL,
  SECURITY_PATH,
  SECURITY_SIGNIN_HREF,
  SecurityError,
  describeGuardianSource,
  describeGuardians,
  describeSecurityError,
  didEndpoint,
  formatDay,
  formatInstant,
  guardiansComplete,
  guardiansSet,
  loadDevices,
  loadGuardians,
  loadSecurity,
  parseGuardianList,
  parseKeyState,
  parseRecoveryRequests,
  type GuardianState,
  type SecurityClient,
  type SecurityDevice,
} from "./security";

// The security screen's calendar days are the reader's, so run the suite in the
// journeys' zone (UTC+11 in November) rather than whatever zone the runner is
// in: on a UTC runner an unlabelled UTC day would look correct here.
process.env.TZ = "Australia/Sydney";

const ACCOUNT = "did:key:z6MkAccountAccountAccountAccountAccountAccount1";
const NEW_KEY = "did:key:z6MkNewKeyNewKeyNewKeyNewKeyNewKeyNewKeyNewKe2";
const GUARDIANS = [1, 2, 3, 4, 5].map((n) => `did:key:z6MkGuardian${n}${"x".repeat(30)}`);

/** A `GET /v1/did/{did}` body for an account that rotated once. */
const ROTATED_DOC = {
  did: ACCOUNT,
  active_key: NEW_KEY,
  tier: 2,
  key_history: [
    {
      record_cid: "bafy-rotation-1",
      seq: 41,
      old_key: ACCOUNT,
      new_key: NEW_KEY,
      effective_at: "2026-11-12T09:05:00Z",
      reason: "new laptop",
    },
  ],
};

const NEVER_ROTATED_DOC = { did: ACCOUNT, active_key: ACCOUNT, tier: 1, key_history: [] };

const SUMMARY: DeviceKeySummary = {
  credentialId: "cred-1",
  createdAt: Date.UTC(2026, 10, 3, 8, 30),
  algorithm: "Ed25519",
  unlocked: false,
  rpId: "scholium.test",
};

function device(did: string | null, overrides: Partial<SecurityDevice> = {}): SecurityDevice {
  return {
    load: async () => (did === null ? null : SUMMARY),
    didKey: async () => did ?? "",
    ...overrides,
  };
}

/** A client that answers by path, like the real API would. */
function client(routes: Record<string, unknown | (() => unknown)>): SecurityClient & {
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (path: string) => {
    if (!(path in routes)) {
      throw new ApiError(404, { title: "Not Found" });
    }
    const route = routes[path];
    return typeof route === "function" ? (route as () => unknown)() : route;
  });
  return { get } as unknown as SecurityClient & { get: ReturnType<typeof vi.fn> };
}

const DASHBOARD = {
  did: ACCOUNT,
  needs_attention: { count: 0, items: [] },
  my_papers: [],
  my_reviews: [],
};

function savedOnboarding(guardians: string[]): MemoryTokenStorage {
  const storage = new MemoryTokenStorage();
  storage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      guardians,
      guardiansSavedAt: guardians.length > 0 ? "2026-11-03T08:40:00Z" : null,
    }),
  );
  return storage;
}

describe("constants", () => {
  it("names the route and reads 3 of 5 from the recovery scheme", () => {
    expect(SECURITY_PATH).toBe("/me/security");
    expect(GUARDIAN_THRESHOLD).toBe(3);
    expect(GUARDIAN_TOTAL).toBe(5);
    expect(GUARDIAN_SCHEME).toBe("3 of 5");
    expect(SECURITY_SIGNIN_HREF).toBe("/signin?next=%2Fme%2Fsecurity");
  });

  it("escapes a DID for the path", () => {
    expect(didEndpoint("did:key:z6Mk")).toBe("/did/did%3Akey%3Az6Mk");
  });
});

describe("parseKeyState", () => {
  it("reads the active key, tier and rotation history", () => {
    const state = parseKeyState(ROTATED_DOC);

    expect(state.did).toBe(ACCOUNT);
    expect(state.activeKey).toBe(NEW_KEY);
    expect(state.tier).toBe(2);
    expect(state.rotations).toEqual([
      {
        recordCid: "bafy-rotation-1",
        seq: 41,
        oldKey: ACCOUNT,
        newKey: NEW_KEY,
        effectiveAt: "2026-11-12T09:05:00Z",
        reason: "new laptop",
      },
    ]);
  });

  it("treats a missing history as no rotations", () => {
    expect(parseKeyState({ did: ACCOUNT, active_key: ACCOUNT }).rotations).toEqual([]);
  });

  it("accepts camelCase field names", () => {
    const state = parseKeyState({
      did: ACCOUNT,
      activeKey: NEW_KEY,
      keyHistory: [{ recordCid: "bafy-1", newKey: NEW_KEY, effectiveAt: "2026-11-12T09:05:00Z" }],
    });

    expect(state.activeKey).toBe(NEW_KEY);
    expect(state.rotations[0]).toMatchObject({ recordCid: "bafy-1", newKey: NEW_KEY });
  });

  it("orders rotations by position in the log when every entry has one", () => {
    const state = parseKeyState({
      did: ACCOUNT,
      active_key: NEW_KEY,
      key_history: [
        { record_cid: "later", seq: 9 },
        { record_cid: "earlier", seq: 3 },
      ],
    });

    expect(state.rotations.map((rotation) => rotation.recordCid)).toEqual(["earlier", "later"]);
  });

  it("keeps the API's order when an entry has no position", () => {
    const state = parseKeyState({
      did: ACCOUNT,
      active_key: NEW_KEY,
      key_history: [{ record_cid: "first" }, { record_cid: "second", seq: 1 }],
    });

    expect(state.rotations.map((rotation) => rotation.recordCid)).toEqual(["first", "second"]);
  });

  it("rejects a document that is not an object", () => {
    expect(() => parseKeyState(null)).toThrow(SecurityError);
    expect(() => parseKeyState([])).toThrow(/key document/);
  });

  it("rejects a document without the account or the active key rather than guessing", () => {
    expect(() => parseKeyState({ active_key: ACCOUNT })).toThrow(/did not name the account/);
    expect(() => parseKeyState({ did: ACCOUNT })).toThrow(/did not name the active key/);
  });

  it("rejects a rotation with no record id", () => {
    expect(() =>
      parseKeyState({ did: ACCOUNT, active_key: ACCOUNT, key_history: [{ seq: 1 }] }),
    ).toThrow(/Key rotation 1 has no record id/);
    expect(() =>
      parseKeyState({ did: ACCOUNT, active_key: ACCOUNT, key_history: ["nope"] }),
    ).toThrow(/Key rotation 1 is not an object/);
  });
});

describe("parseGuardianList", () => {
  it("reads the names PUT accepts, and a bare array", () => {
    expect(parseGuardianList({ guardians: GUARDIANS })).toEqual(GUARDIANS);
    expect(parseGuardianList({ guardian_dids: GUARDIANS })).toEqual(GUARDIANS);
    expect(parseGuardianList(GUARDIANS)).toEqual(GUARDIANS);
  });

  it("drops blanks and non-strings but keeps the rest", () => {
    expect(parseGuardianList({ guardians: ["did:key:a", "", 7, null, " did:key:b "] })).toEqual([
      "did:key:a",
      "did:key:b",
    ]);
  });

  it("returns null for anything that is not a list", () => {
    expect(parseGuardianList(null)).toBeNull();
    expect(parseGuardianList({ guardians: "did:key:a" })).toBeNull();
    expect(parseGuardianList({ other: [] })).toBeNull();
    expect(parseGuardianList("nope")).toBeNull();
  });
});

describe("parseRecoveryRequests", () => {
  it("reads the caller's role and the dates the owner's card shows", () => {
    const parsed = parseRecoveryRequests({
      requests: [
        {
          request_id: "rec_own",
          did: ACCOUNT,
          status: "contest",
          approval_count: 3,
          threshold: 3,
          role: "owner",
          requested_at: "2026-11-16T12:00:00Z",
          contest_until: "2026-11-19T12:00:00Z",
          new_public_key: NEW_KEY,
        },
      ],
    });

    expect(parsed[0]).toMatchObject({
      requestId: "rec_own",
      accountDid: ACCOUNT,
      status: "contest",
      approvals: 3,
      threshold: 3,
      role: "owner",
      requestedAt: "2026-11-16T12:00:00Z",
      contestUntil: "2026-11-19T12:00:00Z",
      newPublicKey: NEW_KEY,
    });
  });

  it("leaves the dates absent for a request that does not carry them", () => {
    const parsed = parseRecoveryRequests([
      { request_id: "rr-1", did: GUARDIANS[0], status: "pending" },
    ]);

    expect(parsed[0]?.requestedAt).toBeNull();
    expect(parsed[0]?.contestUntil).toBeNull();
    expect(parsed[0]?.role).toBeUndefined();
  });
});

describe("loadGuardians", () => {
  it("uses the server's list when it can say", async () => {
    const state = await loadGuardians(client({ "/me/guardians": { guardians: GUARDIANS } }));

    expect(state).toEqual({
      required: 3,
      total: 5,
      dids: GUARDIANS,
      localDids: [],
      source: "server",
    });
  });

  it("trusts a server that says there are none", async () => {
    const state = await loadGuardians(
      client({ "/me/guardians": { guardians: [] } }),
      savedOnboarding(GUARDIANS),
    );

    expect(state.source).toBe("server");
    expect(state.dids).toEqual([]);
  });

  it("falls back to this browser's saved list when the read route does not exist", async () => {
    const state = await loadGuardians(client({}), savedOnboarding(GUARDIANS));

    expect(state.source).toBe("this-browser");
    expect(state.dids).toEqual(GUARDIANS);
  });

  it("falls back when the read fails or returns something that is not a list", async () => {
    const failing = { get: vi.fn().mockRejectedValue(new NetworkError("/v1/me/guardians")) };
    const odd = { get: vi.fn().mockResolvedValue({ unexpected: true }) };

    expect((await loadGuardians(failing, savedOnboarding(GUARDIANS))).source).toBe("this-browser");
    expect((await loadGuardians(odd, savedOnboarding(GUARDIANS))).source).toBe("this-browser");
  });

  it("says unknown, not none, when neither the server nor this browser can tell", async () => {
    const state = await loadGuardians(client({}), new MemoryTokenStorage());

    expect(state).toMatchObject({ source: "unknown", dids: [] });
  });

  it("asks without caching", async () => {
    const api = client({ "/me/guardians": { guardians: GUARDIANS } });
    await loadGuardians(api);

    expect(api.get).toHaveBeenCalledWith("/me/guardians", { cache: "no-store" });
  });
});

function guardianState(count: number, source: GuardianState["source"] = "server"): GuardianState {
  return { required: 3, total: 5, dids: GUARDIANS.slice(0, count), source };
}

describe("guardian wording", () => {
  it("counts guardians and knows when the set is complete", () => {
    expect(guardiansSet(guardianState(0))).toBe(0);
    expect(guardiansSet(guardianState(5))).toBe(5);
    expect(guardiansComplete(guardianState(4))).toBe(false);
    expect(guardiansComplete(guardianState(5))).toBe(true);
    // More than five (should never happen) must not read as "7 of 5 set".
    const extra: GuardianState = { ...guardianState(5), dids: [...GUARDIANS, "did:key:six"] };
    expect(guardiansSet(extra)).toBe(5);
  });

  it("describes every state in plain words", () => {
    expect(describeGuardians(guardianState(0))).toBe(
      "You have not set any recovery guardians yet.",
    );
    expect(describeGuardians(guardianState(2))).toBe(
      "2 of 5 guardians set. Name 3 more so any 3 can recover your account.",
    );
    expect(describeGuardians(guardianState(5))).toBe("All 5 guardians set.");
    expect(describeGuardians(guardianState(0, "unknown"))).toMatch(/No guardians are recorded on this device/);
  });

  it("labels a list that only this browser vouches for", () => {
    expect(describeGuardianSource(guardianState(5, "this-browser"))).toBe(
      "Saved from this browser.",
    );
    expect(describeGuardianSource(guardianState(5, "server"))).toBeNull();
  });
});

describe("loadDevices", () => {
  it("lists this browser's key and marks it active when it is the account's key", async () => {
    const { devices, readable } = await loadDevices(device(ACCOUNT), ACCOUNT);

    expect(readable).toBe(true);
    expect(devices).toEqual([
      {
        id: "cred-1",
        did: ACCOUNT,
        createdAt: SUMMARY.createdAt,
        rpId: "scholium.test",
        holdsActiveKey: true,
      },
    ]);
  });

  it("marks a device whose key is not the account's active key", async () => {
    const { devices } = await loadDevices(device(ACCOUNT), NEW_KEY);

    expect(devices[0]?.holdsActiveKey).toBe(false);
  });

  it("shows nothing for a browser with no key, and says that is not a read failure", async () => {
    expect(await loadDevices(device(null), ACCOUNT)).toEqual({ devices: [], readable: true });
  });

  it("says so when the key store cannot be read, instead of looking empty", async () => {
    const broken = device(ACCOUNT, {
      load: async () => {
        throw new Error("storage blocked");
      },
    });

    expect(await loadDevices(broken, ACCOUNT)).toEqual({ devices: [], readable: false });
  });

  it("ignores a creation time that is not a number", async () => {
    const odd = device(ACCOUNT, { load: async () => ({ ...SUMMARY, createdAt: Number.NaN }) });

    expect((await loadDevices(odd, ACCOUNT)).devices[0]?.createdAt).toBeNull();
  });
});

describe("loadSecurity", () => {
  const didPath = didEndpoint(ACCOUNT);

  it("puts devices, guardians and the last rotation together", async () => {
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: ROTATED_DOC,
      "/me/guardians": { guardians: GUARDIANS },
    });

    const data = await loadSecurity({ client: api, device: device(NEW_KEY) });

    expect(data.did).toBe(ACCOUNT);
    expect(data.tier).toBe(2);
    expect(data.activeKey).toBe(NEW_KEY);
    expect(data.lastRotation?.recordCid).toBe("bafy-rotation-1");
    expect(data.rotations).toHaveLength(1);
    expect(data.guardians.dids).toEqual(GUARDIANS);
    expect(data.devices.map((entry) => entry.holdsActiveKey)).toEqual([true]);
    expect(data.devicesReadable).toBe(true);
  });

  it("fills in when the owner's own recovery started from their notice", async () => {
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: NEVER_ROTATED_DOC,
      "/recovery/requests": [
        {
          request_id: "rec_own",
          did: ACCOUNT,
          status: "pending",
          approval_count: 0,
          threshold: 3,
          role: "owner",
        },
      ],
      "/me/notifications": [
        {
          id: 1,
          did: ACCOUNT,
          kind: "recovery.request",
          read: false,
          payload: {
            request_id: "rec_own",
            account_did: ACCOUNT,
            requested_at: "2026-11-16T12:00:00Z",
            cancel_path: "/me/security",
            safety_window_hours: 72,
          },
        },
      ],
    });

    const data = await loadSecurity({
      client: api,
      device: device(ACCOUNT),
      storage: new MemoryTokenStorage(),
    });

    expect(data.recoveryRequests?.[0]?.requestedAt).toBe("2026-11-16T12:00:00Z");
  });

  it("still loads when the owner's notice cannot be read", async () => {
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: NEVER_ROTATED_DOC,
      "/recovery/requests": [
        { request_id: "rec_own", did: ACCOUNT, status: "pending", role: "owner" },
      ],
    });

    const data = await loadSecurity({
      client: api,
      device: device(ACCOUNT),
      storage: new MemoryTokenStorage(),
    });

    expect(data.recoveryRequests?.[0]?.requestedAt).toBeNull();
  });

  it("asks the API who the caller is rather than trusting the device key", async () => {
    // After a rotation the device holds NEW_KEY; its own DID is not the account.
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: ROTATED_DOC,
      [didEndpoint(NEW_KEY)]: NEVER_ROTATED_DOC,
    });

    await loadSecurity({ client: api, device: device(NEW_KEY), storage: new MemoryTokenStorage() });

    const paths = api.get.mock.calls.map((call) => call[0]);
    expect(paths).toContain(didPath);
    expect(paths).not.toContain(didEndpoint(NEW_KEY));
  });

  it("reports an account that never rotated with no last rotation", async () => {
    const api = client({ "/me/dashboard": DASHBOARD, [didPath]: NEVER_ROTATED_DOC });

    const data = await loadSecurity({
      client: api,
      device: device(ACCOUNT),
      storage: new MemoryTokenStorage(),
    });

    expect(data.lastRotation).toBeNull();
    expect(data.rotations).toEqual([]);
    expect(data.activeKey).toBe(ACCOUNT);
  });

  it("takes the latest of several rotations as the last", async () => {
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: {
        ...ROTATED_DOC,
        key_history: [
          { record_cid: "first", seq: 5, effective_at: "2026-01-01T00:00:00Z" },
          { record_cid: "second", seq: 8, effective_at: "2026-06-01T00:00:00Z" },
        ],
      },
    });

    const data = await loadSecurity({
      client: api,
      device: device(NEW_KEY),
      storage: new MemoryTokenStorage(),
    });

    expect(data.lastRotation?.recordCid).toBe("second");
    expect(data.rotations).toHaveLength(2);
  });

  it("resolves guardians and recovery requesters to their profile names", async () => {
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: NEVER_ROTATED_DOC,
      "/me/guardians": { guardians: [GUARDIANS[0], GUARDIANS[1]] },
      "/recovery/requests": {
        requests: [
          {
            request_id: "rr-1",
            did: GUARDIANS[0],
            status: "pending",
            approval_count: 1,
            threshold: 3,
          },
        ],
      },
      [`/profiles/${encodeURIComponent(GUARDIANS[0])}`]: {
        did: GUARDIANS[0],
        name: "Grace Hopper",
        erased: false,
      },
      [`/profiles/${encodeURIComponent(GUARDIANS[1])}`]: {
        did: GUARDIANS[1],
        name: "Katherine Johnson",
        erased: false,
      },
    });

    const data = await loadSecurity({
      client: api,
      device: device(ACCOUNT),
      storage: new MemoryTokenStorage(),
    });

    expect(data.profileNames).toEqual({
      [GUARDIANS[0]]: "Grace Hopper",
      [GUARDIANS[1]]: "Katherine Johnson",
    });
    expect(api.get).toHaveBeenCalledWith(
      `/profiles/${encodeURIComponent(GUARDIANS[0])}`,
      { auth: false, cache: "no-store" },
    );
  });

  it("keeps the DIDs when a profile cannot be read", async () => {
    const api = client({
      "/me/dashboard": DASHBOARD,
      [didPath]: NEVER_ROTATED_DOC,
      "/me/guardians": { guardians: [GUARDIANS[0]] },
    });

    const data = await loadSecurity({
      client: api,
      device: device(ACCOUNT),
      storage: new MemoryTokenStorage(),
    });

    expect(data.profileNames).toEqual({});
    expect(data.guardians.dids).toEqual([GUARDIANS[0]]);
  });

  it("still loads when guardians and the device cannot be read", async () => {
    const api = client({ "/me/dashboard": DASHBOARD, [didPath]: NEVER_ROTATED_DOC });
    const broken = device(ACCOUNT, {
      load: async () => {
        throw new Error("blocked");
      },
    });

    const data = await loadSecurity({ client: api, device: broken, storage: new MemoryTokenStorage() });

    expect(data.devices).toEqual([]);
    expect(data.devicesReadable).toBe(false);
    expect(data.guardians.source).toBe("unknown");
  });

  it("fails when the caller cannot be identified", async () => {
    const api = client({
      "/me/dashboard": () => {
        throw new ApiError(401, { detail: "Sign in to read your dashboard." });
      },
    });

    await expect(loadSecurity({ client: api, device: device(ACCOUNT) })).rejects.toBeInstanceOf(ApiError);
  });

  it("fails when the key document is unusable rather than showing a blank", async () => {
    const api = client({ "/me/dashboard": DASHBOARD, [didPath]: { did: ACCOUNT } });

    await expect(loadSecurity({ client: api, device: device(ACCOUNT) })).rejects.toThrow(
      /active key/,
    );
  });
});

describe("describeSecurityError", () => {
  it("uses the problem detail, then the title", () => {
    expect(describeSecurityError(new ApiError(401, { detail: "Sign in first." }))).toBe(
      "Sign in first.",
    );
    expect(describeSecurityError(new ApiError(403, { title: "Forbidden" }))).toBe("Forbidden");
  });

  it("explains a network failure in plain words", () => {
    expect(describeSecurityError(new NetworkError("/v1/did/x"))).toMatch(/could not reach the server/);
  });

  it("passes through our own errors and plain errors", () => {
    expect(describeSecurityError(new SecurityError("Bad document."))).toBe("Bad document.");
    expect(describeSecurityError(new DashboardError("No caller."))).toBe("No caller.");
    expect(describeSecurityError(new Error("boom"))).toBe("boom");
  });

  it("has a fallback for anything else", () => {
    expect(describeSecurityError("???")).toBe("The API could not return your security details.");
  });
});

describe("formatInstant and formatDay", () => {
  it("formats an ISO instant in UTC, whatever the reader's time zone", () => {
    expect(formatInstant("2026-11-12T09:05:00Z")).toBe("12 Nov 2026, 09:05 UTC");
    expect(formatInstant("2026-01-03T23:59:00+02:00")).toBe("3 Jan 2026, 21:59 UTC");
  });

  it("formats epoch milliseconds", () => {
    expect(formatInstant(Date.UTC(2026, 10, 3, 8, 30))).toBe("3 Nov 2026, 08:30 UTC");
  });

  it("gives the date alone for the short form", () => {
    expect(formatDay("2026-11-12T09:05:00Z")).toBe("12 Nov 2026");
  });

  it("gives the calendar day in the reader's zone, not the UTC day", () => {
    // 19:20 UTC on 18 Nov is 06:20 on 19 Nov in Sydney (GMT+11): a passkey
    // created just after local midnight was listed a day early.
    expect(formatDay(Date.UTC(2026, 10, 18, 19, 20))).toBe("19 Nov 2026");
    expect(formatDay("2026-11-18T19:20:00Z")).toBe("19 Nov 2026");
    // The same instant is still 18 Nov in UTC, and an instant format says so.
    expect(formatInstant(Date.UTC(2026, 10, 18, 19, 20))).toBe(
      "18 Nov 2026, 19:20 UTC",
    );
  });

  it("returns null for anything that is not a date", () => {
    expect(formatInstant(null)).toBeNull();
    expect(formatInstant(undefined)).toBeNull();
    expect(formatInstant("not a date")).toBeNull();
    expect(formatDay("not a date")).toBeNull();
  });
});
