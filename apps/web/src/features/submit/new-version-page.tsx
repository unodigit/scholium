"use client";

/**
 * `/submit/new-version/[ref]` — the New version form the paper page links an
 * author to (feature 163).
 *
 * `/submit` starts a paper: it signs a `paper.genesis`. This form extends one:
 * it signs exactly one `paper.version` whose `prev` names the paper's current
 * latest version and whose `n` is one more, which is the only pair the server's
 * chain check accepts.
 *
 * The form is pre-filled from what the latest version *signed* — title,
 * abstract, categories and licence, edited through the same Details step as the
 * wizard — and asks the one question a new version must answer: what changed.
 * The byline is carried over from that version unchanged.
 *
 * "What changed" is also where the author handles the **files** and the
 * **response to reviewers**. The previous version's files are kept unless the
 * author removes one or uploads a replacement or an addition, through the same
 * drop zones, tus upload and fingerprint check as `/submit`; changed files are
 * signed into a new manifest the version names. Each revealed review of the
 * previous version gets a response box, and every answer is posted as a
 * `review.response` once the version has landed — a response that fails never
 * undoes the version, and can be sent again.
 *
 * Signing happens on this device behind a passkey prompt, like every record
 * this feature signs. If another version landed while the form was open, the
 * server refuses the record (`409`) and the form says what happened and offers
 * to load the paper again; the typed change note is kept, because what the
 * author changed is still theirs to say.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { useSignedIn } from "../../components/nav/session";
import { roleLabel } from "../paper-meta/meta";
import { shortDid, type DraftAuthor } from "./authors";
import { fetchVersionChecks, type FetchChecks, type VersionChecks } from "./checks";
import { recordUrl } from "./consent-version";
import {
  consentSummary,
  countConsents,
  fetchConsents,
  trackerFromDraft,
  trackerFromReport,
  type ConsentReport,
  type FetchConsents,
} from "./consents";
import { DetailsStep } from "./details-step";
import { DropZone } from "./drop-zone";
import { FileRow } from "./file-row";
import { summaryText } from "./file-view";
import { shortCid } from "./fingerprint";
import { formatBytes, SIZE_LIMITS } from "./limits";
import { withProfileNames, type FetchProfileName, type ProfileNames } from "./profile-names";
import {
  CHANGE_NOTE_MAX,
  canSignNewVersion,
  describeNewVersionError,
  draftFromPaper,
  fileChangeCounts,
  loadNewVersionPaper,
  newVersionBlockers,
  newVersionLoadErrorMessage,
  noFileChanges,
  parseNewVersionRef,
  resultingFiles,
  submitNewVersion,
  submitReviewResponses,
  bylineAsDraft,
  type LoadNewVersion,
  type ManifestFile,
  type NewVersionDraft,
  type NewVersionFailure,
  type NewVersionPaper,
  type RespondToReview,
  type ResponseOutcome,
  type ReviewToAnswer,
  type SignVersionRecord,
  type SubmitVersionRecord,
} from "./new-version";
import { completedFiles, summarize, type ManagerDeps, type UploadManager, type FileEntry } from "./upload-manager";
import { DEFAULT_CHECK_POLL_MS, useChecks } from "./use-checks";
import { DEFAULT_CONSENT_POLL_MS, useConsents } from "./use-consents";
import { useDeviceDid } from "./use-device-did";
import { useProfileNames } from "./use-profile-names";
import { useUploadManager } from "./use-upload-manager";
import { StatusTracker } from "./status-tracker";
import "./submit.css";
import "./new-version.css";

export interface NewVersionPageProps {
  /** The `[ref]` path segment: the paper to publish the next version of. */
  paper: string;
  /** Pin the author's DID instead of reading this device's key; `null` means none. */
  submitterDid?: string | null;
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
  /** Replaces the loader (tests). */
  loadPaper?: LoadNewVersion;
  /** Replaces `signRecord` (tests). */
  sign?: SignVersionRecord;
  /** Replaces `POST /v1/records` (tests). */
  submit?: SubmitVersionRecord;
  /** Replaces `POST /v1/reviews/{cid}/response` (tests). */
  respond?: RespondToReview;
  /** Replaces the real fingerprinting and tus uploading of new files (tests). */
  managerDeps?: ManagerDeps;
  /** Replaces the consent report request (tests). */
  fetchConsents?: FetchConsents;
  /** Milliseconds between consent report refreshes; `0` asks once. */
  pollMs?: number;
  /** Replaces the automated-checks request for the new version (tests). */
  fetchChecks?: FetchChecks;
  /** Milliseconds between check report refreshes; `0` asks once. */
  checksPollMs?: number;
  /** Replaces the public profile lookup that names the carried byline (tests). */
  fetchProfileName?: FetchProfileName;
}

