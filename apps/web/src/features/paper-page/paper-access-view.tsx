/**
 * The two states a paper page reaches through its 404 path: the status banner
 * an author or moderator sees above their unlisted paper, and the
 * removed-content marker of a tombstoned paper (docs/design.md §5.2, §8).
 *
 * Server-safe presentational pieces, no hooks: the route renders the
 * tombstone marker directly (a takedown is a public fact, so it is in the
 * first HTML), and the hydrated retry (`paper-access.tsx`) renders both after
 * it has asked again with the signed-in reader's token.
 */

import { policyHref } from "../policies-page";
import { DecisionBanner, Icon, RecordLink } from "../ui-kit";
import { formatDate } from "../ui-kit/format-date";
import type { FiledAppeal } from "./appeal-dialog";
import { panelNotFormed } from "./appeal-dialog";
import type {
  ModerationFact,
  TombstoneFacts,
  UnlistedBanner,
} from "./unlisted-paper";

/* -------------------------------------------------------------------------- */
/* The tombstone state                                                         */
/* -------------------------------------------------------------------------- */

/** The moderator's reason as a category: trimmed, without closing punctuation. */
function categoryOf(reason: string | null): string | undefined {
  const text = reason?.trim().replace(/[.!?…]+$/, "") ?? "";
  return text === "" ? undefined : text;
}

export interface PaperTombstoneViewProps {
  /** The removal facts, joined from the paper's public records. */
  readonly facts: TombstoneFacts;
}

/**
 * A tombstoned paper (NET-5): "Content removed for legal reasons on {date}.
 * The record of its existence remains." — design.md §8's tombstone copy,
 * carried by the `DecisionBanner` so the decision stays checkable (its record
 * and the policy clause it cites are a link away).
 *
 * The page keeps the paper's title as its `<h1>`: the marker names what was
 * removed, and the record of the paper's existence is the point of one.
 */
export function PaperTombstoneView({ facts }: PaperTombstoneViewProps) {
  return (
    <section className="ppg-tombstone">
      {facts.decisionCid !== null ? (
        // The decision's reason is the *category* (design.md §5.2: "with reason
        // category"), not the banner's `reason`: a `reason` replaces the
        // removal date, and the date is half of what this state says.
        <DecisionBanner
          kind="removed_legal"
          recordCid={facts.decisionCid}
          clause={facts.clause ?? undefined}
          removedOn={facts.removedOn ?? undefined}
          category={categoryOf(facts.reason)}
        />
      ) : (
        // The node withheld the content but the log shows no takedown record
        // (the banner renders nothing without one, and says nothing it cannot
        // link to): the state still says what happened, in design.md's words.
        <p className="ppg-access-note" role="status">
          <strong>Content removed for legal reasons</strong>
          {facts.removedOn !== null ? ` on ${facts.removedOn}` : ""}. The record
          of its existence remains.
        </p>
      )}
      <h1 className="ppg-title">{facts.title ?? "This paper"}</h1>
      <p className="ppg-notice-message">
        Its files are gone and it is not listed. The signed decision, and the
        paper&rsquo;s records, remain on this node.
      </p>
      <a className="ppg-notice-link" href="/search">
        Back to search
      </a>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The status banner                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How a panel's outcome reads after "the panel" in the author's banner. The
 * vocabulary is `appeal.decision`'s schema enum. Kept in step with
 * `appeal-dialog.appealStatus`, whose UTC wording is the record's, not the
 * reader's.
 */
const OUTCOME_PHRASES: Readonly<Record<string, string>> = {
  upheld: "upheld the decision",
  overturned: "overturned the decision",
  modified: "modified the decision",
  remanded: "sent the decision back to the moderators",
  granted: "granted the appeal",
  grant: "granted the appeal",
  denied: "denied the appeal",
  deny: "denied the appeal",
  allowed: "allowed the appeal",
  dismissed: "dismissed the appeal",
};

/**
 * The banner sentence for a filed appeal, with its dates in the reader's own
 * zone (`18 November 2026`, the long month the paper page's moderation copy
 * uses). A reader east of UTC who filed at 00:45 must not be told they filed
 * the previous day (bug_spec_verify6).
 */
function appealDetail(appeal: FiledAppeal): string {
  const filed = formatDate(appeal.filedAt, { month: "long" });
  const opened = filed === null ? "Appeal filed" : `Appeal filed on ${filed}`;
  if (appeal.outcome === null) {
    return panelNotFormed(appeal.status)
      ? `${opened} — panel not yet formed.`
      : `${opened} — awaiting panel.`;
  }
  const decided = formatDate(appeal.decidedAt, { month: "long" });
  const phrase =
    OUTCOME_PHRASES[appeal.outcome] ??
    `recorded the outcome “${appeal.outcome}”`;
  return `${opened} — the panel ${phrase}${decided === null ? "" : ` on ${decided}`}.`;
}

/**
 * The banner, with what the author's appeal says (design.md §8).
 *
 * A refusal banner invites an appeal only until one is filed: afterwards it
 * reports the appeal — filed and awaiting a panel, or the panel's outcome —
 * and keeps the moderator's reason. An overturn appends a `release` that puts
 * the version back in its prior state, so the hold is no longer the standing
 * decision; the appeal is then joined through the release record and its
 * outcome is said alongside the state the release restored.
 *
 * Shared by the retry that assembles the banner from the records and the view
 * that updates it when the dialog files an appeal without a reload.
 */
export function bannerWithAppeal(
  banner: UnlistedBanner,
  decision: ModerationFact | null,
  appeal: FiledAppeal | null,
): UnlistedBanner {
  if (decision === null || appeal === null) {
    return banner;
  }
  if (decision.action === "hold" || decision.action === "reject") {
    const reason = decision.reason?.trim().replace(/[.!?…]+$/, "") ?? "";
    return {
      ...banner,
      detail: `${reason === "" ? "" : `${reason}. `}${appealDetail(appeal)}`,
    };
  }
  if (decision.action === "release") {
    return { ...banner, detail: `${banner.detail} ${appealDetail(appeal)}` };
  }
  return banner;
}

export interface UnlistedStatusBannerProps {
  /** Where the version stands (`unlistedBanner` joins the facts). */
  readonly banner: UnlistedBanner;
}

/**
 * The banner above an unlisted paper's title: *In moderation*, *Held from
 * listing* (with the moderator&rsquo;s reason), *Awaiting co-author consent*…
 * the state the paper is in, said in words, with an icon and a tone that
 * reinforce them (never colour alone, docs/design.md §9).
 *
 * A banner for a decision links to the two places its reason can be checked
 * (principle 6), exactly as a `DecisionBanner` does: the signed record and the
 * policy clause it cites.
 */
export function UnlistedStatusBanner({ banner }: UnlistedStatusBannerProps) {
  return (
    <div className="ppg-access-banner" data-tone={banner.tone} role="status">
      <p className="ppg-access-banner-lead">
        <Icon
          name={banner.icon}
          className="ppg-access-banner-icon"
        />
        <span className="ppg-access-banner-text">
          <strong className="ppg-access-banner-word">{banner.label}</strong>
          <span className="ppg-access-banner-detail">{banner.detail}</span>
        </span>
      </p>
      {banner.decision !== null ? (
        <p className="ppg-access-banner-links">
          <RecordLink cid={banner.decision.decisionCid} />
          {banner.decision.clause !== null ? (
            <a
              className="sch-decision__policy"
              href={policyHref(banner.decision.clause)}
            >
              Policy {banner.decision.clause}
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
