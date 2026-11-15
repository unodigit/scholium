/**
 * The four decisions a DecisionBanner can announce, and everything that
 * decides how each one looks and reads: its word, its icon, its colour
 * family and its default sentence.
 *
 * The words and tones are docs/design.md §5.2's banner list, verbatim:
 * *Retracted* (critical), *Corrected* (pending), *A newer version exists*
 * (neutral), *Content removed for legal reasons* (neutral, with reason
 * category). §7 adds the rule every banner obeys: it links to the record
 * and the policy clause, and principle 6 says why — every decision shows
 * its reason.
 *
 * `retracted` and `corrected` reuse the wire values of the API's
 * `compute_status` (see ./status.ts), so a paper page can pass a computed
 * status straight through as the banner kind. `newer_version` and
 * `removed_legal` are not paper statuses: one comes from comparing version
 * numbers, the other from the tombstone state of the content.
 *
 * Pure data and functions, no React: the markup lives in
 * ./decision-banner.ts.
 */

import type { IconName } from "./icons";

/**
 * The four banner kinds, in docs/design.md §5.2's order: the two notices a
 * record can carry, then the two states a page discovers about itself.
 */
export const DECISION_KINDS = [
  "retracted",
  "corrected",
  "newer_version",
  "removed_legal",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * Colour family of a banner (docs/design.md §3), the same families a
 * StatusChip uses. It maps onto a token pair in `decision-banner.css`:
 * `critical` → `--critical` on `--critical-soft`, `pending` → `--pending`
 * on `--pending-soft`; `neutral` uses `--ink-2` and `--rule` on
 * `--surface`. Two banners share `neutral` on purpose: a newer version and
 * a legal removal are facts, not fault states (design.md §5.2).
 */
export type DecisionTone = "neutral" | "pending" | "critical";

export interface DecisionBannerSpec {
  readonly kind: DecisionKind;
  /** The words at the head of the banner (docs/design.md §5.2, verbatim). */
  readonly label: string;
  readonly tone: DecisionTone;
  /** A different silhouette per kind: a banner must survive without colour. */
  readonly icon: IconName;
  /** The sentence under the word when the decision's own reason is unknown. */
  readonly detail: string;
  /** One plain-language line, for galleries and tooltips. */
  readonly meaning: string;
}

export const DECISION_BANNER_SPECS: Readonly<
  Record<DecisionKind, DecisionBannerSpec>
> = {
  retracted: {
    kind: "retracted",
    label: "Retracted",
    tone: "critical",
    icon: "ban",
    detail: "A retraction notice is on record. Every version carries it.",
    meaning:
      "A retraction notice is on record. The banner appears on every version, in search results and in citation exports.",
  },
  corrected: {
    kind: "corrected",
    label: "Corrected",
    tone: "pending",
    icon: "pencil",
    detail: "A correction notice is on record.",
    meaning:
      "A correction notice is on record. Like a retraction, it travels with every version.",
  },
  newer_version: {
    kind: "newer_version",
    label: "A newer version exists",
    tone: "neutral",
    icon: "update",
    detail: "You are reading an older version of this paper.",
    meaning:
      "Shown on any version that is not the newest, with a link to the newest one.",
  },
  removed_legal: {
    kind: "removed_legal",
    label: "Content removed for legal reasons",
    tone: "neutral",
    icon: "tombstone",
    detail: "The record of its existence remains.",
    meaning:
      "Moderators tombstoned the content. The bytes are deleted; the record of the decision stays verifiable.",
  },
};

/** Narrow an unknown value (an API field, a prop) to a banner kind. */
export function isDecisionKind(value: unknown): value is DecisionKind {
  return (
    typeof value === "string" &&
    (DECISION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The extra sentences a decision can contribute to its banner: the reason
 * signed in its record, and the facts of the two page-discovered kinds.
 */
export interface DecisionContext {
  /**
   * The decision's own reason, signed in its record (`body.reason` of a
   * `retraction`, `correction` or `moderation.decision`). When present it
   * is the banner's sentence, verbatim — principle 6: every decision shows
   * its reason.
   */
  reason?: string;
  /**
   * `newer_version`: how the newest version is named, e.g. `"v3"`. Used by
   * the detail sentence and the link to it.
   */
  versionLabel?: string;
  /**
   * `removed_legal`: when the content was removed, already formatted for
   * reading, e.g. `"4 May 2027"`. Formatting a date is the caller's job;
   * the banner never guesses a locale.
   */
  removedOn?: string;
  /**
   * `removed_legal`: the reason category, e.g. `"Unlawful content"`
   * (docs/design.md §5.2: "with reason category").
   */
  category?: string;
}

/** A non-blank trimmed string, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** End `text` with sentence punctuation, so composed sentences read as two. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * The sentence under the banner's word.
 *
 * - A `reason` from the decision's record wins: the decision's own words,
 *   verbatim (trimmed, and closed with a period so it reads as a sentence).
 * - `removed_legal` always closes with the tombstone sentence of
 *   docs/design.md §8 — "The record of its existence remains." — because
 *   that promise is the point of a tombstone; the lead is the reason, or
 *   the removal date and category.
 * - `newer_version` names the newest version when it knows it.
 * - Every other kind falls back to its plain default.
 */
export function decisionDetail(
  kind: DecisionKind,
  context: DecisionContext = {},
): string {
  const reason = textOf(context.reason);

  if (kind === "removed_legal") {
    const closing = "The record of its existence remains.";
    if (reason) return `${sentence(reason)} ${closing}`;
    const removedOn = textOf(context.removedOn);
    const category = textOf(context.category);
    const lead = [
      removedOn ? `Removed on ${removedOn}` : category ? "Removed" : undefined,
      category,
    ].filter((part): part is string => part !== undefined);
    return lead.length > 0 ? `${lead.join(" · ")}. ${closing}` : closing;
  }

  if (reason) return sentence(reason);

  if (kind === "newer_version") {
    const versionLabel = textOf(context.versionLabel);
    return versionLabel
      ? `You are reading an older version. The newest is ${versionLabel}.`
      : DECISION_BANNER_SPECS[kind].detail;
  }

  return DECISION_BANNER_SPECS[kind].detail;
}

/**
 * A clause id safe to cite: trimmed, or undefined when blank. An empty
 * string from an API response means "no clause cited", not "link to
 * /policies#".
 */
export function normalizeClauseId(clause: unknown): string | undefined {
  return textOf(clause);
}

/**
 * The words on the policy link: "Policy MOD-05". The shape is the anchor
 * contract's own example (`features/policies-page/README.md`).
 */
export function decisionPolicyLabel(clause: string): string {
  return `Policy ${clause}`;
}

/** The words on the newer-version link: "Go to v3", or the unnamed fallback. */
export function decisionVersionLabel(versionLabel?: string): string {
  const label = textOf(versionLabel);
  return label ? `Go to ${label}` : "Go to the newest version";
}
