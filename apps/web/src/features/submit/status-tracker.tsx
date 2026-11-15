"use client";

import type { ReactElement, ReactNode } from "react";

import { ConsentTracker } from "./consent-tracker";
import { countConsents, consentSummary, trackerFromDraft, trackerFromReport, type ConsentReport, type TrackerEntry } from "./consents";
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
      {props.children}
    </section>
  );
}
