/**
 * Endorsing a researcher from their public profile (`/u/{did}`) — ID-5.
 *
 * An endorsement is a signed record, not a form post: the endorser's key
 * vouches that a DID may submit in a category. Two API surfaces are involved
 * (`apps/api/src/app/modules/endorsements/`):
 *
 * - `GET /v1/me/endorsements` — the signed-in viewer's own *active*
 *   endorsements, each with its category. An endorsement there grants the
 *   right to *submit* in that category; it is a convenience source for the
 *   per-category quick actions, never a licence to endorse. Only a viewer at
 *   {@link ENDORSE_MIN_TIER} or above is offered any endorse action at all.
 * - `POST /v1/records` — the standard ingest pipeline for a client-signed
 *   `endorsement` record (`{endorsee, category}`). The API is the gate: it
 *   accepts the record only from an author at
 *   {@link ENDORSE_MIN_TIER} or above, so a tier-3 viewer may endorse in
 *   *any* category ({@link EndorseOffer.anyCategory}) and a refused record is
 *   reported with the API's own words rather than silently swallowed. The
 *   profile mirrors that tier rule so the action is never offered to a
 *   viewer the API would refuse.
 *
 * {@link endorseResearcher} signs with `web-auth`'s `signRecord` — the
 * passkey prompt *is* the confirmation — and posts the signed envelope.
 *
 * Pure data and functions, no React, so the component and vitest share them.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import {
  isPasskeyCancellation,
  signRecord,
  type SignedRecord,
  type SignRecordOptions,
} from "../web-auth";

/** Record type an endorsement is submitted as. */
export const ENDORSEMENT_RECORD_TYPE = "endorsement";

/** `GET` path (under `/v1`) listing the caller's active endorsements. */
export const MY_ENDORSEMENTS_ENDPOINT = "/me/endorsements";

/** `POST` path (under `/v1`) every signed record is submitted to. */
export const RECORDS_ENDPOINT = "/records";

/**
 * The tier an endorsement record's author must hold (`Tier.REVIEWER` in the
 * API). At or above it the API places no limit on the category.
 */
export const ENDORSE_MIN_TIER = 3;

/** The DID shape the endorsement record's schema accepts. */
const ENDORSEE_DID_PATTERN = /^did:[a-z0-9]+:.+$/;

/** Anything that can read the viewer's endorsements and post a record. */
export type EndorseClient = Pick<ApiClient, "get" | "post">;

/** The caller did not name a DID or a category to endorse in. */
export class EndorseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndorseInputError";
  }
}

/** The signer produced a record of another type. */
export class WrongEndorsementRecordError extends Error {
  constructor(actual: string) {
    super(
      `The signer produced a ${actual} record, not an ${ENDORSEMENT_RECORD_TYPE} record.`,
    );
    this.name = "WrongEndorsementRecordError";
  }
}

/* -------------------------------------------------------------------------- */
/* The viewer                                                                 */
/* -------------------------------------------------------------------------- */

/** What the profile can know about the person looking at it. */
export interface ViewerIdentity {
  /** An access token is held; without it nothing is offered. */
  readonly signedIn: boolean;
  /** The viewer's `did:key` (the token's `sub` claim), when it names one. */
  readonly did: string | null;
  /** The viewer's trust tier (0–4), when the token names it. */
  readonly tier: number | null;
}

/** Nobody is signed in. */
export const SIGNED_OUT_VIEWER: ViewerIdentity = { signedIn: false, did: null, tier: null };

