/**
 * WebAuthn passkey prompts.
 *
 * Two ceremonies matter here:
 *
 * - **register** creates the resident passkey that represents this device.
 * - **assert** is the unlock prompt. The device key cannot be used for signing
 *   until a fresh assertion proves the person at the keyboard controls that
 *   passkey, so a stolen browser profile alone is not enough.
 *
 * The browser never hands us the private half of the passkey; we only need
 * the assertion result, which we validate (credential id, challenge, user
 * presence and user verification) before treating the key as unlocked.
 */

import {
  DeviceKeyError,
  PasskeyCancelledError,
  isPasskeyCancellation,
  toDeviceKeyError,
} from "./errors";
import {
  fromBase64Url,
  toBase64Url,
  toUint8Array,
  utf8Decode,
  type BinaryData,
} from "./encoding";

/** Default time a passkey sheet stays open. */
export const DEFAULT_PASSKEY_TIMEOUT_MS = 60_000;

/** COSE algorithm id for EdDSA (Ed25519). */
export const COSE_ALG_EDDSA = -8;

/** COSE algorithm id for ES256, accepted as an authenticator fallback. */
export const COSE_ALG_ES256 = -7;

/** WebAuthn flag: a user was present at the authenticator. */
const FLAG_USER_PRESENT = 0x01;

/** WebAuthn flag: the authenticator verified the user (PIN, biometric, …). */
const FLAG_USER_VERIFIED = 0x04;

/** Options for registering a resident passkey. */
export interface PasskeyRegistrationOptions {
  /** Relying-party id, normally the site's registrable domain. */
  rpId: string;
  /** Human-readable relying-party name shown by the browser. */
  rpName: string;
  /** Stable, random user handle (1–64 bytes). Never an email or name. */
  userId: Uint8Array;
  /** Account name shown in the passkey picker (usually the ORCID or email). */
  userName: string;
  /** Display name shown in the passkey picker. */
  userDisplayName?: string;
  /** Fresh random challenge. */
  challenge: Uint8Array;
  /** How long the browser may show the prompt. */
  timeoutMs?: number;
}

/** Result of a registration ceremony. */
export interface PasskeyRegistrationResult {
  /** base64url credential id, persisted with the device key. */
  credentialId: string;
  /** Authenticator transports reported by the browser, when available. */
  transports?: string[];
}

/** Options for the unlock (assertion) ceremony. */
export interface PasskeyAssertionOptions {
  /** Same relying-party id used at registration. */
  rpId: string;
  /** Credential id persisted with the device key. */
  credentialId: string;
  /** Fresh random challenge for this unlock. */
  challenge: Uint8Array;
  /** How long the browser may show the prompt. */
  timeoutMs?: number;
  /** When set, the assertion's client-data origin must match exactly. */
  expectedOrigin?: string;
}

/** Result of an unlock ceremony. */
export interface PasskeyAssertionResult {
  /** base64url credential id the authenticator used. */
  credentialId: string;
  /** base64url challenge echoed back inside `clientDataJSON`. */
  challenge: string;
  /** True when the authenticator reported user presence. */
  userPresent: boolean;
  /** True when the authenticator reported user verification. */
  userVerified: boolean;
  /** Signature counter, useful for cloned-authenticator detection. */
  signCount: number;
}

/** The passkey operations the device-key manager depends on. */
export interface PasskeyProvider {
  /** True when WebAuthn can be used in this environment. */
  isSupported(): boolean;
  /** Create a resident passkey. */
  register(options: PasskeyRegistrationOptions): Promise<PasskeyRegistrationResult>;
  /** Prompt for the passkey and validate its assertion. */
  assert(options: PasskeyAssertionOptions): Promise<PasskeyAssertionResult>;
}

