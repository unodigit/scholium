/**
 * Following a category (the toggle on `/c/{category}`).
 *
 * Two calls are live on the API today (feature 179,
 * `apps/api/src/app/modules/follows/`):
 *
 * - `PUT    /v1/me/follows/{category}` follows a category (`204`, idempotent)
 * - `DELETE /v1/me/follows/{category}` unfollows it (`204`, idempotent)
 *
 * The toggle also wants to know whether the caller already follows the
 * category, which needs a read the API does not serve yet:
 *
 * - `GET /v1/me/follows` -> `{"categories": ["cs.AI", "cs.CR"]}`
 *
 * {@link loadFollowedCategories} calls it; until it exists the toggle falls
 * back to "unknown", which is safe because both writes are idempotent.
 *
 * Pure data and functions, no React, so the component and vitest share them.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const FOLLOWS_ENDPOINT = "/me/follows";

/** `PUT`/`DELETE` target for one category. */
export function followEndpoint(category: string): string {
  return `${FOLLOWS_ENDPOINT}/${encodeURIComponent(category.trim())}`;
}

/** What a follow addresses. */
export type FollowKind = "category" | "paper" | "person";

/**
 * The kind of subject a follow id names.
 *
 * The follows table stores whatever the Follow control sent: a category
 * (`cs.AI`), a paper (`sch:…`) or a member (`did:…`). The id itself says
 * which, so every screen that reads the list back can link each entry to the
 * page that shows it instead of treating them all as categories.
 */
export function followKind(subject: string): FollowKind {
  const id = subject.trim();
  if (/^sch:/i.test(id)) {
    return "paper";
  }
  if (/^did:/i.test(id)) {
    return "person";
  }
  return "category";
}

/**
 * The page that shows the followed subject: `/c/{id}`, `/p/{id}` or `/u/{did}`.
 *
 * A paper link drops the `sch:` prefix, exactly as the paper page's URL does
 * (docs/design.md §4); a person link keeps the DID whole and percent-encodes
 * its colons.
 */
export function followHref(subject: string): string {
  const id = subject.trim();
  switch (followKind(id)) {
    case "paper":
      return `/p/${encodeURIComponent(id.replace(/^sch:/i, ""))}`;
    case "person":
      return `/u/${encodeURIComponent(id)}`;
    default:
      return `/c/${encodeURIComponent(id)}`;
  }
}

/** Sign-in, returning to the followed subject's page afterwards. */
export function followSigninHref(subject: string): string {
  return `/signin?next=${encodeURIComponent(followHref(subject))}`;
}

/** One entry of the reader's follows, ready to render as a link. */
export interface FollowedSubject {
  /** The stored follow: a category id, `sch:…` or `did:…`. */
  readonly id: string;
  readonly kind: FollowKind;
  /** What the link says: the category, the paper's title, the person's name. */
  readonly label: string;
  /** Where the link goes. */
  readonly href: string;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A paper's title, or `null` when it cannot be read. */
async function loadPaperTitle(
  paperId: string,
  client: Pick<ApiClient, "get">,
): Promise<string | null> {
  try {
    const payload = await client.get<unknown>(
      `/papers/${encodeURIComponent(paperId)}`,
      { cache: "no-store" },
    );
    return isRecord(payload) ? readText(payload.title) : null;
  } catch {
    // An unlisted or removed paper still belongs in the list; it just has no
    // title to show, so the short id stands in.
    return null;
  }
}

/** A member's profile name, or `null` when there is none to read. */
async function loadPersonName(
  did: string,
  client: Pick<ApiClient, "get">,
): Promise<string | null> {
  try {
    const payload = await client.get<unknown>(
      `/profiles/${encodeURIComponent(did)}`,
      { auth: false, cache: "no-store" },
    );
    if (!isRecord(payload) || payload.erased === true) {
      return null;
    }
    return readText(payload.name) ?? readText(payload.display_name) ?? readText(payload.displayName);
  } catch {
    return null;
  }
}

/** Turn a stored follow into a link, with the best label the caller has. */
export function describeFollow(
  subject: string,
  label: string | null = null,
): FollowedSubject {
  const id = subject.trim();
  const kind = followKind(id);
  const fallback = kind === "paper" ? id.replace(/^sch:/i, "") : id;
  return {
    id,
    kind,
    label: label?.trim() || fallback,
    href: followHref(id),
  };
}

/**
 * The reader's follows, each labelled by what it names.
 *
 * Papers are read from the catalog for their title and people from their
 * public profile for their name; both reads are best-effort, so one paper
 * that is no longer listed never hides the rest of the list. Categories
 * are their own label.
 */
export async function loadFollowedSubjects(
  client: Pick<ApiClient, "get"> = api,
): Promise<FollowedSubject[]> {
  const subjects = await loadFollowedCategories(client);
  return Promise.all(
    subjects.map(async (subject) => {
      const kind = followKind(subject);
      if (kind === "paper") {
        return describeFollow(subject, await loadPaperTitle(subject, client));
      }
      if (kind === "person") {
        return describeFollow(subject, await loadPersonName(subject, client));
      }
      return describeFollow(subject);
    }),
  );
}

/** What the follow calls need from the API client. */
export type FollowsClient = Pick<ApiClient, "get" | "put" | "delete">;

/** Raised when the API answers with something that is not a list of follows. */
export class FollowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a `GET /v1/me/follows` body into a sorted, de-duplicated list.
 *
 * Accepts `{"categories": [...]}` (what the API is asked to serve) or a bare
 * array; an entry is a category string or `{"category": "..."}`. Anything else
 * is rejected rather than read as "follows nothing", because the toggle would
 * then offer to follow a category the reader already follows.
 */
export function parseFollowedCategories(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.categories)
      ? payload.categories
      : null;
  if (list === null) {
    throw new FollowError("The API did not return a list of followed categories.");
  }
  const names = list.map((entry) => {
    const name = isRecord(entry) ? entry.category : entry;
    return typeof name === "string" ? name.trim() : "";
  });
  return [...new Set(names.filter((name) => name !== ""))].sort();
}

/** The categories the caller follows. */
export async function loadFollowedCategories(
  client: Pick<ApiClient, "get"> = api,
): Promise<string[]> {
  const payload = await client.get<unknown>(FOLLOWS_ENDPOINT, { cache: "no-store" });
  return parseFollowedCategories(payload);
}

/** Follow `category`; resolves once the API answers `204`. */
export async function followCategory(
  category: string,
  client: Pick<ApiClient, "put"> = api,
): Promise<void> {
  await client.put(followEndpoint(category));
}

/** Stop following `category`; resolves once the API answers `204`. */
export async function unfollowCategory(
  category: string,
  client: Pick<ApiClient, "delete"> = api,
): Promise<void> {
  await client.delete(followEndpoint(category));
}

/** Sort a failed follow or unfollow into a plain sentence. */
export function describeFollowError(error: unknown, following: boolean): string {
  const verb = following ? "follow" : "unfollow";
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return `Sign in to ${verb} categories.`;
    }
    return error.detail || error.title || `Couldn’t ${verb} this category.`;
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return `Couldn’t ${verb} this category.`;
}
