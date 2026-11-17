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

import { loadProfile, profilePath, type ProfileClient } from "./profile";

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

/* -------------------------------------------------------------------------- */
/* Public profile                                                              */
/* -------------------------------------------------------------------------- */

/** The member's own public profile (`/u/{did}`), for the "View public profile" link. */
export function ownProfileHref(did: string): string {
  return profilePath(did);
}

/* -------------------------------------------------------------------------- */
/* Credentials: the linked ORCID iD                                            */
/* -------------------------------------------------------------------------- */

/** Where a linked ORCID iD resolves to. */
export function orcidHref(orcid: string): string {
  return `https://orcid.org/${orcid}`;
}

/**
 * The ORCID iD linked to `did`, or `null` when none is.
 *
 * `GET /v1/dashboard` does not carry it; the profile document does
 * (`GET /v1/profiles/{did}`, taken from the ORCID ownership credential), so
 * the Credentials card asks for it on its own and a failure there never
 * blanks the rest of `/me`.
 */
export async function loadLinkedOrcid(
  did: string,
  client: ProfileClient = api,
): Promise<string | null> {
  const profile = await loadProfile(did, client);
  return profile.orcid;
}

/* -------------------------------------------------------------------------- */
/* My papers: the moderation chip                                              */
/* -------------------------------------------------------------------------- */

/** The colour family of a chip; the word is always the information. */
export type ChipTone = "neutral" | "verified" | "pending";

/** The moderation state of a paper, as its own chip. */
export interface ModerationChip {
  /** The word on the chip. */
  readonly label: string;
  readonly tone: ChipTone;
  /** The version state it was made from (`held`, `listed`, …). */
  readonly state: string;
  /** `true` for a held or rejected version: a moderator has stopped it. */
  readonly stopped: boolean;
}

/**
 * How each version state (`paper_versions.state`) reads on the card. These are
 * the paper's *moderation* state, kept apart from the computed review status
 * (`preprint`, `under_review`, `contested`, …) so a hold is never mistaken for
 * a reviewer's rejection.
 */
const MODERATION_STATES: Readonly<Record<string, { label: string; tone: ChipTone }>> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_consent: { label: "Awaiting consent", tone: "pending" },
  scanning: { label: "Scanning", tone: "neutral" },
  moderation: { label: "In moderation", tone: "pending" },
  listed: { label: "Listed", tone: "verified" },
  held: { label: "Held", tone: "pending" },
  rejected: { label: "Rejected", tone: "pending" },
};

function sentenceCase(text: string): string {
  const spaced = text.replace(/[._-]+/g, " ").trim();
  return spaced === "" ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The moderation chip for a paper, or `null` when it has no version yet.
 *
 * `appealPending` is only meaningful for a paper a moderator stopped (held or
 * rejected): the author has appealed and no panel has decided, so the chip
 * says so instead of repeating the hold.
 */
export function moderationChip(
  paper: Pick<MyPaper, "state">,
  options: { readonly appealPending?: boolean } = {},
): ModerationChip | null {
  const state = paper.state;
  if (state === null) {
    return null;
  }
  const stopped = state === "held" || state === "rejected";
  if (stopped && options.appealPending === true) {
    return { label: "Appeal pending", tone: "pending", state, stopped };
  }
  const known = MODERATION_STATES[state];
  return {
    label: known?.label ?? sentenceCase(state),
    tone: known?.tone ?? "neutral",
    state,
    stopped,
  };
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

/** `GET /v1/me/notifications`, relative to `/v1`. */
export const NOTIFICATIONS_ENDPOINT = "/me/notifications";

/** `POST` target that marks one notification read. */
export function notificationReadEndpoint(id: number): string {
  return `${NOTIFICATIONS_ENDPOINT}/${encodeURIComponent(String(id))}/read`;
}

/**
 * Fired on `window` after a notification is marked read, so the global nav can
 * lower its bell count without asking the API again.
 * `detail.unread` is how many rows are still unread.
 */
export const NOTIFICATIONS_CHANGED_EVENT = "scholium:notifications-changed";

/** One row of `GET /v1/me/notifications` (`NotificationOut`). */
export interface NotificationItem {
  readonly id: number;
  readonly did: string;
  /** What happened, e.g. `consent.request`. */
  readonly kind: string;
  /** Whatever the sending module recorded; never rendered raw. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** `false` until the member opens it. */
  readonly read: boolean;
}

/** What the notification calls need from the API client. */
export type NotificationsClient = Pick<ApiClient, "get">;
export type NotificationsWriteClient = Pick<ApiClient, "post">;

/** Raised when the API answers with something that is not a notification list. */
export class NotificationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationsError";
  }
}

