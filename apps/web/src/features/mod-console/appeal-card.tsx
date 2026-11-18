"use client";

/**
 * One appeal in the console: the decision that was contested, the grounds, and
 * either the panel's decision or the vote form.
 *
 * An open appeal carries the panel vote form; a decided one shows the outcome
 * and reasons the panel published, with a link to the signed record. The card
 * also marks itself decided as soon as the vote form reports that the member's
 * vote completed the panel, without waiting for the list to be reloaded.
 */

import { useState } from "react";

import { policyHref } from "../policies-page";
import { RecordLink } from "../ui-kit";
import { AppealVoteForm } from "./appeal-vote-form";
import {
  actionLabel,
  isAppealOpen,
  outcomeLabel,
  type AppealCase,
  type AppealSubject,
} from "./appeals";
import { PersonName, type LoadPersonName } from "./person";
import type { VoteCaster } from "./panel-vote";
import { modDetailHref, type Signal } from "./queue";
import { SignalCell } from "./queue-table";
import { formatDate } from "./wire";
import "./mod-console.css";

/** Where the appeal stands, as an icon plus words (never colour alone). */
export function appealSignal(open: boolean): Signal {
  return open
    ? { tone: "warn", icon: "pending", text: "Waiting for the panel" }
    : { tone: "ok", icon: "check", text: "Decided by the panel" };
}

/** Props for {@link AppealCard}. */
export interface AppealCardProps {
  appeal: AppealCase;
  /** Injectable vote sender, passed to the form. */
  castVote?: VoteCaster;
  /** Reads the appellant's profile name; replaceable in tests. */
  loadPerson?: LoadPersonName;
}

/** The appeal as a card. */
export function AppealCard({ appeal, castVote, loadPerson }: AppealCardProps) {
  const [decidedNow, setDecidedNow] = useState(false);
  const open = isAppealOpen(appeal) && !decidedNow;
  const filed = formatDate(appeal.filedAt);
  const headingId = `appeal-${appeal.appealCid}-title`;
  const record = recordSubject(appeal);

  return (
    <article className="mc-case" aria-labelledby={headingId}>
      <header className="mc-case-header">
        <div className="mc-case-heading">
          <p className="mc-section-kicker">Appeal</p>
          {appeal.viewerOnPanel === true ? (
            <p className="mc-case-panel">You&apos;re on the appeal panel</p>
          ) : null}
          <h3 id={headingId} className="mc-case-title">
            {appealHeading(appeal)}
          </h3>
          <p className="mc-case-meta">
            {appeal.paper?.versionId ? (
              <span className="mono-id">{appeal.paper.versionId}</span>
            ) : null}
            {appeal.paper?.versionId && filed !== null ? " · " : null}
            {filed !== null ? `Filed ${filed}` : null}
            {appeal.appellantDid !== "" ? " by " : null}
            {appeal.appellantDid !== "" ? (
              <PersonName did={appeal.appellantDid} loadName={loadPerson} />
            ) : null}
          </p>
        </div>
        <SignalCell signal={appealSignal(open)} />
      </header>

      <dl className="mc-case-facts">
        <div>
          <dt>Decision appealed</dt>
          <dd>
            <DecisionSummary appeal={appeal} />
          </dd>
        </div>
        <div>
          <dt>Grounds for appeal</dt>
          <dd className="mc-case-text">
            {appeal.grounds === "" ? "No grounds were given." : appeal.grounds}
          </dd>
        </div>
      </dl>

      <div className="mc-case-links">
        <RecordLink
          cid={appeal.appealCid}
          label="View the appeal"
          title="Signed appeal"
          className="mc-button mc-button--quiet"
        />
        <RecordLink
          cid={appeal.decisionCid}
          label="View the decision"
          title="Signed moderation decision"
          className="mc-button mc-button--quiet"
        />
        {record !== null ? (
          record.link !== null ? (
            <a className="mc-button mc-button--quiet" href={record.link}>
              Read the {recordNoun(record)}
            </a>
          ) : null
        ) : appeal.original?.versionCid != null ? (
          <a
            className="mc-button mc-button--quiet"
            href={modDetailHref(appeal.original.versionCid)}
          >
            Read the paper
          </a>
        ) : null}
      </div>

      {appeal.verdict !== null ? (
        <Verdict appeal={appeal} />
      ) : (
        <AppealVoteForm
          appealCid={appeal.appealCid}
          castVote={castVote}
          onDecided={() => setDecidedNow(true)}
        />
      )}
    </article>
  );
}

