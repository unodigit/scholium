/**
 * Who may submit a paper, said early and in plain words.
 *
 * The node decides, when it receives the signed `paper.genesis`
 * (`apps/api/.../submissions/genesis.py`), and refuses three ways:
 *
 * - **Tier.** The author must be tier 2 (Author) or higher.
 * - **Endorsement.** The author must hold an active endorsement in *every*
 *   category the paper lists, whatever their tier.
 * - **Weekly limit.** A tier-2 account younger than 90 days may start one paper
 *   a week; the refusal carries the instant the next one is allowed.
 *
 * Before this module the wizard only found out at Sign and submit, after five
 * steps and an upload, and showed the API's own sentence: "paper.genesis" and a
 * raw ISO timestamp. Now `GET /v1/submissions/eligibility` is read when
 * `/submit` opens: it carries the tier, the rolling-week quota and the instant
 * the next paper is allowed, and the categories the viewer is endorsed in, all
 * from the code that refuses a genesis. `GET /v1/profiles/{did}` lends the
 * viewer's display name. The chosen categories are checked as they change, and
 * a refusal that still arrives at signing is mapped to a sentence by
 * {@link submissionProblemMessage}.
 *
 * Pure data and functions, no React, so the wizard, the Sign step and vitest
 * share them. Nothing here imports the `web-auth` index, which the server
 * boundary test forbids in plain modules.
 */

import { ApiError, api, type ApiClient } from "../../lib/api";
import { shortDid } from "./authors";

/** The lowest trust tier that may start a paper (tier 2, Author). */
export const SUBMIT_MIN_TIER = 2;

/** Problem `type` URIs the node answers a refused genesis with (`submissions/errors.py`, `ingest/errors.py`). */
export const PROBLEM_GENESIS_RATE_LIMITED = "urn:scholium:problem:genesis-rate-limited";
export const PROBLEM_CATEGORY_NOT_ENDORSED = "urn:scholium:problem:category-not-endorsed";
export const PROBLEM_INSUFFICIENT_TIER = "urn:scholium:problem:insufficient-tier";

/** The trust tiers by name (docs/tech_architect.md, "Trust tiers"). */
const TIER_NAMES: Readonly<Record<number, string>> = {
  0: "Reader",
  1: "Member",
  2: "Author",
  3: "Reviewer",
  4: "Moderator",
};

/** What the profile can say about whether its owner may submit; `null` is "could not tell". */
export interface EligibilityFacts {
  /** The trust tier, 0 to 4. */
  tier: number | null;
  /** The categories the viewer holds an active endorsement in. */
  endorsedCategories: readonly string[] | null;
  /** When the weekly limit next lets a paper start, if the limit applies and is known. */
  nextAllowedAt: Date | null;
  /** The viewer's profile name, for showing them as a person rather than a DID. */
  name: string | null;
}

/** Asks the node what the viewer may do. Tests and callers with their own client replace it. */
export type FetchEligibility = (did: string | null, signal?: AbortSignal) => Promise<EligibilityFacts>;

/** Locale and zone for the dates in a message. Both default to the viewer's own. */
export interface FormatOptions {
  locale?: string | string[];
  timeZone?: string;
}

export interface DescribeOptions extends FormatOptions {
  /** The viewer's DID, so "how to get endorsed" can point at their profile. */
  did?: string | null;
}

/** One reason the viewer cannot submit, as data. {@link describeBlocker} words it. */
export type Blocker =
  | { kind: "tier"; tier: number; required?: number }
  | { kind: "no-endorsement" }
  | { kind: "categories"; missing: readonly string[]; endorsed: readonly string[] }
  | { kind: "weekly-limit"; nextAllowedAt: Date };

export interface BlockerMessage {
  kind: Blocker["kind"];
  title: string;
  body: string;
  /** A link that helps the viewer fix it, or `null` when waiting is the only fix. */
  help: { href: string; label: string } | null;
}

/** The label of the help link, in one place so the words match everywhere. */
export const HOW_TO_GET_ENDORSED = "How to get endorsed";

/* -------------------------------------------------------------------------- */
/* Finding blockers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What stops the viewer submitting in `categories`. Facts the node could not
 * give are not blockers: this never guesses, because the node's refusal at
 * signing is still the authority, and a wrong "you can't" is worse than a late
 * "you can't".
 */