/**
 * Validate a `GET /v1/me/notifications` body.
 *
 * A body that is not a list, or a row with no `id` (it could never be marked
 * read), is rejected rather than shown as "no notifications": an empty card
 * would say there are none when the truth is "we don't know". Rows keep the
 * API's order (oldest first); the card reverses them for display.
 */
export function parseNotifications(payload: unknown): NotificationItem[] {
  if (!Array.isArray(payload)) {
    throw new NotificationsError("The API did not return a list of notifications.");
  }
  return payload.map((row, index) => {
    const id = isRecord(row) ? readNumber(row.id) : null;
    if (!isRecord(row) || id === null) {
      throw new NotificationsError(`Notification ${index + 1} has no id.`);
    }
    return {
      id: Math.trunc(id),
      did: readText(row.did) ?? "",
      kind: readText(row.kind) ?? "notification",
      payload: isRecord(row.payload) ? row.payload : {},
      // Unknown state reads as "needs your attention", like the nav's badge.
      read: row.read === true,
    };
  });
}

/** The viewer's notifications, oldest first, from `GET /v1/me/notifications`. */
export async function loadNotifications(
  client: NotificationsClient = api,
): Promise<NotificationItem[]> {
  const payload = await client.get<unknown>(NOTIFICATIONS_ENDPOINT, { cache: "no-store" });
  return parseNotifications(payload);
}

/**
 * Mark one notification read (`POST /v1/me/notifications/{id}/read`).
 *
 * `keepalive` lets the request outlive the page: opening a notification
 * follows its link in the same click, and an ordinary request would be
 * cancelled by that navigation.
 */
export async function markNotificationRead(
  id: number,
  client: NotificationsWriteClient = api,
): Promise<void> {
  await client.post<unknown>(notificationReadEndpoint(id), undefined, { keepalive: true });
}

/** How each notification kind is named on screen. */
const NOTIFICATION_KIND_LABELS: Readonly<Record<string, string>> = {
  "consent.request": "Consent request",
  "recovery.request": "Recovery approval",
  "recovery.guardians_changed": "Guardians changed",
  "moderation.decision": "Moderation outcome",
  "appeal.panel": "Appeal panel",
  "flag.decided": "Flag decision",
  "review.invitation": "Review invitation",
  review_invitation: "Review invitation",
  "email.verify": "Email verification",
};

/** The word for a notification kind; an unknown kind reads as itself, in words. */
export function notificationKindLabel(kind: string): string {
  return NOTIFICATION_KIND_LABELS[kind] ?? sentenceCase(kind);
}

type NotificationLike = Pick<NotificationItem, "kind" | "payload">;

const MODERATION_ACTION_SUMMARIES: Readonly<Record<string, string>> = {
  hold: "A moderator put your paper on hold.",
  reject: "A moderator rejected your paper.",
  release: "A moderator released your paper.",
  list: "A moderator listed your paper.",
  tombstone: "A moderator removed your paper.",
};

