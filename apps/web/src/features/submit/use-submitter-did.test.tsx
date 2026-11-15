// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const key = vi.hoisted(() => ({
  exists: vi.fn<() => Promise<boolean>>(),
  didKey: vi.fn<() => Promise<string>>(),
}));
vi.mock("../web-auth", () => ({ deviceKey: key }));

import { useSubmitterDid } from "./use-submitter-did";

beforeEach(() => {
  key.exists.mockReset();
  key.didKey.mockReset();
});
afterEach(cleanup);

describe("useSubmitterDid", () => {
  it("reads the DID from this device's key", async () => {
    key.exists.mockResolvedValue(true);
    key.didKey.mockResolvedValue(DID);
    const { result } = renderHook(() => useSubmitterDid());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(DID));
  });

  it("stays null with no key on the device, without asking for one", async () => {
    key.exists.mockResolvedValue(false);
    const { result } = renderHook(() => useSubmitterDid());
    await waitFor(() => expect(key.exists).toHaveBeenCalled());
    expect(result.current).toBeNull();
    expect(key.didKey).not.toHaveBeenCalled();
  });

  it("stays null when the key cannot be read", async () => {
    key.exists.mockRejectedValue(new Error("storage blocked"));
    const { result } = renderHook(() => useSubmitterDid());
    await waitFor(() => expect(key.exists).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("uses an override, even null, and never touches the device key", async () => {
    const { result, rerender } = renderHook(({ did }: { did?: string | null }) => useSubmitterDid(did), {
      initialProps: { did: DID as string | null | undefined },
    });
    expect(result.current).toBe(DID);
    rerender({ did: null });
    expect(result.current).toBeNull();
    expect(key.exists).not.toHaveBeenCalled();
  });
});
