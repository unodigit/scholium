"use client";

/**
 * The post-submission status tracker (docs/design.md §5.4): Submitted →
 * Co-author consents → Moderation → Listed → AI pre-review, with the consent
 * tracker underneath.
 *
 * It can also carry the version's automated checks (`checks`, from
 * `GET /v1/papers/{id}/v/{n}/checks`): `null` means the node has no report
 * yet — a 404 until it has scanned the version — which reads as
 * **Checks pending**; a report is shown as the four advisory verdicts. Checks
 * never gate anything here: signing has already happened.
 */

import type { ReactElement, ReactNode } from "react";

import { ConsentTracker } from "./consent-tracker";
import { countConsents, consentSummary, trackerFromDraft, trackerFromReport, type ConsentReport, type TrackerEntry } from "./consents";
import { CHECK_STATE_TONES } from "./checks-step";
import { checkItems, checksSummary, type VersionChecks } from "./checks";
import type { DraftAuthor } from "./authors";
import "./submit.css";

export interface StatusTrackerProps {
  submitted?: boolean;
  report?: ConsentReport | null;
  consents?: ConsentReport | null;
  consentReport?: ConsentReport | null;
  counts?: { total: number; waiting: number; signed: number; declined: number };
  consentsSummary?: string;
  authors?: readonly DraftAuthor[];
  trackerEntries?: readonly TrackerEntry[];
  paper?: string;
  version?: number;
  /**
   * The version's check report, or `null` while the node has none (shown as
   * "Checks pending"). Leave the prop out to show no checks at all.
   */
  checks?: VersionChecks | null;
  children?: ReactNode;
}

export function StatusTracker(props: StatusTrackerProps): ReactElement {
  const report = props.report ?? props.consents ?? props.consentReport ?? null;
  const authors = props.authors ?? [];
  const entries =
    props.trackerEntries ??
    (report !== null ? trackerFromReport(report, authors) : trackerFromDraft(authors));
  const counts = props.counts ?? countConsents(entries);
  const summary = props.consentsSummary ?? consentSummary(counts);

  const state = report?.state ?? "awaiting_consent";
  const consentsDone = counts.total > 0 && counts.signed === counts.total && counts.declined === 0;
  const moderationDone = state === "listed" || state === "held" || state === "rejected";
  const listedDone = state === "listed";

  const stages = [
    { key: "submitted", label: "Submitted", done: props.submitted ?? true },
    { key: "consents", label: counts.total > 0 ? `Co-author consents (${counts.signed}/${counts.total})` : "Co-author consents", detail: summary, done: consentsDone },
    { key: "moderation", label: "Moderation", detail: "target 48 h", done: moderationDone },
    { key: "listed", label: "Listed", done: listedDone },
    { key: "ai", label: "AI pre-review", done: false },
  ];

  return (
    <section className="sw-status-tracker" aria-label="Status tracker">
      <h3 className="sw-status-tracker__title">Status</h3>
      <ol className="sw-status-tracker__list">
        {stages.map((stage) => (
          <li
            key={stage.key}
            className="sw-status-tracker__stage"
            data-stage={stage.key}
            data-done={stage.done ? "true" : "false"}
          >
            <span className="sw-status-tracker__label">{stage.label}</span>
            {stage.detail ? <span className="sw-status-tracker__detail">{stage.detail}</span> : null}
            {stage.done ? <span className="sw-status-tracker__check" aria-hidden="true">✓</span> : null}
          </li>
        ))}
      </ol>
      <ConsentTracker entries={entries} caption="Co-author consents" />
      {props.checks !== undefined ? <TrackerChecks checks={props.checks} /> : null}
      {props.children}
    </section>
  );
}

/** The advisory check report at the bottom of the tracker; see {@link StatusTrackerProps.checks}. */
function TrackerChecks({ checks }: { checks: VersionChecks | null }): ReactElement {
  const items = checkItems(checks);
  return (
    <section className="sw-tracker" aria-labelledby="sw-tracker-checks-title">
      <header className="sw-tracker__head">
        <h3 id="sw-tracker-checks-title" className="sw-tracker__title">
          Automated checks
        </h3>
        <p className="sw-tracker__summary" role="status">
          {checks === null ? "Checks pending" : checksSummary(items)}
        </p>
      </header>
      {checks === null ? (
        <p className="sw-tracker__note">
          They run once the version is signed and every co-author has consented; results appear here by themselves.
        </p>
      ) : (
        <ul className="sw-tracker__list">
          {items.map((item) => (
            <li key={item.id} className="sw-tracker__row" data-check={item.id} data-state={item.state}>
              <span className="sw-tracker__who">
                <span className="sw-tracker__name">{item.title}</span>
                {item.summary !== "" ? (
                  <span className="sw-tracker__detail">{item.summary}</span>
                ) : null}
              </span>
              <span className="sw-chip" data-tone={CHECK_STATE_TONES[item.state]}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
