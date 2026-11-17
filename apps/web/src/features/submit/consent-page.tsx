"use client";

/**
 * The `/consent/[version]` page: a listed co-author reads the version and signs
 * a `coauthor.consent` to **accept** or **decline** authorship.
 *
 * The link comes from the notification the API sends when a version enters
 * `awaiting_consent`, and names the `paper.version` record. The page shows what
 * the author is being named on (title, abstract, byline with roles, licence,
 * what changed, files), the consent tracker, and, only to an author who has not
 * answered yet and only while the version is waiting, the two buttons. Each
 * answer is signed on this device behind a passkey prompt; an answer already
 * given is shown, never offered again.
 *
 * Wording follows docs/design.md §8: "record" and "version", and "server" in
 * place of "node" or "CID" in anything a co-author reads.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { ApiError, NetworkError, api } from "../../lib/api";
import { PdfView } from "../paper-page/pdf-view";
import { loadPdfjsWithSession } from "../paper-page/reading";
import { ConsentTracker } from "./consent-tracker";
import {
  CONSENT_COMMENT_MAX,
  closedMessage,
  consentGate,
  consentRole,
  consentTrackerEntries,
  describeConsentError,
  fileUrl,
  formatSigned,
  parseVersionParam,
  recordUrl,
  submitConsent,
  type ConsentDecision,
  type ConsentFailure,
  type ConsentVersion,
  type LoadConsentVersion,
  type SignConsent,
  type SubmitConsent,
  type VersionFile,
} from "./consent-version";
import { fetchConsents as defaultFetchConsents, type FetchConsents } from "./consents";
import { licenceById } from "./details";
import { shortCid } from "./fingerprint";
import { shortDid } from "./authors";
import type { FetchProfileName, ProfileNames } from "./profile-names";
import { ConsentIcon } from "./icons";
import { formatBytes } from "./limits";
import { useConsents } from "./use-consents";
import { useConsentVersion } from "./use-consent-version";
import { useDeviceDid } from "./use-device-did";
import { useProfileNames } from "./use-profile-names";
import "./submit.css";
import "./consent-page.css";
// The PDF viewer's own rules (`ppg-pdf*`), drawn unchanged as on the paper page.
import "../paper-page/paper-page.css";

export interface ConsentPageProps {
  /** The `[version]` path segment: the `paper.version` record's id. */
  version: string;
  /** The DID to act as; `undefined` reads this device's key, `null` means none. */
  did?: string | null;
  /** Replaces the loader of the version record (tests). */
  loadVersion?: LoadConsentVersion;
  /** Replaces the consent report request (tests). */
  fetchConsents?: FetchConsents;
  /** Milliseconds between consent report refreshes while someone is waiting; `0` asks once. */
  pollMs?: number;
  /** Replaces `signRecord` (tests). */
  sign?: SignConsent;
  /** Replaces `POST /v1/records` (tests). */
  submit?: SubmitConsent;
  /** Replaces the public profile lookup that names the authors, for tests. */
  fetchProfileName?: FetchProfileName;
}

function Shell({ crumb, children }: { crumb: string; children: ReactNode }): ReactElement {
  return (
    <div className="cp">
      <header className="sw-header">
        <p className="sw-crumb">{crumb}</p>
        <h1 className="sw-title">Review and sign</h1>
        <p className="cp-lede">
          A co-author reads a version of a paper, then accepts or declines being named on it. The answer is a signed
          record that anyone can read.
        </p>
      </header>
      {children}
    </div>
  );
}

/** The page. A link that cannot name a version is said so before anything is asked of the server. */
export function ConsentPage(props: ConsentPageProps): ReactElement {
  const parsed = parseVersionParam(props.version);
  if ("error" in parsed) {
    return (
      <Shell crumb="scholium / consent">
        <p className="sw-notice" role="alert">
          {parsed.error}
        </p>
      </Shell>
    );
  }
  return <ConsentReview {...props} cid={parsed.cid} />;
}

