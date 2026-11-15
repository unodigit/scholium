"use client";

/**
 * Step 5 of the submit wizard: Sign (docs/design.md §5.4).
 *
 * "Summary card + Sign and submit (passkey prompt)." Signs `paper.genesis`,
 * `manifest` and `paper.version`, submits each to the node, and afterwards
 * shows a status tracker: Submitted → Co-author consents → Moderation →
 * Listed → AI pre-review.
 */

import { useMemo, useState, type ReactElement } from "react";

import { recordAuthors, type DraftAuthor } from "./authors";
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
  versionNumber?: number;
  changeNote?: string;
  seed?: string;
  paperSeed?: string;
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

  const fetchConsentsProp = props.fetchConsents ?? fetchConsents;
  const pollMs = props.pollMs ?? props.consentsPollMs ?? DEFAULT_CONSENT_POLL_MS;
  const consents = useConsents(consentsRef, { fetcher: fetchConsentsProp, intervalMs: pollMs });

  const trackerEntries = useMemo(
    () =>
      consents.report !== null
        ? trackerFromReport(consents.report, authors)
        : trackerFromDraft(authors),
    [consents.report, authors],
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
      setPhase("submitted");
      onDone?.(signedResult);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPhase("idle");
    }
  };

  const counts = countConsents(trackerEntries);

  return (
    <section className="sw-step" aria-labelledby="sw-sign-title">
      <h2 id="sw-sign-title" className="sw-step__title" tabIndex={-1}>
        Sign
      </h2>
      <p className="sw-step__lede">
        You are signing version 1 of this paper. This cannot be edited later; you can publish a new version at
        any time.
      </p>

      <section className="sw-summary" aria-label="Summary card">
        <h3 className="sw-summary__title">Summary</h3>
        <p className="sw-summary__title-text">{details.title}</p>
        {details.abstract ? <p className="sw-summary__abstract">{details.abstract}</p> : null}
        {details.categories.length > 0 ? (
          <ul className="sw-summary__categories" aria-label="Categories">
            {details.categories.map((category) => (
              <li key={category}>{category}</li>
            ))}
          </ul>
        ) : null}
        <p className="sw-summary__licence">Licence: {details.licence}</p>
        <ul className="sw-summary__authors" aria-label="Authors">
          {authors.map((author) => (
            <li key={author.key}>
              {author.name.trim() === "" ? author.identifier ?? "Author" : author.name}
              {author.creditRoles.length > 0 ? ` — ${author.creditRoles.join(", ")}` : ""}
            </li>
          ))}
        </ul>
        <p className="sw-summary__files">{files.length} files</p>
        {files.length > 0 ? (
          <ul className="sw-summary__files-list" aria-label="Files">
            {files.map((file) => (
              <li key={file.id}>{file.path}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {error !== null ? (
        <p className="sw-notice" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sw-actions">
        {props.onBack ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={props.onBack} disabled={phase === "signing"}>
            Back to Checks
          </button>
        ) : null}
        <button
          type="button"
          className="sw-button sw-button--primary"
          disabled={phase === "signing" || phase === "submitted"}
          onClick={() => void handleSign()}
        >
          {phase === "signing" ? "Signing…" : "Sign and submit"}
        </button>
      </div>

      {phase === "submitted" && result !== null ? (
        <StatusTracker
          submitted
          report={consents.report}
          consents={consents.report}
          authors={authors}
          trackerEntries={trackerEntries}
          counts={counts}
          consentsSummary={consentSummary(counts)}
          paper={result.shortId ?? result.paperId}
          version={props.versionNumber ?? 1}
        />
      ) : null}
    </section>
  );
}

export { StatusTracker, type StatusTrackerProps } from "./status-tracker";