/** One plain sentence for where the pre-fill came from and what signing does. */
function lede(paper: NewVersionPaper): string {
  return `Pre-filled from version ${paper.n}, the paper's latest version. What you sign becomes version ${paper.n + 1}; version ${paper.n} stays as it is.`;
}

export function NewVersionPage(props: NewVersionPageProps): ReactElement {
  const parsed = parseNewVersionRef(props.paper);
  if ("error" in parsed) {
    return (
      <NewVersionShell crumb="scholium / submit / new version">
        <p className="sw-notice" role="alert">
          {parsed.error}
        </p>
        <p className="nv-back">
          <Link href="/search">Find the paper from search</Link>
        </p>
      </NewVersionShell>
    );
  }
  return <NewVersionForm {...props} paperId={parsed.id} />;
}

function NewVersionShell({
  crumb,
  children,
}: {
  crumb: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="sw-wizard nv-page">
      <header className="sw-header">
        <p className="sw-crumb">{crumb}</p>
        <h1 className="sw-title">Submit a new version</h1>
      </header>
      {children}
    </div>
  );
}

type FormPhase = "loading" | "error" | "details" | "sign" | "submitted";

/** Why the new files are not ready to be named in a manifest, or `null`: the wizard's wording. */
function uploadsBlocker(entries: readonly FileEntry[]): string | null {
  const summary = summarize(entries);
  if (summary.failed > 0) {
    return "Retry or remove the files that failed.";
  }
  if (summary.paused > 0) {
    return "Resume or remove the paused files.";
  }
  if (summary.inProgress > 0) {
    return "Wait for the uploads and fingerprints to finish.";
  }
  return null;
}