function VersionCard({ version, names }: { version: ConsentVersion; names: ProfileNames }): ReactElement {
  const licence = version.licence === null ? undefined : licenceById(version.licence);
  const submitter = version.authors.find((author) => author.did === version.submittedBy);
  // The signed record may carry no name (an author added by DID); the public
  // profile is where the person is named. The DID stands in only when there is
  // no name to show.
  const submitterName = submitter?.name ?? names[version.submittedBy] ?? null;
  const submittedBy = submitterName ?? (version.submittedBy === "" ? null : shortDid(version.submittedBy));
  const when = formatSigned(version.created);

  return (
    <article className="cp-version" aria-labelledby="cp-version-title">
      <p className="cp-version__kicker">
        Version {version.n}
        {submittedBy !== null ? ` · signed by ${submittedBy}` : ""}
        {when !== null ? ` on ${when}` : ""}
      </p>
      <h2 id="cp-version-title" className="cp-version__title">
        {version.title === "" ? "Untitled version" : version.title}
      </h2>
      {version.abstract !== "" ? <p className="cp-version__abstract">{version.abstract}</p> : null}
      {version.categories.length > 0 ? (
        <ul className="cp-tags" aria-label="Categories">
          {version.categories.map((category) => (
            <li key={category}>{category}</li>
          ))}
        </ul>
      ) : null}
      <dl className="cp-facts">
        {version.licence !== null ? (
          <div className="cp-facts__row">
            <dt>Licence</dt>
            <dd>
              {licence?.label ?? version.licence}
              {licence !== undefined ? <span className="cp-facts__more"> — {licence.summary}</span> : null}
            </dd>
          </div>
        ) : null}
        {version.changeNote !== null ? (
          <div className="cp-facts__row">
            <dt>What changed</dt>
            <dd>{version.changeNote}</dd>
          </div>
        ) : null}
        <div className="cp-facts__row">
          <dt>Version record</dt>
          <dd>
            <code className="cp-mono">{shortCid(version.versionCid)}</code>
            {" · "}
            <a href={recordUrl(version.versionCid)} target="_blank" rel="noreferrer noopener">
              View record
            </a>
          </dd>
        </div>
      </dl>
    </article>
  );
}

/** True when a manifest entry is a PDF, by its declared type or its name. */
function isPdfFile(file: VersionFile): boolean {
  return (
    file.mediaType?.toLowerCase() === "application/pdf" ||
    file.path.toLowerCase().endsWith(".pdf")
  );
}

/** The PDF to show: the manuscript if it is one, else the first PDF with bytes. */
function manuscriptPdf(files: readonly VersionFile[]): { file: VersionFile; cid: string } | null {
  const pdfs = files.filter(
    (file): file is VersionFile & { cid: string } => file.cid !== null && isPdfFile(file),
  );
  const pdf = pdfs.find((file) => file.role === "manuscript") ?? pdfs[0];
  return pdf === undefined ? null : { file: pdf, cid: pdf.cid };
}

/** The bytes of a listed file, read with the reader's bearer token. */
async function fetchFile(cid: string): Promise<Blob> {
  // An absolute `/v1/content` URL; the API client still attaches the session's
  // token, which the route requires while the version is not listed.
  return api.get<Blob>(fileUrl(cid), { parse: "blob", cache: "no-store" });
}

/** The last path segment: what the browser saves the file as. */
function fileName(path: string): string {
  return path.split("/").filter((part) => part !== "").at(-1) ?? path;
}

/** A plain sentence for why a file could not be read. */
function describeFileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 423) {
      return "This file is still being scanned, so it cannot be opened yet.";
    }
    if (error.status === 451) {
      return "This file was removed for legal reasons and cannot be opened.";
    }
    if (error.status === 404) {
      return "This server does not have this file.";
    }
  }
  if (error instanceof NetworkError) {
    return "Could not reach the server to open this file. Check your connection and try again.";
  }
  return "Could not open this file. Try again in a moment.";
}

