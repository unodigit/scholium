/**
 * A member's public profile page (`/u/{did}`).
 *
 * `GET /v1/profiles/{did}` (feature 29) is the public view of a DID: the
 * decrypted name, affiliation and email, the linked ORCID iD, the trust tier
 * and the public signed reviews. The page is a public read, so no account is
 * needed to open it; an erased profile shows only the pseudonymous DID, the
 * tier and the signed reviews.
 *
 * Pure data and functions, no React, so the server route and the client
 * component share them (and vitest can test them without a JSX transform).
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import {
  DEFAULT_FEED_STATE,
  FEED_ENDPOINT,
  feedQuery,
  parseFeedPage,
  shortDid,
  type FeedItem,
} from "../feed/feed";

/** The `/u` route prefix (docs/design.md §4: Profile). */
export const PROFILE_PATH = "/u";

/** Alias kept for callers that name the route after the viewer. */
export const USER_PATH = "/u";

/** Alias kept for callers that name the route after the subject. */
export const PUBLIC_PROFILE_PATH = "/u";

/** Alias kept for callers that name the route after its segment. */
export const U_PATH = "/u";

/** Build the path for one DID. */
export function profilePath(did: string): string {
  return `${PROFILE_PATH}/${encodeURIComponent(did)}`;
}

/**
 * Decode the `/u/{did}` route segment once.
 *
 * A profile link built with {@link profilePath} carries a `did:key:…` with its
 * colons percent-encoded (`/u/did%3Akey%3A…`), and Next hands the route the
 * raw segment. Decoding it here — once, before the loader encodes it again for
 * the API — is what makes the request name the DID the link pointed at.
 * Malformed escaping is left untouched, as the other route parsers do.
 */
