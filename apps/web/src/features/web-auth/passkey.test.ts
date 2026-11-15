// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { toBase64Url, utf8Encode } from "./encoding";
import { DeviceKeyError, PasskeyCancelledError } from "./errors";
import {
  BrowserPasskeyProvider,
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  createBrowserPasskeyProvider,
  isBrowserPasskeySupported,
  type CredentialsContainerLike,
  type PasskeyAssertionOptions,
  type PasskeyRegistrationOptions,
} from "./passkey";

const CREDENTIAL_ID = Uint8Array.of(1, 2, 3, 4, 5, 6);
const CHALLENGE = Uint8Array.of(10, 20, 30, 40);
const ORIGIN = "https://scholium.test";

interface CredentialShape {
  credentialId?: Uint8Array;
  challenge?: Uint8Array;
  clientType?: string;
  origin?: string;
  flags?: number;
  signCount?: number;
  authenticatorData?: Uint8Array;
  rawClientData?: string;
  type?: string;
}

function authenticatorData(options: CredentialShape = {}): Uint8Array {
  const bytes = new Uint8Array(37);
  bytes.set(new Uint8Array(32).fill(7), 0); // rpIdHash
  bytes[32] = options.flags ?? 0x05; // user present | user verified
  const count = options.signCount ?? 1;
  bytes[33] = (count >>> 24) & 0xff;
  bytes[34] = (count >>> 16) & 0xff;
  bytes[35] = (count >>> 8) & 0xff;
  bytes[36] = count & 0xff;
  return bytes;
}

function clientDataJson(options: CredentialShape = {}): ArrayBuffer {
  const text =
    options.rawClientData ??
    JSON.stringify({
      type: options.clientType ?? "webauthn.get",
      challenge: toBase64Url(options.challenge ?? CHALLENGE),
      origin: options.origin ?? ORIGIN,
    });
  return utf8Encode(text).buffer;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function assertionCredential(options: CredentialShape = {}): Credential {
  const id = options.credentialId ?? CREDENTIAL_ID;
  const data = options.authenticatorData ?? authenticatorData(options);
  return {
    id: toBase64Url(id),
    type: options.type ?? "public-key",
    rawId: asArrayBuffer(id),
    response: {
      clientDataJSON: clientDataJson(options),
      authenticatorData: asArrayBuffer(data),
      signature: new ArrayBuffer(64),
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  } as unknown as Credential;
}

function registrationCredential(options: CredentialShape = {}): Credential {
  const id = options.credentialId ?? CREDENTIAL_ID;
  return {
    id: toBase64Url(id),
    type: "public-key",
    rawId: asArrayBuffer(id),
    response: {
      clientDataJSON: clientDataJson({
        clientType: "webauthn.create",
        ...options,
      }),
      attestationObject: new ArrayBuffer(8),
      getTransports: () => ["internal", "hybrid"],
    },
    getClientExtensionResults: () => ({}),
  } as unknown as Credential;
}

function container(overrides: Partial<CredentialsContainerLike> = {}): CredentialsContainerLike {
  return {
    create: async () => registrationCredential(),
    get: async () => assertionCredential(),
    ...overrides,
  };
}

const REGISTRATION: PasskeyRegistrationOptions = {
  rpId: "scholium.test",
  rpName: "Scholium",
  userId: Uint8Array.of(42, 43, 44),
  userName: "mei@example.edu",
  userDisplayName: "Mei",
  challenge: CHALLENGE,
  timeoutMs: 1_000,
};

const ASSERTION: PasskeyAssertionOptions = {
  rpId: "scholium.test",
  credentialId: toBase64Url(CREDENTIAL_ID),
  challenge: CHALLENGE,
  timeoutMs: 1_000,
  expectedOrigin: ORIGIN,
};

describe("support detection", () => {
  it("is false in a runtime without navigator.credentials", () => {
    expect(isBrowserPasskeySupported()).toBe(false);
    const provider = new BrowserPasskeyProvider();
    expect(provider.isSupported()).toBe(false);
  });

  it("trusts an injected credentials container", () => {
    expect(isBrowserPasskeySupported(container())).toBe(true);
    expect(createBrowserPasskeyProvider({ credentials: container() }).isSupported()).toBe(true);
  });

  it("fails typed when used without credentials", async () => {
    const provider = new BrowserPasskeyProvider();
    await expect(provider.register(REGISTRATION)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});

describe("registration", () => {
  it("asks for a resident, user-verified Ed25519-capable passkey", async () => {
    const create = vi.fn(
      async (_options: CredentialCreationOptions) => registrationCredential(),
    );
    const provider = createBrowserPasskeyProvider({ credentials: container({ create }) });

    const result = await provider.register(REGISTRATION);

    expect(result.credentialId).toBe(toBase64Url(CREDENTIAL_ID));
    expect(result.transports).toEqual(["internal", "hybrid"]);
    expect(create).toHaveBeenCalledTimes(1);

    const publicKey = create.mock.calls[0][0].publicKey as PublicKeyCredentialCreationOptions;
    expect(new Uint8Array(publicKey.challenge as ArrayBuffer)).toEqual(CHALLENGE);
    expect(publicKey.rp).toEqual({ id: "scholium.test", name: "Scholium" });
    expect(publicKey.user.name).toBe("mei@example.edu");
    expect(publicKey.user.displayName).toBe("Mei");
    expect([...(publicKey.user.id as Uint8Array)]).toEqual([42, 43, 44]);
    expect(publicKey.pubKeyCredParams).toEqual(
      expect.arrayContaining([
        { type: "public-key", alg: COSE_ALG_EDDSA },
        { type: "public-key", alg: COSE_ALG_ES256 },
      ]),
    );
    expect(publicKey.authenticatorSelection).toMatchObject({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(publicKey.attestation).toBe("none");
    expect(publicKey.timeout).toBe(1_000);
  });

  it("maps a dismissed prompt to passkey-cancelled", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({ create: async () => null }),
    });
    await expect(provider.register(REGISTRATION)).rejects.toBeInstanceOf(
      PasskeyCancelledError,
    );

    const notAllowed = new DOMException("user cancelled", "NotAllowedError");
    const cancelling = createBrowserPasskeyProvider({
      credentials: container({
        create: async () => {
          throw notAllowed;
        },
      }),
    });
    await expect(cancelling.register(REGISTRATION)).rejects.toMatchObject({
      code: "passkey-cancelled",
    });
  });

  it("maps other authenticator failures to passkey-failed", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        create: async () => {
          throw new TypeError("no authenticator");
        },
      }),
    });
    await expect(provider.register(REGISTRATION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects user handles outside 1–64 bytes", async () => {
    const create = vi.fn(
      async (_options: CredentialCreationOptions) => registrationCredential(),
    );
    const provider = createBrowserPasskeyProvider({ credentials: container({ create }) });
    await expect(
      provider.register({ ...REGISTRATION, userId: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: "invalid-key" });
    await expect(
      provider.register({ ...REGISTRATION, userId: new Uint8Array(65) }),
    ).rejects.toMatchObject({ code: "invalid-key" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a non-WebAuthn credential object", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        create: async () => ({ type: "password" } as unknown as Credential),
      }),
    });
    await expect(provider.register(REGISTRATION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects an empty credential id", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        create: async () =>
          registrationCredential({ credentialId: new Uint8Array(0) }),
      }),
    });
    await expect(provider.register(REGISTRATION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });
});

