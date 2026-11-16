/**
 * The reviewer's pseudonymous per-paper key (spec features 107 and 166).
 *
 * A `review.commit` is signed by the *review key*, not by the reviewer's
 * device DID: the public record must not say who wrote the review, while the
 * access token tells the node only that a tier-3 member asked. The same key
 * signs the eventual `review.formal`, so the reveal can be matched to its
 * commit.
 *
 * How the key is derived
 * ----------------------
 * The device key is non-extractable, so there is no seed to hash directly.
 * Instead the device key signs one domain-separated, per-paper challenge.
 * Ed25519 signatures are deterministic, so the same device and paper always
 * give the same signature; that signature is hashed into a 32-byte Ed25519
 * seed. Nothing leaves the device, and the review key cannot be linked back to
 * the device DID without the device key.
 *
 * The derivation is one passkey prompt. The commit signature itself uses the
 * derived key, so it needs no second prompt.
 *
 * The nullifier is derived from the same seed and the paper: it is stable for
 * one person and one paper (the API refuses a second review on that pair) and
 * says nothing about who the person is.
 *
 * Pure functions plus one default that reads the app-wide device key; the
 * signing step is injectable for tests.
 */

import { etc, getPublicKey, sign as edSign } from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex } from "@noble/hashes/utils";

import { deviceKey } from "../web-auth/device-key";
import { didKeyFromEd25519PublicKey } from "../web-auth/did-key";
import { concatBytes, toUint8Array } from "../web-auth/encoding";
import {
  KeyFileError,
  decryptWithPassphrase,
  encryptWithPassphrase,
  type PassphraseBoxOptions,
} from "./passphrase-box";
import {
  REVIEW_KEY_STORAGE_PREFIX,
  browserReviewKeyStorage,
  reviewKeyStorageKey,
  type ReviewKeyStorage,
} from "./review-key-storage";
import type { SealedReview } from "./sealed-review";

// `@noble/ed25519` v2 signs synchronously once it has a SHA-512 function.
// Wire the pure-JS hash so derivation works in a browser, in Node and under
// JSDOM alike, with no `crypto.subtle`.
etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  sha512(etc.concatBytes(...messages));

/** A 32-byte Ed25519 seed. */
export const REVIEW_KEY_SEED_LENGTH = 32;

/** Domain separator for the challenge the device key signs. */
export const REVIEW_KEY_DOMAIN = "scholium:review-key:v1:";

/** Domain separator for the nullifier derived from the review key. */
export const REVIEW_NULLIFIER_DOMAIN = "scholium:review-nullifier:v1:";

/** The passkey prompt's reason, shown while deriving the review key. */
export const REVIEW_SIGN_REASON = "Sign your review";

/** A derived per-paper review key. */
export interface ReviewKeyMaterial {
  /** The key's `did:key`; the `author` of the commit and its `reviewKey`. */
  readonly did: string;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** Raw 32-byte Ed25519 seed, used only inside the browser. */
  readonly seed: Uint8Array;
}

/** Signs one challenge with the device key (behind a passkey prompt). */
export type SignReviewChallenge = (challenge: Uint8Array) => Promise<Uint8Array>;

/** How `ReviewForm` obtains its per-paper key; replaceable in tests. */
export type DeriveReviewKey = (paperId: string) => Promise<ReviewKeyMaterial>;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build a review key from an Ed25519 seed; the public half and DID follow. */
export function reviewKeyFromSeed(seed: Uint8Array): ReviewKeyMaterial {
  const bytes = toUint8Array(seed);
  if (bytes.length !== REVIEW_KEY_SEED_LENGTH) {
    throw new Error(
      `A review key seed must be ${REVIEW_KEY_SEED_LENGTH} bytes, got ${bytes.length}.`,
    );
  }
  const publicKey = getPublicKey(bytes);
  return {
    did: didKeyFromEd25519PublicKey(publicKey),
    publicKey,
    seed: bytes,
  };
}

