// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DEFAULT_UNLOCK_TTL_MS,
  DeviceKeyManager,
  createDeviceKeyManager,
  type DeviceKeyManagerOptions,
} from "./device-key";
import {
  DEVICE_KEY_RECORD_ID,
  DEVICE_KEY_RECORD_VERSION,
  MemoryDeviceKeyStorage,
  type DeviceKeyStorage,
  type StoredDeviceKey,
} from "./device-key-storage";
import { didKeyFromEd25519PublicKey } from "./did-key";
import { toBase64Url, utf8Encode } from "./encoding";
import { PasskeyCancelledError } from "./errors";
import type {
  PasskeyAssertionOptions,
  PasskeyAssertionResult,
  PasskeyProvider,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResult,
} from "./passkey";

class FakePasskeys implements PasskeyProvider {
  readonly registrations: PasskeyRegistrationOptions[] = [];
  readonly assertions: PasskeyAssertionOptions[] = [];

  credentialId = "credential-1";
  registerError: unknown = null;
  assertError: unknown = null;
  assertionOverrides: Partial<PasskeyAssertionResult> = {};
  supported = true;

  isSupported(): boolean {
    return this.supported;
  }

  async register(
    options: PasskeyRegistrationOptions,
  ): Promise<PasskeyRegistrationResult> {
    this.registrations.push(options);
    if (this.registerError) {
      throw this.registerError;
    }
    return { credentialId: this.credentialId, transports: ["internal"] };
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
      ...this.assertionOverrides,
    };
  }
}

interface Harness {
  manager: DeviceKeyManager;
  storage: MemoryDeviceKeyStorage;
  passkeys: FakePasskeys;
  clock: { now: number };
  options: DeviceKeyManagerOptions;
  newManager: (overrides?: Partial<DeviceKeyManagerOptions>) => DeviceKeyManager;
}

function createHarness(
  overrides: Partial<DeviceKeyManagerOptions> = {},
): Harness {
  const storage = new MemoryDeviceKeyStorage();
  const passkeys = new FakePasskeys();
  const clock = { now: 1_700_000_000_000 };
  let counter = 0;
  const randomBytes = (length: number): Uint8Array => {
    counter += 1;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = (counter * 31 + i * 7) & 0xff;
    }
    return bytes;
  };

  const options: DeviceKeyManagerOptions = {
    storage,
    passkeys,
    now: () => clock.now,
    randomBytes,
    unlockTtlMs: 60_000,
    rpId: "scholium.test",
    rpName: "Scholium Test",
    ...overrides,
  };

  return {
    manager: new DeviceKeyManager(options),
    storage,
    passkeys,
    clock,
    options,
    newManager: (managerOverrides = {}) =>
      new DeviceKeyManager({ ...options, ...managerOverrides }),
  };
}

const CREATE_OPTIONS = {
  userName: "mei@example.edu",
  userDisplayName: "Mei",
} as const;

const PAYLOAD = utf8Encode("nonce: 7d3f0a");

