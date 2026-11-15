/**
 * The six paper statuses a StatusChip can show, and everything that decides
 * how each one looks: its word, its icon and its colour family.
 *
 * Status ids are the wire values of the API's `compute_status`
 * (`apps/api/src/app/modules/status/compute.py`), so a chip can be rendered
 * straight from a response: `<StatusChip status={paper.status} />`.
 *
 * Pure data and functions, no React: the markup lives in `status-chip.ts`.
 */

import type { IconName } from "./icons";

/** Every status a paper can have, in the order the API's precedence list reads
 * from "nothing yet" to "final". */
export const PAPER_STATUSES = [
  "preprint",
  "under_review",
  "reviewed",
  "contested",
  "corrected",
  "retracted",
] as const;

export type PaperStatus = (typeof PAPER_STATUSES)[number];

/**
 * Colour family of a chip (docs/design.md §3). It maps onto a token pair in
 * `status-chip.css`: `verified` → `--verified`, `pending` → `--pending`,
 * `critical` → `--critical`; `neutral` uses `--ink-2` and `--rule`.
 *
 * `--ai` is deliberately not a tone: AI output never uses the colours of human
 * review status (design.md §1, principle 5).
 */
export type StatusTone = "neutral" | "verified" | "pending" | "critical";

export interface StatusChipSpec {
  readonly status: PaperStatus;
  /** The word shown beside the icon (docs/design.md §7). */
  readonly label: string;
  readonly tone: StatusTone;
  /** Chosen so every status has a different silhouette, not just a different
   * colour: three statuses share the amber tone. */
  readonly icon: IconName;
  /** One plain-language line, for galleries and tooltips. */
  readonly meaning: string;
}

export const STATUS_CHIP_SPECS: Readonly<Record<PaperStatus, StatusChipSpec>> = {
  preprint: {
    status: "preprint",
    label: "Preprint",
    tone: "neutral",
    icon: "circle",
    meaning: "Posted, with no reviews yet.",
  },
  under_review: {
    status: "under_review",
    label: "Under review",
    tone: "pending",
    icon: "eye",
    meaning: "Reviewers have started. The number is how many.",
  },
  reviewed: {
    status: "reviewed",
    label: "Reviewed",
    tone: "verified",
    icon: "check",
    meaning: "Reviewers have read it and support it.",
  },
  contested: {
    status: "contested",
    label: "Contested",
    tone: "pending",
    icon: "alert",
    meaning: "A reviewer recommends rejection, or moderators have put it on hold.",
  },
  corrected: {
    status: "corrected",
    label: "Corrected",
    tone: "pending",
    icon: "pencil",
    meaning: "A correction notice is on record.",
  },
  retracted: {
    status: "retracted",
    label: "Retracted",
    tone: "critical",
    icon: "ban",
    meaning: "A retraction notice is on record. Every version carries it.",
  },
};

/** Narrow an unknown value (an API field, a query parameter) to a status. */
export function isPaperStatus(value: unknown): value is PaperStatus {
  return (
    typeof value === "string" &&
    (PAPER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * A reviewer count that is safe to print: a whole number, zero or more.
 * Anything else (NaN, a negative, a fraction, a string) is dropped rather than
 * shown as "Under review (NaN)".
 */
export function normalizeReviewerCount(count: unknown): number | undefined {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
}

/**
 * The words on a chip: "Preprint", "Under review (3)", …
 *
 * Only `under_review` carries a count (design.md §7); it is the number of
 * reviewers, which is what the API's status counts. For every other status the
 * count is ignored.
 */
export function statusChipLabel(status: PaperStatus, count?: number): string {
  const { label } = STATUS_CHIP_SPECS[status];
  if (status !== "under_review") return label;
  const reviewers = normalizeReviewerCount(count);
  return reviewers === undefined ? label : `${label} (${reviewers})`;
}
