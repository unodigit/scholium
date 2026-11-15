// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  TokenStore,
  clearTokens,
  getTokens,
  setTokens,
  tokenStore,
} from "./index";

describe("TokenStore in the browser", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("persists the token pair in localStorage", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1", refreshToken: "refresh-1" });

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toContain("access-1");

    // A fresh instance rehydrates from the same storage (page reload).
    expect(new TokenStore().get()).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("merges partial updates", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1", refreshToken: "refresh-1" });
    store.set({ accessToken: "access-2" });

    expect(store.get()).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
  });

  it("notifies subscribers when tokens change", () => {
    const store = new TokenStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set({ accessToken: "access-1" });
    store.clear();
    unsubscribe();
    store.set({ accessToken: "access-2" });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ accessToken: "access-1" });
    expect(listener.mock.calls[1]?.[0]).toBeNull();
  });

  it("clears persisted tokens", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1" });
    store.clear();

    expect(store.get()).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("exposes the shared browser store", () => {
    setTokens({ accessToken: "shared", refreshToken: "refresh" });
    expect(getTokens()).toMatchObject({ accessToken: "shared", refreshToken: "refresh" });
    expect(tokenStore.isAuthenticated).toBe(true);

    clearTokens();
    expect(getTokens()).toBeNull();
    expect(tokenStore.isAuthenticated).toBe(false);
  });
});