describe("device key creation", () => {
  it("generates a non-extractable key, registers a passkey and persists both", async () => {
    const harness = createHarness();

    const summary = await harness.manager.create(CREATE_OPTIONS);

    expect(summary).toMatchObject({
      algorithm: "Ed25519",
      credentialId: "credential-1",
      createdAt: harness.clock.now,
      unlocked: true,
      rpId: "scholium.test",
    });
    expect(summary.unlockedUntil).toBe(
      harness.clock.now + harness.options.unlockTtlMs!,
    );

    expect(harness.passkeys.registrations).toHaveLength(1);
    const registration = harness.passkeys.registrations[0];
    expect(registration.rpId).toBe("scholium.test");
    expect(registration.rpName).toBe("Scholium Test");
    expect(registration.userName).toBe("mei@example.edu");
    expect(registration.userDisplayName).toBe("Mei");
    expect(registration.userId).toHaveLength(32);
    expect(registration.challenge).toHaveLength(32);

    const stored = await harness.storage.get();
    expect(stored).not.toBeNull();
    expect(stored?.privateKey.extractable).toBe(false);
    expect(stored?.publicKey.extractable).toBe(true);
    expect(stored?.credentialId).toBe("credential-1");
    expect(stored?.userId).toBe(toBase64Url(registration.userId));
    expect(stored?.rpId).toBe("scholium.test");
  });

  it("keeps the private key non-exportable after persistence", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    const stored = (await harness.storage.get()) as StoredDeviceKey;

    await expect(
      globalThis.crypto.subtle.exportKey("pkcs8", stored.privateKey),
    ).rejects.toBeDefined();
    await expect(
      globalThis.crypto.subtle.exportKey("raw", stored.publicKey),
    ).resolves.toBeDefined();
  });

  it("refuses to silently replace an existing key", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    await expect(
      harness.manager.create(CREATE_OPTIONS),
    ).rejects.toMatchObject({ code: "already-exists" });
    expect(harness.passkeys.registrations).toHaveLength(1);
  });

  it("replaces an existing key when forced", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    harness.passkeys.credentialId = "credential-2";
    const summary = await harness.manager.create({
      ...CREATE_OPTIONS,
      force: true,
    });

    expect(summary.credentialId).toBe("credential-2");
    expect(harness.passkeys.registrations).toHaveLength(2);
    expect((await harness.storage.get())?.credentialId).toBe("credential-2");
  });

  it("keeps the existing key when a forced replacement is cancelled", async () => {
    const harness = createHarness();
    const original = await harness.manager.create(CREATE_OPTIONS);
    harness.passkeys.registerError = new PasskeyCancelledError();

    await expect(
      harness.manager.create({ ...CREATE_OPTIONS, force: true }),
    ).rejects.toMatchObject({ code: "passkey-cancelled" });

    const stored = await harness.storage.get();
    expect(stored?.credentialId).toBe(original.credentialId);
    expect(stored?.createdAt).toBe(original.createdAt);
    expect(await harness.manager.credentialId()).toBe(original.credentialId);
  });

  it("can create locked for callers that want an explicit unlock", async () => {
    const harness = createHarness();
    const summary = await harness.manager.create({
      ...CREATE_OPTIONS,
      skipUnlock: true,
    });

    expect(summary.unlocked).toBe(false);
    expect(harness.manager.isUnlocked()).toBe(false);
    await expect(harness.manager.sign(PAYLOAD)).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("requires a user name", async () => {
    const harness = createHarness();
    await expect(
      harness.manager.create({ userName: "  " }),
    ).rejects.toMatchObject({ code: "invalid-key" });
    expect(harness.passkeys.registrations).toHaveLength(0);
  });
});

