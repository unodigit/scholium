// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DeviceKeyManager, type UnlockDeviceKeyOptions } from "./device-key";
import { MemoryDeviceKeyStorage } from "./device-key-storage";
import { ed25519PublicKeyFromDidKey } from "./did-key";
import { bytesEqual, fromBase64Url, toBase64Url, toHex, utf8Encode } from "./encoding";
import {
  DeviceKeyError,
  PasskeyCancelledError,
  RecordSigningError,
} from "./errors";
import type {
  PasskeyAssertionOptions,
  PasskeyAssertionResult,
  PasskeyProvider,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResult,
} from "./passkey";
import {
  RECORD_ENVELOPE_VERSION,
  SIGN_AND_SUBMIT_REASON,
  signRecord,
  type RecordCid,
  type RecordSigner,
} from "./sign-record";

class FakePasskeys implements PasskeyProvider {
  readonly assertions: PasskeyAssertionOptions[] = [];
  assertError: unknown = null;
  assertionOverrides: Partial<PasskeyAssertionResult> = {};

  isSupported(): boolean {
    return true;
  }

  async register(
    _options: PasskeyRegistrationOptions,
  ): Promise<PasskeyRegistrationResult> {
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
      ...this.assertionOverrides,
    };
  }
}

const CONTENT_FIELDS = [
  "v",
  "type",
  "author",
  "created",
  "prev",
  "body",
  "proofs",
] as const;

/** Deterministic stand-in for verify-core: hashes the seven content fields. */
function createCidSpy() {
  const calls: Array<Record<string, unknown>> = [];
  const computeRecordCid = (envelope: unknown): RecordCid => {
    const env = envelope as Record<string, unknown>;
    calls.push(env);
    const canonical = JSON.stringify(CONTENT_FIELDS.map((field) => env[field]));
    const bytes = new Uint8Array(
      createHash("sha256").update(canonical).digest(),
    );
    return { bytes, toString: () => `bafystub${toHex(bytes).slice(0, 16)}` };
  };
  return { calls, computeRecordCid };
}

const NOW = Date.UTC(2026, 10, 14, 5, 33, 0, 789);

async function createHarness() {
  const passkeys = new FakePasskeys();
  const manager = new DeviceKeyManager({
    storage: new MemoryDeviceKeyStorage(),
    passkeys,
    rpId: "scholium.test",
  });
  await manager.create({ userName: "mei@example.edu" });
  return { manager, passkeys, cid: createCidSpy() };
}

describe("signRecord envelope", () => {
  it("returns a complete signed envelope authored by the device key", async () => {
    const { manager, cid } = await createHarness();

    const record = await signRecord(
      "paper.version",
      { title: "A Minimal Scholium Paper" },
      "bafyprevious",
      { signer: manager, now: () => NOW, computeRecordCid: cid.computeRecordCid },
    );

    expect(record).toEqual({
      v: RECORD_ENVELOPE_VERSION,
      type: "paper.version",
      id: expect.stringMatching(/^bafystub[0-9a-f]{16}$/),
      author: await manager.didKey(),
      created: "2026-11-14T05:33:00Z",
      prev: "bafyprevious",
      body: { title: "A Minimal Scholium Paper" },
      proofs: [],
      sig: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
    });
    expect(record.author).toMatch(/^did:key:z6Mk/);
  });

  it("accepts null prev to start a chain and attaches proofs when given", async () => {
    const { manager, cid } = await createHarness();

    const record = await signRecord("paper.genesis", { seed: "s" }, null, {
      signer: manager,
      proofs: [{ credential: "orcid" }],
      computeRecordCid: cid.computeRecordCid,
    });

    expect(record.prev).toBeNull();
    expect(record.proofs).toEqual([{ credential: "orcid" }]);
    expect(cid.calls[0].proofs).toEqual([{ credential: "orcid" }]);
  });

  it("hands the record id function exactly the seven content fields", async () => {
    const { manager, cid } = await createHarness();

    await signRecord("manifest", { files: [] }, null, {
      signer: manager,
      now: () => NOW,
      computeRecordCid: cid.computeRecordCid,
    });

    expect(cid.calls).toHaveLength(1);
    expect(Object.keys(cid.calls[0])).toEqual([...CONTENT_FIELDS]);
  });

  it("supports synchronous and asynchronous record id functions", async () => {
    const { manager, cid } = await createHarness();

    const sync = await signRecord("t", {}, null, {
      signer: manager,
      computeRecordCid: cid.computeRecordCid,
    });
    const async_ = await signRecord("t", {}, null, {
      signer: manager,
      computeRecordCid: async (envelope) => cid.computeRecordCid(envelope),
    });

    expect(async_.id).toMatch(/^bafystub/);
    expect(sync.id).toMatch(/^bafystub/);
  });

  it("snapshots body and proofs so later mutation cannot desync id and signature", async () => {
    const { manager, cid } = await createHarness();
    const body = { title: "A", nested: { n: 1 } };
    const proofs = [{ p: 1 }];

    const record = await signRecord("t", body, null, {
      signer: manager,
      proofs,
      computeRecordCid: cid.computeRecordCid,
    });
    body.nested.n = 2;
    proofs[0].p = 2;

    expect(record.body).not.toBe(body);
    expect(record.body).toEqual({ title: "A", nested: { n: 1 } });
    expect(record.proofs).toEqual([{ p: 1 }]);
  });
});

