"use client";

/**
 * ProofTab: the Proof tab of the paper page (docs/design.md §5.3).
 *
 * ```tsx
 * <ProofTab schId="sch:k3f9-q2xz-7mwd/v2" />
 * <ProofTab schId={paper.versionId} onStateChange={(state) => setBadge(state)} />
 * ```
 *
 * On mount it runs verify-core **in the browser**: it fetches the paper's
 * signed records, checks every signature, link, consent and notice itself, and
 * says the result as a plain-language checklist,
 *
 * ```text
 * ✓ Verified · 3 versions · 4 signatures                     [Re-run check]
 *   Signed. Anchoring is not enabled on this node yet.
 * ✓ Signed by all 4 listed authors
 * ✓ Version history is intact (v1 → v2)
 * ✓ Files match what the authors signed (3 files)
 * ✓ Recorded in the node's public log (entry #41)
 * ◔ Timestamp anchor pending: anchoring is not enabled on this node yet
 * ✓ No retraction or correction on record
 * ◔ Preserved: 1 of 1 local copy                    Network details ▸
 * ▸ Technical details
 * ```
 *
 * with the technical details (record ids, anchor, signers, the six checks) and
 * the command that repeats the check offline, `scholium verify …`, under a
 * disclosure. The result is the CLI's: both fail on exactly the same failed
 * checks (see `checklist.ts`). The indicator's headline carries the PRD's
 * counts (journey 3: "Verified: 3 versions, 4 signatures") with the anchor
 * state as the line under it, and the checklist names people and records in
 * words — raw ids stay in the technical details.
 *
 * - **Five states**, the VerifyBadge's: Verified, Signed · anchor pending,
 *   Checking…, Could not check, Verification failed. A check that could not
 *   *run* (offline, node has no such paper) is "Could not check", grey, and
 *   says it is not a failure. Only evidence of a mismatch is red.
 * - **Never colour alone.** Every line has an icon of its own shape, and a
 *   visually hidden word ("Passed", "Failed"…) for screen readers.
 * - **It announces its own result.** The verdict is a polite live region that
 *   stays mounted from "Checking…" to the verdict, so a screen reader says the
 *   new words.
 * - `onStateChange` lets the paper header's VerifyBadge show the same state
 *   without verifying a second time.
 *
 * The tab renders its own bad-id notice rather than throwing, so one mistyped
 * link cannot take the page down.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

import {
  COPIED_MESSAGE,
  COPIED_RESET_MS,
  COPY_FAILED_MESSAGE,
  Icon,
  VERIFY_BADGE_SPECS,
  copyText,
  ensureToastRegion,
  showToast,
  type IconName,
  type VerifyState,
} from "../ui-kit";
import {
  abbreviateId,
  verdictCopy,
  type ChecklistItem,
  type ItemState,
  type TechnicalRow,
} from "./checklist";
import { PaperRefError, parsePaperRef, type PaperRef } from "./paper-ref";
import { runProofCheck, type ProofOutcome } from "./run-proof-check";
import { createNodeProofSource, type ProofSource } from "./source";
import "./proof-tab.css";

export interface ProofTabProps {
  /** The paper or version to check: `sch:xxxx-xxxx-xxxx` or `sch:xxxx-xxxx-xxxx/vN`. */
  schId: string;
  /**
   * Where records come from. Defaults to the node's public read API. Pass a
   * stable object (module constant or `useMemo`): a new one starts a new check.
   */
  source?: ProofSource;
  /** `did:key`s trusted to retract, correct or tombstone any paper (CLI `--authority`). */
  authorities?: readonly string[];
  /** Node address shown in the offline command. Defaults to the API base URL. */
  nodeUrl?: string;
  /** Most bytes of files the check may download to compare with the manifest. */
  maxDownloadBytes?: number;
  /**
   * Called with "checking" when a check starts and with the verdict when it
   * ends (and the full outcome, for those that want the details).
   */
  onStateChange?: (state: VerifyState, outcome: ProofOutcome | null) => void;
}

/** The icon of each checklist line: a different shape per state, never colour alone. */
const ITEM_ICONS: Readonly<Record<ItemState, IconName>> = {
  pass: "check",
  pending: "pending",
  warn: "alert",
  fail: "cross",
};

