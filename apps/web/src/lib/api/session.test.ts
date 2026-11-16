// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  createSessionBootstrap,
  isProtectedPath,
  type SessionRefreshClient,
} from "./session";
import { MemoryTokenStorage, TokenStore, type AuthTokens } from "./tokens";

function fakeClient(
  refresh: () => Promise<AuthTokens | null>,
): SessionRefreshClient {
  return { refresh: vi.fn(refresh) };
}

describe("session bootstrap", () => {
  it("shares one refresh between concurrent callers", async () => {
    let resolve!: (tokens: AuthTokens | null) => void;
    const client = fakeClient(
      () =>
        new Promise<AuthTokens | null>((done) => {
          resolve = done;
        }),
    );
    const bootstrap = createSessionBootstrap({
      client,
      tokenStore: new TokenStore(new MemoryTokenStorage()),
    });

    const first = bootstrap.bootstrap();
    const second = bootstrap.bootstrap();

    expect(client.refresh).toHaveBeenCalledTimes(1);
    resolve({ accessToken: "restored" });

    await expect(first).resolves.toEqual({ accessToken: "restored" });
    await expect(second).resolves.toEqual({ accessToken: "restored" });
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when an access token is already in memory", async () => {
    const store = new TokenStore(new MemoryTokenStorage());
    store.set({ accessToken: "already-here" });
    const client = fakeClient(async () => ({ accessToken: "never" }));
    const bootstrap = createSessionBootstrap({ client, tokenStore: store });

    await expect(bootstrap.bootstrap()).resolves.toEqual({
      accessToken: "already-here",
    });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("remembers the answer for the rest of the page load", async () => {
    const client = fakeClient(async () => null);
    const bootstrap = createSessionBootstrap({
      client,
      tokenStore: new TokenStore(new MemoryTokenStorage()),
    });

    await bootstrap.bootstrap();
    await bootstrap.bootstrap();

    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  it("checks again after a reset", async () => {
    const client = fakeClient(async () => ({ accessToken: "restored" }));
    const store = new TokenStore(new MemoryTokenStorage());
    const bootstrap = createSessionBootstrap({ client, tokenStore: store });

    await bootstrap.bootstrap();
    store.clear();
    bootstrap.reset();
    await bootstrap.bootstrap();

    expect(client.refresh).toHaveBeenCalledTimes(2);
  });

  it("reports a failed refresh as no session without throwing", async () => {
    const client = fakeClient(async () => {
      throw new Error("offline");
    });
    const bootstrap = createSessionBootstrap({
      client,
      tokenStore: new TokenStore(new MemoryTokenStorage()),
    });

    await expect(bootstrap.bootstrap()).resolves.toBeNull();
  });
});

describe("isProtectedPath", () => {
  it("matches the pages that need a session, with their subpaths", () => {
    for (const path of [
      "/me",
      "/me/security",
      "/mod",
      "/mod/bafyrei",
      "/submit",
      "/submit/new-version/x",
      "/consent/bafyrei",
      "/onboarding",
      "/onboarding/orcid",
      "/review/abc",
    ]) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  it("leaves public reads alone", () => {
    for (const path of [
      "/",
      "/search",
      "/p/abc",
      "/u/did:key:z6Mk",
      "/signin",
      "/recover",
      "/policies",
      null,
    ]) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });

  it("does not treat a path that merely starts with a prefix as protected", () => {
    expect(isProtectedPath("/menu")).toBe(false);
    expect(isProtectedPath("/moderation")).toBe(false);
  });
});
