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

/** Sign-in, returning to the category page afterwards. */
export function followSigninHref(category: string): string {
  return `/signin?next=${encodeURIComponent(`/c/${category.trim()}`)}`;
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
