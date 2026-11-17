"use client";

/**
 * VersionsTab: the Versions tab of the paper page (docs/design.md §5.2).
 *
 * ```tsx
 * <VersionsTab paperId="sch:6sel-2dio-orm6" currentVersion={2} />
 * <VersionsTab paperId={paper.shortId} initial={timeline} />
 * ```
 *
 * A timeline from v1 to vN, oldest first, each version showing
 *
 * ```text
 * ○ Version 2   [Viewing] [Latest]           2 Feb 2027
 *   Fixed the proof of Lemma 2
 *   ◔ Anchor pending
 * ```
 *
 * the change note the author signed, the date it was listed and the record's
 * anchor status. The version being read is marked "Viewing" (it is not
 * necessarily the current one) and the newest is "Latest"; the two can sit on
 * the same row. The anchor is a state, not a verdict: the node does not
 * timestamp its log on-chain yet, so "Anchor pending" is what every version
 * says today, and it never looks like a failure.
 *
 * The server route may pass `initial` so the first HTML already has the
 * timeline (and `initialError` when its fetch failed); on its own the tab
 * loads from `GET /v1/papers/{id}/versions` and offers a retry. `load` is
 * injectable for tests or another source.
 *
 * Paper page links follow docs/design.md §4 (`/p/{id}/v{n}`); a host may pass
 * `versionHref` (paper page) and `compareHref` (the compare view, feature 186)
 * to take over the links.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "../ui-kit";
import { LocalDate } from "../ui-kit/format-date";
import {
  anchorSpec,
  changeNoteText,
  describeMetaError,
  loadVersions,
  versionPath,
  type LoadVersions,
  type VersionsData,
} from "./meta";
import "./paper-meta.css";

export interface VersionsTabProps {
  /** The paper's id, in any spelling the API accepts (`sch:…` or a genesis cid). */
  paperId: string;
  /**
   * The version the paper page is showing, marked "Viewing". Defaults to the
   * newest listed version.
   */
  currentVersion?: number;
  /** Timeline fetched by the server, so the first paint has rows. */
  initial?: VersionsData;
  /** Why the server's fetch failed; the tab offers a retry. */
  initialError?: string;
  /** Replace the loader, for tests or another source. Keep it stable. */
  load?: LoadVersions;
  /** Where a version's title links; defaults to `/p/{id}/v{n}`. */
  versionHref?: (version: number) => string;
  /**
   * Builds the compare link between two adjacent versions. Omitted, no
   * compare action is shown (the compare view belongs to the paper page).
   */
  compareHref?: (from: number, to: number) => string;
}

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: VersionsData };

function initialView(initial: VersionsData | undefined, initialError: string | undefined): View {
  if (initialError !== undefined && initialError !== "") {
    return { kind: "error", message: initialError };
  }
  if (initial !== undefined) return { kind: "ready", data: initial };
  return { kind: "loading" };
}

export function VersionsTab({
  paperId,
  currentVersion,
  initial,
  initialError,
  load,
  versionHref,
  compareHref,
}: VersionsTabProps) {
  const [view, setView] = useState<View>(() => initialView(initial, initialError));
  const [attempt, setAttempt] = useState(0);
  // A host may swap `paperId` (an SPA navigating between papers) without
  // remounting: start over from this paper's data, never show the old one's.
  const [sourceKey, setSourceKey] = useState(paperId);
  if (sourceKey !== paperId) {
    setSourceKey(paperId);
    setView(initialView(initial, initialError));
    setAttempt(0);
  }

  // The latest loader without making an inline function restart the request.
  const loadRef = useRef<LoadVersions>(load ?? loadVersions);
  useEffect(() => {
    loadRef.current = load ?? loadVersions;
  }, [load]);

  const hasInitial = initial !== undefined;
  useEffect(() => {
    // The server already fetched this paper; only a retry asks again.
    if (attempt === 0 && hasInitial) return;
    const controller = new AbortController();
    setView({ kind: "loading" });
    loadRef.current(paperId, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setView({ kind: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setView({ kind: "error", message: describeMetaError(error, "versions") });
        }
      },
    );
    return () => controller.abort();
  }, [paperId, attempt, hasInitial]);

  const retry = () => setAttempt((count) => count + 1);

  return (
    <section
      className="pm-tab"
      aria-label="Versions"
      aria-busy={view.kind === "loading"}
      data-state={view.kind}
    >
      {view.kind === "loading" ? (
        <p className="pm-loading" role="status">
          <Icon name="spinner" className="pm-loading__icon" />
          Loading version history…
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
        <Timeline
          data={view.data}
          paperId={paperId}
          currentVersion={currentVersion}
          versionHref={versionHref}
          compareHref={compareHref}
        />
      ) : null}
    </section>
  );
}

interface TimelineProps {
  data: VersionsData;
  paperId: string;
  currentVersion: number | undefined;
  versionHref: ((version: number) => string) | undefined;
  compareHref: ((from: number, to: number) => string) | undefined;
}

function Timeline({ data, paperId, currentVersion, versionHref, compareHref }: TimelineProps) {
  const { versions } = data;
  if (versions.length === 0) {
    return <p className="pm-empty">No versions are listed yet.</p>;
  }

  const newest = versions[versions.length - 1].n;
  const current = currentVersion ?? newest;
  const hrefFor = versionHref ?? ((version: number) => versionPath(paperId, version));

  return (
    <>
      <p className="pm-summary">
        {`${versions.length} ${versions.length === 1 ? "version" : "versions"} · newest v${newest}`}
      </p>
      <ol className="pm-timeline" aria-label="Version timeline, oldest first">
        {versions.map((version, index) => {
          const isCurrent = version.n === current;
          const isNewest = version.n === newest;
          const spec = anchorSpec(version.anchor);
          const previous = index > 0 ? versions[index - 1] : null;
          return (
            <li
              key={version.n}
              className="pm-version"
              data-version={version.n}
              data-current={isCurrent}
            >
              <Icon name="circle" className="pm-version__marker" />
              <div className="pm-version__head">
                <p className="pm-version__title">
                  <a className="pm-version__link" href={hrefFor(version.n)}>
                    {`Version ${version.n}`}
                  </a>
                  {isCurrent ? (
                    <span className="pm-chip pm-chip--current" data-chip="viewing">
                      Viewing
                    </span>
                  ) : null}
                  {isNewest ? (
                    <span className="pm-chip" data-chip="latest">
                      Latest
                    </span>
                  ) : null}
                </p>
                {version.listedAt !== null ? (
                  <LocalDate className="pm-version__date" value={version.listedAt} />
                ) : null}
              </div>

              <p className="pm-version__note">{changeNoteText(version)}</p>

              <p className="pm-anchor" data-status={version.anchor.status} title={spec.meaning}>
                <Icon name={spec.icon} className="pm-anchor__icon" />
                <span className="pm-anchor__label">{spec.label}</span>
                {version.anchor.status === "anchored" && version.anchor.txUrl !== null ? (
                  <>
                    {" "}
                    <a
                      className="pm-link"
                      href={version.anchor.txUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View transaction ↗
                      <span className="pm-visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </>
                ) : null}
              </p>

              {compareHref !== undefined && previous !== null ? (
                <p className="pm-compare">
                  <a className="pm-link" href={compareHref(previous.n, version.n)}>
                    {`Compare v${previous.n} with v${version.n}`}
                  </a>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}
