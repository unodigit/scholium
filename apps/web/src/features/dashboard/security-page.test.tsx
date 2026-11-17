// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";

import { RotationError, type RotateKey, type RotateKeyInput } from "./rotate-key";
import { SecurityPage, shortDid } from "./security-page";
import type { DeviceInfo, GuardianState, SecurityData } from "./security";

const ACCOUNT = "did:key:z6MkAccountAccountAccountAccountAccountAccount1";
const NEW_KEY = "did:key:z6MkNewKeyNewKeyNewKeyNewKeyNewKeyNewKeyNewKe2";
const GUARDIANS = [1, 2, 3, 4, 5].map((n) => `did:key:z6MkGuardian${n}${"x".repeat(29)}${n}`);

const DEVICE: DeviceInfo = {
  id: "cred-1",
  did: ACCOUNT,
  createdAt: Date.UTC(2026, 10, 3, 8, 30),
  rpId: "scholium.test",
  holdsActiveKey: true,
};

const FULL_GUARDIANS: GuardianState = {
  required: 3,
  total: 5,
  dids: GUARDIANS,
  source: "server",
};

/** An account that never rotated, on its original device, with all five guardians. */
const BASE: SecurityData = {
  did: ACCOUNT,
  tier: 1,
  activeKey: ACCOUNT,
  rotations: [],
  lastRotation: null,
  guardians: FULL_GUARDIANS,
  devices: [DEVICE],
  devicesReadable: true,
};

const ROTATION = {
  recordCid: "bafy-rotation-1",
  seq: 41,
  oldKey: ACCOUNT,
  newKey: NEW_KEY,
  effectiveAt: "2026-11-12T09:05:00Z",
  reason: "new laptop",
};

function data(overrides: Partial<SecurityData> = {}): SecurityData {
  return { ...BASE, ...overrides };
}

