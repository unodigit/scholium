// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ApiError,
  MemoryTokenStorage,
  TokenStore,
  createApiClient,
  type FetchLike,
} from "../../lib/api";
import { DeviceKeyManager } from "./device-key";
import { MemoryDeviceKeyStorage, type StoredDeviceKey } from "./device-key-storage";
import { ed25519PublicKeyFromDidKey } from "./did-key";
import { fromBase64Url, toBase64Url, utf8Encode } from "./encoding";
import { DeviceKeyError, PasskeyCancelledError } from "./errors";
import type {
  PasskeyAssertionOptions,
  PasskeyAssertionResult,
  PasskeyProvider,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResult,
} from "./passkey";
import {
  DEFAULT_PASSKEY_USER_NAME,
  DEFAULT_SIGNIN_REDIRECT,
  NEW_ACCOUNT_STORAGE_KEY,
  SignInError,
  hasPendingNewAccount,
  parseChallenge,
  safeRedirectPath,
  signIn,
  signInDestination,
  type SignInStage,
} from "./signin";

class FakePasskeys implements PasskeyProvider {
  readonly registrations: PasskeyRegistrationOptions[] = [];
  readonly assertions: PasskeyAssertionOptions[] = [];
  registerError: unknown = null;
  assertError: unknown = null;

  isSupported(): boolean {
    return true;
  }

  async register(
    options: PasskeyRegistrationOptions,
  ): Promise<PasskeyRegistrationResult> {
    this.registrations.push(options);
    if (this.registerError) {
      throw this.registerError;
    }
    return { credentialId: "credential-1", transports: ["internal"] };
  }

