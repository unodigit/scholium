/**
 * The signed-in member's home screen (`/me`).
 *
 * `GET /v1/me/dashboard` (feature 126, `apps/api/src/app/modules/me/`) is the
 * one document the dashboard asks for: what needs attention, the papers the
 * caller wrote, and the reviews they wrote. The API is the source of truth;
 * this module only validates the wire shape, loads it, and holds the display
 * vocabulary (the card titles and the words each state reads as).
 *
 * Pure data and functions, no React, so the server route and the client
 * component share them (and vitest can test them without a JSX transform).
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** The `/me` route (docs/design.md §4: Dashboard). */
export const ME_PATH = "/me";

/** The member's security screen: devices, recovery guardians, key rotation. */
export const SECURITY_PATH = "/me/security";

/** Alias kept for callers that name the feature rather than the route. */
export const DASHBOARD_PATH = "/me";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const DASHBOARD_ENDPOINT = "/me/dashboard";

/** Alias used by callers that spell the route out. */
export const ME_DASHBOARD_ENDPOINT = "/me/dashboard";

/** Human-facing label for the page and its links. */
export const ME_TITLE = "Me";

/** Alias for callers that name the feature. */
export const DASHBOARD_TITLE = "Me";

/** Sign-in, returning to the dashboard afterwards. */
export const SIGNIN_HREF = `/signin?next=${encodeURIComponent(ME_PATH)}`;

/**
 * Anything that can fetch the dashboard. The real implementation is the shared
 * API client; tests pass a narrow object with a single `get`.
 */
export type DashboardClient = Pick<ApiClient, "get">;

/** Raised when the API answers with something that is not a dashboard. */
export class DashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardError";
  }
}

/** Alias for callers that name the error after the route. */
export class MeError extends DashboardError {}

/** Alias for callers that name the error after the endpoint. */
export class MeDashboardError extends DashboardError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBool(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readText).filter((item): item is string => item !== null);
}

/** One item in `needs_attention`. */
export interface AttentionItem {
  readonly kind: string;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly paper: string | null;
  readonly shortId: string | null;
  readonly paperCid: string | null;
  readonly version: number | null;
  readonly versionCid: string | null;
  readonly version_cid: string | null;
  readonly title: string | null;
  readonly link: string | null;
  readonly createdAt: string | null;
  readonly [key: string]: unknown;
}

/** The four attention groups plus their flat list. */
export interface NeedsAttention {
  readonly count: number;
  readonly consents_to_sign: readonly AttentionItem[];
  readonly review_invitations: readonly AttentionItem[];
  readonly author_replies: readonly AttentionItem[];
  readonly moderation_outcomes: readonly AttentionItem[];
  readonly items: readonly AttentionItem[];
}

/** One row of `my_papers`. */
export interface MyPaper {
  readonly paper: string | null;
  readonly shortId: string | null;
  readonly paperCid: string | null;
  readonly paper_cid: string | null;
  readonly title: string | null;
  readonly status: string | null;
  readonly categories: readonly string[];
  readonly role: string | null;
  readonly versionCount: number;
  readonly versions: number;
  readonly latestVersion: number | null;
  readonly latestVersionCid: string | null;
  readonly state: string | null;
  readonly reviewCount: number;
  readonly reviews: number;
  readonly revealedCount: number;
  readonly listedAt: string | null;
  readonly claimed: boolean;
  readonly link: string | null;
}

/** One row of `my_reviews`. */
export interface MyReview {
  readonly reviewCid: string;
  readonly review_cid: string;
  readonly state: string;
  readonly sealed: boolean;
  readonly revealed: boolean;
  readonly paper: string | null;
  readonly shortId: string | null;
  readonly paperCid: string | null;
  readonly version: number | null;
  readonly versionCid: string | null;
  readonly version_cid: string | null;
  readonly title: string | null;
  readonly committedAt: string | null;
  readonly revealedAt: string | null;
  readonly recommendation: unknown;
  readonly confidence: unknown;
  readonly scores: unknown;
  readonly signedBy: string | null;
  readonly authorReplied: boolean;
  readonly awaitingAuthor: boolean;
  readonly responseCount: number;
  readonly link: string | null;
}