function NewVersionForm(props: NewVersionPageProps & { paperId: string }): ReactElement {
  const { paperId } = props;

  const [phase, setPhase] = useState<FormPhase>("loading");
  const [paper, setPaper] = useState<NewVersionPaper | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewVersionDraft | null>(null);
  const [signing, setSigning] = useState(false);
  const [failure, setFailure] = useState<NewVersionFailure | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [manifestId, setManifestId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ResponseOutcome[] | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [nonce, setNonce] = useState(0);

  // The new files live in an upload manager that outlives the steps, so going
  // back to Details and forward again finds the same list.
  const { manager, entries } = useUploadManager(props.managerDeps);
  const uploads = useMemo(() => completedFiles(entries), [entries]);

  const loadRef = useRef(props.loadPaper ?? loadNewVersionPaper);
  loadRef.current = props.loadPaper ?? loadNewVersionPaper;

  // A reload after a stale `prev` keeps the author's change note and their
  // answers to the reviews: what they wrote is still theirs to say, whatever
  // number the version lands on. (Uploaded files stay in the manager; which
  // previous files they drop is asked again, since those may have changed.)
  const keptRef = useRef<{ note: string; responses: Readonly<Record<string, string>> } | null>(null);
  const reload = (): void => {
    if (draft !== null) {
      keptRef.current = { note: draft.changeNote, responses: draft.responses ?? {} };
    }
    setNonce((value) => value + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    setPhase("loading");
    setLoadError(null);
    loadRef
      .current(paperId, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) {
          return;
        }
        const kept = keptRef.current;
        keptRef.current = null;
        setPaper(loaded);
        setDraft({
          ...draftFromPaper(loaded),
          ...(kept === null ? {} : { changeNote: kept.note, responses: kept.responses }),
        });
        setFailure(null);
        setPhase("details");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setPaper(null);
        setDraft(null);
        setLoadError(newVersionLoadErrorMessage(error));
        setPhase("error");
      });
    return () => controller.abort();
  }, [paperId, nonce]);

  const isSignedIn = useSignedIn(props.signedIn);
  // The stored session is only readable after mount; wait before saying
  // otherwise, so a signed-in author never sees the notice flash up.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const device = useDeviceDid(props.submitterDid);
  const ownDid = device.phase === "ready" ? device.did : null;

  const fetchConsentsProp = props.fetchConsents ?? fetchConsents;
  const pollMs = props.pollMs ?? DEFAULT_CONSENT_POLL_MS;
  const consents = useConsents(
    phase === "submitted" && paper !== null
      ? { paper: paper.shortId !== "" ? paper.shortId : paperId, version: paper.n + 1 }
      : null,
    { fetcher: fetchConsentsProp, intervalMs: pollMs },
  );
  // The new files are scanned by the node once the version exists: the same
  // advisory report the wizard's tracker shows. 404 until it has scanned them
  // reads as "Checks pending"; nothing here blocks anything, signing is done.
  const checks = useChecks(
    phase === "submitted" && paper !== null
      ? { paper: paper.shortId !== "" ? paper.shortId : paperId, version: paper.n + 1 }
      : null,
    { fetcher: props.fetchChecks ?? fetchVersionChecks, intervalMs: props.checksPollMs ?? DEFAULT_CHECK_POLL_MS },
  );

  // The previous version's byline lists DIDs, and the form carries it over
  // unchanged; the public profile names each person for display only.
  const profileNames = useProfileNames(
    paper === null ? [] : paper.authors.map((author) => author.did),
    { fetcher: props.fetchProfileName },
  );

  if (phase === "loading") {
    return (
      <NewVersionShell crumb={`scholium / submit / new version / ${paperId}`}>
        <p className="nv-loading" role="status" aria-busy="true">
          Loading the paper…
        </p>
      </NewVersionShell>
    );
  }

  if (phase === "error" || paper === null || draft === null) {
    return (
      <NewVersionShell crumb={`scholium / submit / new version / ${paperId}`}>
        <p className="sw-notice" role="alert">
          {loadError ?? "The paper could not be loaded. Try again in a moment."}
        </p>
        <div className="sw-actions">
          <button type="button" className="sw-button" onClick={reload}>
            Try again
          </button>
          <Link className="sw-button sw-button--quiet" href={`/p/${encodeURIComponent(paperId)}`}>
            Back to the paper
          </Link>
        </div>
      </NewVersionShell>
    );
  }

  // What the author has typed, with the files they have uploaded so far.
  const current: NewVersionDraft = {
    ...draft,
    files: {
      ...(draft.files ?? noFileChanges()),
      added: uploads,
      pending: uploadsBlocker(entries),
    },
  };
  const canSign = canSignNewVersion(current);
  const hasKey = device.phase === "checking" || ownDid !== null;
  const keyReady = device.phase === "ready";
  const listed = ownDid !== null && paper.authors.some((author) => author.did === ownDid);
  // Encoded once, from the raw path: `/signin?next=%2Fsubmit%2F…`, like the wizard.
  const signInHref = `/signin?next=${encodeURIComponent(`/submit/new-version/${paperId}`)}`;
  const paperHref = `/p/${encodeURIComponent(paper.shortId !== "" ? paper.shortId : paperId)}`;

  const handleSign = async (): Promise<void> => {
    if (signing || phase !== "sign" || paper === null || draft === null) {
      return;
    }
    setSigning(true);
    setFailure(null);
    try {
      const submitted = await submitNewVersion({
        paper,
        draft: current,
        sign: props.sign,
        submit: props.submit,
        respond: props.respond,
      });
      setVersionId(submitted.versionId);
      setManifestId(submitted.manifestId ?? null);
      setOutcomes(submitted.responses ?? null);
      setPhase("submitted");
    } catch (error) {
      setFailure(describeNewVersionError(error));
    } finally {
      setSigning(false);
    }
  };

  // Post again only the responses that did not land; the version stays as it is.
  const retryResponses = async (): Promise<void> => {
    if (retrying || outcomes === null) {
      return;
    }
    setRetrying(true);
    try {
      const failed = Object.fromEntries(
        outcomes.filter((outcome) => !outcome.ok).map((outcome) => [outcome.reviewCid, draft.responses?.[outcome.reviewCid] ?? ""]),
      );
      const again = await submitReviewResponses({ responses: failed, sign: props.sign, respond: props.respond });
      setOutcomes((previous) =>
        (previous ?? []).map((outcome) => again.find((next) => next.reviewCid === outcome.reviewCid) ?? outcome),
      );
    } finally {
      setRetrying(false);
    }
  };

  const trackerAuthors = withProfileNames(bylineAsDraft(paper.authors, ownDid), profileNames);

  return (
    <NewVersionShell
      crumb={`scholium / submit / new version / ${paper.shortId !== "" ? paper.shortId : paperId}`}
    >
      <p className="sw-step__lede nv-lede">{lede(paper)}</p>

      {mounted && !isSignedIn ? (
        <p className="sw-notice" role="note">
          You are not signed in. <Link href={signInHref}>Sign in</Link> first so the version is linked to you.
        </p>
      ) : null}

      {phase === "submitted" ? (
        <SubmittedPanel
          paper={paper}
          versionId={versionId}
          manifestId={manifestId}
          outcomes={outcomes}
          retrying={retrying}
          onRetry={() => void retryResponses()}
          paperHref={paperHref}
          authors={trackerAuthors}
          report={consents.report}
          checks={checks.report}
        />
      ) : phase === "details" ? (
        <DetailsStep
          value={draft.details}
          onChange={(details) => setDraft({ ...draft, details })}
          onContinue={() => setPhase("sign")}
          nextStepLabel="the change note"
        />
      ) : (
        <SignSection
          paper={paper}
          draft={current}
          entries={entries}
          manager={manager}
          onChange={(next) =>
            // The state holds what the author decided; uploads are layered on at render.
            setDraft({ ...next, files: { ...(next.files ?? noFileChanges()), added: [], pending: null } })
          }
          onBack={() => setPhase("details")}
          onSign={() => void handleSign()}
          signing={signing}
          canSign={canSign && hasKey}
          hasKey={hasKey}
          keyReady={keyReady}
          listed={listed}
          failure={failure}
          onReload={reload}
          signInHref={signInHref}
          names={profileNames}
        />
      )}
    </NewVersionShell>
  );
}