  async assert(
    options: PasskeyAssertionOptions,
  ): Promise<PasskeyAssertionResult> {
    this.assertions.push(options);
    if (this.assertError) {
      throw this.assertError;
    }
    return {
      credentialId: options.credentialId,
      challenge: toBase64Url(options.challenge),
      userPresent: true,
      userVerified: true,
      signCount: this.assertions.length,
    };
  }
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

function problem(status: number, type: string): Response {
  return new Response(
    JSON.stringify({ type, title: "Problem", status, detail: "No." }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in for the identity API that checks signatures the way the real
 * one does: Ed25519 over the nonce's UTF-8 bytes, against the account's
 * *active* key (the did's own key until `activeKeys` says it moved), and
 * mapping a did:key that is some account's active key to that account.
 */
function createServer() {
  const requests: RecordedRequest[] = [];
  const nonces = new Map<string, string>();
  /** account did -> did:key of the key that now signs for it (after a rotation). */
  const activeKeys = new Map<string, string>();
  /** The account each completed sign-in landed in. */
  const signedInAs: string[] = [];
  let counter = 0;

  const accountFor = (did: string): string => {
    if (activeKeys.has(did)) {
      return did;
    }
    for (const [account, key] of activeKeys) {
      if (key === did) {
        return account;
      }
    }
    return did;
  };

  const hooks: {
    challenge?: (body: Record<string, unknown>) => Response | undefined;
    verify?: (body: Record<string, unknown>) => Response | undefined;
  } = {};

  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    });

    if (url.endsWith("/v1/auth/challenge")) {
      const override = hooks.challenge?.(body ?? {});
      if (override) {
        return override;
      }
      counter += 1;
      const nonce = `nonce-${counter}-q3V7_abc`;
      const account = accountFor(String(body?.did));
      nonces.set(nonce, account);
      return json({
        nonce,
        did: account,
        expires_at: "2026-11-15T09:35:12Z",
      });
    }

    if (url.endsWith("/v1/auth/verify")) {
      const override = hooks.verify?.(body ?? {});
      if (override) {
        return override;
      }
      const did = accountFor(String(body?.did));
      const nonce = String(body?.nonce);
      if (nonces.get(nonce) !== did) {
        return problem(401, "urn:scholium:problem:authentication-failed");
      }
      const publicKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(ed25519PublicKeyFromDidKey(activeKeys.get(did) ?? did)),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        fromBase64Url(String(body?.signature)),
        utf8Encode(nonce),
      );
      if (!valid) {
        return problem(401, "urn:scholium:problem:authentication-failed");
      }
      nonces.delete(nonce);
      signedInAs.push(did);
      return json({ access_token: "access-jwt", refresh_token: "refresh-raw" });
    }

    return new Response("not found", { status: 404 });
  };

  return { fetch, requests, hooks, activeKeys, signedInAs };
}

function createHarness() {
  const server = createServer();
  const passkeys = new FakePasskeys();
  const keyStorage = new MemoryDeviceKeyStorage();
  const browserStorage = new MemoryTokenStorage();
  const tokenStore = new TokenStore(new MemoryTokenStorage());
  const client = createApiClient({
    baseUrl: "http://api.test",
    fetch: server.fetch,
    tokenStore,
  });
  const newManager = () =>
    new DeviceKeyManager({ storage: keyStorage, passkeys, rpId: "scholium.test" });
  const deviceKey = newManager();
  const stages: SignInStage[] = [];

  const run = (options: Partial<Parameters<typeof signIn>[0]> = {}) =>
    signIn({
      deviceKey,
      client,
      tokenStore,
      storage: browserStorage,
      onProgress: (stage) => stages.push(stage),
      ...options,
    });

  return {
    server,
    passkeys,
    keyStorage,
    browserStorage,
    tokenStore,
    client,
    deviceKey,
    newManager,
    stages,
    run,
  };
}

describe("signIn: new account", () => {
  it("creates the key, signs the challenge nonce and goes to /onboarding", async () => {
    const h = createHarness();

    const result = await h.run();

    // A passkey was registered and none was asserted: registration is the prompt.
    expect(h.passkeys.registrations).toHaveLength(1);
    expect(h.passkeys.registrations[0]?.userName).toBe(DEFAULT_PASSKEY_USER_NAME);
    expect(h.passkeys.assertions).toHaveLength(0);

    const did = await h.deviceKey.didKey();
    expect(result).toMatchObject({
      did,
      isNewAccount: true,
      redirectTo: "/onboarding",
    });

    // POST /v1/auth/challenge {did}, then POST /v1/auth/verify, in that order,
    // both unauthenticated.
    expect(h.server.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /v1/auth/challenge",
      "POST /v1/auth/verify",
    ]);
    const [challenge, verify] = h.server.requests;
    expect(challenge?.body).toEqual({ did });
    expect(challenge?.headers.has("Authorization")).toBe(false);
    expect(verify?.headers.has("Authorization")).toBe(false);

    // The server accepted the signature, so it really is Ed25519 over the
    // nonce's UTF-8 bytes in unpadded base64url.
    expect(verify?.body).toMatchObject({ did, nonce: "nonce-1-q3V7_abc" });
    expect(String(verify?.body?.signature)).toMatch(/^[A-Za-z0-9_-]{86}$/);

    // The refresh token is an HttpOnly cookie; script never holds it.
    expect(h.tokenStore.get()).toMatchObject({ accessToken: "access-jwt" });
    expect(h.tokenStore.get()).not.toHaveProperty("refreshToken");
    expect(h.stages).toEqual(["creating-passkey", "requesting-challenge", "verifying"]);
  });

  it("goes to /onboarding even when a returning-user target was requested", async () => {
    const h = createHarness();
    const result = await h.run({ next: "/submit" });
    expect(result.redirectTo).toBe("/onboarding");
  });

  it("consumes the new-account marker once the sign-in completes", async () => {
    const h = createHarness();
    await h.run();
    expect(h.browserStorage.getItem(NEW_ACCOUNT_STORAGE_KEY)).toBeNull();

    // Next time on this device it is an ordinary returning sign-in.
    const again = await h.run();
    expect(again.isNewAccount).toBe(false);
  });

  it("calls nothing when the registration prompt is dismissed", async () => {
    const h = createHarness();
    h.passkeys.registerError = new PasskeyCancelledError();

    await expect(h.run()).rejects.toMatchObject({ code: "passkey-cancelled" });

    expect(h.server.requests).toHaveLength(0);
    expect(await h.deviceKey.exists()).toBe(false);
    expect(hasPendingNewAccount(h.browserStorage)).toBe(false);
    expect(h.tokenStore.get()).toBeNull();
  });

  it("still lands on /onboarding when the first attempt failed after the key was created", async () => {
    const h = createHarness();
    h.server.hooks.verify = () => problem(503, "about:blank");

    await expect(h.run()).rejects.toBeInstanceOf(ApiError);
    expect(await h.deviceKey.exists()).toBe(true);
    expect(hasPendingNewAccount(h.browserStorage)).toBe(true);
    expect(h.tokenStore.get()).toBeNull();

    // Retry: the key exists now, but the account was never completed.
    h.server.hooks.verify = undefined;
    const retry = await h.run({ next: "/submit" });

    expect(h.passkeys.registrations).toHaveLength(1);
    expect(h.passkeys.assertions).toHaveLength(1);
    expect(retry).toMatchObject({ isNewAccount: true, redirectTo: "/onboarding" });
    expect(hasPendingNewAccount(h.browserStorage)).toBe(false);
  });
});

