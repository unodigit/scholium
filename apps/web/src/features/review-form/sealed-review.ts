/**
 * The review a reviewer has sealed but not yet revealed, kept on their device.
 *
 * A commit is the first half of a two-step commit–reveal: the review's content
 * is sealed into the commitment and is nowhere on the node in the clear until
 * the reviewer posts the matching `review.formal`. To post it, the browser
 * needs the content back — the scores, justifications, confidence,
 * recommendation and `signed` choice — together with the commitment it sealed.
 *
 * The review form therefore keeps that material in `localStorage` after a
 * successful commit. It is not the signing secret: the per-paper review key is
 * derived again from the device key (one passkey prompt) at reveal time, and
 * never stored. The entry is removed as soon as the review is revealed, and it
 * is read after mount only, so the server's HTML and the browser's first
 * render agree.
 *
 * Nothing here throws: a browser that refuses storage, or an entry another
 * version wrote, simply means the page shows the blank form again.
 */

import type { ReviewCommitResult } from "./commit";

/** A committed review waiting to be revealed. */
export interface SealedReview {
  /** The paper's id, spelled exactly as the review key was derived from it. */
  readonly paperId: string;
  /** The version the review targets (the commit's `target`). */
  readonly versionCid: string;
  /** cid of the `review.commit`, for display. */
  readonly reviewCid: string;
  /** When the review will be revealed (ISO 8601, UTC). */
  readonly revealAt: string;
  /** The commitment the commit sealed; the reveal must open it. */
  readonly commitment: string;
  /** The `review.formal` content the commitment covers. */
  readonly revealBody: Record<string, unknown>;
}

/** The small subset of the Web Storage API this store needs. */
export interface SealedReviewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Prefix of the one key per paper. */
export const SEALED_REVIEW_PREFIX = "scholium.sealed-review.v1:";

/** The storage key for a paper's sealed review. */
export function sealedReviewKey(paperId: string): string {
  return `${SEALED_REVIEW_PREFIX}${paperId.trim()}`;
}

/** An in-memory {@link SealedReviewStorage}, safe on the server and in tests. */
class MemoryStorage implements SealedReviewStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.has(key) ? (this.values.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

let memory: MemoryStorage | undefined;

function fallback(): MemoryStorage {
  if (memory === undefined) memory = new MemoryStorage();
  return memory;
}

/** `localStorage`, resolved lazily; the in-memory store on the server. */
export const browserSealedReviewStorage: SealedReviewStorage = {
  getItem(key) {
    const local = getLocalStorage();
    return local ? local.getItem(key) : fallback().getItem(key);
  },
  setItem(key, value) {
    const local = getLocalStorage();
    if (local) local.setItem(key, value);
    else fallback().setItem(key, value);
  },
  removeItem(key) {
    const local = getLocalStorage();
    if (local) local.removeItem(key);
    else fallback().removeItem(key);
  },
};

function getLocalStorage(): Storage | undefined {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Access can throw in private-mode browsers or sandboxed iframes.
  }
  return undefined;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored value as a {@link SealedReview}, or `null` if it is not one. */
export function parseSealedReview(raw: unknown): SealedReview | null {
  if (!isRecord(raw)) return null;
  const paperId = readText(raw.paperId);
  const versionCid = readText(raw.versionCid);
  const reviewCid = readText(raw.reviewCid);
  const revealAt = readText(raw.revealAt);
  const commitment = readText(raw.commitment);
  const revealBody = raw.revealBody;
  if (
    paperId === null ||
    versionCid === null ||
    reviewCid === null ||
    revealAt === null ||
    commitment === null ||
    !isRecord(revealBody)
  ) {
    return null;
  }
  return { paperId, versionCid, reviewCid, revealAt, commitment, revealBody };
}

/** Keep a sealed review so the reviewer can reveal it after a reload. */
export function saveSealedReview(
  review: SealedReview,
  storage: SealedReviewStorage = browserSealedReviewStorage,
): void {
  const paperId = review.paperId.trim();
  if (paperId === "") return;
  try {
    storage.setItem(sealedReviewKey(paperId), JSON.stringify(review));
  } catch {
    // Storage full or refused: the review is still revealable on this page.
  }
}

/** The sealed review kept for `paperId`, or `null`. */
export function loadSealedReview(
  paperId: string,
  storage: SealedReviewStorage = browserSealedReviewStorage,
): SealedReview | null {
  const id = paperId.trim();
  if (id === "") return null;
  try {
    const serialized = storage.getItem(sealedReviewKey(id));
    if (serialized === null) return null;
    return parseSealedReview(JSON.parse(serialized));
  } catch {
    return null;
  }
}

/** Forget a paper's sealed review, once it has been revealed. */
export function forgetSealedReview(
  paperId: string,
  storage: SealedReviewStorage = browserSealedReviewStorage,
): void {
  const id = paperId.trim();
  if (id === "") return;
  try {
    storage.removeItem(sealedReviewKey(id));
  } catch {
    // Nothing to forget.
  }
}

/**
 * The material a successful commit leaves to reveal it with.
 *
 * The commit's own body is not the review: the review content is the body the
 * commitment hashes, returned by {@link commitReview} as `revealBody`.
 */
export function sealedReviewFromCommit(
  result: ReviewCommitResult,
  paperId: string,
): SealedReview {
  return {
    paperId: paperId.trim(),
    versionCid: result.body.target,
    reviewCid: result.reviewCid,
    revealAt: result.revealAt,
    commitment: result.body.commitment,
    revealBody: result.revealBody,
  };
}
