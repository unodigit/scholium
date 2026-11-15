// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const key = vi.hoisted(() => ({
  exists: vi.fn<() => Promise<boolean>>(),
  didKey: vi.fn<() => Promise<string>>(),
}));
vi.mock("../web-auth", () => ({ deviceKey: key }));

import { useDeviceDid } from "./use-device-did";

beforeEach(() => {
  key.exists.mockReset();
  key.didKey.mockReset();
});
afterEach(cleanup);

describe("useDeviceDid", () => {
  it("says it is still checking, then gives the DID of this device's key", async () => {
    key.exists.mockResolvedValue(true);
    key.didKey.mockResolvedValue(DID);
    const { result } = renderHook(() => useDeviceDid());
    expect(result.current).toEqual({ phase: "checking", did: null });
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", did: DID }));
  });

  it("says there is no key, once it has looked, without asking for one", async () => {
    key.exists.mockResolvedValue(false);
    const { result } = renderHook(() => useDeviceDid());
    expect(result.current.phase).toBe("checking");
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", did: null }));
    expect(key.didKey).not.toHaveBeenCalled();
  });

  it("counts a key store that cannot be read as no key rather than checking forever", async () => {
    key.exists.mockRejectedValue(new Error("storage blocked"));
    const { result } = renderHook(() => useDeviceDid());
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", did: null }));
  });

  it("uses an override, even null, at once and never touches the device key", () => {
    const some = renderHook(() => useDeviceDid(DID));
    expect(some.result.current).toEqual({ phase: "ready", did: DID });
    const none = renderHook(() => useDeviceDid(null));
    expect(none.result.current).toEqual({ phase: "ready", did: null });
    expect(key.exists).not.toHaveBeenCalled();
  });

  it("does not update after it has been unmounted", async () => {
    let resolve: (value: boolean) => void = () => undefined;
    key.exists.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useDeviceDid());
    unmount();
    resolve(false);
    await Promise.resolve();
    expect(result.current).toEqual({ phase: "checking", did: null });
  });
});