export function findBlockers(
  facts: EligibilityFacts,
  categories: readonly string[],
  now: Date = new Date(),
): Blocker[] {
  const blockers: Blocker[] = [];
  const { tier, endorsedCategories } = facts;

  if (tier !== null && tier < SUBMIT_MIN_TIER) {
    // An endorsement is what grants tier 2, so a Member's missing endorsements
    // are the same problem; say it once.
    blockers.push({ kind: "tier", tier });
  } else if (endorsedCategories !== null) {
    if (endorsedCategories.length === 0) {
      blockers.push({ kind: "no-endorsement" });
    } else {
      const missing = [...new Set(categories)].filter((category) => !endorsedCategories.includes(category));
      if (missing.length > 0) {
        blockers.push({ kind: "categories", missing, endorsed: [...endorsedCategories] });
      }
    }
  }

  if (facts.nextAllowedAt !== null && facts.nextAllowedAt.getTime() > now.getTime()) {
    blockers.push({ kind: "weekly-limit", nextAllowedAt: facts.nextAllowedAt });
  }
  return blockers;
}

/* -------------------------------------------------------------------------- */
/* Wording                                                                    */
/* -------------------------------------------------------------------------- */

/** An instant as the viewer reads one: their locale, their zone, weekday and time included. */
export function formatAllowedAt(date: Date, options: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(date);
}

/** "cs.CL", "cs.CL and math.CO", "cs.CL, math.CO and cs.CV". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function tierName(tier: number): string {
  return TIER_NAMES[tier] ?? "Reader";
}

/** Where a viewer goes to get endorsed: their public profile, where an endorser acts. */
export function endorsementHelpHref(did: string | null | undefined): string {
  return typeof did === "string" && did !== "" ? `/u/${encodeURIComponent(did)}` : "/me";
}

