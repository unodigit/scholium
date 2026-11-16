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
 * The byline and the file manifest are carried over from that version
 * unchanged, and the form says so rather than implying files were re-uploaded.
 *
 * Signing happens on this device behind a passkey prompt, like every record
 * this feature signs. If another version landed while the form was open, the
 * server refuses the record (`409`) and the form says what happened and offers
 * to load the paper again; the typed change note is kept, because what the
 * author changed is still theirs to say.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { useSignedIn } from "../../components/nav/session";
import { shortDid, type DraftAuthor } from "./authors";
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
import { shortCid } from "./fingerprint";
import {
  CHANGE_NOTE_MAX,
  canSignNewVersion,
  describeNewVersionError,
  draftFromPaper,
  loadNewVersionPaper,
  newVersionBlockers,
  newVersionLoadErrorMessage,
  parseNewVersionRef,
  submitNewVersion,
  bylineAsDraft,
  type LoadNewVersion,
  type NewVersionDraft,
  type NewVersionFailure,
  type NewVersionPaper,
  type SignVersionRecord,
  type SubmitVersionRecord,
} from "./new-version";
import { DEFAULT_CONSENT_POLL_MS, useConsents } from "./use-consents";
import { useDeviceDid } from "./use-device-did";
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
  /** Replaces the consent report request (tests). */
  fetchConsents?: FetchConsents;
  /** Milliseconds between consent report refreshes; `0` asks once. */
  pollMs?: number;
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

function NewVersionForm(props: NewVersionPageProps & { paperId: string }): ReactElement {
  const { paperId } = props;

  const [phase, setPhase] = useState<FormPhase>("loading");
  const [paper, setPaper] = useState<NewVersionPaper | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewVersionDraft | null>(null);
  const [signing, setSigning] = useState(false);
  const [failure, setFailure] = useState<NewVersionFailure | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(props.loadPaper ?? loadNewVersionPaper);
  loadRef.current = props.loadPaper ?? loadNewVersionPaper;

  // A reload after a stale `prev` keeps the author's change note: what they
  // changed is still theirs to say, whatever number the version lands on.
  const keptNoteRef = useRef<string | null>(null);
  const reload = (): void => {
    if (draft !== null) {
      keptNoteRef.current = draft.changeNote;
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
        const keptNote = keptNoteRef.current;
        keptNoteRef.current = null;
        setPaper(loaded);
        setDraft({ ...draftFromPaper(loaded), ...(keptNote === null ? {} : { changeNote: keptNote }) });
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

  const blockers = newVersionBlockers(draft);
  const canSign = canSignNewVersion(draft);
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
      const submitted = await submitNewVersion({ paper, draft, sign: props.sign, submit: props.submit });
      setVersionId(submitted.versionId);
      setPhase("submitted");
    } catch (error) {
      setFailure(describeNewVersionError(error));
    } finally {
      setSigning(false);
    }
  };

  const trackerAuthors = bylineAsDraft(paper.authors, ownDid);

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
          paperHref={paperHref}
          authors={trackerAuthors}
          report={consents.report}
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
          draft={draft}
          onChange={setDraft}
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
}

function SignSection({
  paper,
  draft,
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
}: SignSectionProps): ReactElement {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Entering the step starts at the one field this form adds, not on a button
  // that has just moved.
  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  const blockers = newVersionBlockers(draft);
  const nextN = paper.n + 1;

  const hint = !canSignNewVersion(draft)
    ? blockers[0]
    : !hasKey
      ? "This device has no signing key, so it cannot sign the version."
      : `You are signing version ${nextN} of this paper. This cannot be edited later.`;

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

      <CarriedOver paper={paper} />

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

/** The parts of the previous version this form does not change, said in words. */
function CarriedOver({ paper }: { paper: NewVersionPaper }): ReactElement {
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
                    <span className="nv-byline__name">{author.name ?? shortDid(author.did)}</span>
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
            The files of version {paper.n} are carried over unchanged.{" "}
            <span className="nv-facts__more">
              (manifest <code className="nv-mono">{shortCid(paper.manifest)}</code>)
            </span>
          </dd>
        </div>
      </dl>
      <p className="nv-carried__note">
        This form changes the details and the change note. The byline and the files are signed exactly as
        version {paper.n} signed them.
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
  paperHref,
  authors,
  report,
}: {
  paper: NewVersionPaper;
  versionId: string | null;
  paperHref: string;
  authors: readonly DraftAuthor[];
  report: ConsentReport | null;
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
      />
    </>
  );
}