describe("signIn: returning account", () => {
  async function returningHarness() {
    const h = createHarness();
    // An earlier session created the key; this one starts cold.
    await h.deviceKey.create({ userName: "mei@example.edu" });
    const fresh = h.newManager();
    return { ...h, fresh };
  }

  it("asks for the passkey, signs the nonce and goes to the feed", async () => {
    const h = await returningHarness();

    const result = await h.run({ deviceKey: h.fresh });

    expect(h.passkeys.registrations).toHaveLength(1); // from setup only
    expect(h.passkeys.assertions).toHaveLength(1);
    expect(result).toMatchObject({
      did: await h.fresh.didKey(),
      isNewAccount: false,
      redirectTo: "/papers",
    });
    expect(h.stages).toEqual(["requesting-challenge", "waiting-for-passkey", "verifying"]);
    expect(h.tokenStore.get()?.accessToken).toBe("access-jwt");
  });

  it("prompts for the passkey even if the key is still unlocked from earlier", async () => {
    const h = await returningHarness();
    expect(h.deviceKey.isUnlocked()).toBe(true);

    await h.run(); // same manager: unlocked by create() a moment ago

    expect(h.passkeys.assertions).toHaveLength(1);
  });

  it("follows a same-site next target", async () => {
    const h = await returningHarness();
    const result = await h.run({ deviceKey: h.fresh, next: "/p/k3f9-q2xz-7mwd?tab=proof" });
    expect(result.redirectTo).toBe("/p/k3f9-q2xz-7mwd?tab=proof");
  });

  it("ignores a next target that leaves the site", async () => {
    const h = await returningHarness();
    const result = await h.run({ deviceKey: h.fresh, next: "https://evil.example/" });
    expect(result.redirectTo).toBe("/papers");
  });

  it("signs nothing when the passkey prompt is dismissed", async () => {
    const h = await returningHarness();
    h.passkeys.assertError = new PasskeyCancelledError();

    await expect(h.run({ deviceKey: h.fresh })).rejects.toMatchObject({
      code: "passkey-cancelled",
    });

    expect(h.server.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1/auth/challenge",
    ]);
    expect(h.tokenStore.get()).toBeNull();
  });

  it("surfaces a rejected signature as a 401 and stores no tokens", async () => {
    const h = await returningHarness();
    h.server.hooks.verify = () =>
      problem(401, "urn:scholium:problem:authentication-failed");

    await expect(h.run({ deviceKey: h.fresh })).rejects.toMatchObject({ status: 401 });
    expect(h.tokenStore.get()).toBeNull();
  });
});

