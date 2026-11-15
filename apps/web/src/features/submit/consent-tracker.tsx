/**
 * The consent tracker (docs/design.md §6): an avatar for each author with a
 * chip that says **Waiting**, **Signed** or **Declined**.
 *
 * The chip is an icon *and* a word, never colour alone. The summary line is a
 * polite live region, so a screen reader hears "2 of 3 signed" when a poll
 * brings news. The tracker only draws; where the entries come from (the draft,
 * or `GET /v1/papers/{id}/v/{n}/consents`) is the caller's business.
 */

import type { ReactElement, ReactNode } from "react";

import { CONSENT_STATUS_LABELS, consentSummary, countConsents, declineNotice, type TrackerEntry } from "./consents";
import { ConsentIcon, PersonIcon } from "./icons";

const TONES = { waiting: "pending", signed: "verified", declined: "critical" } as const;

export interface ConsentTrackerProps {
  entries: readonly TrackerEntry[];
  /** Id prefix, so two trackers on a page do not share ids. */
  idPrefix?: string;
  /** Plain-language context under the summary: when links go out, what a decline means. */
  caption?: ReactNode;
  /** Shown instead of the caption when the last refresh failed. */
  error?: string | null;
  /** Name each author's CRediT roles under their name (the consent page does). */
  showRoles?: boolean;
}

export function ConsentTracker({
  entries,
  idPrefix = "sw-consents",
  caption,
  error,
  showRoles = false,
}: ConsentTrackerProps): ReactElement {
  const counts = countConsents(entries);
  const declined = declineNotice(entries);
  const titleId = `${idPrefix}-title`;

  return (
    <section className="sw-tracker" aria-labelledby={titleId}>
      <header className="sw-tracker__head">
        <h3 id={titleId} className="sw-tracker__title">
          Co-author consents
        </h3>
        <p className="sw-tracker__summary" role="status">
          {consentSummary(counts)}
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="sw-tracker__note">No authors are listed on this version.</p>
      ) : (
        <ul className="sw-tracker__list">
          {entries.map((entry) => {
            return (
              <li key={entry.key} className="sw-tracker__row" data-status={entry.status}>
                <span className="sw-avatar" aria-hidden="true">
                  {entry.monogram ?? <PersonIcon />}
                </span>
                <span className="sw-tracker__who">
                  <span className="sw-tracker__name">
                    {entry.name}
                    {entry.isYou && entry.name !== "You" ? <span className="sw-tracker__you"> (you)</span> : null}
                  </span>
                  {entry.detail !== null ? <span className="sw-tracker__detail">{entry.detail}</span> : null}
                  {showRoles && entry.roles.length > 0 ? (
                    <span className="sw-tracker__roles">{entry.roles.join(", ")}</span>
                  ) : null}
                </span>
                <span className="sw-chip" data-tone={TONES[entry.status]}>
                  <ConsentIcon status={entry.status} />
                  {CONSENT_STATUS_LABELS[entry.status]}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p className="sw-tracker__note" role="alert">
          {error}
        </p>
      ) : declined !== null ? (
        <p className="sw-tracker__note" data-tone="critical">
          {declined}
        </p>
      ) : caption ? (
        <p className="sw-tracker__note">{caption}</p>
      ) : null}
    </section>
  );
}
