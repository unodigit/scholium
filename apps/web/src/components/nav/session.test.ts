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
  it("navigates to / and scrolls to the top after the navigation", async () => {
    const { result } = renderHook(() => useSignOut());

    await act(async () => {
      await result.current.signOut();
    });

    expect(replace).toHaveBeenCalledWith("/");
    expect(scrollTo).toHaveBeenCalled();
    // The scroll must come after the navigation, not before it.
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(
      scrollTo.mock.invocationCallOrder[0],
    );
    // Bypasses smooth scrolling.
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: expect.stringMatching(/instant|auto/) }),
    );
  });
});