/** The document `GET /v1/me/dashboard` serves. */
export interface DashboardData {
  readonly did: string;
  readonly needs_attention: NeedsAttention;
  readonly my_papers: readonly MyPaper[];
  readonly my_reviews: readonly MyReview[];
}

/** Alias for callers that name the data after the route. */
export type MeData = DashboardData;

/** Alias for callers that name the data after the endpoint. */
export type MeDashboardData = DashboardData;

function parseAttentionItem(value: unknown, index: number): AttentionItem {
  if (!isRecord(value)) {
    throw new DashboardError(`Attention item ${index + 1} is not an object.`);
  }
  const item: Record<string, unknown> = { ...value };
  const kind = readText(item.kind) ?? "attention";
  item.kind = kind;
  item.summary = readText(item.summary);
  item.reason = readText(item.reason);
  item.paper = readText(item.paper);
  item.shortId = readText(item.shortId) ?? readText(item.short_id);
  item.paperCid = readText(item.paperCid) ?? readText(item.paper_cid);
  const version = readNumber(item.version);
  item.version = version === null ? null : Math.trunc(version);
  item.versionCid = readText(item.versionCid) ?? readText(item.version_cid);
  item.version_cid = readText(item.version_cid) ?? readText(item.versionCid);
  item.title = readText(item.title);
  item.link = readText(item.link);
  item.createdAt = readText(item.createdAt) ?? readText(item.created_at);
  return item as unknown as AttentionItem;
}

function parseNeedsAttention(value: unknown): NeedsAttention {
  if (!isRecord(value)) {
    throw new DashboardError("The API did not return a needs_attention object.");
  }
  const groups = {
    consents_to_sign: Array.isArray(value.consents_to_sign)
      ? value.consents_to_sign
      : [],
    review_invitations: Array.isArray(value.review_invitations)
      ? value.review_invitations
      : [],
    author_replies: Array.isArray(value.author_replies)
      ? value.author_replies
      : [],
    moderation_outcomes: Array.isArray(value.moderation_outcomes)
      ? value.moderation_outcomes
      : [],
  };
  const items = Array.isArray(value.items)
    ? value.items
    : [
        ...groups.consents_to_sign,
        ...groups.review_invitations,
        ...groups.author_replies,
        ...groups.moderation_outcomes,
      ];
  const count =
    readNumber(value.count) ?? items.length;

  return {
    count: count === null ? items.length : Math.max(0, Math.trunc(count)),
    consents_to_sign: groups.consents_to_sign.map(parseAttentionItem),
    review_invitations: groups.review_invitations.map(parseAttentionItem),
    author_replies: groups.author_replies.map(parseAttentionItem),
    moderation_outcomes: groups.moderation_outcomes.map(parseAttentionItem),
    items: items.map(parseAttentionItem),
  };
}

function parseMyPaper(value: unknown, index: number): MyPaper {
  if (!isRecord(value)) {
    throw new DashboardError(`My paper ${index + 1} is not an object.`);
  }
  const versionCount =
    readNumber(value.versionCount) ?? readNumber(value.versions) ?? 0;
  const reviewCount =
    readNumber(value.reviewCount) ?? readNumber(value.reviews) ?? 0;
  const revealedCount = readNumber(value.revealedCount) ?? 0;
  return {
    paper: readText(value.paper),
    shortId: readText(value.shortId) ?? readText(value.short_id),
    paperCid: readText(value.paperCid) ?? readText(value.paper_cid),
    paper_cid: readText(value.paper_cid) ?? readText(value.paperCid),
    title: readText(value.title),
    status: readText(value.status),
    categories: readStringArray(value.categories),
    role: readText(value.role),
    versionCount: Math.max(0, Math.trunc(versionCount)),
    versions: Math.max(0, Math.trunc(versionCount)),
    latestVersion:
      readNumber(value.latestVersion) === null
        ? null
        : Math.trunc(readNumber(value.latestVersion) as number),
    latestVersionCid: readText(value.latestVersionCid) ?? readText(value.latest_version_cid),
    state: readText(value.state),
    reviewCount: Math.max(0, Math.trunc(reviewCount)),
    reviews: Math.max(0, Math.trunc(reviewCount)),
    revealedCount: Math.max(0, Math.trunc(revealedCount)),
    listedAt: readText(value.listedAt) ?? readText(value.listed_at),
    claimed: readBool(value.claimed),
    link: readText(value.link),
  };
}

