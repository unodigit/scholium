/**
 * The paper on the left of the review form: which paper `/review/[id]` means,
 * and how it is read from the API.
 *
 * The page needs two public reads, neither of which needs an account:
 *
 * - `GET /v1/papers/{id}` — the newest listed version's title, abstract and
 *   categories (`catalog/router.py`). A paper that is not listed is a `404`:
 *   there is nothing to review.
 * - `GET /v1/papers/{id}/v/{n}/text` — that version's paragraphs
 *   (`reading/router.py`). This is the HTML reading view's text; if it cannot
 *   be had the form still works (the abstract is shown and the reviewer is
 *   told), because a reviewer may hold the PDF.
 *
 * Pure data and functions, no React, so the server route, the components and
 * vitest can share it.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { parseShortId } from "../verify-core";

/** The route prefix: `/review/{id}` (docs/design.md §4). */
export const REVIEW_PATH = "/review";

/** The reader-facing page title. */
export const REVIEW_TITLE = "Review";

/** One paragraph of the paper's text, in reading order. */
export interface PaperParagraph {
  /** Stable id (sha256 of the normalised text); what a citation will name. */
  readonly id: string;
  readonly text: string;
}

/** The paper as the review page shows it. */
export interface ReviewPaper {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** The version being reviewed: the newest listed one. */
  readonly version: number;
  readonly title: string;
  readonly abstract: string;
  readonly categories: readonly string[];
  /**
   * The full text, or `null` when the node has none for this version (as
   * opposed to an empty list, which is a paper with no paragraphs).
   */
  readonly paragraphs: readonly PaperParagraph[] | null;
}

/** Thrown when an API body is not what it should be. */
export class ReviewPaperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPaperError";
  }
}

/** Thrown when a route segment does not name a paper. */
export class InvalidPaperIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaperIdError";
  }
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type PaperClient = Pick<ApiClient, "get">;

/** The URL of the review form for a paper. */
export function reviewHref(shortId: string): string {
  return `${REVIEW_PATH}/${encodeURIComponent(shortId)}`;
}

/** Decode one URL segment, leaving it alone when it is not valid escaping. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The paper a `/review/[id]` segment names.
 *
 * The `sch:` prefix is optional (paper URLs drop it, `/p/k3f9-q2xz-7mwd`) and
 * a percent-encoded `sch%3A…`, as a browser or a pasted link may carry, is
 * decoded first. The id's checksum is verified, so a mistyped id is reported
 * as such instead of being looked up.
 *
 * A review is written against the paper's newest version, so a version id
 * (`…/v2`) is not accepted here.
 *
 * @throws {InvalidPaperIdError} if the segment does not name a paper.
 */