/** Saves a fetched file, so a co-author can read it without a tokenised link. */
function saveFile(blob: Blob, path: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(path);
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started; release the bytes on the next task.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * One non-PDF file: a button, not a plain `<a href>`, because the bytes of a
 * version awaiting consent go only to its authors and need the bearer token.
 */
function FileDownload({ file }: { file: VersionFile }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (file.cid === null) {
    return <span>{file.path}</span>;
  }
  const cid = file.cid;

  const download = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      saveFile(await fetchFile(cid), file.path);
    } catch (failure) {
      setError(describeFileError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="sw-link-button" aria-busy={busy} onClick={() => void download()}>
        {file.path}
        <span className="sw-sr-only"> — download</span>
      </button>
      {error !== null ? (
        <span className="cp-note" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function FilesSection({ version }: { version: ConsentVersion }): ReactElement {
  const files = version.files;
  const pdf = files === null ? null : manuscriptPdf(files);
  return (
    <section className="cp-section" aria-labelledby="cp-files-title">
      <h2 id="cp-files-title" className="cp-section__title">
        Files
      </h2>
      {files === null ? (
        <p className="cp-note">The list of files could not be loaded or checked, so it is not shown here.</p>
      ) : files.length === 0 ? (
        <p className="cp-note">This version lists no files.</p>
      ) : (
        <>
          <ul className="cp-files" aria-label={`Files of version ${version.n}`}>
            {files.map((file, index) => (
              <li key={`${file.path}-${index}`} className="cp-files__item">
                {pdf !== null && file === pdf.file ? (
                  // The PDF is drawn on this page; this only moves the reader
                  // to it. A bare content URL would be fetched without the
                  // co-author's token and answered 404.
                  <a href="#cp-pdf">{file.path}</a>
                ) : (
                  <FileDownload file={file} />
                )}
                <span className="cp-files__facts">
                  {[file.role, file.size === null ? null : formatBytes(file.size)].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
          <p className="cp-note">Files open once the server&rsquo;s safety scan has passed.</p>
          {pdf !== null ? (
            <div id="cp-pdf" className="cp-pdf">
              {/* PDF.js fetches the file itself, so the loader adds the
                  reader's token: the bytes are not public yet. */}
              <PdfView url={fileUrl(pdf.cid)} loadPdf={loadPdfjsWithSession} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The answer on record: shown straight after signing and on every later visit. */
function Decided({
  decision,
  consentCid,
}: {
  decision: ConsentDecision;
  consentCid: string | null;
}): ReactElement {
  const accepted = decision === "accept";
  return (
    <div className="cp-decided" data-decision={decision} role="status">
      <p className="cp-decided__head">
        <span className="sw-chip" data-tone={accepted ? "verified" : "critical"}>
          <ConsentIcon status={accepted ? "signed" : "declined"} />
          {accepted ? "Signed" : "Declined"}
        </span>
        <strong>{accepted ? "You accepted authorship of this version." : "You declined authorship of this version."}</strong>
      </p>
      <p className="cp-note">
        {accepted
          ? "Your acceptance is a signed record that anyone can read. It cannot be edited."
          : "This version is back in draft, so it will not be listed. Your answer is a signed record that anyone can read. It cannot be edited."}
      </p>
      {consentCid !== null ? (
        <p className="cp-note">
          Your record: <code className="cp-mono">{shortCid(consentCid)}</code>
          {" · "}
          <a href={recordUrl(consentCid)} target="_blank" rel="noreferrer noopener">
            View record
          </a>
        </p>
      ) : null}
    </div>
  );
}

function ConsentReview({ cid, ...props }: ConsentPageProps & { cid: string }): ReactElement {
  const device = useDeviceDid(props.did);
  const loaded = useConsentVersion(cid, { loader: props.loadVersion });
  const version = loaded.version;

  const ref = useMemo(() => (version === null ? null : { paper: version.paper, version: version.n }), [version]);
  const consents = useConsents(ref, { fetcher: props.fetchConsents ?? defaultFetchConsents, intervalMs: props.pollMs });
  // The signed byline lists DIDs; the public profile names each person. Ask
  // whenever the version changes, and keep the DID when there is no name.
  const profileNames = useProfileNames(
    version === null ? [] : version.authors.map((author) => author.did),
    { fetcher: props.fetchProfileName },
  );

  const [stage, setStage] = useState<"idle" | "confirming" | "signing">("idle");
  const [comment, setComment] = useState("");
  const [failure, setFailure] = useState<ConsentFailure | null>(null);
  /** Set by a successful answer given on this page, ahead of the report catching up. */
  const [answered, setAnswered] = useState<{ decision: ConsentDecision; id: string } | null>(null);

  const signing = useRef(false);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (stage === "confirming") {
      confirmHeading.current?.focus();
    }
  }, [stage]);

  const crumb = `scholium / consent / ${shortCid(cid)}`;

  if (loaded.phase === "loading" || (loaded.phase === "ready" && version === null)) {
    return (
      <Shell crumb={crumb}>
        <p className="cp-note" role="status" aria-busy="true">
          Loading the version…
        </p>
      </Shell>
    );
  }
  if (loaded.phase === "error" || version === null) {
    return (
      <Shell crumb={crumb}>
        <div className="sw-notice" role="alert">
          <p className="cp-notice__text">{loaded.error}</p>
          <button type="button" className="sw-button sw-button--quiet" onClick={loaded.reload}>
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  const gate = consentGate({
    device,
    version,
    report: consents.report,
    reportFailed: consents.phase === "error" && consents.report === null,
  });
  const entries = consentTrackerEntries(version, consents.report, device.did, profileNames);
  const signInHref = `/signin?next=${encodeURIComponent(`/consent/${cid}`)}`;

  const answer = async (decision: ConsentDecision): Promise<void> => {
    if (gate.kind !== "open" || signing.current) {
      return;
    }
    signing.current = true;
    setStage("signing");
    setFailure(null);
    try {
      const done = await submitConsent({
        version,
        author: gate.author,
        decision,
        comment,
        sign: props.sign,
        submit: props.submit,
      });
      setAnswered({ decision: done.decision, id: done.id });
      consents.refresh();
    } catch (error) {
      const described = describeConsentError(error);
      setFailure(described);
      if (described.recheck) {
        consents.refresh();
      }
    } finally {
      signing.current = false;
      setStage("idle");
    }
  };

  let decision: ReactNode;
  if (answered !== null) {
    decision = <Decided decision={answered.decision} consentCid={answered.id} />;
  } else if (gate.kind === "decided") {
    decision = <Decided decision={gate.decision} consentCid={gate.consentCid} />;
  } else if (gate.kind === "checking") {
    decision = (
      <p className="cp-note" role="status">
        Checking who can sign…
      </p>
    );
  } else if (gate.kind === "unavailable") {
    decision = (
      <div className="sw-notice" role="alert">
        <p className="cp-notice__text">
          {consents.error ?? "Could not check who has signed."} Signing is switched off until it is known.
        </p>
        <button type="button" className="sw-button sw-button--quiet" onClick={consents.refresh}>
          Try again now
        </button>
      </div>
    );
  } else if (gate.kind === "no-key") {
    decision = (
      <div className="sw-notice" role="status">
        <p className="cp-notice__text">
          This device has no signing key, so it cannot sign for you. Open this link on the device where you set up your
          Scholium account, or sign in here first.
        </p>
        <p className="cp-notice__actions">
          <Link href={signInHref} className="sw-button sw-button--quiet">
            Sign in
          </Link>
          <Link href="/onboarding" className="sw-button sw-button--quiet">
            Create an account
          </Link>
        </p>
      </div>
    );
  } else if (gate.kind === "not-listed") {
    decision = (
      <p className="sw-notice" role="status">
        The key on this device ({shortDid(gate.did)}) is not one of this version&rsquo;s authors, so it cannot sign for it.
        If the invitation was meant for another account, open the link on that account&rsquo;s device.
      </p>
    );
  } else if (gate.kind === "closed") {
    decision = (
      <p className="sw-notice" role="status">
        {closedMessage(gate, version, profileNames)}
      </p>
    );
  } else {
    const author = gate.author;
    const roles = consentRole(author);
    const busy = stage === "signing";
    decision = (
      <div className="cp-open">
        <p className="cp-open__role">
          You are listed as author {author.position} of {version.authors.length}
          {author.creditRoles.length > 0 ? `, for ${roles}` : ""}.
        </p>
        <p className="cp-note">
          Accepting names you as an author of this version{author.creditRoles.length > 0 ? ", in the roles above" : ""}.
          Declining sends the version back to draft for every author.
        </p>

        <div className="sw-field">
          <label className="sw-field__label" htmlFor="cp-comment">
            Comment <span className="sw-field__hint">(optional)</span>
          </label>
          <textarea
            id="cp-comment"
            className="sw-textarea"
            rows={3}
            maxLength={CONSENT_COMMENT_MAX}
            value={comment}
            disabled={busy}
            aria-describedby="cp-comment-hint"
            onChange={(event) => setComment(event.target.value)}
          />
          <p id="cp-comment-hint" className="sw-field__hint">
            Public: it is part of your signed record. Up to {CONSENT_COMMENT_MAX} characters.
          </p>
        </div>

        {failure !== null ? (
          <p className="sw-notice" role="alert">
            {failure.message}
            {failure.signIn ? (
              <>
                {" "}
                <Link href={signInHref}>Sign in</Link>
              </>
            ) : null}
          </p>
        ) : null}

        {stage === "confirming" ? (
          <div className="cp-confirm" role="group" aria-labelledby="cp-confirm-title">
            <h3 id="cp-confirm-title" className="cp-confirm__title" tabIndex={-1} ref={confirmHeading}>
              Decline authorship of this version?
            </h3>
            <p className="cp-note">
              The version goes back to draft for every author, and your answer is recorded publicly, signed by you. It
              cannot be edited afterwards.
            </p>
            <div className="sw-actions">
              <button type="button" className="sw-button cp-button--critical" onClick={() => void answer("decline")}>
                Yes, decline
              </button>
              <button
                type="button"
                className="sw-button"
                onClick={() => {
                  setStage("idle");
                  window.setTimeout(() => declineButton.current?.focus(), 0);
                }}
              >
                Keep reviewing
              </button>
            </div>
          </div>
        ) : (
          <div className="sw-actions">
            <button
              type="button"
              className="sw-button sw-button--primary"
              disabled={busy}
              onClick={() => void answer("accept")}
            >
              Accept authorship
            </button>
            <button
              type="button"
              className="sw-button"
              disabled={busy}
              ref={declineButton}
              onClick={() => {
                setFailure(null);
                setStage("confirming");
              }}
            >
              Decline authorship
            </button>
          </div>
        )}

        {busy ? (
          <p className="cp-note" role="status" aria-busy="true">
            Waiting for your passkey…
          </p>
        ) : null}
        <p className="cp-note">You&rsquo;re signing with your passkey. Scholium never sees your key.</p>
      </div>
    );
  }

  return (
    <Shell crumb={crumb}>
      <VersionCard version={version} names={profileNames} />
      <ConsentTracker
        entries={entries}
        idPrefix="cp-consents"
        showRoles
        caption="The version moves on once every author has accepted. One decline sends it back to draft."
        error={consents.report !== null ? consents.error : null}
      />
      <FilesSection version={version} />
      <section className="cp-section" aria-labelledby="cp-decision-title">
        <h2 id="cp-decision-title" className="cp-section__title">
          Your decision
        </h2>
        {decision}
      </section>
    </Shell>
  );
}
