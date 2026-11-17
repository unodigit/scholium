"use client";

/**
 * Step 5 of the submit wizard: Sign (docs/design.md §5.4).
 *
 * "Summary card + Sign and submit (passkey prompt)." Signs `paper.genesis`,
 * `manifest` and `paper.version`, submits each to the node, and afterwards
 * shows a status tracker: Submitted → Co-author consents → Moderation →
 * Listed → AI pre-review. The tracker also polls the version's automated
 * checks (`GET /v1/papers/{id}/v/{n}/checks`) once it exists: 404 until the
 * node has scanned the version reads as "Checks pending", and the report that
 * lands is advisory — signing has already happened.
 */

import { useMemo, useState, type ReactElement } from "react";

import { authorLabel, recordAuthors, shortDid, type DraftAuthor } from "./authors";
import { fetchVersionChecks, type ChecksVersionRef, type FetchChecks } from "./checks";
import { ConsentTracker } from "./consent-tracker";
import {
  countConsents,
  consentSummary,
  fetchConsents,
  trackerFromDraft,
  trackerFromReport,
  type ConsentReport,
  type FetchConsents,
  type VersionRef,
} from "./consents";
import { emptyDetails, type DetailsValues } from "./details";
import { submissionProblemMessage } from "./eligibility";
import { formatBytes, pluralize } from "./limits";
import { withProfileNames, type FetchProfileName } from "./profile-names";
import { useProfileNames } from "./use-profile-names";
import { useChecks, DEFAULT_CHECK_POLL_MS } from "./use-checks";
import { useConsents, DEFAULT_CONSENT_POLL_MS } from "./use-consents";
import { StatusTracker } from "./status-tracker";
import type { SubmitFile } from "./upload-manager";
import { signRecord, type SignedRecord } from "../web-auth";
import { api } from "../../lib/api";
import "./submit.css";

export interface SignResult {
  paperId: string;
  shortId: string | null;
  manifestId: string;
  versionId: string;
}

export interface SignStepProps {
  files?: readonly SubmitFile[];
  submitFiles?: readonly SubmitFile[];
  submitFilesList?: readonly SubmitFile[];
  details?: DetailsValues;
  value?: DetailsValues;
  draft?: DetailsValues;
  detailsValues?: DetailsValues;
  authors?: readonly DraftAuthor[];
  roster?: readonly DraftAuthor[];
  authorsList?: readonly DraftAuthor[];
  /**
   * The submitting author's profile name, shown on the summary and the tracker
   * in place of "You" when their draft entry carries no name. Display only: it
   * is never written into the signed byline, which lists exactly what the
   * author entered on the Authors step.
   */
  submitterName?: string | null;
  /** Replaces the public profile lookup that names co-authors, for tests. */
  fetchProfileName?: FetchProfileName;
  onBack?: () => void;
  onContinue?: (result: SignResult) => void;
  onSigned?: (result: SignResult) => void;
  onSuccess?: (result: SignResult) => void;
  onSubmitted?: (result: SignResult) => void;
  onSign?: (result: SignResult) => void;
  onSubmit?: (result: SignResult) => void;
  onComplete?: (result: SignResult) => void;
  /** Injected signer; defaults to `signRecord` from web-auth. */
  signRecord?: (
    type: string,
    body: Record<string, unknown>,
    prev: string | null,
  ) => Promise<SignedRecord>;
  sign?: (
    type: string,
    body: Record<string, unknown>,
    prev: string | null,
  ) => Promise<SignedRecord>;
  signer?: (
    type: string,
    body: Record<string, unknown>,
    prev: string | null,
  ) => Promise<SignedRecord>;
  /** Injected submitter; defaults to `POST /records`. */
  submitRecord?: (record: SignedRecord) => Promise<{ id?: string; shortId?: string | null; short_id?: string | null }>;
  submit?: (record: SignedRecord) => Promise<{ id?: string; shortId?: string | null; short_id?: string | null }>;
  postRecord?: (record: SignedRecord) => Promise<{ id?: string; shortId?: string | null; short_id?: string | null }>;
  submitter?: (record: SignedRecord) => Promise<{ id?: string; shortId?: string | null; short_id?: string | null }>;
  apiClient?: { post: (path: string, body: unknown) => Promise<{ id?: string; shortId?: string | null; short_id?: string | null }> };
  fetchConsents?: FetchConsents;
  pollMs?: number;
  consentsPollMs?: number;
  /** Replaces the check report request (tests, callers with their own client). */
  fetchChecks?: FetchChecks;
  /** Milliseconds between check report refreshes; `0` asks once. */
  checksPollMs?: number;
  versionNumber?: number;
  changeNote?: string;
  seed?: string;
  paperSeed?: string;
}

