"use client";

/**
 * VerifyPage: "Verify a file" (`/verify`, docs/design.md §4).
 *
 * The reader names a version of a paper (`sch:xxxx-xxxx-xxxx/vN`) and drops a
 * file they hold. The page works out the file's id **in the browser** (a raw
 * CIDv1 over SHA-256, the id the node files the bytes under) and compares it
 * with the ids in the version's signed file list:
 *
 * ```text
 * ✓ This file matches what the authors signed
 *   It is main.pdf (manuscript), one of the 3 files signed for sch:6sel-2dio-orm6/v2.
 *
 * ✕ This file does not match what the authors signed
 *   It is not one of the 3 files signed for sch:6sel-2dio-orm6/v2. Do not rely on it …
 * ```
 *
 * - **The file never leaves the device.** The only request is for the signed
 *   list; the file is read in chunks and hashed locally, with progress.
 * - **A mismatch is the only red.** Not being able to get the signed list, or
 *   to read the file, is grey "Could not check" and says it is not a verdict on
 *   the file (docs/design.md §5.3).
 * - **Never colour alone.** Every state has an icon of its own shape and the
 *   words; the result is a polite live region that stays mounted, so a screen
 *   reader says the verdict when it arrives.
 * - **What it does not do.** It compares ids with the file list the node
 *   serves for the version. It does not check the authors' signatures; the
 *   Proof page does, and the result links to it.
 *
 * The server never renders a verdict: the first HTML is the form and a hint.
 */

import { Icon } from "../ui-kit";
import { formatBytes } from "../ui-kit/format-bytes";
import { CopyValue } from "./copy-value";
import { FileDrop } from "./file-drop";
import type { ContentVersion, LoadContentVersions, LoadManifest, VersionManifest } from "./manifest-source";
import { useFileCheck } from "./use-file-check";
import { VERDICT_LOOKS, type Verdict } from "./verdict";
import { PLACEHOLDER_VERSION_ID, proofHref, type VersionRef } from "./version-ref";
import "./verify-page.css";

export interface VerifyPageProps {
  /** The version id to start with, e.g. from `/verify?id=sch:6sel-2dio-orm6/v2`. */
  initialId?: string;
  /**
   * Where signed file lists come from. Defaults to the node's public catalog
   * API. The latest function is used; its identity does not reload the list.
   */
  loadManifest?: LoadManifest;
  /** Where the listed versions naming a blob come from. */
  loadContentVersions?: LoadContentVersions;
  loadContent?: LoadContentVersions;
  loadVersions?: LoadContentVersions;
  contentLoader?: LoadContentVersions;
}

const ID_FIELD = "vp-id";
const ID_HELP = "vp-id-help";
const ID_ERROR = "vp-id-error";
const PRIVACY = "vp-privacy";

export function VerifyPage({
  initialId,
  loadManifest,
  loadContentVersions,
  loadContent,
  loadVersions,
  contentLoader,
}: VerifyPageProps) {
  const check = useFileCheck({
    initialId,
    loadManifest,
    loadContentVersions,
    loadContent,
    loadVersions,
    contentLoader,
  });
  const { verdict, ref, file, manifest, contentMatch } = check;

  const dropped =
    file.status === "ready"
      ? { name: file.file.name, size: file.file.size }
      : file.status === "hashing"
        ? { name: file.name, size: file.size }
        : null;

  return (
    <section className="vp-page" aria-label="Verify a file">
      <form className="vp-field" onSubmit={(event) => event.preventDefault()}>
        <label className="vp-label" htmlFor={ID_FIELD}>
          Paper version
        </label>
        <input
          id={ID_FIELD}
          className="vp-input"
          type="text"
          value={check.idText}
          placeholder={
            initialId !== undefined && initialId.trim() !== ""
              ? initialId.trim()
              : PLACEHOLDER_VERSION_ID
          }
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={check.idError !== null}
          aria-describedby={check.idError !== null ? `${ID_HELP} ${ID_ERROR}` : ID_HELP}
          onChange={(event) => check.setIdText(event.target.value)}
          onBlur={check.onIdBlur}
        />
        <p className="vp-help" id={ID_HELP}>
          The id of the version you hold, from its paper page: sch:xxxx-xxxx-xxxx/vN.
        </p>
        {check.idError !== null ? (
          <p className="vp-error" id={ID_ERROR}>
            <Icon name="alert" className="vp-error__icon" />
            <span>{check.idError}</span>
          </p>
        ) : null}
      </form>

      <FileDrop current={dropped} privacyId={PRIVACY} onFile={check.checkFile} />

      <div className="vp-result" aria-busy={verdict.kind === "checking"} data-kind={verdict.kind}>
        <VerdictPanel verdict={verdict} onRetry={check.retry} />

        {ref !== null && (verdict.kind === "match" || verdict.kind === "mismatch") ? (
          <p className="vp-proof">
            This compares the file with the list of files the authors signed. To check the
            signatures themselves,{" "}
            <a className="vp-link" href={proofHref(ref)}>
              open the Proof page
            </a>
            .
          </p>
        ) : null}

        {contentMatch !== null ? (
          <p className="vp-proof">
            <a className="vp-link" href={`/p/${contentMatch.paper.replace(/^sch:/i, "")}`}>
              {contentMatch.title}
            </a>
          </p>
        ) : null}

        {file.status === "ready" ? (
          <TechnicalDetails
            fileName={file.file.name}
            fileSize={file.file.size}
            fingerprint={file.file.cid}
            version={ref}
            manifest={manifest.status === "ready" ? manifest.manifest : null}
            open={verdict.kind === "mismatch"}
          />
        ) : null}
      </div>
    </section>
  );
}

