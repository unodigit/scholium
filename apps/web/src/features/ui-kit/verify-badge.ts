/**
 * VerifyBadge: whether a paper's proof checks out, as an icon plus a word,
 * never colour alone (docs/design.md §5.3, §7 and §9).
 *
 * ```tsx
 * <VerifyBadge state="verified" />
 * <VerifyBadge state="anchor_pending" />
 * <VerifyBadge state="checking" />
 * <VerifyBadge state="cannot_verify" />
 * <VerifyBadge state="failed" />
 * <VerifyBadge state={proofState} counts={counts} href={proofTabHref("/p/k3f9-q2xz-7mwd/v2")} />
 * ```
 *
 * Five states, the header-indicator table of §5.3:
 *
 * | `state`          | Shown                               |
 * | ---------------- | ----------------------------------- |
 * | `verified`       | ✓ green "Verified"                  |
 * | `anchor_pending` | ◔ amber "Signed · anchor pending"   |
 * | `checking`       | spinner "Checking…"                 |
 * | `cannot_verify`  | ? grey "Could not check"            |
 * | `failed`         | ✕ red "Verification failed"         |
 *
 * A finished check also says what it checked (`counts`): "Verified · 3
 * versions · 4 signatures" (PRD §9 journey 3), with the anchor state as the
 * paper page's own line beneath it. The counts are added only to a check that
 * passed; a failure keeps its failure words.
 *
 * What makes a badge safe to read without colour:
 * - the **word** is real text, so it is the accessible name and survives
 *   forced-colour, print and greyscale;
 * - the **icon** has a different silhouette per state, is `aria-hidden`, and
 *   draws in `currentColor`;
 * - the **colour** is reinforcement only, carried by the icon and the border,
 *   so the label stays `--ink` on a soft tint at ≥ 4.5:1.
 *
 * "Could not check" is grey, not red, and "Signed · anchor pending" is amber,
 * not red: both are states, not errors (§1, principle 7). Only a real
 * mismatch is "Verification failed".
 *
 * **It always opens the Proof tab** (§7), so it is a link: `href` defaults to
 * `#proof`, the fragment the paper page's Proof tab answers to. Pass `href` to
 * point it at a paper from elsewhere (see `proofTabHref`), and `onClick` to
 * take the click over with a client-side tab switch (`event.preventDefault()`
 * keeps the browser from following the link).
 *
 * **It announces its own changes.** The badge usually starts as "Checking…"
 * and becomes a verdict a moment later, when no one is looking at it. The root
 * is a polite live region (`role="status"`), so when the same badge is
 * re-rendered with a new `state`, a screen reader says the new words. Keep it
 * mounted across the change (do not give it a new `key`) or nothing is said.
 *
 * Server-safe (no hooks, no state). Plain `.ts` with `createElement` rather
 * than JSX because vitest cannot transform JSX in this app (tsconfig sets
 * `jsx: "preserve"`), and this keeps the real markup under test.
 */

import { createElement, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { Icon } from "./icons";
import {
  PROOF_TAB_HREF,
  VERIFY_BADGE_SPECS,
  countedLabel,
  isVerifyState,
  verifyBadgeTitle,
  type VerifyCounts,
  type VerifyState,
} from "./verify";
import "./verify-badge.css";

// `title` is the badge's own: the tooltip says what the state means, and a
// second one from the caller on the wrapper would be hidden under it.
type SpanProps = Omit<ComponentPropsWithoutRef<"span">, "children" | "title">;

export interface VerifyBadgeProps extends SpanProps {
  state: VerifyState;
  /**
   * Where activating the badge goes. Defaults to `#proof`. A blank value falls
   * back to the default, so the badge never renders a link that goes nowhere.
   */
  href?: string;
  /**
   * How many versions and signatures a finished check verified. With them the
   * words carry the PRD's counts (journey 3): "Verified · 3 versions · 4
   * signatures". Omit them — or pass `null` — for a check that has not run or
   * has no counts, and the state's own label is shown. A failure or an
   * unfinished check never shows counts (see `countedLabel`).
   */
  counts?: VerifyCounts | null;
}

/**
 * The badge for one state.
 *
 * Renders nothing for a state outside the five. The type forbids that, but the
 * value usually comes from the Proof tab's own logic, and one unexpected string
 * should not show the wrong words, least of all "Verified". Narrow with
 * `isVerifyState` first if you need to handle it.
 */
export function VerifyBadge({
  state,
  href,
  counts,
  className,
  ...rest
}: VerifyBadgeProps): ReactElement | null {
  if (!isVerifyState(state)) return null;
  const spec = VERIFY_BADGE_SPECS[state];
  // The counts ride on the words, never the state: a check that failed keeps
  // its failure label whatever numbers the caller passes.
  const label = countedLabel(state, counts ?? null);
  const target =
    typeof href === "string" && href.trim().length > 0
      ? href.trim()
      : PROOF_TAB_HREF;

  return createElement(
    "span",
    {
      ...rest,
      className: className ? `sch-verify ${className}` : "sch-verify",
      // After `rest`: the root is the live region and the state's own record,
      // and attributes passed in cannot turn either off or make it lie.
      role: "status",
      "data-state": state,
      "data-tone": spec.tone,
    },
    createElement(
      "a",
      {
        className: "sch-verify__link",
        href: target,
        title: verifyBadgeTitle(state),
      },
      createElement(Icon, { name: spec.icon, className: "sch-verify__icon" }),
      createElement("span", { className: "sch-verify__label" }, label),
    ),
  );
}