/** Read before each line by a screen reader, since the icon is hidden from it. */
const ITEM_WORDS: Readonly<Record<ItemState, string>> = {
  pass: "Passed",
  pending: "Pending",
  warn: "Warning",
  fail: "Failed",
};

type Parsed = { ref: PaperRef; error?: undefined } | { ref?: undefined; error: string };

function parse(schId: string): Parsed {
  try {
    return { ref: parsePaperRef(schId) };
  } catch (error) {
    return {
      error: error instanceof PaperRefError ? error.message : "That is not a paper id.",
    };
  }
}

export function ProofTab({
  schId,
  source,
  authorities,
  nodeUrl,
  maxDownloadBytes,
  onStateChange,
}: ProofTabProps) {
  const parsed = useMemo(() => parse(schId), [schId]);
  const fallbackSource = useMemo(() => createNodeProofSource(), []);
  const activeSource = source ?? fallbackSource;
  // Compared by value, so an inline `authorities={[…]}` does not restart the check.
  const authoritiesKey = (authorities ?? []).join("\n");

  const [outcome, setOutcome] = useState<ProofOutcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The latest callback, without making a new one restart the check.
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const ref = parsed.ref;
  useEffect(() => {
    if (ref === undefined) return;
    const controller = new AbortController();
    setOutcome(null);
    onStateChangeRef.current?.("checking", null);

    runProofCheck({
      ref,
      source: activeSource,
      authorities: authoritiesKey === "" ? [] : authoritiesKey.split("\n"),
      nodeUrl,
      maxDownloadBytes,
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setOutcome(result);
        onStateChangeRef.current?.(result.state, result);
      },
      () => {
        // Rejects only when aborted: this check has been replaced or unmounted.
      },
    );
    return () => controller.abort();
  }, [ref, activeSource, authoritiesKey, nodeUrl, maxDownloadBytes, attempt]);

  const rerun = useCallback(() => setAttempt((count) => count + 1), []);

  if (parsed.error !== undefined) {
    return <ProofNotice message={parsed.error} />;
  }

  const checking = outcome === null;
  const state: VerifyState = outcome?.state ?? "checking";
  const spec = VERIFY_BADGE_SPECS[state];
  const copy = verdictCopy(state);

  return (
    <section className="pt-tab" aria-label="Proof" aria-busy={checking} data-state={state}>
      <div className="pt-head">
        <div className="pt-verdict" role="status" data-state={state} data-tone={spec.tone}>
          <p className="pt-verdict__line">
            <Icon name={spec.icon} className="pt-verdict__icon" />
            {/* A finished check's headline carries its counts; the fallback is
                the checking copy, the only outcome-less render there is. */}
            <span className="pt-verdict__headline">{outcome?.headline ?? copy.headline}</span>
          </p>
          <p className="pt-verdict__summary">{outcome?.summary ?? copy.summary}</p>
          {outcome !== null && (outcome.state === "anchor_pending" || outcome.state === "verified") ? (
            <p className="pt-verified">Verified in your browser</p>
          ) : null}
        </div>
        <button type="button" className="pt-button" onClick={rerun} disabled={checking}>
          Re-run check
        </button>
      </div>

      {outcome !== null && outcome.items.length > 0 ? (
        <ul className="pt-checklist">
          {outcome.items.map((item) => (
            <ChecklistLine key={item.key} item={item} />
          ))}
        </ul>
      ) : null}

      {outcome !== null ? <TechnicalDetails outcome={outcome} /> : null}
    </section>
  );
}

/**
 * What the tab shows for a link that does not name a paper. Also used by the
 * `/proof/…` route when it cannot read the URL, so both say the same thing.
 */
export function ProofNotice({ message }: { message: string }) {
  return (
    <section className="pt-tab" aria-label="Proof">
      <div className="pt-notice" role="alert">
        <p className="pt-notice__title">That is not a paper id</p>
        <p className="pt-notice__text">{message}</p>
      </div>
    </section>
  );
}