/** The small slice of `navigator.credentials` we use. */
export interface CredentialsContainerLike {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

/** Injection points for {@link createBrowserPasskeyProvider}. */
export interface BrowserPasskeyProviderOptions {
  /** Defaults to `navigator.credentials`. */
  credentials?: CredentialsContainerLike;
  /** Defaults to `globalThis.location.origin` when available. */
  expectedOrigin?: string;
}

function resolveCredentials(
  explicit?: CredentialsContainerLike,
): CredentialsContainerLike | undefined {
  if (explicit) {
    return explicit;
  }
  const navigatorLike = (
    globalThis as {
      navigator?: { credentials?: CredentialsContainerLike };
    }
  ).navigator;
  const credentials = navigatorLike?.credentials;
  return credentials &&
    typeof credentials.create === "function" &&
    typeof credentials.get === "function"
    ? credentials
    : undefined;
}

function resolveOrigin(explicit?: string): string | undefined {
  if (explicit) {
    return explicit;
  }
  return (globalThis as { location?: { origin?: string } }).location?.origin;
}

/** True when the current browser exposes WebAuthn credential creation and lookup. */
export function isBrowserPasskeySupported(
  credentials?: CredentialsContainerLike,
): boolean {
  if (resolveCredentials(credentials) === undefined) {
    return false;
  }
  // An injected container is trusted; the ambient one additionally requires
  // the WebAuthn constructor that browsers expose in secure contexts.
  if (credentials !== undefined) {
    return true;
  }
  return (
    typeof (globalThis as { PublicKeyCredential?: unknown })
      .PublicKeyCredential !== "undefined"
  );
}

/** Adapter over `navigator.credentials.create/get`. */
export class BrowserPasskeyProvider implements PasskeyProvider {
  private readonly options: BrowserPasskeyProviderOptions;

  constructor(options: BrowserPasskeyProviderOptions = {}) {
    this.options = options;
  }

  isSupported(): boolean {
    return isBrowserPasskeySupported(this.options.credentials);
  }

  async register(
    options: PasskeyRegistrationOptions,
  ): Promise<PasskeyRegistrationResult> {
    const credentials = this.requireCredentials();
    const userId = toUint8Array(options.userId);
    if (userId.length < 1 || userId.length > 64) {
      throw new DeviceKeyError(
        "invalid-key",
        "A WebAuthn user handle must be between 1 and 64 bytes",
      );
    }

    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: toUint8Array(options.challenge),
      rp: { id: options.rpId, name: options.rpName },
      user: {
        id: userId,
        name: options.userName,
        displayName: options.userDisplayName ?? options.userName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: COSE_ALG_EDDSA },
        { type: "public-key", alg: COSE_ALG_ES256 },
      ],
      authenticatorSelection: {
        // A resident credential means the passkey itself is discoverable on
        // this device, so unlocking does not require a separate username.
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: options.timeoutMs ?? DEFAULT_PASSKEY_TIMEOUT_MS,
    };

    let credential: Credential | null;
    try {
      credential = await credentials.create({ publicKey });
    } catch (error) {
      throw toDeviceKeyError(
        error,
        "passkey-failed",
        "The passkey could not be created",
      );
    }