describe("signRecord signature", () => {
  it("signs the binary CID, verifiable with the author's did:key", async () => {
    const { manager, cid } = await createHarness();

    const record = await signRecord("t", { a: 1 }, null, {
      signer: manager,
      computeRecordCid: cid.computeRecordCid,
    });

    const expectedCid = cid.computeRecordCid(cid.calls[0]);
    const signature = fromBase64Url(record.sig);
    expect(signature).toHaveLength(64);
    expect(await manager.verify(expectedCid.bytes, signature)).toBe(true);

    // The same key is what the author did:key names.
    expect(
      bytesEqual(
        ed25519PublicKeyFromDidKey(record.author),
        await manager.publicKey(),
      ),
    ).toBe(true);
  });

  it("does not sign the id string, only the binary CID", async () => {
    const { manager, cid } = await createHarness();

    const record = await signRecord("t", {}, null, {
      signer: manager,
      computeRecordCid: cid.computeRecordCid,
    });

    expect(
      await manager.verify(utf8Encode(record.id), fromBase64Url(record.sig)),
    ).toBe(false);
  });

  it("produces a different signature when any content field changes", async () => {
    const { manager, cid } = await createHarness();
    const options = { signer: manager, computeRecordCid: cid.computeRecordCid };

    const a = await signRecord("t", { n: 1 }, null, options);
    const b = await signRecord("t", { n: 2 }, null, options);
    const c = await signRecord("t", { n: 1 }, "bafyprev", options);

    expect(new Set([a.sig, b.sig, c.sig]).size).toBe(3);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});

describe("signRecord passkey prompt", () => {
  it("shows a Sign and submit prompt on every call, even while unlocked", async () => {
    const { manager, passkeys, cid } = await createHarness();
    expect(manager.isUnlocked()).toBe(true); // create() unlocked it
    const calls: Array<{ data: Uint8Array; options?: UnlockDeviceKeyOptions }> = [];
    const signer: RecordSigner = {
      didKey: () => manager.didKey(),
      signWithPasskey: (data, options) => {
        calls.push({ data, options });
        return manager.signWithPasskey(data, options);
      },
    };
    const options = { signer, computeRecordCid: cid.computeRecordCid };

    await signRecord("t", {}, null, options);
    expect(passkeys.assertions).toHaveLength(1);
    await signRecord("t", {}, null, options);
    expect(passkeys.assertions).toHaveLength(2);

    expect(calls).toHaveLength(2);
    expect(calls[0].options?.reason).toBe(SIGN_AND_SUBMIT_REASON);
    expect(SIGN_AND_SUBMIT_REASON).toBe("Sign and submit");
  });

  it("forwards a custom reason and timeout to the prompt", async () => {
    const { manager, cid } = await createHarness();
    let seen: UnlockDeviceKeyOptions | undefined;
    const signer: RecordSigner = {
      didKey: () => manager.didKey(),
      signWithPasskey: (data, options) => {
        seen = options;
        return manager.signWithPasskey(data, options);
      },
    };

    await signRecord("t", {}, null, {
      signer,
      reason: "Publish paper",
      timeoutMs: 15_000,
      computeRecordCid: cid.computeRecordCid,
    });

    expect(seen).toEqual({ reason: "Publish paper", timeoutMs: 15_000 });
  });

  it("computes the id before prompting and signs exactly those bytes", async () => {
    const { manager, cid } = await createHarness();
    const order: string[] = [];
    let signed: Uint8Array | undefined;
    const signer: RecordSigner = {
      didKey: () => manager.didKey(),
      signWithPasskey: (data, options) => {
        order.push("prompt");
        signed = data;
        return manager.signWithPasskey(data, options);
      },
    };

    await signRecord("t", {}, null, {
      signer,
      computeRecordCid: (envelope) => {
        order.push("cid");
        return cid.computeRecordCid(envelope);
      },
    });

    expect(order).toEqual(["cid", "prompt"]);
    expect(bytesEqual(signed!, cid.computeRecordCid(cid.calls[0]).bytes)).toBe(true);
  });
});

describe("signRecord failures", () => {
  it("raises passkey-cancelled when the prompt is dismissed and returns nothing", async () => {
    const { manager, passkeys, cid } = await createHarness();
    passkeys.assertError = Object.assign(new Error("dismissed"), {
      name: "NotAllowedError",
    });

    const result = signRecord("t", {}, null, {
      signer: manager,
      computeRecordCid: cid.computeRecordCid,
    });

    await expect(result).rejects.toBeInstanceOf(PasskeyCancelledError);
    await expect(result).rejects.toMatchObject({ code: "passkey-cancelled" });
  });

  it("raises passkey-failed when the passkey did not verify the user", async () => {
    const { manager, passkeys, cid } = await createHarness();
    passkeys.assertionOverrides = { userVerified: false };

    await expect(
      signRecord("t", {}, null, {
        signer: manager,
        computeRecordCid: cid.computeRecordCid,
      }),
    ).rejects.toMatchObject({ name: "DeviceKeyError", code: "passkey-failed" });
  });

  it("wraps an unexpected signer failure as signing-failed with its cause", async () => {
    const { manager, cid } = await createHarness();
    const cause = new Error("webcrypto exploded");
    const signer: RecordSigner = {
      didKey: () => manager.didKey(),
      signWithPasskey: async () => {
        throw cause;
      },
    };

    const error = await signRecord("t", {}, null, {
      signer,
      computeRecordCid: cid.computeRecordCid,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeviceKeyError);
    expect(error).toMatchObject({ code: "signing-failed", cause });
  });

  it("fails with not-found, without a prompt or an id, when no device key exists", async () => {
    const passkeys = new FakePasskeys();
    const manager = new DeviceKeyManager({
      storage: new MemoryDeviceKeyStorage(),
      passkeys,
      rpId: "scholium.test",
    });
    const cid = createCidSpy();

    await expect(
      signRecord("t", {}, null, {
        signer: manager,
        computeRecordCid: cid.computeRecordCid,
      }),
    ).rejects.toMatchObject({ code: "not-found" });

    expect(passkeys.assertions).toHaveLength(0);
    expect(cid.calls).toHaveLength(0);
  });

  it("rejects an invalid record before any passkey prompt", async () => {
    const { manager, passkeys } = await createHarness();
    const failure = new Error("body must be a mapping");

    const error = await signRecord("t", {}, null, {
      signer: manager,
      computeRecordCid: () => {
        throw failure;
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RecordSigningError);
    expect(error).toMatchObject({
      code: "invalid-record",
      cause: failure,
      message: "The record is not valid: body must be a mapping",
    });
    expect(passkeys.assertions).toHaveLength(0);
  });

  it("rejects an empty prev rather than silently starting a new chain", async () => {
    const { manager, passkeys, cid } = await createHarness();

    await expect(
      signRecord("t", {}, "", {
        signer: manager,
        computeRecordCid: cid.computeRecordCid,
      }),
    ).rejects.toMatchObject({ code: "invalid-record" });

    expect(cid.calls).toHaveLength(0);
    expect(passkeys.assertions).toHaveLength(0);
  });

  it("rejects a body that cannot be copied before any passkey prompt", async () => {
    const { manager, passkeys, cid } = await createHarness();

    await expect(
      signRecord("t", { notData: () => 1 }, null, {
        signer: manager,
        computeRecordCid: cid.computeRecordCid,
      }),
    ).rejects.toMatchObject({ code: "invalid-record" });

    expect(cid.calls).toHaveLength(0);
    expect(passkeys.assertions).toHaveLength(0);
  });
});

describe("signRecord defaults", () => {
  it("uses the app-wide device key when no signer is given", async () => {
    // In Node there is no IndexedDB, so the default `deviceKey` cannot load.
    // Reaching that error proves the default signer was consulted first.
    const cid = createCidSpy();

    await expect(
      signRecord("t", {}, null, { computeRecordCid: cid.computeRecordCid }),
    ).rejects.toMatchObject({ code: "storage-unavailable" });
    expect(cid.calls).toHaveLength(0);
  });
});
