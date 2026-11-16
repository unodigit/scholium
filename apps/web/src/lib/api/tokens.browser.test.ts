// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  TokenStore,
  browserTokenStorage,
  clearTokens,
  getTokens,
  purgeLegacyPersistedTokens,
  setTokens,
  tokenStore,
} from "./index";

/** Everything script in the page can read back: both Web Storage areas and cookies. */
function scriptReadableState(): string {
  const entries: string[] = [];
  for (const area of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < area.length; i += 1) {
      const key = area.key(i) as string;
      entries.push(`${key}=${area.getItem(key)}`);
    }
  }
  entries.push(document.cookie);
  return entries.join("\n");
}

describe("TokenStore in the browser", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("keeps the access token in memory, never in web storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const store = new TokenStore();
    store.set({ accessToken: "access-1" });
    setTokens({ accessToken: "shared-access" });

    expect(store.get()).toMatchObject({ accessToken: "access-1" });
    expect(setItem).not.toHaveBeenCalled();
    expect(scriptReadableState()).not.toContain("access-1");
    expect(scriptReadableState()).not.toContain("shared-access");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    clearTokens();
  });

  it("does not survive a reload: a fresh store starts signed out", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1" });

    // A reload builds new module state; nothing was persisted to rehydrate.
    expect(new TokenStore().get()).toBeNull();
  });

  it("drops a refresh token instead of storing it anywhere", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1", refreshToken: "long-lived-refresh-secret" });
    setTokens({ accessToken: "access-2", refreshToken: "long-lived-refresh-secret" });

    expect(store.get()).not.toHaveProperty("refreshToken");
    expect(getTokens()).not.toHaveProperty("refreshToken");
    expect(scriptReadableState()).not.toContain("long-lived-refresh-secret");
    clearTokens();
  });

  it("merges partial updates", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1", tokenType: "Bearer", expiresAt: 123 });
    store.set({ accessToken: "access-2" });

    expect(store.get()).toEqual({
      accessToken: "access-2",
      tokenType: "Bearer",
      expiresAt: 123,
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

  it("clears the tokens", () => {
    const store = new TokenStore();
    store.set({ accessToken: "access-1" });
    store.clear();

    expect(store.get()).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  it("exposes the shared in-memory store", () => {
    setTokens({ accessToken: "shared" });
    expect(getTokens()).toMatchObject({ accessToken: "shared" });
    expect(tokenStore.isAuthenticated).toBe(true);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();

    clearTokens();
    expect(getTokens()).toBeNull();
    expect(tokenStore.isAuthenticated).toBe(false);
  });
});

describe("legacy persisted tokens", () => {
  const legacyBlob = JSON.stringify({
    accessToken: "stale-access",
    refreshToken: "stale-refresh-secret",
    tokenType: "Bearer",
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it("purges the token pair an older build left in localStorage", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, legacyBlob);

    purgeLegacyPersistedTokens();

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("purges it on load and does not sign the user in from it", async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, legacyBlob);
    vi.resetModules();

    const fresh = await import("./index");

    expect(window.localStorage.getItem(fresh.TOKEN_STORAGE_KEY)).toBeNull();
    expect(fresh.tokenStore.get()).toBeNull();
  });

  it("leaves other localStorage entries alone", () => {
    window.localStorage.setItem("unrelated", "keep");
    window.localStorage.setItem(TOKEN_STORAGE_KEY, legacyBlob);

    purgeLegacyPersistedTokens();

    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("keeps browserTokenStorage as plain localStorage for non-secret client state", () => {
    // web-auth keeps its "new account" marker here; only credentials moved out.
    browserTokenStorage.setItem("scholium.marker", "1");

    expect(window.localStorage.getItem("scholium.marker")).toBe("1");
    browserTokenStorage.removeItem("scholium.marker");
    expect(window.localStorage.getItem("scholium.marker")).toBeNull();
  });
});