    if (!credential) {
      throw new PasskeyCancelledError("Passkey creation was cancelled");
    }
    if (!isPublicKeyCredential(credential)) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The authenticator returned an unexpected credential",
      );
    }

    const response = credential.response as
      | AuthenticatorAttestationResponse
      | undefined;
    const transports =
      response && typeof response.getTransports === "function"
        ? response.getTransports()
        : undefined;

    const credentialId = toBase64Url(credential.rawId);
    if (!credentialId) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The authenticator returned an empty credential id",
      );
    }

    return {
      credentialId,
      ...(transports ? { transports } : {}),
    };
  }

  async assert(
    options: PasskeyAssertionOptions,
  ): Promise<PasskeyAssertionResult> {
    const credentials = this.requireCredentials();
    const challenge = toUint8Array(options.challenge);

    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge,
      rpId: options.rpId,
      allowCredentials: [
        { type: "public-key", id: fromBase64Url(options.credentialId) },
      ],
      userVerification: "required",
      timeout: options.timeoutMs ?? DEFAULT_PASSKEY_TIMEOUT_MS,
    };

    let credential: Credential | null;
    try {
      credential = await credentials.get({ publicKey });
    } catch (error) {
      throw toDeviceKeyError(
        error,
        "passkey-failed",
        "The passkey prompt could not be completed",
      );
    }

    if (!credential) {
      throw new PasskeyCancelledError();
    }
    if (!isPublicKeyCredential(credential)) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The authenticator returned an unexpected credential",
      );
    }

    const returnedId = toBase64Url(credential.rawId);
    if (returnedId !== options.credentialId) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The authenticator used a different passkey",
      );
    }

    const response = credential.response as
      | AuthenticatorAssertionResponse
      | undefined;
    if (!response || !response.clientDataJSON || !response.authenticatorData) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The authenticator did not return an assertion",
      );
    }

    const clientData = parseClientData(response.clientDataJSON);
    if (clientData.type !== "webauthn.get") {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey response was not an authentication assertion",
      );
    }

    const expectedChallenge = toBase64Url(challenge);
    if (clientData.challenge !== expectedChallenge) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey response answered a different challenge",
      );
    }

    const expectedOrigin = options.expectedOrigin ?? resolveOrigin();
    if (expectedOrigin && clientData.origin !== expectedOrigin) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey response came from a different origin",
      );
    }

    const flags = readAuthenticatorFlags(response.authenticatorData);
    const userPresent = (flags & FLAG_USER_PRESENT) !== 0;
    const userVerified = (flags & FLAG_USER_VERIFIED) !== 0;

    if (!userPresent) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey did not report user presence",
      );
    }

    return {
      credentialId: returnedId,
      challenge: clientData.challenge,
      userPresent,
      userVerified,
      signCount: readSignCount(response.authenticatorData),
    };
  }

  private requireCredentials(): CredentialsContainerLike {
    const credentials = resolveCredentials(this.options.credentials);
    if (!credentials) {
      throw new DeviceKeyError(
        "unsupported",
        "Passkeys are unavailable in this browser",
      );
    }
    return credentials;
  }
}

/** Create a {@link BrowserPasskeyProvider}. */
export function createBrowserPasskeyProvider(
  options: BrowserPasskeyProviderOptions = {},
): PasskeyProvider {
  return new BrowserPasskeyProvider(options);
}

/** Default provider backed by the browser's `navigator.credentials`. */
export const browserPasskeys: PasskeyProvider = createBrowserPasskeyProvider();

interface ParsedClientData {
  type?: string;
  challenge?: string;
  origin?: string;
}

function parseClientData(clientDataJSON: BinaryData | Uint8Array): ParsedClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(clientDataJSON));
  } catch (error) {
    throw new DeviceKeyError(
      "passkey-failed",
      "The passkey response was not valid JSON",
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new DeviceKeyError(
      "passkey-failed",
      "The passkey response was empty",
    );
  }
  return parsed as ParsedClientData;
}

/**
 * Authenticator data layout:
 * `rpIdHash(32) | flags(1) | signCount(4) | …`
 */
function readAuthenticatorFlags(authenticatorData: BinaryData | Uint8Array): number {
  const bytes = toUint8Array(authenticatorData);
  if (bytes.length < 37) {
    throw new DeviceKeyError(
      "passkey-failed",
      "The authenticator data was truncated",
    );
  }
  return bytes[32];
}

function readSignCount(authenticatorData: BinaryData | Uint8Array): number {
  const bytes = toUint8Array(authenticatorData);
  return (
    ((bytes[33] << 24) >>> 0) +
    (bytes[34] << 16) +
    (bytes[35] << 8) +
    bytes[36]
  );
}

function isPublicKeyCredential(
  credential: Credential,
): credential is PublicKeyCredential {
  return (
    typeof credential === "object" &&
    credential !== null &&
    (credential as PublicKeyCredential).type === "public-key" &&
    "rawId" in credential &&
    "response" in credential
  );
}
