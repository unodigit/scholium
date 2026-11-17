"use client";

/**
 * The header's four public actions — PDF, HTML, Cite and Download
 * (docs/design.md §5.2: `[ PDF ] [ HTML ] [ Cite ] [ Download ]`) — and, for a
 * consented author of the paper, the three author actions beneath them.
 *
 * Each of the four is a real link, so the row works before any JavaScript runs
 * and is reachable by keyboard like any other link:
 *
 * - **PDF** is the version's PDF file, served by the node. As a plain link it
 *   opens in a new tab (what the browser then does with it is the node's
 *   content endpoint's call: it serves every file inert, as a sandboxed,
 *   unsniffed download, because uploads are untrusted). Once the page runs, a
 *   plain click shows the PDF in the reading column instead, drawn by PDF.js
 *   (`reading-view.tsx`); a modified click, or a phone, still gets the file.
 *   When the PDF cannot be opened (no PDF, still being scanned, scan failed)
 *   the word stays and says why, in text, rather than becoming a button that
 *   does nothing.
 * - **HTML** is the rendition the page starts on, so it is marked as the
 *   current view and jumps to the reading column; following it from the PDF
 *   view brings the HTML back.
 * - **Cite** opens a dialog with this exact version cited as BibTeX and as RIS,
 *   each copied with a click (`cite-dialog.tsx`). Until the page runs it is a
 *   link to the BibTeX, which opens in a new tab.
 * - **Download** opens a menu whose item saves the paper's archive
 *   (`download-menu.tsx`). Until the page runs it is a link to the archive.
 *
 * **Author actions.** A signed-in viewer who is on the paper's byline *and*
 * whose consent for this version is signed is offered:
 *
 * - **New version**, a link to the existing form (`submit/new-version-link`);
 * - **Issue notice**, a correction, retraction or withdrawal signed with the
 *   device key and sent to `POST /v1/records` (`notice-dialog.tsx`);
 * - **File an appeal**, when the paper's latest moderation decision is a hold
 *   or reject that has not been appealed yet (`appeal-dialog.tsx`).
 *
 * The check is a convenience; the API is the gate. It is deliberately a client
 * island after mount: the server's HTML (and the first client render) is the
 * four public actions for everyone, so a shared link, a crawler and a reader
 * who is not an author see the header exactly as it was.
 */

import { useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import { fetchConsents, type FetchConsents } from "../submit/consents";
import { NewVersionLink } from "../submit/new-version-link";
import { useViewer } from "../review-form/use-viewer";
import type { Viewer } from "../review-form/viewer";
import { FollowToggle } from "../dashboard";
import { AppealDialog } from "./appeal-dialog";
import { CiteDialog } from "./cite-dialog";
import { DownloadMenu } from "./download-menu";
import { NoticeDialog } from "./notice-dialog";
import { ReportPaper } from "./report-paper";
import type { PdfAccess } from "./paper-facts";
import { READING_ID } from "./paper-links";
import { ReadingViewLink } from "./reading-view";
import "./paper-actions.css";

export interface PaperActionsProps {
  /** Whether, and where, the PDF can be opened. */
  readonly pdf: PdfAccess;
  /** The paper, `sch:xxxx-xxxx-xxxx`: what the Cite dialog asks the node to cite. */
  readonly paperId: string;
  /** cid of the paper's genesis record: the `paper` of a notice or an appeal. */
  readonly paperCid: string;
  /** cid of the version on screen: the target of a notice. */
  readonly versionCid: string;
  /** The version on screen: the one both citations name. */
  readonly version: number;
  /** The BibTeX of the version on screen: the Cite link until the page runs. */
  readonly citeUrl: string;
  /** The paper's archive: the Download link until the page runs, then the menu's item. */
  readonly archiveUrl: string;
  /** The paper's authors' DIDs: who is offered the author actions. */
  readonly authorDids: readonly string[];
  /** Where "Sign in" goes when a session has ended. */
  readonly signInHref?: string;
}

export function PaperActions({
  pdf,
  paperId,
  paperCid,
  versionCid,
  version,
  citeUrl,
  archiveUrl,
  authorDids,
  signInHref,
}: PaperActionsProps) {
  return (
    <div className="ppg-actions-block">
      <div className="ppg-actions" role="group" aria-label="Read, cite and download">
        {pdf.kind === "available" ? (
          <ReadingViewLink view="pdf" className="ppg-action" href={pdf.url}>
            PDF
          </ReadingViewLink>
        ) : (
          // A link with no destination: announced as a disabled link, and the
          // reason is on the page below, not only in a tooltip.
          <a
            className="ppg-action"
            role="link"
            aria-disabled="true"
            aria-describedby="ppg-pdf-note"
          >
            PDF
          </a>
        )}
        <ReadingViewLink view="html" className="ppg-action" href={`#${READING_ID}`}>
          HTML
        </ReadingViewLink>
        <CiteDialog paperId={paperId} version={version} href={citeUrl} />
        <DownloadMenu href={archiveUrl} />
      </div>
      <div className="ppg-extra-actions" role="group" aria-label="Follow and report">
        <FollowToggle category={paperId} />
        <ReportPaper versionCid={versionCid} signInHref={signInHref} />
      </div>
      {pdf.kind === "unavailable" ? (
        <p id="ppg-pdf-note" className="ppg-actions-note">
          {pdf.reason}
        </p>
      ) : null}

      <AuthorActions
        paperId={paperId}
        paperCid={paperCid}
        versionCid={versionCid}
        version={version}
        authorDids={authorDids}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Author actions                                                               */
/* -------------------------------------------------------------------------- */

/** Where the consent read stands for the viewer. */
type Standing = "unknown" | "signed" | "no";

/**
 * Read the viewer's own consent for this version, once.
 *
 * A viewer whose DID is not on the byline costs no request and is never an
 * author. A byline author is an author only when their consent says `signed`:
 * someone who has not answered, or declined, cannot speak for the paper — the
 * API reads the same rule for notices (`submissions.paper_authors`).
 */
function useAuthorStanding(
  viewer: Viewer,
  authorDids: readonly string[],
  paperId: string,
  version: number,
  load: FetchConsents,
): Standing {
  const byline =
    viewer.signedIn && viewer.did !== null && authorDids.includes(viewer.did);
  const key = `${paperId}/v${version}/${viewer.did ?? ""}`;
  const [answer, setAnswer] = useState<{ key: string; standing: Standing }>({
    key: "",
    standing: "unknown",
  });

  useEffect(() => {
    if (!byline || viewer.did === null) return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const report = await load(
          { paper: paperId, version },
          controller.signal,
        );
        if (cancelled) return;
        const me = report.authors.find((author) => author.did === viewer.did);
        setAnswer({
          key,
          standing: me?.status === "signed" ? "signed" : "no",
        });
      } catch (error) {
        if (cancelled) return;
        // A listed paper has every co-author's consent (PUB-3), so a node with
        // no consent report for the version (404) cannot contradict the
        // byline and the byline stands. Any other failure offers nothing: the
        // actions are a convenience and the API is the gate.
        setAnswer({
          key,
          standing:
            error instanceof ApiError && error.status === 404 ? "signed" : "no",
        });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [byline, key, load, paperId, version, viewer.did]);

  if (!byline) return "no";
  return answer.key === key ? answer.standing : "unknown";
}

export interface AuthorActionsProps {
  /** The paper, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** cid of the paper's genesis record. */
  readonly paperCid: string;
  /** cid of the version on screen. */
  readonly versionCid: string;
  /** The version on screen: the one the actions name. */
  readonly version: number;
  /** The paper's authors' DIDs: who is offered these actions. */
  readonly authorDids: readonly string[];
  /** Pin the viewer instead of reading it from the signed-in session. */
  readonly viewer?: Viewer;
  /** Replace the consent read, for tests. */
  readonly loadConsents?: FetchConsents;
  /** Where "Sign in" goes when a session has ended. */
  readonly signInHref?: string;
}

/**
 * The paper page's author actions, or nothing.
 *
 * It renders nothing until the page runs and a consented author is known, so
 * the server's HTML is the same for every reader. Who may do any of this is
 * the API's call; this only chooses whether to offer it.
 */
export function AuthorActions({
  paperId,
  paperCid,
  versionCid,
  version,
  authorDids,
  viewer: viewerOverride,
  loadConsents = fetchConsents,
  signInHref,
}: AuthorActionsProps) {
  const viewer = useViewer(viewerOverride);
  const standing = useAuthorStanding(
    viewer,
    authorDids,
    paperId,
    version,
    loadConsents,
  );

  if (standing !== "signed") return null;

  return (
    <div className="ppg-author-actions" role="group" aria-label="Author actions">
      <NewVersionLink paper={paperId} label="New version" />
      <NoticeDialog
        paperId={paperId}
        paperCid={paperCid}
        versionCid={versionCid}
        version={version}
        signInHref={signInHref}
      />
      <AppealDialog paperId={paperId} paperCid={paperCid} signInHref={signInHref} />
    </div>
  );
}