/** Decode one base64url JWT segment to text; `null` when it is not valid. */
function decodeSegment(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * The viewer an access token describes: its `sub` (DID) and `tier` claims.
 * Never throws — an opaque token is a signed-in viewer whose DID and tier are
 * unknown, and the API still decides what they may do.
 */
export function viewerFromAccessToken(
  accessToken: string | null | undefined,
): ViewerIdentity {
  if (typeof accessToken !== "string" || accessToken === "") return SIGNED_OUT_VIEWER;

  const unknown: ViewerIdentity = { signedIn: true, did: null, tier: null };
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

/* -------------------------------------------------------------------------- */
/* The viewer's own endorsements                                              */
/* -------------------------------------------------------------------------- */

/** One active endorsement of the viewer, as `GET /v1/me/endorsements` serves. */
export interface ViewerEndorsement {
  readonly recordCid: string;
  readonly endorserDid: string;
  readonly endorseeDid: string;
  readonly category: string;
  /** ISO 8601 instant the endorsement lapses, or `null` when it never does. */
  readonly expiresAt: string | null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Validate a `GET /v1/me/endorsements` body into {@link ViewerEndorsement}s.
 *
 * A row without a usable `category` is skipped rather than fatal: it can only
 * make the offer smaller, never offer a right the viewer does not hold. A
 * payload that is not a list at all is refused, because "no list" and "cannot
 * read the list" must not blur together.
 */
export function parseViewerEndorsements(payload: unknown): ViewerEndorsement[] {
  if (!Array.isArray(payload)) {
    throw new EndorseInputError("The API did not return a list of endorsements.");
  }
  const rows: ViewerEndorsement[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const category = readText(raw.category);
    if (category === null) continue;
    rows.push({
      recordCid: readText(raw.record_cid) ?? readText(raw.recordCid) ?? "",
      endorserDid: readText(raw.endorser_did) ?? readText(raw.endorserDid) ?? "",
      endorseeDid: readText(raw.endorsee_did) ?? readText(raw.endorseeDid) ?? "",
      category,
      expiresAt: readText(raw.expires_at) ?? readText(raw.expiresAt),
    });
  }
  return rows;
}

/** Load the viewer's active endorsements from `GET /v1/me/endorsements`. */
export async function loadViewerEndorsements(
  client: Pick<ApiClient, "get"> = api,
): Promise<ViewerEndorsement[]> {
  const payload = await client.get<unknown>(MY_ENDORSEMENTS_ENDPOINT, {
    cache: "no-store",
  });
  return parseViewerEndorsements(payload);
}

/* -------------------------------------------------------------------------- */
/* What to offer                                                              */
/* -------------------------------------------------------------------------- */

/** The endorse actions the profile puts in front of the viewer. */
export interface EndorseOffer {
  /**
   * One action per category the viewer may submit in — a shortcut, offered
   * only alongside {@link anyCategory}; it never widens what the API grants.
   */
  readonly categories: readonly string[];
  /**
   * The API accepts an endorsement record from a tier-3 author in *any*
   * category, so such a viewer gets a category choice instead of a list.
   * An unknown tier is offered the same choice; the API decides. A known
   * tier below {@link ENDORSE_MIN_TIER} gets no offer at all.
   */
  readonly anyCategory: boolean;
}

/** Nothing is offered. */
export const NO_ENDORSE_OFFER: EndorseOffer = { categories: [], anyCategory: false };

/**
 * Which endorse actions `viewer` gets, from the API's rules: a viewer at
 * {@link ENDORSE_MIN_TIER} or above (or one whose tier is unknown) may
 * endorse, with their endorsed categories offered as quick actions and a
 * category picker beside them. Everyone below that tier gets nothing — the
 * API would refuse every record they posted.
 */
export function endorseOffer(
  viewerTier: number | null,
  endorsements: readonly ViewerEndorsement[],
): EndorseOffer {
  // The API accepts an endorsement record only from an author at
  // ENDORSE_MIN_TIER or above, in any category (`handle_endorsement`). An
  // endorsement the viewer holds grants the right to *submit* in its
  // category, never the right to endorse, so it cannot make up for a tier
  // the API refuses.
  const anyCategory = viewerTier === null || viewerTier >= ENDORSE_MIN_TIER;
  if (!anyCategory) return NO_ENDORSE_OFFER;

  const categories = [...new Set(endorsements.map((row) => row.category))].sort();
  return { categories, anyCategory };
}

/** `Endorse in cs.AI` — the action, named after the category. */
export function endorseActionLabel(category: string): string {
  return `Endorse in ${category}`;
}

/** `✓ Endorsed in cs.AI` — the state after the record is accepted. */
export function endorsedActionLabel(category: string): string {
  return `✓ Endorsed in ${category}`;
}

/* -------------------------------------------------------------------------- */
/* Signing and posting                                                        */
/* -------------------------------------------------------------------------- */

/** Who to endorse, and in which category. */
export interface EndorseInput {
  /** The profile being viewed. */
  readonly endorseeDid: string;
  /** An arXiv-style category id, e.g. `cs.AI`. */
  readonly category: string;
}

/** Signs an `endorsement`; `web-auth`'s `signRecord` by default. */
export type SignEndorsement = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
  options?: SignRecordOptions,
) => Promise<SignedRecord>;

/** Sends the signed record; `POST /v1/records` by default. */
export type SubmitEndorsement = (record: SignedRecord) => Promise<unknown>;

/** Replacement seams, for tests or another client. */
export interface EndorseSeams {
  /** Signs the record behind the passkey prompt. */
  readonly sign?: SignEndorsement;
  /** Posts the signed record. */
  readonly submit?: SubmitEndorsement;
}

/** What an accepted endorsement produced. */
export interface EndorseResult {
  /** cid of the accepted `endorsement` record. */
  readonly recordCid: string;
  /** The category it was issued in. */
  readonly category: string;
  /** The state the API reported, when it names one. */
  readonly state: string | null;
}

function requireInput(input: EndorseInput): { endorsee: string; category: string } {
  const endorsee = input.endorseeDid.trim();
  if (!ENDORSEE_DID_PATTERN.test(endorsee)) {
    throw new EndorseInputError(
      "An endorsement needs the researcher's DID, like did:key:z6Mk…",
    );
  }
  const category = input.category.trim();
  if (category === "") {
    throw new EndorseInputError("Choose a category to endorse in.");
  }
  return { endorsee, category };
}

/**
 * Sign an endorsement of `endorseeDid` in `category` and post it.
 *
 * Nothing is sent until the record is signed — the passkey prompt is the
 * endorser's confirmation — and the endorsement has no expiry: it stands
 * until the endorser's own record says otherwise.
 *
 * @throws {EndorseInputError} the DID or category is missing.
 * @throws {WrongEndorsementRecordError} the signer produced another type.
 * @throws {DeviceKeyError} no key, a dismissed prompt or a failed signature.
 * @throws {ApiError | NetworkError} the API refused the record or was unreachable.
 */
export async function endorseResearcher(
  input: EndorseInput,
  seams: EndorseSeams = {},
): Promise<EndorseResult> {
  const { endorsee, category } = requireInput(input);
  const sign = seams.sign ?? signRecord;
  const submit =
    seams.submit ?? ((record: SignedRecord) => api.post<unknown>(RECORDS_ENDPOINT, record));

  const record = await sign(ENDORSEMENT_RECORD_TYPE, { endorsee, category }, null);
  if (record.type !== ENDORSEMENT_RECORD_TYPE) {
    throw new WrongEndorsementRecordError(record.type);
  }

  const accepted = await submit(record);
  const answer =
    typeof accepted === "object" && accepted !== null
      ? (accepted as Record<string, unknown>)
      : {};
  const recordCid = readText(answer.id) ?? readText(answer.record_cid) ?? record.id;
  const state = readText(answer.state);
  return { recordCid, category, state };
}

/**
 * One plain-language sentence for a failed endorsement. The API's refusal is
 * quoted as-is — it names the tier rule — and a dismissed passkey prompt is
 * reported as the no-op it is.
 */
export function describeEndorseError(error: unknown): string {
  if (isPasskeyCancellation(error)) {
    return "The passkey prompt was dismissed. Nothing was endorsed.";
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Sign in to endorse researchers.";
    }
    return error.detail || error.title || "The API refused this endorsement.";
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof EndorseInputError) {
    return error.message;
  }
  if (error instanceof WrongEndorsementRecordError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The endorsement could not be posted.";
}