describe("signIn: after a key rotation or a recovery", () => {
  /** Install a replacement key on the device, as Rotate key or a recovery leaves it. */
  async function installReplacementKey(
    h: ReturnType<typeof createHarness>,
    accountDid: string | undefined,
  ): Promise<{ device: DeviceKeyManager; keyDid: string }> {
    const staging = new MemoryDeviceKeyStorage();
    const maker = new DeviceKeyManager({
      storage: staging,
      passkeys: h.passkeys,
      rpId: "scholium.test",
    });
    await maker.create({ userName: "mei@example.edu", skipUnlock: true });
    const record = (await staging.get()) as StoredDeviceKey;
    const { accountDid: _own, ...bare } = record;
    await h.keyStorage.put(accountDid === undefined ? bare : { ...bare, accountDid });
    const device = h.newManager();
    return { device, keyDid: await maker.didKey() };
  }

  /** An account created by a first sign-in, whose key then moved to a new one. */
  async function rotatedAccount(accountDidStored: boolean) {
    const h = createHarness();
    const first = await h.run();
    const accountDid = first.did;
    const { device, keyDid } = await installReplacementKey(
      h,
      accountDidStored ? accountDid : undefined,
    );
    h.server.activeKeys.set(accountDid, keyDid);
    h.server.requests.length = 0;
    h.server.signedInAs.length = 0;
    h.browserStorage.removeItem(NEW_ACCOUNT_STORAGE_KEY);
    return { h, accountDid, keyDid, device };
  }

  it("signs in as the account the device stored, not as the key's own did:key", async () => {
    const { h, accountDid, keyDid, device } = await rotatedAccount(true);
    expect(keyDid).not.toBe(accountDid);

    const result = await h.run({ deviceKey: device });

    const [challenge, verify] = h.server.requests;
    expect(challenge.body).toEqual({ did: accountDid });
    expect(verify.body).toMatchObject({ did: accountDid });
    expect(h.server.signedInAs).toEqual([accountDid]);
    expect(result.did).toBe(accountDid);
    expect(result.isNewAccount).toBe(false);
    expect(result.redirectTo).toBe("/papers");
  });

  it("signs in as the same account every time, never as a new one", async () => {
    const { h, accountDid, device } = await rotatedAccount(true);

    await h.run({ deviceKey: device });
    const again = await h.run({ deviceKey: h.newManager() });

    expect(h.server.signedInAs).toEqual([accountDid, accountDid]);
    expect(again.did).toBe(accountDid);
    expect(again.isNewAccount).toBe(false);
  });

  it("follows the account the server names for a key rotated before devices stored it", async () => {
    const { h, accountDid, keyDid, device } = await rotatedAccount(false);

    const result = await h.run({ deviceKey: device });

    const [challenge, verify] = h.server.requests;
    // The device only knows its key's did:key; the server answers with the account.
    expect(challenge.body).toEqual({ did: keyDid });
    expect(verify.body).toMatchObject({ did: accountDid });
    expect(h.server.signedInAs).toEqual([accountDid]);
    expect(result.did).toBe(accountDid);
    expect(result.isNewAccount).toBe(false);
    expect(result.redirectTo).toBe("/papers");
  });

  it("remembers the account it was told about, so the next sign-in asks for it directly", async () => {
    const { h, accountDid, device } = await rotatedAccount(false);

    await h.run({ deviceKey: device });
    expect(await device.accountDid()).toBe(accountDid);
    expect(await h.newManager().accountDid()).toBe(accountDid);

    h.server.requests.length = 0;
    await h.run({ deviceKey: h.newManager() });
    expect(h.server.requests[0].body).toEqual({ did: accountDid });
  });

  it("still signs in when the account cannot be remembered", async () => {
    const { h, accountDid, device } = await rotatedAccount(false);
    const failing = {
      load: () => device.load(),
      create: device.create.bind(device),
      didKey: () => device.didKey(),
      accountDid: () => device.accountDid(),
      setAccountDid: async () => {
        throw new DeviceKeyError("storage-unavailable", "blocked");
      },
      sign: device.sign.bind(device),
      signWithPasskey: device.signWithPasskey.bind(device),
      isSupported: () => true,
    };

    const result = await h.run({ deviceKey: failing });

    expect(result.did).toBe(accountDid);
  });

  it("refuses a challenge for another account when the device knows its account", async () => {
    const { h, device } = await rotatedAccount(true);
    const other = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";
    h.server.hooks.challenge = () => json({ nonce: "n", did: other, expires_at: "x" });

    await expect(h.run({ deviceKey: device })).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(h.passkeys.assertions).toHaveLength(0);
  });

  it("refuses a challenge naming something that is not a did:key, even without a stored account", async () => {
    const { h, device } = await rotatedAccount(false);
    h.server.hooks.challenge = () => json({ nonce: "n", did: "someone", expires_at: "x" });

    await expect(h.run({ deviceKey: device })).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(h.passkeys.assertions).toHaveLength(0);
  });

  it("is unchanged for a key that was never rotated: its own did:key, onboarding on first sign-in", async () => {
    const h = createHarness();

    const first = await h.run();
    const own = await h.deviceKey.didKey();
    const second = await h.run({ deviceKey: h.newManager() });

    expect(first.did).toBe(own);
    expect(first.isNewAccount).toBe(true);
    expect(second.did).toBe(own);
    expect(second.isNewAccount).toBe(false);
    expect(h.server.requests.map((request) => request.body?.did)).toEqual([own, own, own, own]);
    expect(await h.deviceKey.accountDid()).toBe(own);
  });

  it("does not store anything for a legacy key whose account is its own did:key", async () => {
    const h = createHarness();
    await h.deviceKey.create({ userName: "mei@example.edu" });
    const own = await h.deviceKey.didKey();
    const record = (await h.keyStorage.get()) as StoredDeviceKey;
    const { accountDid: _own, ...legacy } = record;
    await h.keyStorage.put(legacy);

    const result = await h.run({ deviceKey: h.newManager() });

    expect(result.did).toBe(own);
    expect((await h.keyStorage.get())?.accountDid).toBeUndefined();
  });
});

