"use client";

/**
 * FilesTab: the Files tab of the paper page (docs/design.md §5.2).
 *
 * ```tsx
 * <FilesTab paperId="sch:6sel-2dio-orm6" version={2} />
 * <FilesTab paperId={paper.shortId} version={paper.n} initial={manifest} />
 * ```
 *
 * The signed file list of one version, each file showing
 *
 * ```text
 * paper.pdf                                   ✓ Scan passed
 * Manuscript · 1.2 MiB · CC BY 4.0
 * Download paper.pdf
 * ```
 *
 * its path, what it is for, its exact size, the version's licence and the
 * sanitizer's live verdict, with a download link for files the node will
 * serve (`GET /v1/content/{cid}` serves only `passed` bytes). A file that is
 * still scanning, failed its scan or is missing is *not* linked and says why —
 * a dead download on a paper page is worse than no download.
 *
 * Scan status never depends on colour: every verdict has its own word and its
 * own icon silhouette (`docs/design.md §9`).
 *
 * The server route may pass `initial` so the first HTML already has the file
 * list (and `initialError` when its fetch failed); on its own the tab loads
 * from `GET /v1/papers/{id}/v/{n}/manifest` and offers a retry. `load` and
 * `downloadUrl` are injectable for tests or another node.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "../ui-kit";
import { formatBytes } from "../submit/limits";
import {
  SCAN_STATUS_SPECS,
  contentUrl,
  describeMetaError,
  isDownloadable,
  licenceLabel,
  loadManifest,
  roleLabel,
  type LoadManifest,
  type ManifestData,
  type ManifestFile,
  type ScanStatus,
} from "./meta";
import "./paper-meta.css";

export interface FilesTabProps {
  /** The paper's id, in any spelling the API accepts. */
  paperId: string;
  /** The version whose files are listed. */
  version: number;
  /** Files fetched by the server, so the first paint has rows. */
  initial?: ManifestData;
  /** Why the server's fetch failed; the tab offers a retry. */
  initialError?: string;
  /** Replace the loader, for tests or another source. Keep it stable. */
  load?: LoadManifest;
  /** Where a file's bytes come from; defaults to the node's `/v1/content/{cid}`. */
  downloadUrl?: (cid: string) => string;
}

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: ManifestData };

function initialView(initial: ManifestData | undefined, initialError: string | undefined): View {
  if (initialError !== undefined && initialError !== "") {
    return { kind: "error", message: initialError };
  }
  if (initial !== undefined) return { kind: "ready", data: initial };
  return { kind: "loading" };
}

/** The last path segment: what a browser saves the file as. */
export function fileName(path: string): string {
  const name = path.split("/").filter((part) => part !== "").at(-1);
  return name ?? path;
}

/**
 * The URL a download link uses: the content address with `?download=1`.
 *
 * The bytes live on the API's origin, so the HTML `download` attribute is
 * ignored there; the query is what makes the API answer
 * `Content-Disposition: attachment` with the manifest's file name. Existing
 * query parameters are kept, and a fragment stays at the end.
 */
export function downloadHref(url: string): string {
  const hashAt = url.indexOf("#");
  const address = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const separator = address.includes("?") ? "&" : "?";
  return `${address}${separator}download=1${fragment}`;
}

/**
 * The artefact name a row shows: the manuscript is the paper's PDF, whether
 * the manifest calls its role `manuscript` or says `application/pdf`; every
 * other role reads the way {@link roleLabel} spells it.
 */
export function fileRoleLabel(file: Pick<ManifestFile, "role" | "mediaType">): string {
  const role = file.role.trim().toLowerCase();
  if (role === "manuscript" || (file.mediaType ?? "").toLowerCase() === "application/pdf") {
    return "PDF";
  }
  return roleLabel(role);
}

/** The roles that together make a paper's code, data and reproduction log. */
const SUPPLEMENTARY_ROLES: ReadonlySet<string> = new Set([
  "code",
  "data",
  "dataset",
  "reproduction-log",
  "reproduction_log",
]);

/** Whether the version published any code, data or reproduction log. */
export function hasSupplementaryArtefacts(
  files: readonly Pick<ManifestFile, "role">[],
): boolean {
  return files.some((file) => SUPPLEMENTARY_ROLES.has(file.role.trim().toLowerCase()));
}

