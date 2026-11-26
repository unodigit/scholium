"use client";

/**
 * The post-submission status tracker (docs/design.md §5.4): a stepper through
 * Submitted → Co-author consents → Scan → Moderation → Listed → AI pre-review.
 *
 * Each stage is its own block: a marker, a label, a count where there is one,
 * the stage's state *in words* (Done, In progress, Needs attention, Not
 * started) and a line of detail. The consents stage carries each author's own
 * state, and, while the viewer still owes a consent, a "Sign your consent"
 * link to `/consent/{version}` — the submitter is listed as an author who has
 * not signed, and the tracker used to give them no way to do it.
 *
 * It can also carry the version's automated checks (`checks`, from
 * `GET /v1/papers/{id}/v/{n}/checks`): `null` means the node has no report
 * yet — a 404 until it has scanned the version — which reads as
 * **Checks pending**; a report is shown as the four advisory verdicts. Checks
 * never gate anything here: signing has already happened.
 *
 * A version the safety scan held is not a version waiting for a moderator. Its
 * report names the file that failed, so the Scan step carries the attention
 * ("Needs fixing", the reason, and a link to publish a corrected version),
 * Moderation reads "Not reached", and the advisory checks say they did not run.
 *
 * A version waiting for the node's antivirus is not held either: nothing was
 * found, the node could not run the scan. Its Scan step reads "Waiting" and
 * says the scan runs again automatically with nothing for the author to do;
 * there is no new version to publish, Moderation reads "Not reached", and the
 * step keeps polling as for a scan in progress.
 */

import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import { ConsentTracker } from "./consent-tracker";
import { countConsents, consentSummary, trackerFromDraft, trackerFromReport, type ConsentReport, type TrackerEntry } from "./consents";
import { CHECK_STATE_TONES } from "./checks-step";
import { checkItems, checksSummary, fileProblem, WAITING_FOR_SCAN, type VersionChecks } from "./checks";
import { newVersionHref } from "./new-version";
import type { DraftAuthor } from "./authors";
import { CheckIcon, WarningIcon } from "./icons";
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
   * The id of the signed `paper.version`, which the consent link points at
   * (`/consent/{versionCid}`). Used until the consent report arrives and says
   * it itself; with neither, there is nothing to link to.
   */
  versionCid?: string;
  /**
   * The version's check report, or `null` while the node has none (shown as
   * "Checks pending"). Leave the prop out to show no checks at all.
   */
  checks?: VersionChecks | null;
  children?: ReactNode;
}

type StageState = "done" | "current" | "attention" | "upcoming";

interface Stage {
  key: "submitted" | "consents" | "scan" | "moderation" | "listed" | "ai";
  label: string;
  /** "1/2": a fraction beside the label, for a stage that counts something. */
  count?: string;
  detail?: string;
  done: boolean;
  /** Something needs a person: a co-author declined, or moderation held the version. */
  attention?: boolean;
}

const STATE_WORDS: Record<StageState, string> = {
  done: "Done",
  current: "In progress",
  attention: "Needs attention",
  upcoming: "Not started",
};

/** The version states that come after consents / after the scan. */
const PAST_CONSENTS = new Set(["scanning", "moderation", "listed", "held", "rejected"]);
const PAST_SCAN = new Set(["moderation", "listed", "held", "rejected"]);
/** A held version has not passed moderation: it is stopped there, waiting for a person. */
const PAST_MODERATION = new Set(["listed", "rejected"]);

