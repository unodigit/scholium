/**
 * The five states a VerifyBadge can show, and everything that decides how each
 * one looks: its words, its icon and its colour family.
 *
 * The states, words, icons and colours are the header-indicator table of
 * docs/design.md §5.3, verbatim:
 *
 * | State          | Icon + label                       |
 * | -------------- | ---------------------------------- |
 * | Verified       | ✓ green "Verified"                 |
 * | Anchor pending | ◔ amber "Signed · anchor pending"  |
 * | Checking       | spinner "Checking…"                |
 * | Cannot verify  | ? grey "Could not check"           |
 * | Failed         | ✕ red "Verification failed"        |
 *
 * Pure data and functions, no React: the markup lives in `verify-badge.ts`.
 * Deciding *which* state a paper is in (from verify-core's report and the
 * anchor proof) belongs to the Proof tab; the badge only shows the answer.
 * The counts a finished check adds to the indicator's words — "Verified · 4
 * author signatures across 2 versions" (PRD §9 journey 3), the distinct author
 * signatures over the version's verified chain — are `countedLabel` below.
 */

import type { IconName } from "./icons";

/**
 * Every state, in the order of docs/design.md §5.3: the best outcome first,
 * then "working", then the two ways a check can fail to finish.
 */
export const VERIFY_STATES = [
  "verified",
  "anchor_pending",
  "checking",
  "cannot_verify",
  "failed",
] as const;

export type VerifyState = (typeof VERIFY_STATES)[number];

/**
 * Colour family of a badge (docs/design.md §3), the same families a StatusChip
 * uses. It maps onto token pairs in `verify-badge.css`: `verified` →
 * `--verified`, `pending` → `--pending`, `critical` → `--critical`; `neutral`
 * (grey: `--ink-2` and `--rule`) is shared by "Checking…" and "Could not
 * check" on purpose. Neither is a verdict, and an inability to check is never
 * dressed as a failure (§5.3).
 */
export type VerifyTone = "neutral" | "verified" | "pending" | "critical";

export interface VerifyBadgeSpec {
  readonly state: VerifyState;
  /** The words beside the icon (docs/design.md §5.3, verbatim). */
  readonly label: string;
  readonly tone: VerifyTone;
  /** A different silhouette per state: a badge must survive without colour. */
  readonly icon: IconName;
  /** One plain-language line, for galleries and the badge's tooltip. */
  readonly meaning: string;
}

export const VERIFY_BADGE_SPECS: Readonly<Record<VerifyState, VerifyBadgeSpec>> = {
  verified: {
    state: "verified",
    label: "Verified",
    tone: "verified",
    icon: "check",
    meaning: "Every check passed and the public timestamp is in place.",
  },
  anchor_pending: {
    state: "anchor_pending",
    label: "Signed · anchor pending",
    tone: "pending",
    icon: "pending",
    // Phase 1 has no anchoring, so pending never promises a time: a time is
    // promised only by the anchored state, which names the anchor's own date.
    meaning: "Signed. Anchoring is not enabled on this node yet.",
  },
  checking: {
    state: "checking",
    label: "Checking…",
    tone: "neutral",
    icon: "spinner",
    meaning: "The check is running in your browser.",
  },
  cannot_verify: {
    state: "cannot_verify",
    label: "Could not check",
    tone: "neutral",
    icon: "question",
    meaning:
      "You may be offline, or the proof is not available. This is not a failure.",
  },
  failed: {
    state: "failed",
    label: "Verification failed",
    tone: "critical",
    icon: "cross",
    meaning:
      "This file does not match what the authors signed. Do not rely on it.",
  },
};

/** Narrow an unknown value (an API field, a query parameter) to a state. */
export function isVerifyState(value: unknown): value is VerifyState {
  return (
    typeof value === "string" &&
    (VERIFY_STATES as readonly string[]).includes(value)
  );
}

/**
 * Where every badge goes when it is activated: the paper page's Proof tab
 * answers to the `#proof` fragment (docs/design.md §7: "always opens the Proof
 * tab"). A badge on the paper page itself can leave `href` out; one in a feed
 * passes the paper's own path, e.g. `proofTabHref("/p/k3f9-q2xz-7mwd/v2")`.
 */
export const PROOF_TAB_HREF = "#proof";

/**
 * The link target of a badge: `base` with the Proof tab's fragment on it, or
 * the bare fragment when there is no base.
 *
 * A blank or non-string base is treated as none, so a badge never renders a
 * dead link. A base that already has a fragment loses it: the badge always
 * opens *the Proof tab*, never wherever the page happened to point.
 */
export function proofTabHref(base?: string): string {
  if (typeof base !== "string") return PROOF_TAB_HREF;
  const path = base.trim().split("#")[0];
  return path.length === 0 ? PROOF_TAB_HREF : `${path}${PROOF_TAB_HREF}`;
}

/** The tooltip (and accessible description) of a badge: what it means, then what a click does. */
export function verifyBadgeTitle(state: VerifyState): string {
  return `${VERIFY_BADGE_SPECS[state].meaning} Opens the Proof tab.`;
}

/**
 * The counts a finished check can add to the indicator: how many versions the
 * paper has, and how many author signatures were checked (PRD §9 journey 3:
 * "Verified: 3 versions, 4 signatures, anchored 2027-03-02").
 *
 * Both numbers describe *the check that ran* (bug_spec_verify6 bug 2):
 * `versions` is the versions of the verified chain — viewing `/v1` of a
 * two-version paper is one version — and `signatures` is the distinct author
 * signatures over that chain's records, so the counted words and the
 * checklist's "Signed by all N listed authors" line always agree.
 */
export interface VerifyCounts {
  readonly versions: number;
  readonly signatures: number;
}

/** A count worth printing: a whole number, and not zero of something a verified paper always has. */
function isCounted(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The indicator's words for a finished check: "Verified · 4 author signatures
 * across 2 versions" when the check passed and the counts are known, whatever
 * the anchor state is (that follows the indicator as its own line).
 *
 * The words say *what* was counted: author signatures over the verified
 * chain's records, distinct signers — the same number the checklist's "Signed
 * by all N listed authors" line rests on, for the version being viewed
 * (bug_spec_verify5 bug 5, bug_spec_verify6 bug 2).
 *
 * Anything else — no counts, a check that failed or could not run — keeps the
 * state's own label, so a count is never printed next to a failure and
 * "Verified" never appears without the checks behind it.
 */
export function countedLabel(state: VerifyState, counts: VerifyCounts | null): string {
  if (
    counts === null ||
    (state !== "verified" && state !== "anchor_pending") ||
    !isCounted(counts.versions) ||
    !isCounted(counts.signatures)
  ) {
    return VERIFY_BADGE_SPECS[state].label;
  }
  const versions = `${counts.versions} ${counts.versions === 1 ? "version" : "versions"}`;
  const signatures = `${counts.signatures} ${
    counts.signatures === 1 ? "author signature" : "author signatures"
  }`;
  return `Verified · ${signatures} across ${versions}`;
}
