/**
 * StatusChip: a paper's standing as an icon plus a word, never colour alone
 * (docs/design.md §7 and §9).
 *
 * ```tsx
 * <StatusChip status={paper.status} count={paper.reviewers} />
 * <UnderReviewChip count={3} />   // "Under review (3)"
 * <RetractedChip />               // "Retracted"
 * ```
 *
 * What makes a chip safe to read without colour:
 * - the **word** is real text, so it is the accessible name and survives
 *   forced-colour, print and greyscale;
 * - the **icon** has a different silhouette per status (three statuses share
 *   amber), is `aria-hidden`, and draws in `currentColor`;
 * - the **colour** is reinforcement only, and is carried by the icon and the
 *   border, not the label, so the label stays `--ink` on a soft tint at
 *   ≥ 4.5:1.
 *
 * Server-safe (no hooks, no state). Plain `.ts` with `createElement` rather
 * than JSX because vitest cannot transform JSX in this app (tsconfig sets
 * `jsx: "preserve"`), and this keeps the real markup under test.
 */

import { createElement, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { Icon } from "./icons";
import {
  STATUS_CHIP_SPECS,
  isPaperStatus,
  statusChipLabel,
  type PaperStatus,
} from "./status";
import "./status-chip.css";

type SpanProps = Omit<ComponentPropsWithoutRef<"span">, "children">;

export interface StatusChipProps extends SpanProps {
  status: PaperStatus;
  /**
   * Number of reviewers. Printed as "Under review (n)" and ignored for every
   * other status. A value that is not a whole number ≥ 0 is dropped.
   */
  count?: number;
}

/**
 * The chip for one status.
 *
 * Renders nothing for a status outside the six. The type forbids that, but the
 * value usually comes from an API response, and one unexpected string should
 * not take a whole feed down or show the wrong word. Narrow with
 * `isPaperStatus` first if you need to handle it.
 */
export function StatusChip({
  status,
  count,
  className,
  ...rest
}: StatusChipProps): ReactElement | null {
  if (!isPaperStatus(status)) return null;
  const spec = STATUS_CHIP_SPECS[status];

  return createElement(
    "span",
    {
      ...rest,
      className: className ? `sch-chip ${className}` : "sch-chip",
      "data-status": status,
      "data-tone": spec.tone,
    },
    createElement(Icon, { name: spec.icon, className: "sch-chip__icon" }),
    createElement(
      "span",
      { className: "sch-chip__label" },
      statusChipLabel(status, count),
    ),
  );
}

/** Props of a chip whose status is fixed by the component that renders it. */
export type FixedStatusChipProps = Omit<StatusChipProps, "status" | "count">;

function chipFor<Props extends FixedStatusChipProps = FixedStatusChipProps>(
  status: PaperStatus,
) {
  const Chip = (props: Props): ReactElement | null =>
    createElement(StatusChip, { ...props, status });
  // "under_review" → "UnderReviewChip"
  Chip.displayName = `${status.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase())}Chip`;
  return Chip;
}

/** ○ Preprint */
export const PreprintChip = chipFor("preprint");

/** 👁 Under review (n). `count` is the number of reviewers. */
export const UnderReviewChip = chipFor<
  FixedStatusChipProps & Pick<StatusChipProps, "count">
>("under_review");

/** ✓ Reviewed */
export const ReviewedChip = chipFor("reviewed");

/** ⚠ Contested */
export const ContestedChip = chipFor("contested");

/** ✎ Corrected */
export const CorrectedChip = chipFor("corrected");

/** ⊘ Retracted */
export const RetractedChip = chipFor("retracted");