describe("loading a persisted key", () => {
  it("restores the key without prompting and stays locked", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    const second = harness.newManager();
    const summary = await second.load();

    expect(summary?.credentialId).toBe("credential-1");
    expect(summary?.unlocked).toBe(false);
    expect(summary?.createdAt).toBe(harness.clock.now);
    expect(harness.passkeys.assertions).toHaveLength(0);
    await expect(second.sign(PAYLOAD)).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("returns null when no key exists", async () => {
    const harness = createHarness();
    expect(await harness.manager.load()).toBeNull();
    expect(await harness.manager.exists()).toBe(false);
  });

  it("refuses a stored private key that is extractable", async () => {
    const pair = (await globalThis.crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const unsafeRecord: StoredDeviceKey = {
      id: DEVICE_KEY_RECORD_ID,
      version: DEVICE_KEY_RECORD_VERSION,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      credentialId: "credential-1",
      userId: "user",
      createdAt: 1,
      rpId: "scholium.test",
    };

    const unsafeStorage: DeviceKeyStorage = {
      kind: "memory",
      isAvailable: () => true,
      get: async () => unsafeRecord,
      put: async () => undefined,
      delete: async () => undefined,
    };

    const harness = createHarness({ storage: unsafeStorage });
    await expect(harness.manager.load()).rejects.toMatchObject({
      code: "invalid-key",
    });
  });
});

describe("unlocking with a passkey", () => {
  it("prompts for the stored credential and then signs", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });

    const summary = await harness.manager.unlock();

    expect(summary.unlocked).toBe(true);
    expect(harness.passkeys.assertions).toHaveLength(1);
    const assertion = harness.passkeys.assertions[0];
    expect(assertion.credentialId).toBe("credential-1");
    expect(assertion.rpId).toBe("scholium.test");
    expect(assertion.challenge).toHaveLength(32);

    const signature = await harness.manager.sign(PAYLOAD);
    expect(signature).toHaveLength(64);
    await expect(harness.manager.verify(PAYLOAD, signature)).resolves.toBe(true);
  });

  it("supports unlock-and-sign in one call", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });

    const signature = await harness.manager.signWithPasskey(PAYLOAD);

    expect(harness.passkeys.assertions).toHaveLength(1);
    await expect(harness.manager.verify(PAYLOAD, signature)).resolves.toBe(true);
  });

  it("rejects a mismatched credential and stays locked", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });
    harness.passkeys.assertionOverrides = { credentialId: "other-passkey" };

    await expect(harness.manager.unlock()).rejects.toMatchObject({
      code: "passkey-failed",
    });
    expect(harness.manager.isUnlocked()).toBe(false);
  });

  it("rejects a mismatched challenge", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });
    harness.passkeys.assertionOverrides = { challenge: "AAAA" };

    await expect(harness.manager.unlock()).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("requires user verification, not just presence", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });
    harness.passkeys.assertionOverrides = { userVerified: false };

    await expect(harness.manager.unlock()).rejects.toMatchObject({
      code: "passkey-failed",
    });
    expect(harness.manager.isUnlocked()).toBe(false);
  });

  it("requires user presence", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });
    harness.passkeys.assertionOverrides = { userPresent: false };

    await expect(harness.manager.unlock()).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("propagates a dismissed passkey prompt as passkey-cancelled", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });
    harness.passkeys.assertError = new PasskeyCancelledError();

    await expect(harness.manager.unlock()).rejects.toMatchObject({
      code: "passkey-cancelled",
    });
    expect(harness.manager.isUnlocked()).toBe(false);
  });

  it("fails with not-found when no key exists", async () => {
    const harness = createHarness();
    await expect(harness.manager.unlock()).rejects.toMatchObject({
      code: "not-found",
    });
    expect(harness.passkeys.assertions).toHaveLength(0);
  });

  it("locks again when the unlock TTL elapses", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    expect(harness.manager.isUnlocked()).toBe(true);

    harness.clock.now += DEFAULT_UNLOCK_TTL_MS + 1;

    expect(harness.manager.isUnlocked()).toBe(false);
    expect(harness.manager.summary()?.unlocked).toBe(false);
    await expect(harness.manager.sign(PAYLOAD)).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("locks immediately on request", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    harness.manager.lock();

    expect(harness.manager.isUnlocked()).toBe(false);
    await expect(harness.manager.sign(PAYLOAD)).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("can sign without unlocking only when explicitly allowed", async () => {
    const harness = createHarness();
    await harness.manager.create({ ...CREATE_OPTIONS, skipUnlock: true });

    const signature = await harness.manager.sign(PAYLOAD, {
      requireUnlock: false,
    });
    await expect(harness.manager.verify(PAYLOAD, signature)).resolves.toBe(true);
  });
});

describe("public identity", () => {
  it("derives a did:key from the stored public key", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    const publicKey = await harness.manager.publicKey();
    const did = await harness.manager.didKey();

    expect(publicKey).toHaveLength(32);
    expect(did).toBe(didKeyFromEd25519PublicKey(publicKey));
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
    expect(await harness.manager.credentialId()).toBe("credential-1");
  });

  it("verifies signatures and rejects tampering", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    const signature = await harness.manager.sign(PAYLOAD);

    await expect(harness.manager.verify(PAYLOAD, signature)).resolves.toBe(true);
    const tampered = Uint8Array.from(PAYLOAD);
    tampered[0] ^= 0xff;
    await expect(
      harness.manager.verify(tampered, signature),
    ).resolves.toBe(false);
  });
});