/**
 * Licence ids print by their full name on the summary card. The id is what the
 * signed record carries, so it is never what the author reads back; an id this
 * release does not know still prints as itself rather than being guessed at.
 */
const LICENCE_FULL_NAMES: Readonly<Record<string, string>> = {
  "CC-BY-4.0": "Creative Commons Attribution 4.0",
  "CC-BY-SA-4.0": "Creative Commons Attribution-ShareAlike 4.0",
  "CC-BY-NC-4.0": "Creative Commons Attribution-NonCommercial 4.0",
  "CC-BY-NC-ND-4.0": "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0",
  "CC0-1.0": "CC0 1.0 Universal",
};

function licenceFullName(id: string): string {
  return LICENCE_FULL_NAMES[id] ?? id;
}

function manifestRole(role: SubmitFile["role"]): string {
  switch (role) {
    case "pdf":
      return "manuscript";
    case "source":
      return "source";
    case "code":
      return "code";
    case "data":
      return "dataset";
    default:
      return "other";
  }
}

function manifestBody(files: readonly SubmitFile[]): Record<string, unknown> {
  return {
    files: files.map((file) => ({
      path: file.path,
      cid: file.cid,
      size: file.size,
      mediaType: file.mediaType,
      role: manifestRole(file.role),
    })),
  };
}

