// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryTokenStorage, apiErrorFrom } from "../../lib/api";

import { PasskeyCancelledError } from "./errors";
import {
  RECOVERY_STORAGE_KEY,
  placeholderRecovery,
  savePersistedRecovery,
  type RecoverySnapshot,
} from "./recover";
import {
  RECOVER_CANCELLED_NOTICE,
  RECOVER_ORCID_INVALID_MESSAGE,
  RECOVER_STARTED_NOTICE,
  RECOVER_WRONG_DEVICE_MESSAGE,
} from "./recover-messages";
import {
  useRecover,
  type RecoveryDeviceKey,
  type RecoveryServices,
} from "./use-recover";

const ORCID = "0000-0002-1825-0097";
const NEW_KEY = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";
const NOW = Date.parse("2026-11-15T00:00:00Z");

const OPENED = {
  request_id: "rec_1",
  status: "pending",
  guardians_notified: 5,
};

type MockDeviceKey = RecoveryDeviceKey & {
  exists: ReturnType<typeof vi.fn>;
  didKey: ReturnType<typeof vi.fn>;
  ensure: ReturnType<typeof vi.fn>;
  signWithPasskey: ReturnType<typeof vi.fn>;
};

type MockClient = RecoveryServices["client"] & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

function makeServices(options: {
  hasKey?: boolean;
  get?: (path: string) => unknown;
  post?: (path: string, body?: unknown) => unknown;
} = {}) {
  const storage = new MemoryTokenStorage();
  const deviceKey = {
    exists: vi.fn(async () => options.hasKey ?? true),
    didKey: vi.fn(async () => NEW_KEY),
    ensure: vi.fn(async () => ({ credentialId: "cred", createdAt: NOW })),
    signWithPasskey: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const client = {
    get: vi.fn(async (path: string) =>
      options.get ? options.get(path) : { status: "pending", approvals: 0 },
    ),
    post: vi.fn(async (path: string, body?: unknown) =>
      options.post ? options.post(path, body) : OPENED,
    ),
  };
  const services = {
    client,
    deviceKey,
    storage,
    now: () => NOW,
  } as unknown as RecoveryServices;
  return {
    services,
    storage,
    client: client as unknown as MockClient,
    deviceKey: deviceKey as unknown as MockDeviceKey,
  };
}

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return { ...placeholderRecovery("rec_1", ORCID, () => NOW), ...overrides };
}

afterEach(() => {
  cleanup();
});

describe("identify step", () => {
  it("starts empty and ready with no remembered request", async () => {
    const { services, client } = makeServices();
    const { result } = renderHook(() => useRecover({ services }));

    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(client.get).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("refuses a value that is not an ORCID iD without calling the API", async () => {
    const { services, client } = makeServices();
    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.start("nope");
    });

    expect(result.current.error).toBe(RECOVER_ORCID_INVALID_MESSAGE);
    expect(result.current.snapshot).toBeNull();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("opens a request with this device's key and remembers it", async () => {
    const { services, storage, client, deviceKey } = makeServices();
    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.start(` https://orcid.org/${ORCID} `);
    });

    expect(deviceKey.ensure).not.toHaveBeenCalled();
    expect(deviceKey.didKey).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      "/recovery/requests",
      { orcid: ORCID, new_public_key: NEW_KEY },
      { auth: false },
    );
    expect(result.current.snapshot).toMatchObject({
      requestId: "rec_1",
      orcid: ORCID,
      newPublicKey: NEW_KEY,
      status: "pending",
      approvals: 0,
      threshold: 3,
      guardiansNotified: 5,
    });
    expect(result.current.notice).toBe(RECOVER_STARTED_NOTICE);
    expect(storage.getItem(RECOVERY_STORAGE_KEY)).toContain("rec_1");
  });

  it("creates the new passkey on a device that has no key", async () => {
    const { services, deviceKey } = makeServices({ hasKey: false });
    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.start(ORCID);
    });

    expect(deviceKey.ensure).toHaveBeenCalledWith({ userName: ORCID });
    expect(deviceKey.didKey).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.requestId).toBe("rec_1");
  });

  it("explains an ORCID iD that names no account", async () => {
    const { services } = makeServices({
      post: () => {
        throw apiErrorFrom(404, {
          type: "urn:scholium:problem:recovery-account-not-found",
        });
      },
    });
    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.start(ORCID);
    });

    expect(result.current.error).toMatch(/couldn't find an account/);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("explains an account that has not set guardians", async () => {
    const { services } = makeServices({
      post: () => {
        throw apiErrorFrom(409, {
          type: "urn:scholium:problem:recovery-guardians-not-set",
        });
      },
    });
    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.start(ORCID);
    });

    expect(result.current.error).toMatch(/hasn't set recovery guardians/);
  });
});