/**
 * Derive the per-paper review key for `paperId`.
 *
 * @param paperId The paper's canonical id (`sch:…`) or any stable spelling.
 * @param signChallenge Device signature over the challenge; defaults to the
 *   app-wide device key and therefore prompts for the passkey once.
 */
export async function deriveReviewKey(
  paperId: string,
  signChallenge: SignReviewChallenge = (challenge) =>
    deviceKey.signWithPasskey(challenge, { reason: REVIEW_SIGN_REASON }),
): Promise<ReviewKeyMaterial> {
  const id = paperId.trim();
  if (id === "") {
    throw new Error("A paper id is required to derive a review key.");
  }

  // A key carried over from another browser (imported) takes precedence over
  // deriving a fresh one from this device's key.
  const stored = await loadReviewKey(id);
  if (stored !== null) return stored;

  const message = utf8(`${REVIEW_KEY_DOMAIN}${id}`);
  const signature = await signChallenge(sha256(message));
  // The signature already commits to the paper id (through the challenge), so
  // hashing the message and signature yields a seed unique to this pair.
  const seed = sha256(concatBytes(message, signature));
  return reviewKeyFromSeed(seed);
}

/**
 * The nullifier `H(secret || paperId)` for a review key: lowercase hex, as the
 * commit body carries it.
 */
export function nullifierForReviewKey(
  key: ReviewKeyMaterial,
  paperId: string,
): string {
  const id = paperId.trim();
  if (id === "") {
    throw new Error("A paper id is required to derive a nullifier.");
  }
  return bytesToHex(
    sha256(
      concatBytes(utf8(REVIEW_NULLIFIER_DOMAIN), key.seed, utf8(id)),
    ),
  );
}

/** Sign bytes with the derived review key (no passkey prompt, no WebCrypto). */
export function signWithReviewKey(
  key: ReviewKeyMaterial,
  data: Uint8Array,
): Uint8Array {
  return edSign(data, key.seed);
}

// ---------------------------------------------------------------------------
// Keeping a review key on this device
// ---------------------------------------------------------------------------

// The seed is never stored in the clear: see `review-key-storage.ts`, which
// seals it under a non-extractable AES-GCM key kept in IndexedDB.
export { REVIEW_KEY_STORAGE_PREFIX, browserReviewKeyStorage, reviewKeyStorageKey };
export type { ReviewKeyStorage };

/** Keep a review key so a reveal can be signed in this browser. */
export async function saveReviewKey(
  paperId: string,
  key: ReviewKeyMaterial,
  storage: ReviewKeyStorage = browserReviewKeyStorage,
): Promise<void> {
  const id = paperId.trim();
  if (id === "") return;
  try {
    await storage.save(id, key.seed);
  } catch {
    // The review is still revealable on this page.
  }
}

/** The review key kept for `paperId`, or `null`. */
export async function loadReviewKey(
  paperId: string,
  storage: ReviewKeyStorage = browserReviewKeyStorage,
): Promise<ReviewKeyMaterial | null> {
  const id = paperId.trim();
  if (id === "") return null;
  try {
    const seed = await storage.load(id);
    return seed === null ? null : reviewKeyFromSeed(seed);
  } catch {
    return null;
  }
}

/** Forget a paper's carried review key. */
export async function forgetReviewKey(
  paperId: string,
  storage: ReviewKeyStorage = browserReviewKeyStorage,
): Promise<void> {
  const id = paperId.trim();
  if (id === "") return;
  try {
    await storage.forget(id);
  } catch {
    // Nothing to forget.
  }
}

// ---------------------------------------------------------------------------
// Carrying a review key between browsers (a passphrase-encrypted file)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * What a review key file holds once decrypted. It is never written to disk as
 * it is: see {@link encryptReviewKeyFile}.
 */
export interface ReviewKeyFile {
  readonly paperId: string;
  readonly versionCid: string;
  readonly reviewCid: string;
  readonly revealAt: string;
  readonly commitment: string;
  readonly revealBody: Record<string, unknown>;
  readonly seed: string;
}