describe("signIn: bad server replies", () => {
  it("stops at a challenge rejection without asking for a signature", async () => {
    const h = createHarness();
    await h.deviceKey.create({ userName: "mei@example.edu" });
    const fresh = h.newManager();
    h.server.hooks.challenge = () => problem(422, "urn:scholium:problem:invalid-did");

    await expect(h.run({ deviceKey: fresh })).rejects.toMatchObject({ status: 422 });

    expect(h.passkeys.assertions).toHaveLength(0);
    expect(h.server.requests).toHaveLength(1);
  });

  it("rejects a challenge response with no nonce before any prompt", async () => {
    const h = createHarness();
    await h.deviceKey.create({ userName: "mei@example.edu" });
    const fresh = h.newManager();
    h.server.hooks.challenge = () => json({ did: "whatever" });

    await expect(h.run({ deviceKey: fresh })).rejects.toBeInstanceOf(SignInError);
    expect(h.passkeys.assertions).toHaveLength(0);
  });

  it("rejects a challenge issued to a different did before any prompt", async () => {
    const h = createHarness();
    await h.deviceKey.create({ userName: "mei@example.edu" });
    const fresh = h.newManager();
    h.server.hooks.challenge = () =>
      json({ nonce: "n", did: "did:key:z6MkSomeoneElse", expires_at: "x" });

    await expect(h.run({ deviceKey: fresh })).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(h.passkeys.assertions).toHaveLength(0);
  });

  it("accepts a verify response whose only token is the access token", async () => {
    // The refresh token is delivered as an HttpOnly cookie, not in the body;
    // the body carries the access token and its lifetime.
    const h = createHarness();
    h.server.hooks.verify = () =>
      json({ access_token: "only-access", expires_in: 900 });

    const result = await h.run();

    expect(result.tokens.accessToken).toBe("only-access");
    expect(h.tokenStore.get()).toMatchObject({ accessToken: "only-access" });
    expect(h.tokenStore.get()).not.toHaveProperty("refreshToken");
  });

  it("rejects a verify response with no access token", async () => {
    const h = createHarness();
    h.server.hooks.verify = () => json({ expires_in: 900 });

    await expect(h.run()).rejects.toMatchObject({ code: "invalid-response" });
    expect(h.tokenStore.get()).toBeNull();
    // Not completed, so the account is still pending.
    expect(hasPendingNewAccount(h.browserStorage)).toBe(true);
  });

  it("does not let a throwing progress listener abort the sign-in", async () => {
    const h = createHarness();
    const result = await h.run({
      onProgress: () => {
        throw new Error("listener bug");
      },
    });
    expect(result.redirectTo).toBe("/onboarding");
  });

  it("passes device-key failures through untouched", async () => {
    const h = createHarness();
    h.passkeys.registerError = new DeviceKeyError("unsupported", "no webauthn");
    await expect(h.run()).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("parseChallenge", () => {
  const did = "did:key:z6MkExample";

  it("accepts the API's challenge shape", () => {
    expect(
      parseChallenge({ nonce: "abc", did, expires_at: "2026-11-15T09:35:12Z" }, did),
    ).toEqual({ nonce: "abc", did, expires_at: "2026-11-15T09:35:12Z" });
  });

  it.each([null, undefined, "nonce", [], {}, { nonce: "" }, { nonce: 7 }])(
    "refuses %j",
    (payload) => {
      expect(() => parseChallenge(payload, did)).toThrow(SignInError);
    },
  );
});

describe("safeRedirectPath", () => {
  it.each([
    ["/", "/"],
    ["/submit", "/submit"],
    ["/p/abc/v2?tab=proof#cite", "/p/abc/v2?tab=proof#cite"],
    ["/c/cs.AI", "/c/cs.AI"],
    ["/me/security", "/me/security"],
  ])("keeps the site path %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "",
    "submit",
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "/ok\nSet-Cookie: a=b",
    "/signin",
    "/signin?next=/submit",
    "/signin/",
  ])("refuses %j", (input) => {
    expect(safeRedirectPath(input as string | null | undefined)).toBeNull();
  });
});

describe("signInDestination", () => {
  it("sends a returning user with no target to the feed, not the marketing homepage", () => {
    expect(DEFAULT_SIGNIN_REDIRECT).toBe("/papers");
  });

  it("always sends a new account to onboarding", () => {
    expect(signInDestination(true, "/submit")).toBe("/onboarding");
  });

  it("sends a returning user to next, or the feed", () => {
    expect(signInDestination(false, "/submit")).toBe("/submit");
    expect(signInDestination(false, "//evil.example")).toBe("/papers");
    expect(signInDestination(false)).toBe("/papers");
  });
});