/** The card with the given heading, found by its accessible name. */
function card(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function ready(overrides: Partial<SecurityData> = {}, props: Parameters<typeof SecurityPage>[0] = {}) {
  return render(<SecurityPage initialSecurity={data(overrides)} signedIn {...props} />);
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

describe("SecurityPage", () => {
  it("shows the title and the three cards", () => {
    ready();

    expect(screen.getByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    for (const name of ["Devices", "Recovery guardians", "Key rotation"]) {
      expect(card(name)).toBeTruthy();
    }
  });

  it("links back to the dashboard", () => {
    ready();

    expect(screen.getByRole("link", { name: "Back to your dashboard" }).getAttribute("href")).toBe(
      "/me",
    );
  });
});

describe("Devices card", () => {
  it("shows this device, its key and that it signs for the account", () => {
    ready();

    const devices = within(card("Devices"));
    expect(devices.getByText("This device")).toBeTruthy();
    expect(devices.getByText(ACCOUNT)).toBeTruthy();
    expect(devices.getByText("Passkey created 3 Nov 2026")).toBeTruthy();
    expect(devices.getByText("Active signing key")).toBeTruthy();
  });

  it("says in words when this device's key is no longer the account's", () => {
    ready({ devices: [{ ...DEVICE, holdsActiveKey: false }], activeKey: NEW_KEY });

    const devices = within(card("Devices"));
    expect(devices.getByText("Not the active key")).toBeTruthy();
    expect(devices.getByText(/this device cannot sign for it/)).toBeTruthy();
    expect(devices.queryByText("Active signing key")).toBeNull();
  });

  it("offers sign-in when this browser holds no key", () => {
    ready({ devices: [] });

    const devices = within(card("Devices"));
    expect(devices.getByText("This browser holds no signing key.")).toBeTruthy();
    expect(devices.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Fme%2Fsecurity",
    );
  });

  it("says so when the key store could not be read, rather than looking empty", () => {
    ready({ devices: [], devicesReadable: false });

    const devices = within(card("Devices"));
    expect(devices.getByRole("status").textContent).toMatch(/key store could not be read/);
    expect(devices.queryByText("This browser holds no signing key.")).toBeNull();
  });

  it("copes with a device whose creation time is unknown", () => {
    ready({ devices: [{ ...DEVICE, createdAt: null }] });

    expect(within(card("Devices")).getByText("Passkey creation date unknown")).toBeTruthy();
  });
});

describe("Recovery guardians card", () => {
  it("shows 3 of 5 and lists the guardians when all five are set", () => {
    ready();

    const guardians = within(card("Recovery guardians"));
    expect(guardians.getByText("3 of 5")).toBeTruthy();
    expect(guardians.getByText("All 5 guardians set.")).toBeTruthy();
    expect(guardians.getByText(/any 3 of your 5 guardians/)).toBeTruthy();
    const list = guardians.getByRole("list", { name: "Your recovery guardians" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      GUARDIANS.map(shortDid),
    );
    expect(guardians.queryByRole("link", { name: "Set recovery guardians" })).toBeNull();
  });

  it("does not annotate a guardian that is also saved on this device", () => {
    ready({ guardians: { ...FULL_GUARDIANS, localDids: GUARDIANS } });

    const guardians = within(card("Recovery guardians"));
    expect(guardians.queryByText(/also on this device/)).toBeNull();
  });

  it("still shows 3 of 5 and offers setup when no guardians are set", () => {
    ready({ guardians: { ...FULL_GUARDIANS, dids: [] } });

    const guardians = within(card("Recovery guardians"));
    expect(guardians.getByText("3 of 5")).toBeTruthy();
    expect(guardians.getByText("You have not set any recovery guardians yet.")).toBeTruthy();
    expect(guardians.queryByRole("list")).toBeNull();
    expect(guardians.getByRole("link", { name: "Set recovery guardians" }).getAttribute("href")).toBe(
      "/onboarding",
    );
  });

  it("says how many more are needed when the set is partial", () => {
    ready({ guardians: { ...FULL_GUARDIANS, dids: GUARDIANS.slice(0, 2) } });

    const guardians = within(card("Recovery guardians"));
    expect(guardians.getByText(/2 of 5 guardians set\. Name 3 more/)).toBeTruthy();
    expect(guardians.getByRole("link", { name: "Set recovery guardians" })).toBeTruthy();
  });

  it("labels a list that only this browser vouches for", () => {
    ready({ guardians: { ...FULL_GUARDIANS, source: "this-browser" } });

    expect(within(card("Recovery guardians")).getByText("Saved from this browser.")).toBeTruthy();
  });

  it("does not claim the server has none when it simply does not know", () => {
    ready({ guardians: { ...FULL_GUARDIANS, dids: [], source: "unknown" } });

    const guardians = within(card("Recovery guardians"));
    expect(guardians.getByText(/No guardians are recorded on this device/)).toBeTruthy();
    expect(guardians.queryByText("You have not set any recovery guardians yet.")).toBeNull();
  });

  it("names a guardian by their profile name, with the DID secondary", () => {
    ready({ profileNames: { [GUARDIANS[0]!]: "Grace Hopper" } });

    const guardians = within(card("Recovery guardians"));
    expect(guardians.getByText("Grace Hopper")).toBeTruthy();
    // The DID is still there, secondarily and shortened, so the guardian is identifiable.
    expect(guardians.getByText(shortDid(GUARDIANS[0]!))).toBeTruthy();
    expect(guardians.getByText(shortDid(GUARDIANS[1]!))).toBeTruthy();
    expect(guardians.queryByText(GUARDIANS[0]!)).toBeNull();
  });
});

describe("Recovery requests card", () => {
  const REQUEST = {
    requestId: "rr-1",
    accountDid: GUARDIANS[0]!,
    status: "pending",
    approvals: 1,
    threshold: 3,
    newPublicKey: NEW_KEY,
  };

  it("names the requester by their profile name, with the DID secondary", () => {
    ready({
      recoveryRequests: [REQUEST],
      profileNames: { [GUARDIANS[0]!]: "Grace Hopper" },
    });

    const requests = within(card("Recovery requests"));
    expect(
      requests.getByRole("link", { name: "Grace Hopper" }).getAttribute("href"),
    ).toBe(`/me/recovery/${encodeURIComponent("rr-1")}`);
    expect(requests.getByText(shortDid(GUARDIANS[0]!))).toBeTruthy();
  });

  it("falls back to the requester's short DID when no profile name is known", () => {
    ready({ recoveryRequests: [REQUEST] });

    const requests = within(card("Recovery requests"));
    expect(
      requests.getByRole("link", { name: shortDid(GUARDIANS[0]!) }).getAttribute("href"),
    ).toBe(`/me/recovery/${encodeURIComponent("rr-1")}`);
  });
});

describe("Key rotation card", () => {
  it("says the key never rotated, and shows the active key", () => {
    ready();

    const rotation = within(card("Key rotation"));
    expect(rotation.getByText("Last key rotation")).toBeTruthy();
    expect(rotation.getByText("Never rotated")).toBeTruthy();
    expect(rotation.getByText(/still sign with the key your account was created with/)).toBeTruthy();
    expect(rotation.getByText("Active key")).toBeTruthy();
    expect(rotation.getByText(ACCOUNT)).toBeTruthy();
    expect(rotation.queryByRole("button", { name: "View rotation record" })).toBeNull();
  });

  it("shows when the key last rotated, why, and links the record", () => {
    ready({ activeKey: NEW_KEY, rotations: [ROTATION], lastRotation: ROTATION });

    const rotation = within(card("Key rotation"));
    expect(rotation.getByText("12 Nov 2026, 09:05 UTC")).toBeTruthy();
    expect(rotation.getByText("new laptop")).toBeTruthy();
    expect(rotation.getByText(NEW_KEY)).toBeTruthy();
    expect(rotation.getByRole("button", { name: "View rotation record" })).toBeTruthy();
    expect(rotation.queryByText("Never rotated")).toBeNull();
  });

  it("says when a rotation carried no date", () => {
    const undated = { ...ROTATION, effectiveAt: null, reason: null };
    ready({ rotations: [undated], lastRotation: undated });

    expect(within(card("Key rotation")).getByText("Date not recorded")).toBeTruthy();
  });
});

describe("Rotate key", () => {
  it("is a button on the Key rotation card", () => {
    ready();

    const button = within(card("Key rotation")).getByRole("button", { name: "Rotate key" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("is unavailable, and says why, when this device does not hold the active key", () => {
    ready({ devices: [{ ...DEVICE, holdsActiveKey: false }], activeKey: NEW_KEY });

    const rotation = within(card("Key rotation"));
    const button = rotation.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(rotation.getByText(/Rotate from the device that holds your current signing key/)).toBeTruthy();
    expect(rotation.getByRole("link", { name: "recover your account" }).getAttribute("href")).toBe(
      "/recover",
    );
  });

  it("is unavailable when this browser has no key at all", () => {
    ready({ devices: [] });

    expect(
      (within(card("Key rotation")).getByRole("button", { name: "Rotate key" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("asks before doing anything, and says it cannot be undone", () => {
    const rotate = vi.fn();
    ready({}, { rotate });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));

    const form = screen.getByRole("form", { name: "Rotate your signing key?" });
    expect(within(form).getByText(/can.t be undone/)).toBeTruthy();
    expect(within(form).getByText(/Scholium never sees your key/)).toBeTruthy();
    expect(within(form).getByLabelText("Reason (optional)")).toBeTruthy();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("moves focus into the question, and back to the button when dismissed", () => {
    ready();

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Rotate your signing key?" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rotate key" }));
  });

  it("rotates with the account's current key, chained to the last rotation, with the reason", async () => {
    const rotate = vi.fn<RotateKey>().mockResolvedValue({ recordId: "bafy-new", newKey: NEW_KEY });
    const onRotated = vi.fn();
    ready(
      { activeKey: ACCOUNT, rotations: [ROTATION], lastRotation: ROTATION },
      { rotate, onRotated },
    );

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "lost my old phone" },
    });
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));

    await waitFor(() => expect(onRotated).toHaveBeenCalledTimes(1));
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate.mock.calls[0]?.[0]).toEqual<RotateKeyInput>({
      accountDid: ACCOUNT,
      activeKey: ACCOUNT,
      deviceDid: ACCOUNT,
      prev: "bafy-rotation-1",
      reason: "lost my old phone",
    });
    expect(screen.getByRole("status").textContent).toMatch(/Key rotated/);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("starts a chain when this is the first rotation", async () => {
    const rotate = vi.fn<RotateKey>().mockResolvedValue({ recordId: "r", newKey: NEW_KEY });
    ready({}, { rotate, onRotated: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));

    await waitFor(() => expect(rotate).toHaveBeenCalled());
    expect(rotate.mock.calls[0]?.[0].prev).toBeNull();
  });

  it("waits for the passkey with the controls locked, and cannot be submitted twice", async () => {
    let finish: () => void = () => {};
    const rotate = vi.fn<RotateKey>(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ recordId: "r", newKey: NEW_KEY });
        }),
    );
    const onRotated = vi.fn();
    ready({}, { rotate, onRotated });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    const form = screen.getByRole("form");
    fireEvent.click(within(form).getByRole("button", { name: "Rotate key" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Waiting for your passkey…"));
    expect((within(form).getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByLabelText("Reason (optional)") as HTMLInputElement).disabled).toBe(true);

    fireEvent.submit(form);
    expect(rotate).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(onRotated).toHaveBeenCalledTimes(1));
  });

  it("explains a failure, keeps the question open and allows another try", async () => {
    const rotate = vi
      .fn<RotateKey>()
      .mockRejectedValueOnce(new RotationError("cancelled", "dismissed"))
      .mockResolvedValueOnce({ recordId: "r", newKey: NEW_KEY });
    const onRotated = vi.fn();
    ready({}, { rotate, onRotated });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Rotation cancelled\. Nothing changed/);
    expect(onRotated).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(onRotated).toHaveBeenCalledTimes(1));
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it("shows the server's reason when it refuses", async () => {
    const rotate = vi
      .fn<RotateKey>()
      .mockRejectedValue(
        new RotationError("rejected", "The signature does not match your active key."),
      );
    ready({}, { rotate });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /did not accept the rotation: The signature does not match your active key\./,
    );
  });

  it("closes a failed question with Cancel", async () => {
    const rotate = vi.fn<RotateKey>().mockRejectedValue(new RotationError("unreachable", "x"));
    ready({}, { rotate });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Rotate key" })).toBeTruthy();
  });

  it.each(["install-failed", "unknown-outcome"] as const)(
    "does not offer a retry after %s, because the account may already have rotated",
    async (code) => {
      const rotate = vi.fn<RotateKey>().mockRejectedValue(new RotationError(code, "x"));
      const onRotated = vi.fn();
      ready({}, { rotate, onRotated });

      fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
      fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));
      await screen.findByRole("alert");

      const form = screen.getByRole("form", { name: "Your key may have changed" });
      expect(within(form).queryByRole("button", { name: "Rotate key" })).toBeNull();
      expect(within(form).queryByLabelText("Reason (optional)")).toBeNull();
      expect(within(form).getByRole("link", { name: "Recover your account" }).getAttribute("href")).toBe(
        "/recover",
      );

      fireEvent.click(within(form).getByRole("button", { name: "Reload this page" }));
      expect(onRotated).toHaveBeenCalledTimes(1);
      expect(rotate).toHaveBeenCalledTimes(1);
    },
  );

  it("handles an error that is not a RotationError", async () => {
    const rotate = vi.fn<RotateKey>().mockRejectedValue(new Error("boom"));
    ready({}, { rotate });

    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Rotate key" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The key was not rotated: boom.");
    // rotateKey wraps every step in a RotationError, so a bare error can only
    // come from before any server contact: the question stays open to retry.
    expect(screen.getByRole("button", { name: "Rotate key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("SecurityPage fetch states", () => {
  it("loads the screen on mount when there is no initial data", async () => {
    render(<SecurityPage signedIn loadSecurity={async () => data()} />);

    expect(await screen.findByRole("heading", { level: 2, name: "Recovery guardians" })).toBeTruthy();
  });

  it("shows a loading line while the request is in flight", () => {
    render(<SecurityPage signedIn loadSecurity={() => new Promise(() => {})} />);

    expect(screen.getByRole("status").textContent).toBe("Loading your security settings…");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("does not fetch when it already has the data", () => {
    const loadSecurity = vi.fn(async () => data());
    render(<SecurityPage signedIn initialSecurity={data()} loadSecurity={loadSecurity} />);

    expect(loadSecurity).not.toHaveBeenCalled();
    expect(card("Devices")).toBeTruthy();
  });

  it("asks a signed-out reader to sign in and returns them here afterwards", () => {
    const loadSecurity = vi.fn(async () => data());
    render(<SecurityPage signedIn={false} loadSecurity={loadSecurity} />);

    expect(screen.getByRole("alert").textContent).toMatch(/Sign in to continue/);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Fme%2Fsecurity",
    );
    expect(loadSecurity).not.toHaveBeenCalled();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("reads the sign-in state from the token store when not told", async () => {
    const loadSecurity = vi.fn(async () => data());

    const { unmount } = render(<SecurityPage loadSecurity={loadSecurity} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Sign in to continue/));
    expect(loadSecurity).not.toHaveBeenCalled();
    unmount();

    tokenStore.set({ accessToken: "a", refreshToken: "r" });
    render(<SecurityPage loadSecurity={loadSecurity} />);
    expect(await screen.findByRole("region", { name: "Devices" })).toBeTruthy();
    expect(loadSecurity).toHaveBeenCalledTimes(1);
  });

  it("explains an API failure and retries on request", async () => {
    const loadSecurity = vi
      .fn<() => Promise<SecurityData>>()
      .mockRejectedValueOnce(new ApiError(500, { detail: "The key service is down." }))
      .mockResolvedValueOnce(data());
    render(<SecurityPage signedIn loadSecurity={loadSecurity} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn.t load your security settings/);
    expect(alert.textContent).toMatch(/The key service is down\./);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("region", { name: "Devices" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(loadSecurity).toHaveBeenCalledTimes(2);
  });

  it("explains a network failure in plain words", async () => {
    render(
      <SecurityPage
        signedIn
        loadSecurity={async () => {
          throw new NetworkError("/v1/did/x");
        }}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the server/);
  });

  it("shows no stale cards after a failed refresh", async () => {
    const loadSecurity = vi
      .fn<() => Promise<SecurityData>>()
      .mockRejectedValue(new ApiError(500, { detail: "Down." }));
    render(<SecurityPage signedIn loadSecurity={loadSecurity} />);

    await screen.findByRole("alert");
    expect(screen.queryByRole("region")).toBeNull();
  });
});
