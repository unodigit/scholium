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

  return (
    <article className="mc-case" aria-labelledby={headingId}>
      <header className="mc-case-header">
        <div className="mc-case-heading">
          <p className="mc-section-kicker">Appeal</p>
          <p className="mc-case-panel">
            You&apos;re on the appeal panel for {appeal.paper?.title ?? "a moderation decision"}
          </p>
          <h3 id={headingId} className="mc-case-title">
            {appeal.paper?.title ?? "Appeal of a moderation decision"}
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
        {appeal.original?.versionCid != null ? (
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
      <span className="mc-case-strong">{actionLabel(original.action)}</span>
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