describe("progress step", () => {
  it("reads a remembered request's approvals on mount", async () => {
    const { services, storage, client } = makeServices({
      get: () => ({ status: "pending", approvals: 2, guardians_notified: 5 }),
    });
    savePersistedRecovery(storage, snapshot());

    const { result } = renderHook(() => useRecover({ services }));

    await waitFor(() => expect(result.current.snapshot?.approvals).toBe(2));
    expect(client.get).toHaveBeenCalledWith("/recovery/requests/rec_1", {
      auth: false,
    });
    expect(result.current.statusLive).toBe(true);
    expect(result.current.snapshot?.threshold).toBe(3);
  });

  it("opens the safety window when the third approval arrives", async () => {
    const { services, storage } = makeServices({
      get: () => ({
        status: "contest",
        approvals: 3,
        contest_until: "2026-11-18T00:00:00Z",
      }),
    });
    savePersistedRecovery(storage, snapshot());

    const { result } = renderHook(() => useRecover({ services }));

    await waitFor(() => expect(result.current.snapshot?.status).toBe("contest"));
    expect(result.current.snapshot?.contestUntil).toBe("2026-11-18T00:00:00.000Z");
    expect(storage.getItem(RECOVERY_STORAGE_KEY)).toContain("contest");
  });

  it("keeps the last known progress when the status route is not there", async () => {
    const { services, storage } = makeServices({
      get: () => {
        throw apiErrorFrom(405, { detail: "Method Not Allowed" });
      },
    });
    savePersistedRecovery(storage, snapshot({ approvals: 1 }));

    const { result } = renderHook(() => useRecover({ services }));

    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.snapshot?.approvals).toBe(1);
    expect(result.current.statusLive).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("shows a real status failure in plain language", async () => {
    const { services, storage } = makeServices({
      get: () => {
        throw apiErrorFrom(503, { detail: "Service Unavailable" });
      },
    });
    savePersistedRecovery(storage, snapshot());

    const { result } = renderHook(() => useRecover({ services }));

    await waitFor(() => expect(result.current.error).toMatch(/having trouble/));
    expect(result.current.snapshot?.requestId).toBe("rec_1");
  });

  it("loads the request named by ?request= even without local memory", async () => {
    const { services, client } = makeServices({
      get: () => ({
        request_id: "rec_77",
        status: "contest",
        approvals: 3,
        contest_until: "2026-11-18T00:00:00Z",
      }),
    });

    const { result } = renderHook(() =>
      useRecover({ services, requestId: "rec_77", initialOrcid: ORCID }),
    );

    // The hook shows a placeholder for rec_77 first and the loaded request a
    // render later, so wait for the loaded values, not just the id.
    await waitFor(() =>
      expect(result.current.snapshot).toMatchObject({
        requestId: "rec_77",
        orcid: ORCID,
        status: "contest",
        approvals: 3,
      }),
    );
    expect(client.get).toHaveBeenCalledWith("/recovery/requests/rec_77", {
      auth: false,
    });
  });

  it("checks again on demand", async () => {
    let approvals = 1;
    const { services, storage } = makeServices({
      get: () => ({ status: "pending", approvals }),
    });
    savePersistedRecovery(storage, snapshot());

    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.snapshot?.approvals).toBe(1));

    approvals = 2;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.snapshot?.approvals).toBe(2);
  });
});

describe("cancelling", () => {
  it("signs with the passkey and marks the request cancelled", async () => {
    const { services, storage, client, deviceKey } = makeServices({
      get: () => ({ status: "contest", approvals: 3 }),
    });
    savePersistedRecovery(storage, snapshot({ status: "contest", approvals: 3 }));

    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.snapshot?.status).toBe("contest"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(deviceKey.signWithPasskey).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      "/recovery/requests/rec_1/cancel",
      { signature: "AQID" },
      { auth: false },
    );
    expect(result.current.snapshot?.status).toBe("cancelled");
    expect(result.current.notice).toBe(RECOVER_CANCELLED_NOTICE);
    expect(storage.getItem(RECOVERY_STORAGE_KEY)).toContain("cancelled");
  });

  it("explains that this device does not hold the old key", async () => {
    const { services, storage } = makeServices({
      get: () => ({ status: "contest", approvals: 3 }),
      post: () => {
        throw apiErrorFrom(401, { detail: "Not authorized to cancel" });
      },
    });
    savePersistedRecovery(storage, snapshot({ status: "contest", approvals: 3 }));

    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.snapshot?.status).toBe("contest"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.error).toBe(RECOVER_WRONG_DEVICE_MESSAGE);
    expect(result.current.snapshot?.status).toBe("contest");
    expect(result.current.busy).toBe(false);
  });

  it("explains a dismissed passkey prompt", async () => {
    const { services, storage, deviceKey } = makeServices();
    savePersistedRecovery(storage, snapshot());
    deviceKey.signWithPasskey.mockRejectedValueOnce(new PasskeyCancelledError());

    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.snapshot?.requestId).toBe("rec_1"));
    await waitFor(() => expect(result.current.refreshing).toBe(false));

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.error).toMatch(/prompt was closed/);
    expect(result.current.snapshot?.status).toBe("pending");
  });
});

describe("starting over", () => {
  it("forgets the request and shows the identify step", async () => {
    const { services, storage } = makeServices();
    savePersistedRecovery(storage, snapshot());

    const { result } = renderHook(() => useRecover({ services }));
    await waitFor(() => expect(result.current.snapshot?.requestId).toBe("rec_1"));

    act(() => {
      result.current.reset();
    });

    expect(result.current.snapshot).toBeNull();
    expect(storage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });
});