describe("account DID", () => {
  const ACCOUNT_DID = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";

  it("is the key's own did:key when the key creates the account, stored beside the key", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    const own = await harness.manager.didKey();

    expect(await harness.manager.accountDid()).toBe(own);
    expect((await harness.storage.get())?.accountDid).toBe(own);
  });

  it("is null for a key stored before devices recorded it", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    const record = (await harness.storage.get()) as StoredDeviceKey;
    const { accountDid: _accountDid, ...legacy } = record;
    await harness.storage.put(legacy);

    const reloaded = harness.newManager();

    expect(await reloaded.exists()).toBe(true);
    expect(await reloaded.accountDid()).toBeNull();
  });

  it("is null when there is no key", async () => {
    const harness = createHarness();

    expect(await harness.manager.accountDid()).toBeNull();
  });

  it("can be pointed at another account, and a new manager on the same storage sees it", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    const own = await harness.manager.didKey();

    await harness.manager.setAccountDid(ACCOUNT_DID);

    expect(await harness.manager.accountDid()).toBe(ACCOUNT_DID);
    expect(await harness.newManager().accountDid()).toBe(ACCOUNT_DID);
    // The key itself is untouched: it still signs, and its own did:key is unchanged.
    expect(await harness.manager.didKey()).toBe(own);
    expect((await harness.storage.get())?.credentialId).toBe("credential-1");
    await expect(harness.manager.sign(PAYLOAD)).resolves.toHaveLength(64);
  });

  it("refuses something that is not an Ed25519 did:key, and keeps the stored one", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    const own = await harness.manager.didKey();

    await expect(harness.manager.setAccountDid("not-a-did")).rejects.toMatchObject({
      code: "invalid-key",
    });

    expect(await harness.manager.accountDid()).toBe(own);
  });

  it("cannot be set without a key", async () => {
    const harness = createHarness();

    await expect(harness.manager.setAccountDid(ACCOUNT_DID)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("is forgotten with the key", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    await harness.manager.setAccountDid(ACCOUNT_DID);

    await harness.manager.reset();
    await harness.manager.create(CREATE_OPTIONS);

    expect(await harness.manager.accountDid()).toBe(await harness.manager.didKey());
  });

  it("is ignored when the stored value is not a did:key", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);
    const record = (await harness.storage.get()) as StoredDeviceKey;
    await harness.storage.put({ ...record, accountDid: "garbage" });

    // A damaged value must never make the key vanish: it just reads as absent.
    const reloaded = harness.newManager();
    expect(await reloaded.exists()).toBe(true);
    expect(await reloaded.accountDid()).toBeNull();
  });
});

describe("ensure and reset", () => {
  it("creates only when missing", async () => {
    const harness = createHarness();

    const created = await harness.manager.ensure(CREATE_OPTIONS);
    const again = await harness.manager.ensure(CREATE_OPTIONS);

    expect(harness.passkeys.registrations).toHaveLength(1);
    expect(again.credentialId).toBe(created.credentialId);
  });

  it("deletes the key, its storage record and the unlock", async () => {
    const harness = createHarness();
    await harness.manager.create(CREATE_OPTIONS);

    await harness.manager.reset();

    expect(await harness.manager.exists()).toBe(false);
    expect(await harness.storage.get()).toBeNull();
    expect(harness.manager.summary()).toBeNull();
    await expect(harness.manager.sign(PAYLOAD)).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("support reporting", () => {
  it("reports support when crypto, storage and passkeys are available", () => {
    const harness = createHarness();
    expect(harness.manager.isSupported()).toBe(true);
    expect(harness.manager.storageKind).toBe("memory");
  });

  it("reports no support when passkeys are missing", () => {
    const harness = createHarness();
    harness.passkeys.supported = false;
    expect(harness.manager.isSupported()).toBe(false);
  });

  it("uses a custom manager factory", () => {
    const harness = createHarness();
    const manager = createDeviceKeyManager(harness.options);
    expect(manager).toBeInstanceOf(DeviceKeyManager);
  });
});
