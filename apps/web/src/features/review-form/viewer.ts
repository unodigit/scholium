/**
 * Who is looking at a review card, and what the card should offer them.
 *
 * The card offers an author a point-by-point reply form and a tier-3 member a
 * quality rating. Both are only a convenience for the reader: **the API is the
 * gate** (`POST /v1/reviews/{cid}/response` answers `403` to anyone not on the
 * byline; `POST /v1/reviews/{cid}/rating` answers `403` to a lower tier, to the
 * review's own reviewer and to an author). So the viewer here is read from the
 * claims inside the signed-in account's access token — `sub` (their `did:key`)
 * and `tier` — and used only to decide which control to put in front of them.
 * A claim that is stale or missing never blocks anything the API would allow.
 *
 * Two things the card cannot know, by design:
 *
 * - whether the viewer *wrote* the review: a reviewer's identity is escrowed,
 *   so the API says so (`403`, "The reviewer of a review may not rate it.");
 * - whether the viewer is an author, from the token alone: that is the paper's
 *   byline, which {@link loadPaperAuthors} reads.
 *
 * Pure functions and one small loader; no React.
 */

import { api, type ApiClient } from "../../lib/api";

/** The lowest tier that may rate a review (`Tier.REVIEWER` in the API). */
export const RATING_MIN_TIER = 3;

/** What the card knows about the person looking at it. */
export interface Viewer {
  /** An access token is held; without one the card offers nothing. */
  readonly signedIn: boolean;
  /** The viewer's `did:key` (the token's `sub`), when the token names it. */
  readonly did: string | null;
  /** The viewer's trust tier (0–4), when the token names it. */
  readonly tier: number | null;
}

/** Nobody is signed in. */
export const SIGNED_OUT: Viewer = { signedIn: false, did: null, tier: null };

/** Decode one base64url segment to text; `null` when it is not valid. */
function decodeSegment(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The viewer an access token describes. Never throws: a token that is not a
 * JWT, or whose claims are not what the API issues, is a signed-in viewer
 * whose DID and tier are unknown (the API still decides).
 *
 * The signature is **not** checked: nothing here is trusted, it only picks a
 * control to show.
 */
export function viewerFromToken(accessToken: string | null | undefined): Viewer {
  if (typeof accessToken !== "string" || accessToken === "") return SIGNED_OUT;

  const unknown: Viewer = { signedIn: true, did: null, tier: null };
  const segments = accessToken.split(".");
  if (segments.length !== 3) return unknown;

  const text = decodeSegment(segments[1] ?? "");
  if (text === null) return unknown;

  let claims: unknown;
  try {
    claims = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (typeof claims !== "object" || claims === null) return unknown;

  const { sub, tier } = claims as { sub?: unknown; tier?: unknown };
  return {
    signedIn: true,
    did: typeof sub === "string" && sub !== "" ? sub : null,
    tier:
      typeof tier === "number" && Number.isInteger(tier) && tier >= 0 && tier <= 4
        ? tier
        : null,
  };
}

/** What the card offers the viewer. */
export interface Offer {
  /** The point-by-point reply form (paper authors). */
  readonly reply: boolean;
  /** The quality rating (tier-3 members who are not authors). */
  readonly rate: boolean;
}

/** Nothing is offered. */
export const NO_OFFER: Offer = { reply: false, rate: false };

/**
 * What to put in front of `viewer`, given the paper's byline.
 *
 * - **Reply**: only a viewer whose DID is on the byline. With no byline (not
 *   yet read, or unreadable) nothing can be said, so the form stays out of
 *   the way; the API would refuse anyone else anyway.
 * - **Rate**: a signed-in viewer whose tier is not known to be below tier 3,
 *   and who is not an author. An unknown tier is allowed through, because the
 *   API (which reads the current tier, not the one in a short-lived token)
 *   decides.
 *
 * @param authorDids the paper's authors' DIDs, or `null` when not known.
 */
export function offerFor(
  viewer: Viewer,
  authorDids: readonly string[] | null,
): Offer {
  if (!viewer.signedIn) return NO_OFFER;

  const isAuthor =
    authorDids !== null && viewer.did !== null && authorDids.includes(viewer.did);
  if (isAuthor) return { reply: true, rate: false };

  const tierAllows = viewer.tier === null || viewer.tier >= RATING_MIN_TIER;
  return { reply: false, rate: tierAllows };
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type AuthorsClient = Pick<ApiClient, "get">;

/** Reads a paper's authors' DIDs; {@link loadPaperAuthors} by default. */
export type LoadPaperAuthors = (
  paperId: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

/** Splits a `/vN` suffix off a version id: the endpoint wants the paper's id. */
function paperOf(paperId: string): string {
  const match = /^(.+?)\/v\d+$/.exec(paperId.trim());
  return match?.[1] ?? paperId.trim();
}

/** The DIDs in a `GET /v1/papers/{id}` payload's `authors`. Never throws. */
export function parseAuthorDids(raw: unknown): string[] {
  const authors =
    typeof raw === "object" && raw !== null
      ? (raw as { authors?: unknown }).authors
      : undefined;
  if (!Array.isArray(authors)) return [];

  const dids: string[] = [];
  for (const entry of authors) {
    const candidate =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null
          ? ((entry as { did?: unknown }).did ??
            (entry as { author?: unknown }).author)
          : undefined;
    if (typeof candidate === "string" && candidate !== "" && !dids.includes(candidate)) {
      dids.push(candidate);
    }
  }
  return dids;
}

/** The authors' DIDs of a paper, from the public `GET /v1/papers/{id}`. */
export async function loadPaperAuthors(
  paperId: string,
  signal?: AbortSignal,
  client: AuthorsClient = api,
): Promise<readonly string[]> {
  const body = await client.get<unknown>(
    `/papers/${encodeURIComponent(paperOf(paperId))}`,
    { auth: false, cache: "no-store", signal },
  );
  return parseAuthorDids(body);
}