export function decodeProfileDid(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const PROFILE_ENDPOINT = "/profiles";

/** Human-facing label for the page and its links. */
export const PROFILE_TITLE = "Profile";

/**
 * What a profile is called on screen and in the tab: the member's name, else
 * the short pseudonymous DID (`z6MkpT…vktH`). A member who shared no name, or
 * whose profile was erased, is still a person the page can name.
 */
export function profileDisplayName(profile: Pick<ProfileData, "did" | "name">): string {
  return profile.name ?? shortDid(profile.did);
}

/** The short pseudonymous form of a DID, the way the feed names an author. */
export const profileShortDid = shortDid;

/** The trust tiers' plain names (`Tier` in the API). */
const TIER_LABELS = ["Reader", "Member", "Author", "Reviewer", "Moderator"] as const;

/** `Tier 3 · Reviewer`: the tier as a number and a word, never a colour. */
export function tierLabel(tier: number): string {
  const name = TIER_LABELS[tier];
  return name === undefined ? `Tier ${tier}` : `Tier ${tier} · ${name}`;
}

/** The public ORCID record of an iD. */
export function orcidUrl(orcid: string): string {
  return `https://orcid.org/${encodeURIComponent(orcid)}`;
}

/** Alias for callers that name the page after the viewer. */
export const USER_TITLE = "Profile";

/** Alias for callers that name the page after the subject. */
export const PUBLIC_PROFILE_TITLE = "Profile";

/** Sign-in is not required to read a profile. */
export const PROFILE_SIGNIN_HREF = `/signin`;

/**
 * Anything that can fetch a profile. The real implementation is the shared API
 * client; tests pass a narrow object with a single `get`.
 */
export type ProfileClient = Pick<ApiClient, "get" | "delete">;

/** Raised when the API answers with something that is not a profile. */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** Aliases for callers that name the error after the page or the subject. */
export class ProfilePageError extends ProfileError {}
export class PublicProfileError extends ProfileError {}
export class UserProfileError extends ProfileError {}

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

/** One revealed review the DID chose to sign with their name. */
export interface SignedReview {
  readonly review_cid: string;
  readonly reviewCid: string;
  readonly version_cid: string;
  readonly versionCid: string;
  /** The reviewed paper's short id (`sch:k3f9-…`), when the API can name it. */
  readonly paper_id: string | null;
  readonly paperId: string | null;
  /** The reviewed version's title, when the API can name it. */
  readonly paper_title: string | null;
  readonly paperTitle: string | null;
  /** The reviewed version's number, when the API can name it. */
  readonly version: number | null;
  readonly recommendation: string | null;
  readonly confidence: number | null;
  readonly scores: unknown;
  readonly report_cid: string | null;
  readonly reportCid: string | null;
  readonly committed_at: string | null;
  readonly committedAt: string | null;
  readonly revealed_at: string | null;
  readonly revealedAt: string | null;
}

/** The document `GET /v1/profiles/{did}` serves. */
export interface ProfileData {
  readonly did: string;
  readonly name: string | null;
  readonly affiliation: string | null;
  readonly email: string | null;
  readonly orcid: string | null;
  readonly tier: number;
  readonly erased: boolean;
  readonly reviews: readonly SignedReview[];
}

/** Aliases for callers that name the data after the page or the subject. */
export type ProfilePageData = ProfileData;
export type PublicProfileData = ProfileData;
export type UserProfileData = ProfileData;

function parseSignedReview(value: unknown, index: number): SignedReview {
  if (!isRecord(value)) {
    throw new ProfileError(`Signed review ${index + 1} is not an object.`);
  }
  const reviewCid =
    readText(value.review_cid) ?? readText(value.reviewCid) ?? readText(value.cid);
  if (reviewCid === null) {
    throw new ProfileError(`Signed review ${index + 1} has no review id.`);
  }
  const versionCid =
    readText(value.version_cid) ?? readText(value.versionCid) ?? readText(value.version) ?? "";
  const committed =
    readText(value.committed_at) ?? readText(value.committedAt) ?? null;
  const revealed =
    readText(value.revealed_at) ?? readText(value.revealedAt) ?? null;
  const reportCid = readText(value.report_cid) ?? readText(value.reportCid);
  const confidence = readNumber(value.confidence);
  const recommendation = readText(value.recommendation);
  // The paper the review was written on. The API serves `paper_id`/`title`;
  // the aliases cover the `me` vocabulary (`shortId`, `paper`, `title`).
  const paperId =
    readText(value.paper_id) ??
    readText(value.paperId) ??
    readText(value.short_id) ??
    readText(value.shortId) ??
    readText(value.paper);
  const paperTitle =
    readText(value.paper_title) ?? readText(value.paperTitle) ?? readText(value.title);
  const version = readNumber(value.version);
  return {
    review_cid: reviewCid,
    reviewCid,
    version_cid: versionCid,
    versionCid,
    paper_id: paperId,
    paperId,
    paper_title: paperTitle,
    paperTitle,
    version: version === null ? null : Math.trunc(version),
    recommendation,
    confidence: confidence === null ? null : Math.trunc(confidence),
    scores: value.scores ?? null,
    report_cid: reportCid,
    reportCid,
    committed_at: committed,
    committedAt: committed,
    revealed_at: revealed,
    revealedAt: revealed,
  };
}

/**
 * `/p/{id}` for the paper a signed review names, or `null` when the API could
 * not place it. Paper URLs drop the `sch:` prefix (docs/design.md §4), as the
 * feed's own `paperHref` does.
 */
export function signedReviewPaperHref(
  review: Pick<SignedReview, "paper_id">,
): string | null {
  const id = (review.paper_id ?? "").trim().replace(/^sch:/, "");
  return id === "" ? null : `/p/${encodeURIComponent(id)}`;
}

/**
 * Validate and normalise an API payload into a {@link ProfileData}.
 */
export function parseProfile(payload: unknown, did: string = ""): ProfileData {
  if (!isRecord(payload)) {
    throw new ProfileError("The API did not return a profile.");
  }
  const erased = readBool(payload.erased);
  const person = erased
    ? { name: null, affiliation: null, email: null, orcid: null }
    : {
        name: readText(payload.name) ?? readText(payload.displayName) ?? readText(payload.display_name),
        affiliation: readText(payload.affiliation),
        email: readText(payload.email),
        orcid: readText(payload.orcid) ?? readText(payload.orcid_id) ?? readText(payload.orcidId),
      };
  const reviews = Array.isArray(payload.reviews)
    ? payload.reviews.map((item, index) => parseSignedReview(item, index))
    : [];
  const tier = readNumber(payload.tier);
  return {
    did: readText(payload.did) ?? did,
    name: person.name,
    affiliation: person.affiliation,
    email: person.email,
    orcid: person.orcid,
    tier: tier === null ? 0 : Math.trunc(tier),
    erased,
    reviews,
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Load one public profile from `GET /v1/profiles/{did}`.
 */
export async function loadProfile(
  did: string,
  client: ProfileClient = api,
): Promise<ProfileData> {
  const payload = await client.get<unknown>(`/profiles/${encodeURIComponent(did)}`, {
    auth: false,
    cache: "no-store",
  });
  return parseProfile(payload, did);
}

/** Aliases for callers that name the loader after the page or the subject. */
export const loadProfilePage = loadProfile;
export const loadPublicProfile = loadProfile;
export const loadUserProfile = loadProfile;
export const fetchProfile = loadProfile;

/**
 * Erase the owner's profile via `DELETE /v1/profiles/{did}`.
 */
export async function eraseProfile(
  did: string,
  client: ProfileClient = api,
): Promise<void> {
  await client.delete(`/profiles/${encodeURIComponent(did)}`, {
    cache: "no-store",
  });
}

/** Aliases. */
export const deleteProfile = eraseProfile;
export const eraseMyProfile = eraseProfile;

/**
 * One plain-language sentence for the page's error state.
 */
export function describeProfileError(error: unknown): string {
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not return this profile.";
  }
  if (error instanceof ProfileError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "This profile could not be loaded.";
}

/** Aliases. */
export const describeProfilePageError = describeProfileError;
export const describePublicProfileError = describeProfileError;
export const describeUserProfileError = describeProfileError;


/** Aliases for callers that name the parser after the page or the subject. */
export const parseProfilePage = parseProfile;
export const parsePublicProfile = parseProfile;
export const parseUserProfile = parseProfile;

/* -------------------------------------------------------------------------- */
/* A member's papers                                                          */
/* -------------------------------------------------------------------------- */

/** How many pages of the catalog the Papers card reads before it stops. */
export const MEMBER_PAPERS_MAX_PAGES = 10;

/** The papers a member is an author of, found in the newest listed ones. */
export interface MemberPapers {
  readonly papers: readonly FeedItem[];
  /**
   * The search stopped at {@link MEMBER_PAPERS_MAX_PAGES} pages with more
   * listed papers unread, so older papers may be missing.
   */
  readonly truncated: boolean;
}

/**
 * The papers `did` is an author of, newest first.
 *
 * `GET /v1/papers` has no author filter yet, so this reads the newest listed
 * papers page by page and keeps the ones whose byline names the DID. It stops
 * after {@link MEMBER_PAPERS_MAX_PAGES} pages and says so (`truncated`) rather
 * than present a partial list as the whole. Public: no token is sent.
 */
export async function loadMemberPapers(
  did: string,
  client: Pick<ApiClient, "get"> = api,
): Promise<MemberPapers> {
  const papers: FeedItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MEMBER_PAPERS_MAX_PAGES; page += 1) {
    const payload: unknown = await client.get<unknown>(FEED_ENDPOINT, {
      query: feedQuery(DEFAULT_FEED_STATE, cursor),
      auth: false,
      cache: "no-store",
    });
    const data = parseFeedPage(payload);
    papers.push(...data.items.filter((item) => item.authors.some((author) => author.did === did)));
    cursor = data.nextCursor;
    if (cursor === null) {
      return { papers, truncated: false };
    }
  }
  return { papers, truncated: true };
}