// ---------------------------------------------------------------------------
// The change note and the sign action
// ---------------------------------------------------------------------------

interface SignSectionProps {
  paper: NewVersionPaper;
  draft: NewVersionDraft;
  entries: readonly FileEntry[];
  manager: UploadManager;
  onChange: (draft: NewVersionDraft) => void;
  onBack: () => void;
  onSign: () => void;
  signing: boolean;
  /** True when the draft is complete and a key is (or may yet be) available. */
  canSign: boolean;
  hasKey: boolean;
  keyReady: boolean;
  listed: boolean;
  failure: NewVersionFailure | null;
  onReload: () => void;
  signInHref: string;
  /** Public names for the carried byline, which lists DIDs only. */
  names: ProfileNames;
}

function SignSection({
  paper,
  draft,
  entries,
  manager,
  onChange,
  onBack,
  onSign,
  signing,
  canSign,
  hasKey,
  keyReady,
  listed,
  failure,
  onReload,
  signInHref,
  names,
}: SignSectionProps): ReactElement {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Entering the step starts at the one field this form adds, not on a button
  // that has just moved.
  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  const blockers = newVersionBlockers(draft);
  const nextN = paper.n + 1;

  // One passkey prompt per record: the file list when the files changed, the
  // version, and each answered review.
  const signatures = signatureCount(paper, draft);
  const hint = !canSignNewVersion(draft)
    ? blockers[0]
    : !hasKey
      ? "This device has no signing key, so it cannot sign the version."
      : `You are signing version ${nextN} of this paper. This cannot be edited later.${
          signatures.total > 1 ? ` You will confirm ${signatures.total} signatures: ${signatures.what}.` : ""
        }`;

  return (
    <section className="sw-step" aria-labelledby="nv-sign-title">
      <h2 id="nv-sign-title" className="sw-step__title" tabIndex={-1}>
        What changed
      </h2>
      <p className="sw-step__lede">
        The change note is part of the signed version and is shown in its timeline, so a reader can tell the
        versions apart.
      </p>

      <div className="sw-field">
        <label className="sw-field__label" htmlFor="nv-change-note">
          Change note (required)
        </label>
        <textarea
          id="nv-change-note"
          ref={noteRef}
          className="sw-input sw-textarea"
          rows={4}
          value={draft.changeNote}
          maxLength={CHANGE_NOTE_MAX}
          required
          aria-describedby="nv-change-note-hint"
          onChange={(event) => onChange({ ...draft, changeNote: event.target.value })}
        />
        <p id="nv-change-note-hint" className="sw-field__hint">
          What is different from version {paper.n}. {draft.changeNote.length} of {CHANGE_NOTE_MAX} characters.
        </p>
      </div>

      <FilesSection
        paper={paper}
        draft={draft}
        entries={entries}
        manager={manager}
        onToggleRemoved={(path) => {
          const files = draft.files ?? noFileChanges();
          onChange({
            ...draft,
            files: {
              ...files,
              removed: files.removed.includes(path)
                ? files.removed.filter((removed) => removed !== path)
                : [...files.removed, path],
            },
          });
        }}
      />

      {paper.reviews.length > 0 ? (
        <ResponsesSection
          paper={paper}
          responses={draft.responses ?? {}}
          onChange={(responses) => onChange({ ...draft, responses })}
        />
      ) : null}

      <CarriedOver paper={paper} draft={draft} names={names} />

      {keyReady && !hasKey ? (
        <p className="sw-notice" role="note">
          This device has no signing key. <Link href="/onboarding">Create one</Link> or{" "}
          <Link href={signInHref}>sign in</Link> on a device that has yours.
        </p>
      ) : null}

      {keyReady && hasKey && !listed ? (
        <p className="sw-notice" role="note">
          The key on this device is not one of the authors version {paper.n} lists. The byline is carried over
          unchanged; whether this key may publish a version of the paper is the server&rsquo;s to say.
        </p>
      ) : null}

      {failure !== null ? (
        <p className="sw-notice" role="alert">
          {failure.message}
          {failure.signIn ? (
            <>
              {" "}
              <Link href={signInHref}>Sign in</Link>
            </>
          ) : null}
          {failure.staleChain ? (
            <>
              {" "}
              <button type="button" className="nv-inline-action" onClick={onReload}>
                Load the paper again
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="sw-actions">
        <button type="button" className="sw-button sw-button--quiet" onClick={onBack} disabled={signing}>
          Back to Details
        </button>
        <button
          type="button"
          className="sw-button sw-button--primary"
          disabled={!canSign || signing}
          aria-describedby="nv-sign-hint"
          onClick={onSign}
        >
          {signing ? "Signing…" : `Sign and submit version ${nextN}`}
        </button>
        <p id="nv-sign-hint" className="sw-actions__hint">
          {hint}
        </p>
      </div>
    </section>
  );
}

/** How many records signing signs, and what they are, in words. */
function signatureCount(paper: NewVersionPaper, draft: NewVersionDraft): { total: number; what: string } {
  const previous = draft.previousFiles ?? null;
  const filesChanged = previous !== null && !fileCounts(previous, draft).unchanged;
  const answered = paper.reviews.filter((review) => (draft.responses?.[review.cid] ?? "").trim() !== "").length;
  const parts = [
    ...(filesChanged ? ["the new file list"] : []),
    "the version",
    ...(answered > 0 ? [answered === 1 ? "1 response" : `${answered} responses`] : []),
  ];
  return {
    total: (filesChanged ? 1 : 0) + 1 + answered,
    what: parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0],
  };
}

/** What the author's file changes come to against `previous`. */
function fileCounts(previous: readonly ManifestFile[], draft: NewVersionDraft) {
  const result = resultingFiles(previous, draft.files ?? noFileChanges());
  return { result, ...fileChangeCounts(previous, result) };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** What the Paper zone's file picker offers first; any file can still be chosen and is then validated. */
const PAPER_ACCEPT = ".pdf,.tex,.latex,.ltx,.bib,.bbl,.bst,.sty,.cls,.zip,.tar,.tar.gz,.tgz,.png,.jpg,.jpeg,.svg,.eps";

interface FilesSectionProps {
  paper: NewVersionPaper;
  draft: NewVersionDraft;
  entries: readonly FileEntry[];
  manager: UploadManager;
  onToggleRemoved: (path: string) => void;
}

/**
 * The previous version's files, kept unless the author says otherwise, and the
 * same drop zones and upload rows as `/submit` for replacing or adding files.
 */
function FilesSection({ paper, draft, entries, manager, onToggleRemoved }: FilesSectionProps): ReactElement {
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const nextN = paper.n + 1;
  const previous = paper.files;

  if (previous === null) {
    // The list could not be read, so there is nothing safe to change: a manifest
    // built from new files alone would silently drop every old one.
    return (
      <section className="nv-block" aria-labelledby="nv-files-title">
        <h3 id="nv-files-title" className="nv-block__title">
          Files
        </h3>
        <p className="nv-block__lede">
          The files of version {paper.n} could not be listed here, so they are carried over unchanged.{" "}
          <span className="nv-facts__more">
            (manifest <code className="nv-mono">{shortCid(paper.manifest)}</code>)
          </span>
        </p>
      </section>
    );
  }

  const changes = draft.files ?? noFileChanges();
  const uploadedPaths = new Set(changes.added.map((file) => file.path));
  const { result, kept, replaced, added, removed, unchanged } = fileCounts(previous, draft);
  const summary = summarize(entries);

  const handleFiles =
    (zone: "paper" | "extras") =>
    (files: File[], folders: string[]): void => {
      setFolderNotice(
        folders.length > 0
          ? `Folders cannot be uploaded as they are (${folders.join(", ")}). ` +
              "Compress each into a .zip or .tar.gz and add that instead."
          : null,
      );
      if (files.length > 0) {
        manager.addFiles(files, zone);
      }
    };

  return (
    <section className="nv-block" aria-labelledby="nv-files-title">
      <h3 id="nv-files-title" className="nv-block__title">
        Files
      </h3>
      <p className="nv-block__lede">
        Every file of version {paper.n} is kept unless you remove it. To replace a file, upload one with the
        same name; to add one, upload it below. What you change is signed into a new file list for version{" "}
        {nextN}.
      </p>

      <ul className="sw-files" aria-label={`Files of version ${paper.n}`}>
        {previous.map((file) => {
          const state = uploadedPaths.has(file.path) && result.some((item) => item.path === file.path && item.cid !== file.cid)
            ? "replaced"
            : changes.removed.includes(file.path) && !uploadedPaths.has(file.path)
              ? "removed"
              : "kept";
          return (
            <PreviousFileRow key={file.path} file={file} state={state} onToggle={() => onToggleRemoved(file.path)} />
          );
        })}
      </ul>

      <aside className="sw-limits" aria-labelledby="nv-limits-title">
        <h4 id="nv-limits-title" className="sw-limits__title">
          Size limits
        </h4>
        <ul className="sw-limits__list">
          {SIZE_LIMITS.map((limit) => (
            <li key={limit.id}>
              <span>{limit.label}</span> <strong>up to {limit.limit}</strong>
            </li>
          ))}
        </ul>
        <p className="sw-limits__note">
          Uploads are resumable. If your connection drops they carry on where they stopped. Each file is
          fingerprinted on your device and checked against the copy on the node.
        </p>
      </aside>

      <div className="sw-zones">
        <DropZone
          title="Paper"
          prompt="Drop a new PDF and/or LaTeX source here, or a .zip of it."
          limit="PDF up to 50 MB · other files up to 5 GB"
          inputLabel="Choose paper files"
          accept={PAPER_ACCEPT}
          onFiles={handleFiles("paper")}
        />
        <DropZone
          title="Code and data (optional)"
          prompt="Drop analysis code, notebooks or datasets here. Bundle many files into a .zip."
          limit="Up to 5 GB per file"
          inputLabel="Choose code and data files"
          onFiles={handleFiles("extras")}
        />
      </div>

      {folderNotice ? (
        <p className="sw-notice" role="alert">
          {folderNotice}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <>
          <p className="nv-block__lede" role="status">
            {summaryText(summary)}
          </p>
          <ul className="sw-files" aria-label={`New files for version ${nextN}`}>
            {entries.map((entry) => (
              <FileRow
                key={entry.id}
                entry={entry}
                onRole={(id, role) => manager.setRole(id, role)}
                onPause={(id) => manager.pause(id)}
                onResume={(id) => manager.resume(id)}
                onRetry={(id) => manager.retry(id)}
                onRemove={(id) => manager.remove(id)}
              />
            ))}
          </ul>
        </>
      ) : null}

      <p className="nv-block__total" role="status" aria-label={`Files in version ${nextN}`}>
        {unchanged
          ? `Version ${nextN} lists the same ${result.length === 1 ? "file" : "files"} as version ${paper.n}.`
          : `Version ${nextN} will list ${result.length} ${result.length === 1 ? "file" : "files"}: ${[
              kept > 0 ? `${kept} kept` : null,
              replaced > 0 ? `${replaced} replaced` : null,
              added > 0 ? `${added} added` : null,
              removed > 0 ? `${removed} removed` : null,
            ]
              .filter((part): part is string => part !== null)
              .join(", ")}.`}
      </p>
    </section>
  );
}

const PREVIOUS_FILE_STATES = {
  kept: { label: "Kept", tone: "neutral" },
  removed: { label: "Removed", tone: "critical" },
  replaced: { label: "Replaced by the new upload", tone: "active" },
} as const;

/** One file of the previous version: kept by default, with a way to drop it (or bring it back). */
function PreviousFileRow({
  file,
  state,
  onToggle,
}: {
  file: ManifestFile;
  state: keyof typeof PREVIOUS_FILE_STATES;
  onToggle: () => void;
}): ReactElement {
  const { label, tone } = PREVIOUS_FILE_STATES[state];
  return (
    <li className="sw-file nv-file" data-state={state}>
      <div className="sw-file__head">
        <span className="sw-file__name">{file.path}</span>
        <span className="sw-chip" data-tone={tone}>
          {label}
        </span>
      </div>
      <div className="sw-file__facts">
        <span>{formatBytes(file.size)}</span>
        <span>{roleLabel(file.role)}</span>
        <code className="sw-file__cid" title={file.cid}>
          {shortCid(file.cid)}
        </code>
      </div>
      {state === "replaced" ? null : (
        <div className="sw-file__actions">
          <button
            type="button"
            className="sw-button sw-button--quiet"
            aria-label={`${state === "removed" ? "Keep" : "Remove"} ${file.path}`}
            onClick={onToggle}
          >
            {state === "removed" ? "Keep" : "Remove"}
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Response to reviewers
// ---------------------------------------------------------------------------

/**
 * One box per revealed review of the previous version. Each answer is posted as
 * the author's response to that review once the version has landed; an empty
 * box says nothing.
 */
function ResponsesSection({
  paper,
  responses,
  onChange,
}: {
  paper: NewVersionPaper;
  responses: Readonly<Record<string, string>>;
  onChange: (responses: Readonly<Record<string, string>>) => void;
}): ReactElement {
  return (
    <section className="nv-block" aria-labelledby="nv-responses-title">
      <h3 id="nv-responses-title" className="nv-block__title">
        Response to reviewers
      </h3>
      <p className="nv-block__lede">
        Answer the reviews of version {paper.n}. Each answer is signed by you and shown under the review it
        answers, once version {paper.n + 1} is submitted. Leave a box empty to say nothing.
      </p>
      <ol className="nv-reviews">
        {paper.reviews.map((review, index) => (
          <ResponseBox
            key={review.cid}
            review={review}
            id={`nv-response-${index}`}
            value={responses[review.cid] ?? ""}
            onChange={(value) => onChange({ ...responses, [review.cid]: value })}
          />
        ))}
      </ol>
    </section>
  );
}

function ResponseBox({
  review,
  id,
  value,
  onChange,
}: {
  review: ReviewToAnswer;
  id: string;
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <li className="nv-review">
      <p className="nv-review__head">
        <span className="nv-review__label">{review.label}</span>
        <span className="nv-review__recommendation">{review.recommendation}</span>
      </p>
      {review.report !== null ? (
        <details className="nv-review__report">
          <summary>Read {review.label}&rsquo;s report</summary>
          <p>{review.report}</p>
        </details>
      ) : (
        <p className="nv-review__sealed">This report is not public yet.</p>
      )}
      <div className="sw-field">
        <label className="sw-field__label" htmlFor={id}>
          Your response to {review.label}
        </label>
        <textarea
          id={id}
          className="sw-input sw-textarea"
          rows={4}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </li>
  );
}

/** The parts of the previous version this form does not change, said in words. */
function CarriedOver({
  paper,
  draft,
  names,
}: {
  paper: NewVersionPaper;
  draft: NewVersionDraft;
  names: ProfileNames;
}): ReactElement {
  const previous = paper.files;
  const unchanged = previous === null || fileCounts(previous, draft).unchanged;
  return (
    <section className="sw-summary nv-carried" aria-labelledby="nv-carried-title">
      <h3 id="nv-carried-title" className="sw-summary__title">
        Carried over from version {paper.n}
      </h3>
      <dl className="nv-facts">
        <div className="nv-facts__row">
          <dt>Extends</dt>
          <dd>
            Version {paper.n} · <code className="nv-mono">{shortCid(paper.versionCid)}</code>
          </dd>
        </div>
        <div className="nv-facts__row">
          <dt>Authors</dt>
          <dd>
            {paper.authors.length === 0 ? (
              `No authors are listed on version ${paper.n}.`
            ) : (
              <ol className="nv-byline">
                {paper.authors.map((author) => (
                  <li key={author.did} className="nv-byline__author">
                    <span className="nv-byline__name">
                      {author.name ?? names[author.did] ?? shortDid(author.did)}
                    </span>
                    {author.creditRoles.length > 0 ? (
                      <span className="nv-byline__roles">{author.creditRoles.join(", ")}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </div>
        <div className="nv-facts__row">
          <dt>Files</dt>
          <dd>
            {unchanged ? (
              <>
                The files of version {paper.n} are carried over unchanged.{" "}
                <span className="nv-facts__more">
                  (manifest <code className="nv-mono">{shortCid(paper.manifest)}</code>)
                </span>
              </>
            ) : (
              <>You changed the files, so version {paper.n + 1} is signed with a new file list.</>
            )}
          </dd>
        </div>
      </dl>
      <p className="nv-carried__note">
        The byline is signed exactly as version {paper.n} signed it.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// After signing
// ---------------------------------------------------------------------------

function SubmittedPanel({
  paper,
  versionId,
  manifestId,
  outcomes,
  retrying,
  onRetry,
  paperHref,
  authors,
  report,
  checks,
}: {
  paper: NewVersionPaper;
  versionId: string | null;
  manifestId: string | null;
  outcomes: readonly ResponseOutcome[] | null;
  retrying: boolean;
  onRetry: () => void;
  paperHref: string;
  authors: readonly DraftAuthor[];
  report: ConsentReport | null;
  checks: VersionChecks | null;
}): ReactElement {
  const nextN = paper.n + 1;
  const entries = report !== null ? trackerFromReport(report, authors) : trackerFromDraft(authors);
  const counts = countConsents(entries);

  return (
    <>
      <section className="sw-step" aria-labelledby="nv-done-title">
        <h2 id="nv-done-title" className="sw-step__title" tabIndex={-1}>
          Version {nextN} is signed and submitted
        </h2>
        <p className="sw-step__lede">
          Version {nextN} of this paper is on its way: every listed author is asked to consent again, then the
          server scans and moderates it before it is listed.
        </p>
        <p className="nv-record">
          Version record <code className="nv-mono">{shortCid(versionId ?? "")}</code>
          {versionId === null ? null : (
            <>
              {" · "}
              <a href={recordUrl(versionId)} target="_blank" rel="noreferrer noopener">
                View record
              </a>
            </>
          )}
        </p>
        {manifestId === null ? null : (
          <p className="nv-record">
            New file list <code className="nv-mono">{shortCid(manifestId)}</code>
          </p>
        )}
        {outcomes === null ? null : (
          <div className="nv-outcomes" role="status">
            <ul className="nv-outcomes__list">
              {outcomes.map((outcome) => {
                const label = paper.reviews.find((review) => review.cid === outcome.reviewCid)?.label ?? "a review";
                return outcome.ok ? (
                  <li key={outcome.reviewCid}>Response to {label}: posted</li>
                ) : (
                  <li key={outcome.reviewCid} className="nv-outcomes__failed">
                    Response to {label}: not posted. {outcome.error}
                  </li>
                );
              })}
            </ul>
            {outcomes.some((outcome) => !outcome.ok) ? (
              <button type="button" className="sw-button" disabled={retrying} onClick={onRetry}>
                {retrying ? "Posting…" : "Post the failed responses again"}
              </button>
            ) : null}
          </div>
        )}
        <div className="sw-actions">
          <Link className="sw-button" href={paperHref}>
            Back to the paper
          </Link>
        </div>
      </section>
      <StatusTracker
        submitted
        report={report}
        authors={authors}
        trackerEntries={entries}
        counts={counts}
        consentsSummary={consentSummary(counts)}
        paper={paper.shortId !== "" ? paper.shortId : paper.paperCid}
        version={nextN}
        checks={checks}
      />
    </>
  );
}