function parseMyReview(value: unknown, index: number): MyReview {
  if (!isRecord(value)) {
    throw new DashboardError(`My review ${index + 1} is not an object.`);
  }
  const reviewCid = readText(value.reviewCid) ?? readText(value.review_cid);
  if (reviewCid === null) {
    throw new DashboardError(`My review ${index + 1} has no review id.`);
  }
  return {
    reviewCid,
    review_cid: reviewCid,
    state: readText(value.state) ?? "sealed",
    sealed: readBool(value.sealed) || value.state === "sealed",
    revealed: readBool(value.revealed) || value.state === "revealed",
    paper: readText(value.paper),
    shortId: readText(value.shortId) ?? readText(value.short_id),
    paperCid: readText(value.paperCid) ?? readText(value.paper_cid),
    version:
      readNumber(value.version) === null ? null : Math.trunc(readNumber(value.version) as number),
    versionCid: readText(value.versionCid) ?? readText(value.version_cid),
    version_cid: readText(value.version_cid) ?? readText(value.versionCid),
    title: readText(value.title),
    committedAt: readText(value.committedAt) ?? readText(value.committed_at),
    revealedAt: readText(value.revealedAt) ?? readText(value.revealed_at),
    recommendation: value.recommendation ?? null,
    confidence: value.confidence ?? null,
    scores: value.scores ?? null,
    signedBy: readText(value.signedBy) ?? readText(value.signed_by),
    authorReplied: readBool(value.authorReplied) || readBool(value.author_replied),
    awaitingAuthor: readBool(value.awaitingAuthor) || readBool(value.awaiting_author),
    responseCount:
      readNumber(value.responseCount) === null
        ? 0
        : Math.max(0, Math.trunc(readNumber(value.responseCount) as number)),
    link: readText(value.link),
  };
}

/**
 * Validate and normalise an API payload into a {@link DashboardData}.
 *
 * A payload that is not an object, or that is missing its `did`, is rejected
 * with {@link DashboardError} rather than rendering an empty dashboard,
 * because an empty screen would say "nothing needs attention" when the truth
 * is "we don't know".
 */
export function parseDashboard(payload: unknown): DashboardData {
  if (!isRecord(payload)) {
    throw new DashboardError("The API did not return a dashboard document.");
  }
  const did = readText(payload.did);
  if (did === null) {
    throw new DashboardError("The dashboard did not name the caller.");
  }
  const needsAttention = parseNeedsAttention(payload.needs_attention ?? payload.needsAttention);
  const myPapersRaw = payload.my_papers ?? payload.myPapers;
  const myPapers = Array.isArray(myPapersRaw) ? myPapersRaw : [];
  const myReviewsRaw = payload.my_reviews ?? payload.myReviews;
  const myReviews = Array.isArray(myReviewsRaw) ? myReviewsRaw : [];
  return {
    did,
    needs_attention: needsAttention,
    my_papers: myPapers.map(parseMyPaper),
    my_reviews: myReviews.map(parseMyReview),
  };
}

/**
 * Load the dashboard from `GET /v1/me/dashboard`.
 */
export async function loadDashboard(
  client: DashboardClient = api,
): Promise<DashboardData> {
  const payload = await client.get<unknown>(DASHBOARD_ENDPOINT, {
    cache: "no-store",
  });
  return parseDashboard(payload);
}

/** Alias for callers that name the loader after the route. */
export async function loadMe(client: DashboardClient = api): Promise<DashboardData> {
  return loadDashboard(client);
}

/** Alias for callers that name the loader after the endpoint. */
export async function loadMeDashboard(
  client: DashboardClient = api,
): Promise<DashboardData> {
  return loadDashboard(client);
}

/** A function that loads the dashboard; mirrors the prop type. */
export type LoadDashboard = (client?: DashboardClient) => Promise<DashboardData>;

/** Sort a failed load into a plain message. */
export function describeDashboardError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not return your dashboard.";
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof DashboardError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The API could not return your dashboard.";
}

/** Alias. */
export function describeMeError(error: unknown): string {
  return describeDashboardError(error);
}

/** Alias. */
export function describeMeDashboardError(error: unknown): string {
  return describeDashboardError(error);
}
