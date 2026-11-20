// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";

const replace = vi.fn();
const scrollTo = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: { logout: vi.fn(async () => undefined) },
    resetSessionBootstrap: vi.fn(),
  };
});

vi.mock("../../lib/api/session-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/api/session-provider")>();
  return {
    ...actual,
    forgetSignedInHint: vi.fn(),
    hasSignedInHint: vi.fn(() => false),
  };
});

import { api, resetSessionBootstrap } from "../../lib/api";
import {
  forgetSignedInHint,
  hasSignedInHint,
} from "../../lib/api/session-provider";
import { useSignOut } from "./session";

beforeEach(() => {
  replace.mockReset();
  scrollTo.mockReset();
  vi.mocked(api.logout).mockReset();
  vi.mocked(api.logout).mockResolvedValue(undefined);
  vi.mocked(resetSessionBootstrap).mockReset();
  vi.mocked(forgetSignedInHint).mockReset();
  (tokenStore as { clear?: () => void }).clear?.();
  window.localStorage.clear();
  Object.defineProperty(window, "scrollTo", { value: scrollTo, writable: true });
});

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

describe("useSignOut", () => {
  it("lands on / at the top: instant scroll first, then a navigation that does not scroll", async () => {
    const { result } = renderHook(() => useSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    // Next.js's post-navigation scroll is what glided the smooth-scrolling
    // homepage down to "Why Scholium", so the navigation must opt out of it.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/", { scroll: false });
    // The page being left goes to the top instantly, before the navigation.
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 0, behavior: "instant" }),
    );
    expect(scrollTo.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0],
    );
  });
});