function ChecklistLine({ item }: { item: ChecklistItem }) {
  // An `https:` follow-up (the anchor transaction) opens in a new tab; a path
  // (`/network`) is this site's own page and opens in this one.
  const external = item.link !== null && /^https:\/\//.test(item.link.href);
  return (
    <li className="pt-item" data-state={item.state} data-key={item.key}>
      <Icon name={ITEM_ICONS[item.state]} className="pt-item__icon" />
      <div className="pt-item__body">
        <p className="pt-item__text">
          <span className="pt-visually-hidden">{ITEM_WORDS[item.state]}: </span>
          {item.text}
          {item.link !== null ? (
            <>
              {" "}
              <a
                className="pt-link"
                href={item.link.href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
              >
                {item.link.label}
                {external ? " ↗" : null}
                {external ? (
                  <span className="pt-visually-hidden"> (opens in a new tab)</span>
                ) : null}
              </a>
            </>
          ) : null}
        </p>
        {item.details.length > 0 ? (
          <ul className="pt-item__details">
            {item.details.map((detail, index) => (
              <li key={`${index}:${detail}`}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Record ids, anchor, signers, the six checks and the offline command.
 *
 * Collapsed when all is well, as in the design. Open when the reader most
 * needs it: after a failure (the findings) and after "Could not check" (the
 * offline command is the way forward).
 */
function TechnicalDetails({ outcome }: { outcome: ProofOutcome }) {
  const open = outcome.state === "failed" || outcome.state === "cannot_verify";
  return (
    <details className="pt-details" open={open}>
      <summary className="pt-details__summary">Technical details</summary>

      {outcome.rows.length > 0 ? (
        <dl className="pt-tech">
          {outcome.rows.map((row) => (
            <TechnicalRowView key={row.key} row={row} />
          ))}
        </dl>
      ) : null}

      {outcome.checks.length > 0 ? (
        <>
          <p className="pt-subhead">Checks run in your browser</p>
          <ul className="pt-checks">
            {outcome.checks.map((check) => (
              <li key={check.name} className="pt-check" data-passed={check.passed}>
                <code className="pt-check__name">{check.name}</code>
                <span className="pt-check__result">{check.passed ? "ok" : "FAILED"}</span>
                <span className="pt-check__message">{check.message}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="pt-offline">
        <p className="pt-subhead">Verify offline:</p>
        <CopyValue value={outcome.command} label="the offline command" block />
      </div>
    </details>
  );
}

function TechnicalRowView({ row }: { row: TechnicalRow }) {
  return (
    <div className="pt-tech__row" data-key={row.key}>
      <dt className="pt-tech__label">{row.label}</dt>
      <dd className="pt-tech__value">
        {row.kind === "id" ? (
          <CopyValue value={row.value} label={row.label} abbreviate />
        ) : (
          row.value
        )}
      </dd>
    </div>
  );
}

interface CopyValueProps {
  /** The full value: what is copied. */
  value: string;
  /** What it is, for the button's name: "Copy Version record: …". */
  label: string;
  /** Show it shortened; the full value is the tooltip and the accessible name. */
  abbreviate?: boolean;
  /** A command that wraps over several lines instead of one id. */
  block?: boolean;
}

/**
 * A value in monospace that copies on click and confirms with the "Copied"
 * toast, the way an ID pill does (docs/design.md §7). It is a real button, so
 * Tab, Enter and Space work, and it never claims a copy the browser refused.
 */
function CopyValue({ value, label, abbreviate = false, block = false }: CopyValueProps) {
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    // The live region must exist before the first toast for it to be announced.
    ensureToastRegion();
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Read the theme now: `currentTarget` is gone once the handler returns.
    const theme = event.currentTarget.closest("[data-theme]")?.getAttribute("data-theme") ?? null;
    // Started inside the click, which is what lets the browser allow the write.
    void copyText(value).then((ok) => {
      showToast(ok ? COPIED_MESSAGE : COPY_FAILED_MESSAGE, { theme });
      if (!ok || !mounted.current) return;
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, COPIED_RESET_MS);
    });
  };

  return (
    <button
      type="button"
      className="pt-copy"
      data-block={block}
      data-copied={copied}
      aria-label={`Copy ${label}: ${value}`}
      title={abbreviate ? value : undefined}
      onClick={handleClick}
    >
      <code className="pt-copy__value">{abbreviate ? abbreviateId(value) : value}</code>
      <Icon name={copied ? "check" : "copy"} className="pt-copy__icon" />
    </button>
  );
}