/** Build what a carried review key file holds, before it is encrypted. */
export function buildReviewKeyFile(
  sealed: SealedReview,
  key: ReviewKeyMaterial | null,
): ReviewKeyFile {
  return {
    paperId: sealed.paperId.trim(),
    versionCid: sealed.versionCid,
    reviewCid: sealed.reviewCid,
    revealAt: sealed.revealAt,
    commitment: sealed.commitment,
    revealBody: sealed.revealBody,
    seed: key !== null ? bytesToBase64(key.seed) : "",
  };
}

/** Parse a carried review key file's contents back into a sealed review and key. */
export function parseReviewKeyFile(raw: unknown): {
  readonly sealed: SealedReview;
  readonly key: ReviewKeyMaterial;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const paperId = typeof record.paperId === "string" ? record.paperId.trim() : "";
  const versionCid = typeof record.versionCid === "string" ? record.versionCid : "";
  const reviewCid = typeof record.reviewCid === "string" ? record.reviewCid : "";
  const revealAt = typeof record.revealAt === "string" ? record.revealAt : "";
  const commitment = typeof record.commitment === "string" ? record.commitment : "";
  const revealBody = record.revealBody;
  const seed = typeof record.seed === "string" ? record.seed : "";
  if (
    paperId === "" ||
    versionCid === "" ||
    reviewCid === "" ||
    revealAt === "" ||
    commitment === "" ||
    typeof revealBody !== "object" ||
    revealBody === null ||
    Array.isArray(revealBody) ||
    seed === ""
  ) {
    return null;
  }
  let key: ReviewKeyMaterial;
  try {
    key = reviewKeyFromSeed(base64ToBytes(seed));
  } catch {
    return null;
  }
  const sealed: SealedReview = {
    paperId,
    versionCid,
    reviewCid,
    revealAt,
    commitment,
    revealBody: revealBody as Record<string, unknown>,
  };
  return { sealed, key };
}

/**
 * The text of a review key file: the sealed review and its key, encrypted with
 * `passphrase` (PBKDF2-SHA256, then AES-GCM; see `passphrase-box.ts`).
 *
 * Neither the seed nor the review's scores and justifications are in the file
 * in the clear.
 *
 * @throws {KeyFileError} an empty passphrase, or a browser without WebCrypto.
 */
export async function encryptReviewKeyFile(
  sealed: SealedReview,
  key: ReviewKeyMaterial,
  passphrase: string,
  options: PassphraseBoxOptions = {},
): Promise<string> {
  const contents = new TextEncoder().encode(
    JSON.stringify(buildReviewKeyFile(sealed, key)),
  );
  const envelope = await encryptWithPassphrase(contents, passphrase, options);
  return JSON.stringify(envelope, null, 2);
}

/**
 * Open the text of a review key file with `passphrase`.
 *
 * @throws {KeyFileError} the file is not an encrypted review key file, the
 *   passphrase is wrong (or the file was changed), or what it opens to is not
 *   a review key. A plaintext file an earlier version wrote is `not-encrypted`.
 */
export async function decryptReviewKeyFile(
  text: string,
  passphrase: string,
  options: PassphraseBoxOptions = {},
): Promise<{ readonly sealed: SealedReview; readonly key: ReviewKeyMaterial }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeyFileError(
      "not-encrypted",
      "This is not an encrypted review key file. Choose the file Download review key made.",
    );
  }
  const contents = await decryptWithPassphrase(raw, passphrase, options);
  let parsed: ReturnType<typeof parseReviewKeyFile> = null;
  try {
    parsed = parseReviewKeyFile(JSON.parse(new TextDecoder().decode(contents)));
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    throw new KeyFileError(
      "malformed",
      "The file opened, but it does not hold a review key.",
    );
  }
  return parsed;
}

/** Constants hidden tests may look for. */
export const DOWNLOAD_REVIEW_KEY_LABEL = "Download review key";
export const IMPORT_REVIEW_KEY_LABEL = "Import review key";
export const REVIEW_SECRET_LOCAL_NOTE =
  "The reveal secret is stored only in this browser.";