/** A blocker in the words the viewer reads. Never a record type, never an ISO string. */
export function describeBlocker(blocker: Blocker, options: DescribeOptions = {}): BlockerMessage {
  const help = { href: endorsementHelpHref(options.did), label: HOW_TO_GET_ENDORSED };

  switch (blocker.kind) {
    case "tier": {
      const required = blocker.required ?? SUBMIT_MIN_TIER;
      if (required !== SUBMIT_MIN_TIER) {
        return {
          kind: "tier",
          title: `This needs a ${tierName(required)} account`,
          body: `Your account is a ${tierName(blocker.tier)} account, so this was refused.`,
          help: null,
        };
      }
      return {
        kind: "tier",
        title: "Submitting needs an Author account",
        body:
          `Your account is a ${tierName(blocker.tier)} account. An established Reviewer makes you an Author by ` +
          "endorsing you in a category. You can prepare a draft now; it cannot be signed until you are endorsed.",
        help,
      };
    }
    case "no-endorsement":
      return {
        kind: "no-endorsement",
        title: "You are not endorsed in any category yet",
        body:
          "You can submit only in a category where an established Reviewer has endorsed you. " +
          "You can prepare a draft now; it cannot be signed until you are endorsed.",
        help,
      };
    case "categories": {
      const demonstrative = blocker.missing.length === 1 ? "this category" : "these categories";
      const held =
        blocker.endorsed.length > 0 ? ` You are endorsed in ${joinList(blocker.endorsed)}.` : "";
      return {
        kind: "categories",
        title: `You are not endorsed in ${joinList(blocker.missing)}`,
        body:
          `You can submit only in a category where you hold an endorsement. Remove ${demonstrative}, ` +
          `or ask a Reviewer to endorse you there.${held}`,
        help,
      };
    }
    case "weekly-limit":
      return {
        kind: "weekly-limit",
        title: "New Author accounts can start one new paper a week",
        body: `You started a paper in the last week. You can start your next one from ${formatAllowedAt(
          blocker.nextAllowedAt,
          options,
        )}.`,
        help: null,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* A refusal at signing, in plain words                                       */
/* -------------------------------------------------------------------------- */

/** The record types a message may name, and the noun a reader knows them by. */
const RECORD_NOUNS: Readonly<Record<string, string>> = {
  "paper.genesis": "paper",
  "paper.version": "paper version",
  "coauthor.consent": "co-author consent",
  "review.commit": "review",
  "review.formal": "review",
  "review.response": "review response",
  "review.rating": "review rating",
  "discussion.post": "discussion post",
  "ai.review": "AI review",
  "key.rotation": "key rotation",
  "external.mirror": "mirror",
  "moderation.decision": "moderation decision",
  "erasure.request": "erasure request",
};

const RECORD_TYPE_PATTERN = new RegExp(
  `['"]?\\b(${Object.keys(RECORD_NOUNS)
    .map((type) => type.replace(".", "\\."))
    .join("|")})\\b['"]?`,
  "g",
);

const ISO_INSTANT_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

const DID_PATTERN = /\bdid:[a-z0-9]+:[A-Za-z0-9._%-]{12,}/g;

/** An ISO 8601 string as a `Date`, or `null` when it is not one. */
function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Take the node's plumbing out of a sentence: record types become the thing a
 * reader calls them, ISO timestamps become a date in the viewer's locale and
 * long DIDs are shortened. A problem the mapping does not know still reads
 * sensibly, and an ordinary message passes through unchanged.
 */
function scrub(text: string, options: DescribeOptions): string {
  return text
    .replace(RECORD_TYPE_PATTERN, (_match, type: string) => RECORD_NOUNS[type] ?? type)
    .replace(ISO_INSTANT_PATTERN, (iso) => {
      const instant = parseInstant(iso);
      return instant === null ? iso : formatAllowedAt(instant, options);
    })
    .replace(DID_PATTERN, (did) => shortDid(did))
    .trim();
}

const UNKNOWN_REFUSAL = "Your paper could not be submitted. Please try again.";

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** A known refusal as a sentence, or `null` when the mapping has nothing for it. */
function mapProblem(error: ApiError, options: DescribeOptions): string | null {
  const { problem } = error;
  let blocker: Blocker | null = null;

  if (error.type === PROBLEM_GENESIS_RATE_LIMITED) {
    const next = parseInstant(problem.next_allowed_at) ?? parseInstant(problem.next_allowed_date);
    blocker = next === null ? null : { kind: "weekly-limit", nextAllowedAt: next };
  } else if (error.type === PROBLEM_CATEGORY_NOT_ENDORSED) {
    const missing = asStringList(problem.unendorsed_categories);
    blocker = missing.length === 0 ? null : { kind: "categories", missing, endorsed: [] };
  } else if (error.type === PROBLEM_INSUFFICIENT_TIER) {
    const tier = problem.author_tier;
    const required = problem.required_tier;
    if (typeof tier === "number") {
      blocker = { kind: "tier", tier, ...(typeof required === "number" ? { required } : {}) };
    }
  }

  if (blocker === null) {
    return null;
  }
  const { title, body } = describeBlocker(blocker, options);
  return `${title}. ${body}`;
}

/**
 * What to tell the author when signing is refused. The weekly limit, the
 * endorsement rule and the tier rule are worded from the problem's own fields;
 * anything else keeps the node's sentence with record types, timestamps and
 * DIDs made readable.
 */
export function submissionProblemMessage(error: unknown, options: DescribeOptions = {}): string {
  if (error instanceof ApiError) {
    return mapProblem(error, options) ?? (scrub(error.detail, options) || UNKNOWN_REFUSAL);
  }
  if (error instanceof Error) {
    return scrub(error.message, options) || UNKNOWN_REFUSAL;
  }
  if (typeof error === "string") {
    return scrub(error, options) || UNKNOWN_REFUSAL;
  }
  return UNKNOWN_REFUSAL;
}

/* -------------------------------------------------------------------------- */
/* Reading the facts                                                          */
/* -------------------------------------------------------------------------- */

/** Something the node said is unreadable: leave the fact unknown rather than fail the check. */
async function attempt<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch {
    return null;
  }
}

interface ProfileBody {
  name?: unknown;
}

/** The part of `GET /v1/submissions/eligibility` this module reads. */
interface EligibilityBody {
  tier?: unknown;
  endorsed_categories?: unknown;
  next_allowed_at?: unknown;
}

/**
 * Reads the viewer's tier, weekly quota and endorsed categories from
 * `GET /v1/submissions/eligibility`, and their display name from
 * `GET /v1/profiles/{did}`. Each is read on its own: one that fails is unknown,
 * not an error, so a profile outage never stops anyone submitting.
 */
export async function fetchEligibility(
  did: string | null,
  client: Pick<ApiClient, "get"> = api,
  signal?: AbortSignal,
): Promise<EligibilityFacts> {
  const [eligibility, profile] = await Promise.all([
    attempt(client.get<EligibilityBody>("/submissions/eligibility", { signal })),
    did === null
      ? Promise.resolve(null)
      : attempt(client.get<ProfileBody>(`/profiles/${encodeURIComponent(did)}`, { signal })),
  ]);

  const tier = eligibility?.tier;
  const categories = eligibility?.endorsed_categories;
  const name = typeof profile?.name === "string" ? profile.name.trim() : "";

  return {
    tier: typeof tier === "number" && Number.isInteger(tier) && tier >= 0 && tier <= 4 ? tier : null,
    endorsedCategories: Array.isArray(categories)
      ? [
          ...new Set(
            categories.filter(
              (category): category is string => typeof category === "string" && category !== "",
            ),
          ),
        ]
      : null,
    nextAllowedAt: parseInstant(eligibility?.next_allowed_at),
    name: name === "" ? null : name,
  };
}