export function StatusTracker(props: StatusTrackerProps): ReactElement {
  const report = props.report ?? props.consents ?? props.consentReport ?? null;
  const authors = props.authors ?? [];
  const entries =
    props.trackerEntries ??
    (report !== null ? trackerFromReport(report, authors) : trackerFromDraft(authors));
  const counts = props.counts ?? countConsents(entries);
  const summary = props.consentsSummary ?? consentSummary(counts);

  const state = report?.state ?? "awaiting_consent";
  const consentsDone =
    PAST_CONSENTS.has(state) || (counts.total > 0 && counts.signed === counts.total && counts.declined === 0);

  // The scan only passed when it ran: a report naming a failed file is the
  // scan's own verdict, and it stops the version before moderation. A version
  // waiting for the node's antivirus is a wait, not a verdict: nothing failed
  // and there is nothing to fix, so it never takes the attention path.
  const failedFiles = props.checks?.files.filter((file) => file.status === "failed") ?? [];
  const scanFailed = failedFiles.length > 0;
  const scanWaiting = !scanFailed && props.checks?.scanWaiting === true;

  const stages: Stage[] = [
    { key: "submitted", label: "Submitted", done: props.submitted ?? true },
    {
      key: "consents",
      label: "Co-author consents",
      count: counts.total > 0 ? `${counts.signed}/${counts.total}` : undefined,
      detail: summary,
      done: consentsDone,
      attention: counts.declined > 0 && !consentsDone,
    },
    {
      key: "scan",
      label: "Scan",
      detail: scanFailed
        ? failedFiles.map((file) => fileProblem(file)).join(" ")
        : scanWaiting
          ? WAITING_FOR_SCAN
          : "Files and references are checked",
      done: PAST_SCAN.has(state) && !scanFailed && !scanWaiting,
      attention: scanFailed,
    },
    {
      key: "moderation",
      label: "Moderation",
      detail: state === "held" && !scanFailed ? "Not listed while the hold stands" : "Target: 48 hours",
      done: PAST_MODERATION.has(state) && !scanFailed,
      // A hold by the safety scan is not a moderator's decision.
      attention: state === "held" && !scanFailed,
    },
    { key: "listed", label: "Listed", done: state === "listed" },
    { key: "ai", label: "AI pre-review", detail: "Advisory, after listing", done: false },
  ];
  // The first stage that is not done is where the version is now.
  const currentIndex = stages.findIndex((stage) => !stage.done);

  // The node's own report names the version; the id from signing stands in until it arrives.
  const versionCid = report?.versionCid ?? props.versionCid;
  const owesConsent = entries.some((entry) => entry.isYou && entry.status === "waiting");
  // A version back in draft (someone declined) is not asking for signatures.
  const consentLink =
    owesConsent && state === "awaiting_consent" && versionCid !== undefined && versionCid !== ""
      ? `/consent/${encodeURIComponent(versionCid)}`
      : null;
  // A file the scan failed is fixed by publishing a corrected one in a new version.
  const fixPaper = props.paper ?? report?.paper;
  const fixHref =
    scanFailed && fixPaper !== undefined && fixPaper !== "" ? newVersionHref(fixPaper) : null;

  return (
    <section className="sw-status-tracker" aria-label="Status tracker">
      <h3 className="sw-status-tracker__title">Status</h3>
      <ol className="sw-status-tracker__list" aria-label="Submission status">
        {stages.map((stage, index) => {
          const stageState: StageState = stage.done
            ? "done"
            : index === currentIndex
              ? stage.attention
                ? "attention"
                : "current"
              : "upcoming";
          // After listing, the AI pre-review is on its way rather than "in
          // progress"; a hold is said as "Held"; a failed scan is something to
          // fix; a scan the node could not run is a wait; and moderation
          // behind a failed or waiting scan was never reached.
          const stateWords =
            stage.key === "ai" && stageState === "current"
              ? "Pending"
              : stage.key === "scan" && stageState === "attention"
                ? "Needs fixing"
                : stage.key === "scan" && scanWaiting
                  ? "Waiting"
                  : stage.key === "moderation" && stageState === "attention"
                    ? "Held"
                    : stage.key === "moderation" && (scanFailed || scanWaiting) && !stage.done
                      ? "Not reached"
                      : STATE_WORDS[stageState];
          return (
            <li
              key={stage.key}
              className="sw-status-tracker__stage"
              data-stage={stage.key}
              data-state={stageState}
              data-done={stage.done ? "true" : "false"}
              aria-current={stageState === "current" || stageState === "attention" ? "step" : undefined}
            >
              <span className="sw-status-tracker__marker" aria-hidden="true">
                {stageState === "done" ? (
                  <CheckIcon />
                ) : stageState === "attention" ? (
                  <WarningIcon />
                ) : (
                  index + 1
                )}
              </span>
              <div className="sw-status-tracker__body">
                <div className="sw-status-tracker__head">
                  <span className="sw-status-tracker__label">{stage.label}</span>
                  {stage.count !== undefined ? (
                    // The detail line already says "1 of 2 signed"; the fraction is for the eye.
                    <span className="sw-status-tracker__count" aria-hidden="true">
                      {stage.count}
                    </span>
                  ) : null}
                  <span className="sw-status-tracker__state">{stateWords}</span>
                </div>
                {stage.detail ? (
                  // The count of signatures changes by itself as co-authors answer, so it is announced politely.
                  <p className="sw-status-tracker__detail" role={stage.key === "consents" ? "status" : undefined}>
                    {stage.detail}
                  </p>
                ) : null}
                {stage.key === "scan" && fixHref !== null ? (
                  <Link className="sw-button sw-button--primary sw-status-tracker__action" href={fixHref}>
                    Publish a new version
                  </Link>
                ) : null}
                {stage.key === "consents" ? (
                  <>
                    <ConsentTracker
                      entries={entries}
                      embedded
                      caption={
                        state === "awaiting_consent"
                          ? "Each author gets a link to review and sign. The version moves on once everyone has signed."
                          : undefined
                      }
                    />
                    {consentLink !== null ? (
                      <Link className="sw-button sw-button--primary sw-status-tracker__action" href={consentLink}>
                        Sign your consent
                      </Link>
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
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