describe("assertion (unlock)", () => {
  it("requests the stored credential and validates the result", async () => {
    const get = vi.fn(
      async (_options: CredentialRequestOptions) =>
        assertionCredential({ signCount: 9 }),
    );
    const provider = createBrowserPasskeyProvider({ credentials: container({ get }) });

    const result = await provider.assert(ASSERTION);

    expect(result.credentialId).toBe(toBase64Url(CREDENTIAL_ID));
    expect(result.challenge).toBe(toBase64Url(CHALLENGE));
    expect(result.userPresent).toBe(true);
    expect(result.userVerified).toBe(true);
    expect(result.signCount).toBe(9);

    const publicKey = get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(new Uint8Array(publicKey.challenge as ArrayBuffer)).toEqual(CHALLENGE);
    expect(publicKey.rpId).toBe("scholium.test");
    expect(publicKey.userVerification).toBe("required");
    expect(publicKey.allowCredentials).toHaveLength(1);
    expect([...(publicKey.allowCredentials?.[0].id as Uint8Array)]).toEqual([
      ...CREDENTIAL_ID,
    ]);
  });

  it("reports user verification honestly", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ flags: 0x01 }),
      }),
    });
    const result = await provider.assert(ASSERTION);
    expect(result.userPresent).toBe(true);
    expect(result.userVerified).toBe(false);
  });

  it("rejects a response with no user presence", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ flags: 0x04 }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects the wrong credential", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ credentialId: Uint8Array.of(9) }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects a response to a different challenge", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () =>
          assertionCredential({ challenge: Uint8Array.of(1, 1, 1) }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects a registration response used as an assertion", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ clientType: "webauthn.create" }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects a response from another origin when one is expected", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ origin: "https://evil.test" }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects truncated authenticator data", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ authenticatorData: new Uint8Array(31) }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("rejects malformed client data", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => assertionCredential({ rawClientData: "not json" }),
      }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-failed",
    });
  });

  it("maps a dismissed unlock prompt to passkey-cancelled", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({ get: async () => null }),
    });
    await expect(provider.assert(ASSERTION)).rejects.toMatchObject({
      code: "passkey-cancelled",
    });
  });

  it("maps an authenticator exception to passkey-failed", async () => {
    const provider = createBrowserPasskeyProvider({
      credentials: container({
        get: async () => {
          throw new DOMException("bad origin", "SecurityError");
        },
      }),
    });
    const error = await provider.assert(ASSERTION).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeviceKeyError);
    expect((error as DeviceKeyError).code).toBe("passkey-failed");
  });
});