export function parseReviewTarget(segment: string): string {
  const text = decodeSegment(typeof segment === "string" ? segment : "").trim();
  if (text === "") {
    throw new InvalidPaperIdError("Expected a paper id like k3f9-q2xz-7mwd.");
  }
  try {
    return parseShortId(/^sch:/i.test(text) ? text : `sch:${text}`);
  } catch (error) {
    throw new InvalidPaperIdError(
      error instanceof Error ? error.message : "That is not a paper id.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A version number: a positive integer. */
function readVersion(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      return value;
    }
  }
  return null;
}

/** The fields of `GET /v1/papers/{id}` the page uses. */
export interface PaperHead {
  readonly shortId: string;
  readonly version: number;
  readonly title: string;
  readonly abstract: string;
  readonly categories: readonly string[];
}

/**
 * Read the body of `GET /v1/papers/{id}`.
 *
 * A body with no title or no version is an error, never a blank page: a form
 * that does not say which paper it reviews would invite a review of the wrong
 * one.
 *
 * @throws {ReviewPaperError} if the body is not a paper.
 */
export function parsePaperHead(payload: unknown): PaperHead {
  if (!isRecord(payload)) {
    throw new ReviewPaperError("The API did not return a paper.");
  }
  const title = readText(payload.title);
  const version = readVersion(payload.n, payload.version);
  const shortId = readText(payload.shortId) ?? readText(payload.paper);
  if (title === null || version === null || shortId === null) {
    throw new ReviewPaperError("The API did not return a paper.");
  }

  const categories = Array.isArray(payload.categories)
    ? payload.categories.flatMap((category) => readText(category) ?? [])
    : [];

  return {
    shortId,
    version,
    title,
    abstract: readText(payload.abstract) ?? "",
    categories,
  };
}

/**
 * Read the body of `GET /v1/papers/{id}/v/{n}/text`, in reading order.
 *
 * A paragraph with no text is dropped; the order the API sent them in
 * (`position`) is the order shown.
 *
 * @throws {ReviewPaperError} if the body carries no paragraph list.
 */
export function parseParagraphs(payload: unknown): PaperParagraph[] {
  if (!isRecord(payload) || !Array.isArray(payload.paragraphs)) {
    throw new ReviewPaperError("The API did not return the paper's text.");
  }

  const entries = payload.paragraphs.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const text = readText(entry.text);
    if (text === null) return [];
    const position =
      typeof entry.position === "number" && Number.isFinite(entry.position)
        ? entry.position
        : index;
    const id =
      readText(entry.paragraph_id) ?? readText(entry.paragraphId) ?? `p${index}`;
    return [{ id, text, position, index }];
  });

  entries.sort((a, b) => a.position - b.position || a.index - b.index);
  return entries.map(({ id, text }) => ({ id, text }));
}

/**
 * Read the paper to review: its head, then its text.
 *
 * Both calls are unauthenticated and never cached: a paper can be retracted or
 * gain a newer version, and a reviewer must not be shown stale text. The head
 * failing fails the load (there is nothing to review). The text failing does
 * not: the paper is returned with `paragraphs: null` and the page says so.
 *
 * @throws {ApiError | NetworkError | ReviewPaperError} if the head cannot be read.
 */
export async function loadReviewPaper(
  shortId: string,
  client: PaperClient = api,
): Promise<ReviewPaper> {
  const head = parsePaperHead(
    await client.get<unknown>(`/papers/${encodeURIComponent(shortId)}`, {
      auth: false,
      cache: "no-store",
    }),
  );

  let paragraphs: PaperParagraph[] | null = null;
  try {
    paragraphs = parseParagraphs(
      await client.get<unknown>(
        `/papers/${encodeURIComponent(shortId)}/v/${head.version}/text`,
        { auth: false, cache: "no-store" },
      ),
    );
  } catch {
    // The reading text is a convenience beside the form, not part of it.
    paragraphs = null;
  }

  return { ...head, paragraphs };
}

/** Why the page cannot show a paper. */
export interface PaperFailure {
  /** `not-found` has no retry: asking again will not list the paper. */
  readonly kind: "invalid-id" | "not-found" | "failed";
  readonly title: string;
  readonly message: string;
}

/**
 * One plain-language failure for the page, from whatever `loadReviewPaper`
 * (or {@link parseReviewTarget}) threw.
 */
export function describePaperError(error: unknown): PaperFailure {
  if (error instanceof InvalidPaperIdError) {
    return {
      kind: "invalid-id",
      title: "That is not a paper id",
      message: error.message,
    };
  }
  if (error instanceof ApiError && error.isNotFound) {
    return {
      kind: "not-found",
      title: "No such paper",
      message:
        "This node has no listed paper with that id, so there is nothing to review.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "failed",
      title: "Couldn’t load the paper",
      message:
        "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  if (error instanceof ApiError) {
    return {
      kind: "failed",
      title: "Couldn’t load the paper",
      message: error.detail || error.title || "The API could not return the paper.",
    };
  }
  return {
    kind: "failed",
    title: "Couldn’t load the paper",
    message:
      error instanceof Error && error.message
        ? error.message
        : "The paper could not be loaded.",
  };
}
