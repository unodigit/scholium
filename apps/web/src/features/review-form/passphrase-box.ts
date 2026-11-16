/**
 * Passphrase-encrypted review key files.
 *
 * The file a reviewer downloads carries what reveals a sealed review: the
 * review key's seed, and the scores and justifications the commitment covers.
 * It must not be readable by whoever finds it, so the contents are encrypted
 * with a passphrase the reviewer chooses:
 *
 * 1. PBKDF2 with SHA-256 stretches the passphrase and a random 16-byte salt
 *    into a 256-bit AES key, with at least {@link PBKDF2_MIN_ITERATIONS}
 *    iterations, so guessing a passphrase offline is slow;
 * 2. AES-GCM, with a random 12-byte IV, encrypts and authenticates the
 *    contents. A wrong passphrase, or a file changed after it was written,
 *    fails the authentication tag and decrypts to nothing.
 *
 * The file is a small JSON envelope: the format, the parameters a reader needs
 * to derive the key again (none of them secret) and the ciphertext. Nothing
 * about the review, not even which paper it is for, is outside the ciphertext.
 *
 * Everything is WebCrypto (`crypto.subtle`); the implementation is injectable
 * so a test can pass a faster iteration count (never below the minimum, which
 * is enforced on import too) or a stand-in random source.
 */

import {
  fromBase64Url,
  toBase64Url,
  toUint8Array,
  utf8Encode,
} from "../web-auth/encoding";

/** The envelope's `format`: what kind of file this is. */
export const KEY_FILE_FORMAT = "scholium.review-key";

/** The envelope's `version`; the plaintext JSON file was never given one. */
export const KEY_FILE_VERSION = 2;

/** The fewest PBKDF2 iterations a file may use, written or read. */
export const PBKDF2_MIN_ITERATIONS = 310_000;

/** The iteration count a new file is written with. */
export const PBKDF2_ITERATIONS = 600_000;

/**
 * The most iterations a file to be read may ask for. The count is read from the
 * file, so a hostile file must not be able to hang the page.
 */
export const PBKDF2_MAX_ITERATIONS = 10_000_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

/** What went wrong with a key file, for the words the page shows. */
export type KeyFileProblem =
  | "empty-passphrase"
  | "unavailable"
  | "not-encrypted"
  | "malformed"
  | "unsupported"
  | "wrong-passphrase";

/** A key file that cannot be written or read; `problem` says why. */
export class KeyFileError extends Error {
  readonly problem: KeyFileProblem;

  constructor(problem: KeyFileProblem, message: string) {
    super(message);
    this.name = "KeyFileError";
    this.problem = problem;
  }
}

/** The JSON a review key file holds. */
export interface PassphraseEnvelope {
  readonly format: typeof KEY_FILE_FORMAT;
  readonly version: typeof KEY_FILE_VERSION;
  readonly kdf: {
    readonly name: "PBKDF2";
    readonly hash: "SHA-256";
    readonly iterations: number;
    /** base64url */
    readonly salt: string;
  };
  readonly cipher: {
    readonly name: "AES-GCM";
    /** base64url */
    readonly iv: string;
  };
  /** base64url; the AES-GCM output, authentication tag included. */
  readonly ciphertext: string;
}

/** Seams for tests; the defaults are the browser's. */
export interface PassphraseBoxOptions {
  /** PBKDF2 iterations to write with; at least {@link PBKDF2_MIN_ITERATIONS}. */
  readonly iterations?: number;
  readonly subtle?: SubtleCrypto;
  readonly randomBytes?: (length: number) => Uint8Array;
}

function resolveSubtle(options: PassphraseBoxOptions): SubtleCrypto {
  const subtle =
    options.subtle ??
    (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new KeyFileError(
      "unavailable",
      "This browser cannot encrypt or decrypt a review key file (WebCrypto is not available here).",
    );
  }
  return subtle;
}

function randomBytes(options: PassphraseBoxOptions, length: number): Uint8Array {
  if (options.randomBytes !== undefined) return options.randomBytes(length);
  return (globalThis as { crypto: Crypto }).crypto.getRandomValues(
    new Uint8Array(length),
  );
}

/** The bytes of a passphrase: NFKC, so one typed on another keyboard matches. */
function passphraseBytes(passphrase: string): Uint8Array<ArrayBuffer> {
  if (passphrase === "") {
    throw new KeyFileError("empty-passphrase", "Enter a passphrase.");
  }
  return utf8Encode(passphrase.normalize("NFKC"));
}

