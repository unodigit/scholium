/**
 * DecisionBanner: the full-width notice above a paper's title that
 * announces a decision about it (docs/design.md §5.2 and §7).
 *
 * ```tsx
 * <DecisionBanner
 *   kind="retracted"
 *   recordCid={notice.id}
 *   clause="MOD-03"
 *   reason={notice.body.reason}
 * />
 * <DecisionBanner
 *   kind="newer_version"
 *   recordCid={newest.id}
 *   versionHref={`/papers/${paperId}/v3`}
 *   versionLabel="v3"
 * />
 * <DecisionBanner
 *   kind="removed_legal"
 *   recordCid={decision.id}
 *   clause="MOD-05"
 *   category="Unlawful content"
 *   removedOn="4 May 2027"
 * />
 * ```
 *
 * Four kinds, the words and tones of docs/design.md §5.2: Retracted
 * (critical), Corrected (pending), A newer version exists (neutral),
 * Content removed for legal reasons (neutral, with reason category).
 *
 * Every decision shows its reason (principle 6), so the banner always
 * links to the two places a reader can check it:
 * - **the record** — "View record" opens the raw signed JSON of the
 *   decision's envelope in a side sheet (RecordLink, `GET /v1/records/{cid}`);
 * - **the policy clause** — "Policy MOD-05" goes to `/policies#MOD-05`,
 *   the public clause the decision cites, through `policyHref` so the
 *   anchor can never disagree with the page.
 * A newer-version notice links to the newer version instead; it is a fact
 * about versions, not a moderation decision, so no clause applies.
 *
 * Status is never colour alone (§9): each kind has its own word and its
 * own icon silhouette; colour only reinforces.
 *
 * The banner is ordinary content — no `role`, no live region. It is on the
 * page from the first paint, above the title, and the paper's own heading
 * (not the banner's word) is the structural heading.
 *
 * Server-safe (no hooks of its own; the record link it renders is a client
 * component). Plain `.ts` with `createElement` rather than JSX because
 * vitest cannot transform JSX in this app (tsconfig sets `jsx: "preserve"`),
 * and this keeps the real markup under test.
 */

import {
  createElement,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from "react";

import { policyHref } from "../policies-page";
import { Icon } from "./icons";
import { RecordLink, type RecordLoader } from "./record-link";
import {
  DECISION_BANNER_SPECS,
  decisionDetail,
  decisionPolicyLabel,
  decisionVersionLabel,
  isDecisionKind,
  normalizeClauseId,
  type DecisionContext,
  type DecisionKind,
} from "./decision";
import "./decision-banner.css";

type DivProps = Omit<ComponentPropsWithoutRef<"div">, "children">;

export interface DecisionBannerProps extends DivProps {
  /** Which decision the banner announces. */
  kind: DecisionKind;
  /**
   * The signed record behind the decision: the `{cid}` its "View record"
   * link reads — a retraction or correction notice, the tombstone's
   * moderation decision, or the newest version's `paper.version`.
   */
  recordCid: string;
  /**
   * The policy clause the decision cites, e.g. `"MOD-05"`. Renders
   * "Policy MOD-05" → `/policies#MOD-05`. Absent for notices that cite no
   * clause (an author's retraction) and for version notices.
   */
  clause?: string;
  /**
   * The decision's own reason, signed in its record (`body.reason`). When
   * present it is the banner's sentence, verbatim.
   */
  reason?: string;
  /**
   * `newer_version`: where the newer version is, e.g.
   * `/papers/sch:9f2c1a7e/v3`. The banner renders "Go to v3" before the
   * record link. Ignored by every other kind.
   */
  versionHref?: string;
  /** `newer_version`: how the newest version is named, e.g. `"v3"`. */
  versionLabel?: string;
  /**
   * `removed_legal`: when the content was removed, already formatted for
   * reading, e.g. `"4 May 2027"`. The banner never formats dates itself.
   */
  removedOn?: string;
  /** `removed_legal`: the reason category, e.g. `"Unlawful content"`. */
  category?: string;
  /** Record fetcher passed to the record link. Defaults to the API client. */
  loadRecord?: RecordLoader;
}

/**
 * The banner for one decision about a paper.
 *
 * Renders nothing when `kind` is not one of the four or `recordCid` is
 * blank: without the record there is no decision to show, only an
 * unverifiable claim — the one thing principle 6 forbids. Narrow with
 * `isDecisionKind` when the kind comes from an API response.
 */
export function DecisionBanner({
  kind,
  recordCid,
  clause,
  reason,
  versionHref,
  versionLabel,
  removedOn,
  category,
  loadRecord,
  className,
  ...rest
}: DecisionBannerProps): ReactElement | null {
  if (!isDecisionKind(kind)) return null;

  const usableCid =
    typeof recordCid === "string" && recordCid.trim().length > 0
      ? recordCid.trim()
      : undefined;
  if (usableCid === undefined) return null;

  const spec = DECISION_BANNER_SPECS[kind];
  const context: DecisionContext = { reason, versionLabel, removedOn, category };
  const usableClause = normalizeClauseId(clause);
  const usableVersionHref =
    kind === "newer_version" &&
    typeof versionHref === "string" &&
    versionHref.trim().length > 0
      ? versionHref.trim()
      : undefined;

  const links: ReactElement[] = [];
  if (usableVersionHref !== undefined) {
    links.push(
      createElement(
        "a",
        {
          key: "version",
          className: "sch-decision__version",
          href: usableVersionHref,
        },
        decisionVersionLabel(versionLabel),
      ),
    );
  }
  links.push(
    createElement(RecordLink, { key: "record", cid: usableCid, loadRecord }),
  );
  if (usableClause !== undefined) {
    links.push(
      createElement(
        "a",
        {
          key: "policy",
          className: "sch-decision__policy",
          href: policyHref(usableClause),
        },
        decisionPolicyLabel(usableClause),
      ),
    );
  }

  return createElement(
    "div",
    {
      ...rest,
      className: className ? `sch-decision ${className}` : "sch-decision",
      "data-kind": kind,
      "data-tone": spec.tone,
    },
    createElement(
      "p",
      { className: "sch-decision__lead" },
      createElement(Icon, { name: spec.icon, className: "sch-decision__icon" }),
      createElement(
        "span",
        { className: "sch-decision__text" },
        createElement(
          "strong",
          { className: "sch-decision__word" },
          spec.label,
        ),
        createElement(
          "span",
          { className: "sch-decision__detail" },
          decisionDetail(kind, context),
        ),
      ),
    ),
    createElement("p", { className: "sch-decision__links" }, ...links),
  );
}