export function SignStep(props: SignStepProps): ReactElement {
  const files = props.files ?? props.submitFiles ?? props.submitFilesList ?? [];
  const details = props.details ?? props.value ?? props.draft ?? props.detailsValues ?? emptyDetails();
  const authors = props.authors ?? props.roster ?? props.authorsList ?? [];

  const signer = props.signRecord ?? props.sign ?? props.signer ?? signRecord;
  const submitter =
    props.submitRecord ?? props.submit ?? props.postRecord ?? props.submitter ??
    (props.apiClient !== undefined
      ? (record: SignedRecord) => props.apiClient!.post("/records", record)
      : (record: SignedRecord) => api.post("/records", record));

  const onDone =
    props.onContinue ?? props.onSigned ?? props.onSuccess ?? props.onSubmitted ?? props.onSign ?? props.onSubmit ?? props.onComplete;

  const [phase, setPhase] = useState<"idle" | "signing" | "submitted" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignResult | null>(null);
  const [consentsRef, setConsentsRef] = useState<VersionRef | null>(null);
  const [checksRef, setChecksRef] = useState<ChecksVersionRef | null>(null);

  // People are shown by name. The submitter's draft entry has none unless they
  // typed one, so lend it the profile name for display; co-authors added by DID
  // have none at all, so their public profile supplies it. `authors` itself,
  // which is what gets signed, is left exactly as the author built it.
  const submitterName = props.submitterName ?? null;
  const unnamedDids = useMemo(
    () =>
      authors
        .filter(
          (author) =>
            author.name.trim() === "" &&
            author.did !== null &&
            !(author.isSubmitter && submitterName !== null && submitterName.trim() !== ""),
        )
        .map((author) => author.did as string),
    [authors, submitterName],
  );
  const profileNames = useProfileNames(unnamedDids, { fetcher: props.fetchProfileName });
  const shownAuthors = useMemo(() => {
    const named = withProfileNames(authors, profileNames);
    return submitterName === null || submitterName.trim() === ""
      ? named
      : named.map((author) =>
          author.isSubmitter && author.name.trim() === "" ? { ...author, name: submitterName.trim() } : author,
        );
  }, [authors, profileNames, submitterName]);
  const submitterDid = authors.find((author) => author.isSubmitter)?.did ?? null;

  const fetchConsentsProp = props.fetchConsents ?? fetchConsents;
  const pollMs = props.pollMs ?? props.consentsPollMs ?? DEFAULT_CONSENT_POLL_MS;
  const consents = useConsents(consentsRef, { fetcher: fetchConsentsProp, intervalMs: pollMs });
  // The checks only run on the signed version, so this asks from signing
  // onwards: 404 (route not mounted yet, or the version not scanned) reads as
  // "Checks pending" in the tracker, and the report is advisory — signing has
  // already happened, so nothing here blocks anything.
  const checks = useChecks(checksRef, {
    fetcher: props.fetchChecks ?? fetchVersionChecks,
    intervalMs: props.checksPollMs ?? DEFAULT_CHECK_POLL_MS,
  });

  const trackerEntries = useMemo(
    () =>
      consents.report !== null
        ? trackerFromReport(consents.report, shownAuthors)
        : trackerFromDraft(shownAuthors),
    [consents.report, shownAuthors],
  );

  const handleSign = async (): Promise<void> => {
    if (phase === "signing") return;
    setPhase("signing");
    setError(null);
    try {
      const seed = props.seed ?? props.paperSeed ?? `seed-${Date.now()}`;

      // 1. paper.genesis
      const genesisSigned = await signer(
        "paper.genesis",
        {
          seed,
          title: details.title,
          abstract: details.abstract,
          categories: details.categories,
          licence: details.licence,
          authors: recordAuthors(authors),
        },
        null,
      );
      const genesisAccepted = await submitter(genesisSigned);
      const paperId = genesisAccepted.id ?? genesisSigned.id;
      const shortId = genesisAccepted.shortId ?? genesisAccepted.short_id ?? null;

      // 2. manifest
      const manifestSigned = await signer("manifest", manifestBody(files), null);
      const manifestAccepted = await submitter(manifestSigned);
      const manifestId = manifestAccepted.id ?? manifestSigned.id;

      // 3. paper.version
      const versionNumber = props.versionNumber ?? 1;
      const versionSigned = await signer(
        "paper.version",
        {
          paper: paperId,
          n: versionNumber,
          title: details.title,
          abstract: details.abstract,
          authors: recordAuthors(authors),
          manifest: manifestId,
          licence: details.licence,
          changeNote: props.changeNote ?? "Initial version.",
          categories: details.categories,
        },
        paperId,
      );
      const versionAccepted = await submitter(versionSigned);
      const versionId = versionAccepted.id ?? versionSigned.id;

      const signedResult: SignResult = { paperId, shortId, manifestId, versionId };
      setResult(signedResult);
      setConsentsRef({ paper: shortId ?? paperId, version: versionNumber });
      setChecksRef({ paper: shortId ?? paperId, version: versionNumber });
      setPhase("submitted");
      onDone?.(signedResult);
    } catch (failure) {
      // The node's refusal says "paper.genesis" and prints a raw timestamp;
      // the author gets the rule and the date in their own words.
      setError(submissionProblemMessage(failure, { did: submitterDid }));
      setPhase("idle");
    }
  };

  const counts = countConsents(trackerEntries);

  return (
    <section className="sw-step" aria-labelledby="sw-sign-title">
      <h2 id="sw-sign-title" className="sw-step__title" tabIndex={-1}>
        Sign
      </h2>
      {phase !== "submitted" ? (
        <p className="sw-step__lede">
          You are signing version 1 of this paper. This cannot be edited later; you can publish a new version at
          any time.
        </p>
      ) : null}

      <section className="sw-summary" aria-label="Summary card">
        <h3 className="sw-summary__title">Summary</h3>
        <dl className="sw-summary__list">
          <div className="sw-summary__row">
            <dt className="sw-summary__label">Title</dt>
            <dd className="sw-summary__value sw-summary__title-text">{details.title || "Untitled"}</dd>
          </div>
          <div className="sw-summary__row">
            <dt className="sw-summary__label">Abstract</dt>
            <dd className="sw-summary__value sw-summary__abstract">
              {details.abstract || "No abstract."}
            </dd>
          </div>
          <div className="sw-summary__row">
            <dt className="sw-summary__label">Categories</dt>
            <dd className="sw-summary__value">
              {details.categories.length > 0 ? (
                <ul className="sw-summary__categories" aria-label="Categories">
                  {details.categories.map((category) => (
                    <li key={category}>{category}</li>
                  ))}
                </ul>
              ) : (
                "None chosen."
              )}
            </dd>
          </div>
          <div className="sw-summary__row">
            <dt className="sw-summary__label">Licence</dt>
            <dd className="sw-summary__value sw-summary__licence">{licenceFullName(details.licence)}</dd>
          </div>
          <div className="sw-summary__row">
            <dt className="sw-summary__label">Authors</dt>
            <dd className="sw-summary__value">
              <ul className="sw-summary__authors" aria-label="Authors">
                {shownAuthors.map((author) => {
                  const label = authorLabel(author);
                  const did = author.did ?? (author.kind === "did" ? author.identifier : null);
                  // The name slot already shows an unnamed co-author by their DID;
                  // repeating it underneath would print the same identifier twice.
                  const showDid = did !== null && (author.name.trim() !== "" || author.isSubmitter);
                  return (
                    <li key={author.key}>
                      <span className="sw-summary__author-name">
                        {label}
                        {author.isSubmitter && label !== "You" ? " (you)" : ""}
                      </span>
                      {author.creditRoles.length > 0 ? (
                        <span className="sw-summary__author-roles"> — {author.creditRoles.join(", ")}</span>
                      ) : null}
                      {showDid && did !== null ? (
                        <span className="sw-summary__author-did" title={did}>
                          {shortDid(did)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
          <div className="sw-summary__row">
            <dt className="sw-summary__label">Files</dt>
            <dd className="sw-summary__value">
              <p className="sw-summary__files">{pluralize(files.length, "file")}</p>
              {files.length > 0 ? (
                <ul className="sw-summary__files-list" aria-label="Files">
                  {files.map((file) => (
                    <li key={file.id}>
                      <span className="sw-summary__file-name">{file.path}</span>
                      <span className="sw-summary__file-size">{formatBytes(file.size)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </dd>
          </div>
        </dl>
      </section>

      {error !== null ? (
        <p className="sw-notice" role="alert">
          {error}
        </p>
      ) : null}

      {phase !== "submitted" ? (
        <div className="sw-actions">
          {props.onBack ? (
            <button type="button" className="sw-button sw-button--quiet" onClick={props.onBack} disabled={phase === "signing"}>
              Back to Checks
            </button>
          ) : null}
          <button
            type="button"
            className="sw-button sw-button--primary"
            disabled={phase === "signing"}
            onClick={() => void handleSign()}
          >
            {phase === "signing" ? "Signing…" : "Sign and submit"}
          </button>
        </div>
      ) : null}

      {phase === "submitted" && result !== null ? (
        <StatusTracker
          submitted
          report={consents.report}
          consents={consents.report}
          authors={shownAuthors}
          trackerEntries={trackerEntries}
          counts={counts}
          consentsSummary={consentSummary(counts)}
          paper={result.shortId ?? result.paperId}
          version={props.versionNumber ?? 1}
          versionCid={result.versionId}
          checks={checks.report}
        />
      ) : null}
    </section>
  );
}

export { StatusTracker, type StatusTrackerProps } from "./status-tracker";