/** One plain sentence for what happened, never the payload's keys. */
export function notificationSummary({ kind, payload }: NotificationLike): string {
  switch (kind) {
    case "consent.request": {
      const version = readNumber(payload.n);
      return `A co-author consent is waiting for your signature${
        version === null ? "" : ` on version ${Math.trunc(version)}`
      }.`;
    }
    case "recovery.request":
      return "A recovery request needs your approval as a guardian.";
    case "recovery.guardians_changed":
      return "Your recovery guardians were changed.";
    case "moderation.decision":
      return (
        MODERATION_ACTION_SUMMARIES[readText(payload.action) ?? ""] ??
        "A moderator made a decision on your paper."
      );
    case "appeal.panel":
      return "You were drawn for an appeal panel.";
    case "flag.decided": {
      const status = readText(payload.status);
      return status === null ? "Your flag was decided." : `Your flag was ${status}.`;
    }
    case "review.invitation":
    case "review_invitation":
      return "You were invited to review a paper.";
    case "email.verify":
      return "Confirm your email address.";
    default:
      return (
        readText(payload.summary) ??
        readText(payload.message) ??
        readText(payload.title) ??
        sentenceCase(kind)
      );
  }
}

/** The reason a moderator or panel gave, when the notification carries one. */
export function notificationDetail({ payload }: Pick<NotificationItem, "payload">): string | null {
  return readText(payload.reason);
}

/** A path segment, with `:` left readable as the API's own links leave it. */
function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":");
}

/**
 * A link from the payload that is safe to put in an `href`: a path on this
 * site, or an absolute http(s) address. `javascript:` and protocol-relative
 * links are refused, and so is an API route (`/v1/…`), which the web origin
 * would answer with a 404.
 */
function safePayloadLink(payload: Readonly<Record<string, unknown>>): string | null {
  const link = readText(payload.link) ?? readText(payload.url);
  if (link === null) {
    return null;
  }
  if (link.startsWith("/")) {
    return link.startsWith("//") || /^\/v1(\/|$)/.test(link) ? null : link;
  }
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? link : null;
  } catch {
    return null;
  }
}

/**
 * Where a notification leads: the consent page, the guardian approval, the
 * paper a moderator decided on. Anything else uses the link the sender
 * recorded, if it is safe; otherwise there is nothing to open.
 */
export function notificationLink({ kind, payload }: NotificationLike): string | null {
  switch (kind) {
    case "consent.request": {
      const version = readText(payload.version_cid);
      if (version !== null) {
        return `/consent/${pathSegment(version)}`;
      }
      break;
    }
    case "recovery.request": {
      const request = readText(payload.request_id);
      if (request !== null) {
        return `/me/recovery/${pathSegment(request)}`;
      }
      break;
    }
    case "moderation.decision": {
      const target = readText(payload.target_cid);
      if (target !== null) {
        return `/p/${pathSegment(target)}`;
      }
      break;
    }
    default:
      break;
  }
  return safePayloadLink(payload);
}

/** Payload members that carry a time, most specific first. */
const NOTIFICATION_TIME_KEYS = [
  "created_at",
  "createdAt",
  "requested_at",
  "requestedAt",
  "decided_at",
  "decidedAt",
] as const;

/**
 * When a notification happened, as the ISO string its payload carries.
 *
 * The row itself has no timestamp, so this is only as good as what the sender
 * recorded; `null` means "unknown", and the card then shows no time rather
 * than inventing one.
 */
export function notificationTime({ payload }: Pick<NotificationItem, "payload">): string | null {
  for (const key of NOTIFICATION_TIME_KEYS) {
    const value = readText(payload[key]);
    if (value !== null && !Number.isNaN(Date.parse(value))) {
      return value;
    }
  }
  return null;
}

/** `45 minutes ago`, `1 day ago`; a plain date once it is over a month old. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return plural(minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return plural(hours, "hour");
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return plural(days, "day");
  }
  return new Date(then).toISOString().slice(0, 10);
}

/** Sort a failed notifications call into a plain message. */
export function describeNotificationsError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not return your notifications.";
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The API could not return your notifications.";
}

/** Sort a failed mark-read call into a plain message. */
export function describeMarkReadError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not mark this notification read.";
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The API could not mark this notification read.";
}