function VerdictPanel({ verdict, onRetry }: { verdict: Verdict; onRetry: () => void }) {
  const look = verdict.kind === "idle" ? null : VERDICT_LOOKS[verdict.kind];
  const { progress } = verdict;

  return (
    <div className="vp-verdict" role="status" data-kind={verdict.kind} data-tone={look?.tone ?? "none"}>
      {look !== null && verdict.headline !== null ? (
        <p className="vp-verdict__line">
          <Icon name={look.icon} className="vp-verdict__icon" />
          <span className="vp-verdict__headline">{verdict.headline}</span>
        </p>
      ) : null}
      <p className="vp-verdict__summary">{verdict.summary}</p>

      {progress !== null ? (
        <progress
          className="vp-progress"
          aria-label="Reading your file"
          max={Math.max(progress.total, 1)}
          value={progress.total === 0 ? 1 : progress.hashed}
        />
      ) : null}

      {verdict.details.length > 0 ? (
        <ul className="vp-verdict__details">
          {verdict.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}

      {verdict.canRetry ? (
        <button type="button" className="vp-button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

interface TechnicalDetailsProps {
  fileName: string;
  fileSize: number;
  fingerprint: string;
  version: VersionRef | null;
  manifest: VersionManifest | null;
  /** Open after a mismatch: the ids are what the reader needs to see next. */
  open: boolean;
}

/**
 * The file's own id and the signed list it was compared with, for a reader who
 * wants to see why. Collapsed after a match, open after a mismatch.
 */
function TechnicalDetails({ fileName, fileSize, fingerprint, version, manifest, open }: TechnicalDetailsProps) {
  return (
    <details className="vp-details" open={open}>
      <summary className="vp-details__summary">Technical details</summary>

      <dl className="vp-tech">
        <div className="vp-tech__row">
          <dt className="vp-tech__label">Your file</dt>
          <dd className="vp-tech__value">
            {fileName} · {formatBytes(fileSize)}
          </dd>
        </div>
        <div className="vp-tech__row">
          <dt className="vp-tech__label">Its id, computed here</dt>
          <dd className="vp-tech__value">
            <CopyValue value={fingerprint} label="your file's id" />
          </dd>
        </div>
        {version !== null ? (
          <div className="vp-tech__row">
            <dt className="vp-tech__label">Version</dt>
            <dd className="vp-tech__value">{version.schId}</dd>
          </div>
        ) : null}
        {manifest !== null && manifest.manifestCid !== null ? (
          <div className="vp-tech__row">
            <dt className="vp-tech__label">Signed file list</dt>
            <dd className="vp-tech__value">
              <CopyValue value={manifest.manifestCid} label="the signed file list's record id" abbreviate />
            </dd>
          </div>
        ) : null}
      </dl>

      {manifest !== null ? (
        <>
          <p className="vp-subhead">Files signed for {manifest.ref.schId}</p>
          <ul className="vp-signed">
            {manifest.files.map((signed) => {
              // The same rule the verdict used: files are the same when their ids are.
              const same = signed.cid === fingerprint;
              return (
                <li key={signed.path} className="vp-signed__item" data-same={same}>
                  <p className="vp-signed__name">
                    <span className="vp-signed__path">{signed.path}</span>
                    {same ? <span className="vp-signed__flag">Same as your file</span> : null}
                  </p>
                  <p className="vp-signed__meta">
                    {signed.role} · {formatBytes(signed.size)}
                  </p>
                  <CopyValue value={signed.cid} label={`the signed id of ${signed.path}`} abbreviate />
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </details>
  );
}