/** Why a file the node will not serve has no download link. */
export function unavailableReason(status: ScanStatus): string {
  switch (status) {
    case "scanning":
      return "Download opens when the scan finishes.";
    case "failed":
      return "Not served: the scan found active content.";
    case "missing":
      return "Not available on this node.";
    case "unknown":
      return "Not downloadable: the scan status is unknown.";
    case "passed":
      return "";
  }
}

export function FilesTab({
  paperId,
  version,
  initial,
  initialError,
  load,
  downloadUrl,
}: FilesTabProps) {
  const [view, setView] = useState<View>(() => initialView(initial, initialError));
  const [attempt, setAttempt] = useState(0);
  // A host may swap `version` (the paper page's v1 ⇄ v2 links) without
  // remounting: start over from this version's data, never show v1's files as
  // if they were v2's.
  const sourceKey = `${paperId}\n${version}`;
  const [lastSourceKey, setLastSourceKey] = useState(sourceKey);
  if (lastSourceKey !== sourceKey) {
    setLastSourceKey(sourceKey);
    setView(initialView(initial, initialError));
    setAttempt(0);
  }

  // The latest loader without making an inline function restart the request.
  const loadRef = useRef<LoadManifest>(load ?? loadManifest);
  useEffect(() => {
    loadRef.current = load ?? loadManifest;
  }, [load]);

  const hasInitial = initial !== undefined;
  useEffect(() => {
    // The server already fetched this version; only a retry asks again.
    if (attempt === 0 && hasInitial) return;
    const controller = new AbortController();
    setView({ kind: "loading" });
    loadRef.current(paperId, version, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setView({ kind: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setView({ kind: "error", message: describeMetaError(error, "files") });
        }
      },
    );
    return () => controller.abort();
  }, [paperId, version, attempt, hasInitial]);

  const retry = () => setAttempt((count) => count + 1);

  return (
    <section
      className="pm-tab"
      aria-label="Files"
      aria-busy={view.kind === "loading"}
      data-state={view.kind}
    >
      {view.kind === "loading" ? (
        <p className="pm-loading" role="status">
          <Icon name="spinner" className="pm-loading__icon" />
          Loading files…
        </p>
      ) : null}

      {view.kind === "error" ? (
        <div className="pm-error" role="alert">
          <p className="pm-error__message">{view.message}</p>
          <button type="button" className="pm-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {view.kind === "ready" ? (
        <FileList data={view.data} downloadUrl={downloadUrl ?? contentUrl} />
      ) : null}
    </section>
  );
}

function FileList({
  data,
  downloadUrl,
}: {
  data: ManifestData;
  downloadUrl: (cid: string) => string;
}) {
  const { files } = data;
  if (files.length === 0) {
    return <p className="pm-empty">No files are listed for this version.</p>;
  }

  return (
    <>
      <p className="pm-summary">
        {`${files.length} ${files.length === 1 ? "file" : "files"} · ${licenceLabel(data.licence)}`}
      </p>
      <ul className="pm-files" aria-label={`Files of version ${data.n}`}>
        {files.map((file) => {
          const spec = SCAN_STATUS_SPECS[file.scanStatus];
          return (
            <li key={`${file.path}:${file.cid}`} className="pm-file" data-scan={file.scanStatus}>
              <div className="pm-file__head">
                <p className="pm-file__path">
                  <span className="pm-visually-hidden">File: </span>
                  <span className="pm-file__name">{file.path}</span>
                </p>
                <span
                  className="pm-scan"
                  data-status={file.scanStatus}
                  data-tone={spec.tone}
                  title={spec.meaning}
                >
                  <Icon name={spec.icon} className="pm-scan__icon" />
                  <span className="pm-scan__label">{spec.label}</span>
                </span>
              </div>

              <p className="pm-file__meta">
                <span className="pm-file__role">{fileRoleLabel(file)}</span>
                <span className="pm-file__size">{formatBytes(file.size)}</span>
                <span className="pm-file__licence">{licenceLabel(file.licence)}</span>
              </p>

              {isDownloadable(file) ? (
                <a
                  className="pm-download"
                  href={downloadHref(downloadUrl(file.cid))}
                  download={fileName(file.path)}
                  aria-label={`Download ${file.path}`}
                >
                  Download
                </a>
              ) : (
                <p className="pm-file__blocked">{unavailableReason(file.scanStatus)}</p>
              )}
            </li>
          );
        })}
      </ul>
      {!hasSupplementaryArtefacts(files) ? (
        <p className="pm-empty">
          No code, data or reproduction log was published with this version.
        </p>
      ) : null}
    </>
  );
}