/** The subject, when the appealed decision was about a post, annotation or review. */
function recordSubject(appeal: AppealCase): AppealSubject | null {
  const { subject } = appeal;
  return subject != null && subject.kind !== "paper" ? subject : null;
}

/** `post`, `annotation` or `review`; anything else is "record". */
function recordNoun(subject: AppealSubject): string {
  return subject.kind === "item" ? "record" : subject.kind;
}

/** `a post`, `an annotation`. */
function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** Whether the appealed decision hid its target. */
function wasHidden(appeal: AppealCase): boolean {
  return appeal.original?.action === "hide" || appeal.subject?.action === "hide";
}

/**
 * The card's heading: the paper's title, once. An appeal about a post or review
 * is headed by what it is about instead, because the decision line below names
 * the paper the post is on and the title would otherwise be said twice.
 */
function appealHeading(appeal: AppealCase): string {
  const record = recordSubject(appeal);
  if (record !== null) {
    const noun = recordNoun(record);
    return wasHidden(appeal)
      ? `Appeal of a hidden ${noun}`
      : `Appeal of a decision on ${withArticle(noun)}`;
  }
  return (
    appeal.paper?.title ?? appeal.subject?.title ?? "Appeal of a moderation decision"
  );
}

/** What was decided, citing which clause and why. */
function DecisionSummary({ appeal }: { appeal: AppealCase }) {
  const { original } = appeal;
  if (original === null) {
    return (
      <span className="mc-paper-muted">
        This server&rsquo;s log does not hold the decision record.
      </span>
    );
  }
  return (
    <>
      <span className="mc-case-strong">{decisionHeadline(appeal, original.action)}</span>
      {original.clause !== null ? (
        <>
          {" "}
          under policy{" "}
          <a className="mc-link" href={policyHref(original.clause)}>
            {original.clause}
          </a>
        </>
      ) : null}
      {original.reason !== null ? (
        <span className="mc-case-text mc-case-reason">{original.reason}</span>
      ) : null}
    </>
  );
}

/**
 * What the decision did, to what: `Reject the paper`, or for a record
 * `Hidden post on 'Title': 'The post's first words'`. What the node could not
 * read is left out, never replaced by a placeholder.
 */
function decisionHeadline(appeal: AppealCase, action: string): string {
  const record = recordSubject(appeal);
  if (record === null) {
    return action === "hide" ? "Hidden record" : actionLabel(action);
  }
  const noun = recordNoun(record);
  let headline = wasHidden(appeal) ? `Hidden ${noun}` : `Decision on ${withArticle(noun)}`;
  if (record.title !== null) {
    headline += ` on '${record.title}'`;
  }
  if (record.excerpt !== null) {
    headline += `: '${record.excerpt}'`;
  }
  return headline;
}

/** The panel's published decision. */
function Verdict({ appeal }: { appeal: AppealCase }) {
  const { verdict } = appeal;
  if (verdict === null) {
    return null;
  }
  const decided = formatDate(verdict.decidedAt);
  return (
    <section className="mc-verdict" aria-label="Panel decision">
      <h4 className="mc-vote-title">Panel decision</h4>
      <p className="mc-verdict-outcome">
        {outcomeLabel(verdict.outcome)}
        {decided !== null ? (
          <span className="mc-paper-muted"> · {decided}</span>
        ) : null}
      </p>
      {verdict.reasons.map((reason, index) => (
        <p key={index} className="mc-verdict-reason">
          {reason}
        </p>
      ))}
      <div className="mc-case-links">
        <RecordLink
          cid={verdict.cid}
          label="View the panel's decision"
          title="Signed panel decision"
          className="mc-button mc-button--quiet"
        />
      </div>
    </section>
  );
}

export default AppealCard;