/** The additional data the ciphertext is bound to: this format and version. */
function boundData(): Uint8Array<ArrayBuffer> {
  return utf8Encode(`${KEY_FILE_FORMAT}:${KEY_FILE_VERSION}`);
}

async function deriveKey(
  subtle: SubtleCrypto,
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const material = await subtle.importKey(
    "raw",
    passphraseBytes(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Encrypt `plaintext` under `passphrase` into a key file's envelope. */
export async function encryptWithPassphrase(
  plaintext: Uint8Array,
  passphrase: string,
  options: PassphraseBoxOptions = {},
): Promise<PassphraseEnvelope> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS) {
    throw new Error(
      `A review key file needs at least ${PBKDF2_MIN_ITERATIONS} PBKDF2 iterations.`,
    );
  }
  const subtle = resolveSubtle(options);
  const salt = toUint8Array(randomBytes(options, SALT_BYTES));
  const iv = toUint8Array(randomBytes(options, IV_BYTES));
  const key = await deriveKey(subtle, passphrase, salt, iterations, "encrypt");
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: boundData() },
    key,
    toUint8Array(plaintext),
  );
  return {
    format: KEY_FILE_FORMAT,
    version: KEY_FILE_VERSION,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: toBase64Url(salt),
    },
    cipher: { name: "AES-GCM", iv: toBase64Url(iv) },
    ciphertext: toBase64Url(ciphertext),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesOf(value: unknown, what: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value === "") {
    throw new KeyFileError("malformed", `The key file has no ${what}.`);
  }
  try {
    return fromBase64Url(value);
  } catch {
    throw new KeyFileError("malformed", `The key file's ${what} is not valid.`);
  }
}

/**
 * Read an envelope from a file's parsed JSON.
 *
 * @throws {KeyFileError} `not-encrypted` for JSON that is not a key file
 *   envelope (the plaintext files an earlier version wrote among them),
 *   `unsupported` for another version or other parameters, `malformed` for an
 *   envelope that is missing or garbles a part.
 */
export function parsePassphraseEnvelope(raw: unknown): {
  readonly iterations: number;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
} {
  if (!isRecord(raw) || raw.format !== KEY_FILE_FORMAT) {
    throw new KeyFileError(
      "not-encrypted",
      "This is not an encrypted review key file. Download a new one from the browser that holds the review.",
    );
  }
  if (raw.version !== KEY_FILE_VERSION) {
    throw new KeyFileError(
      "unsupported",
      "This review key file is from a version of Scholium this one cannot read.",
    );
  }
  const kdf = raw.kdf;
  const cipher = raw.cipher;
  if (!isRecord(kdf) || !isRecord(cipher)) {
    throw new KeyFileError("malformed", "The key file is missing its encryption details.");
  }
  if (kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || cipher.name !== "AES-GCM") {
    throw new KeyFileError(
      "unsupported",
      "This review key file uses encryption this version cannot read.",
    );
  }
  const iterations = kdf.iterations;
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < PBKDF2_MIN_ITERATIONS ||
    iterations > PBKDF2_MAX_ITERATIONS
  ) {
    throw new KeyFileError(
      "unsupported",
      "This review key file asks for an iteration count this version will not use.",
    );
  }
  return {
    iterations,
    salt: bytesOf(kdf.salt, "salt"),
    iv: bytesOf(cipher.iv, "IV"),
    ciphertext: bytesOf(raw.ciphertext, "contents"),
  };
}

/**
 * Decrypt a key file's parsed JSON with `passphrase`.
 *
 * @throws {KeyFileError} see {@link parsePassphraseEnvelope}; `wrong-passphrase`
 *   when the authentication tag does not match, which is also what a file that
 *   was changed after it was written looks like.
 */
export async function decryptWithPassphrase(
  raw: unknown,
  passphrase: string,
  options: PassphraseBoxOptions = {},
): Promise<Uint8Array> {
  const { iterations, salt, iv, ciphertext } = parsePassphraseEnvelope(raw);
  const subtle = resolveSubtle(options);
  const key = await deriveKey(subtle, passphrase, salt, iterations, "decrypt");
  try {
    return new Uint8Array(
      await subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: boundData() },
        key,
        ciphertext,
      ),
    );
  } catch {
    throw new KeyFileError(
      "wrong-passphrase",
      "That passphrase does not open this file, or the file has been changed.",
    );
  }
}
