"use client";

/**
 * The retry behind a 404 paper page.
 *
 * `/p/{id}` is rendered on the server, and the server holds no token — the
 * access token lives in browser memory only — so the public catalog answers
 * `404` for a paper that is in moderation, held before listing, or awaiting
 * co-author consent, *even for its own author*. The dashboard's "My papers"
 * and "Moderation outcome … Open" links lead straight there.
 *
 * {@link PaperAccess} is what the `/p/{id}` not-found boundary renders. It
 * starts as the honest not-found page (the first HTML is the same for
 * everyone: a crawler, a shared link, a stranger). Once the page runs it
 * restores the session from the refresh cookie and asks again **with the
 * signed-in reader's token**:
 *
 * - the paper's public records say which version this is, what it is called,
 *   and whether moderation removed it — a takedown renders the removed-content
 *   marker for everyone (it is a public fact), no token needed;
 * - the version's text, read with the token, is the gate: the API answers
 * `200` to an author or a moderator, the unknown-version `404` to everyone
 *   else, and `451` to a takedown. An author or a moderator then sees the
 *   paper — banner, byline, actions, text, PDF and checks report
 *   ({@link PaperAccessView}); everyone else keeps the not-found page.
 *
 * The page never decides access itself; it reads what the node answered.
 */

import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";

import { ApiError, bootstrapSession, tokenStore } from "../../lib/api";
import { licenceLabel } from "../paper-meta/meta";
import { loadProfile, type AuthorProfile } from "../search-page/paper";
import { checksErrorMessage, fetchVersionChecks, type FetchChecks, type VersionChecks } from "../submit/checks";
import { StatusTracker } from "../submit/status-tracker";
import type { LoadPdfjs } from "./pdf-render";
import { PdfView } from "./pdf-view";
import { parsePaperAddress } from "./paper-address";
import type { PaperAddress } from "./paper-address";
import { AuthorActions } from "./paper-actions";
import { PaperTombstoneView, UnlistedStatusBanner } from "./paper-access-view";
import { authorDetail, authorLabel, versionOfTotal } from "./paper-facts";
import { READING_ID } from "./paper-links";
import { PaperPageNotice } from "./paper-page-view";
import { loadPdfjsWithSession } from "./reading";
import { ReadingText } from "./reading-text";
import {
  DEFAULT_ACCESS_LOADERS,
  PAPER_NOT_LISTED,
  latestDecision,
  loadUnlistedPdf,
  pickUnlistedVersion,
  tombstoneOf,
  unlistedBanner,
  type AccessLoaders,
  type AccessView,
  type TombstoneFacts,
  type UnlistedAuthor,
  type UnlistedPdf,
  type UnlistedVersion,
} from "./unlisted-paper";

/* -------------------------------------------------------------------------- */
/* The address, when none was given                                            */
/* -------------------------------------------------------------------------- */

/** `/p/{id}` (optionally `/v{n}`, trailing slash) as a paper address. */
export function addressFromPath(pathname: string): PaperAddress | null {
  const match = /^\/p\/([^/]+)(?:\/(v[1-9][0-9]{0,8}))?\/?$/.exec(pathname);
  if (match === null) {
    return null;
  }
  const segments =
    match[2] === undefined ? [match[1]] : [match[1], match[2]];
  // `parsePaperAddress` decodes `%3A` and accepts the `sch:` prefix, a bare
  // id, or a record cid — every spelling a link to this page may carry.
  return parsePaperAddress(segments);
}

/* -------------------------------------------------------------------------- */
/* The retry                                                                   */
/* -------------------------------------------------------------------------- */

/** Where the boundary stands: the not-found page, the marker, or the paper. */
type Phase =
  | { readonly kind: "notice" }
  | { readonly kind: "tombstone"; readonly facts: TombstoneFacts }
  | { readonly kind: "paper"; readonly view: AccessView };

export interface PaperAccessProps {
  /** The paper the page is for; the boundary reads it from the address. */
  readonly address?: PaperAddress;
  /** The reads the retry makes; the real ones by default. */
  readonly loaders?: AccessLoaders;
  /**
   * The sentence the page says until the retry knows better. The `/p/{id}`
   * boundary says the id is not listed; `/p/{id}/v{n}` says which *version*
   * is not, because the paper itself may well be.
   */
  readonly message?: string;
}

/**
 * The `/p/{id}` not-found page, hydrated.
 *
 * Renders the same notice as the server did until it knows better, so the
 * first paint never flashes author-only content at a stranger (the server's
 * HTML *is* this component's first render). A signed-in reader sees one quiet
 * line while the retry asks; everyone else never sees a flicker.
 */
export function PaperAccess({
  address: givenAddress,
  loaders = DEFAULT_ACCESS_LOADERS,
  message = PAPER_NOT_LISTED,
}: PaperAccessProps) {
  const pathname = usePathname();
  const address = givenAddress ?? addressFromPath(pathname);
  const [phase, setPhase] = useState<Phase>({ kind: "notice" });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (address === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      // Restore the session first: the token lives in memory only, so a full
      // page load (every dashboard link is one) starts without it.
      await bootstrapSession().catch(() => null);
      if (cancelled) {
        return;
      }

      // The paper's records are public — the signed log answers for a paper
      // the catalog does not list. They name the version and carry every
      // decision about it.
      let entries: readonly unknown[] | null = null;
      try {
        entries = await loaders.records(address.id);
      } catch {
        entries = null; // nothing to retry with; the notice stands.
      }
      if (cancelled || entries === null) {
        return;
      }

      // A takedown is public: the marker renders for everyone, signed in or not.
      const tombstone = tombstoneOf(entries, address.version);
      if (tombstone !== null) {
        setPhase({ kind: "tombstone", facts: tombstone });
        return;
      }

      const version = pickUnlistedVersion(entries, address.version);
      if (version === null) {
        return; // no paper behind this address: the notice stands.
      }

      // Without a token the private reads can only answer the unknown-version
      // 404, so an anonymous visitor is spared them (and so is the node).
      if (tokenStore.get() === null) {
        return;
      }
      setChecking(true);

      // The id the node is asked with: the one derived from the signed genesis
      // cid, else the one in the address. The view uses the same one.
      const readId = version.shortId ?? address.id;
      const decision = latestDecision(entries, version.versionCid);
      try {
        const [text, consents] = await Promise.all([
          loaders.text(readId, version.n),
          loaders.consents(readId, version.n).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        setPhase({
          kind: "paper",
          view: {
            version: { ...version, shortId: readId },
            banner: unlistedBanner(consents?.state, decision),
            consents,
            text,
          },
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 451) {
          // The node withheld the text for legal reasons. A takedown the log
          // records was already shown above (`tombstoneOf`), so reaching this
          // means the log names none for this version: the marker says what
          // the node said and claims no date, clause or reason it cannot
          // back (a hold's date is not a removal date).
          setPhase({
            kind: "tombstone",
            facts: {
              decisionCid: null,
              clause: null,
              reason: null,
              removedOn: null,
              title: version.title,
            },
          });
          return;
        }
        // A 404 is the node saying this reader may not see the paper — the
        // not-found page they already have is the right one.
      } finally {
        // Whatever the answer, the question is no longer open: the "checking"
        // line must not outlive it under a notice that stands.
        if (!cancelled) {
          setChecking(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address?.id, address?.version, loaders]);

  if (phase.kind === "tombstone") {
    return <PaperTombstoneView facts={phase.facts} />;
  }
  if (phase.kind === "paper") {
    return <PaperAccessView view={phase.view} />;
  }
  return (
    <>
      <PaperPageNotice message={message} />
      {checking ? (
        <p className="ppg-access-checking" role="status">
          Checking whether you can read this paper…
        </p>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The paper an author or a moderator sees                                     */
/* -------------------------------------------------------------------------- */

/** An author with their public profile filled in, as the byline shows them. */
interface ShownAuthor extends UnlistedAuthor {
  readonly name: string | null;
  readonly affiliation: string | null;
}

/** Read the public profile behind each byline DID; a failure keeps the DID. */
function useAuthorProfiles(
  authors: readonly UnlistedAuthor[],
): readonly ShownAuthor[] {
  const bare = (list: readonly UnlistedAuthor[]): readonly ShownAuthor[] =>
    list.map((author) => ({ ...author, name: null, affiliation: null }));
  const key = authors.map((author) => author.did).join("\n");
  const [shown, setShown] = useState<{ key: string; list: readonly ShownAuthor[] }>(
    () => ({ key, list: bare(authors) }),
  );

  useEffect(() => {
    if (authors.length === 0) {
      return;
    }
    let cancelled = false;
    void Promise.all(
      authors.map((author) =>
        author.did === ""
          ? Promise.resolve<AuthorProfile | null>(null)
          : loadProfile(author.did).catch(() => null),
      ),
    ).then((profiles) => {
      if (cancelled) {
        return;
      }
      setShown({
        key,
        list: authors.map((author, index) => ({
          ...author,
          name: profiles[index]?.name ?? null,
          affiliation: profiles[index]?.affiliation ?? null,
        })),
      });
    });
    return () => {
      cancelled = true;
    };
    // `key` carries the byline; a new array of the same DIDs changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return shown.key === key ? shown.list : bare(authors);
}

/** Where the checks read stands: a report, pending, or why it failed. */
interface ChecksPart {
  readonly report: VersionChecks | null;
  readonly message: string | null;
}

/** Read the version's advisory checks with the reader's token. */
function useChecks(
  version: UnlistedVersion,
  fetch: FetchChecks,
): ChecksPart {
  const [state, setState] = useState<ChecksPart>({
    report: null,
    message: null,
  });

  useEffect(() => {
    if (version.shortId === null) {
      return; // no address to ask: the tracker shows checks pending.
    }
    let cancelled = false;
    void fetch({ paper: version.shortId, version: version.n }).then(
      (report) => {
        if (!cancelled) {
          setState({ report, message: null });
        }
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        // A 404 is the node saying checks have not run for the version yet —
        // the calm pending state, not a failure.
        setState(
          error instanceof ApiError && error.status === 404
            ? { report: null, message: null }
            : { report: null, message: checksErrorMessage(error) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version.shortId, version.n, fetch]);

  return state;
}

export interface PaperAccessViewProps {
  /** The paper the retry assembled (see {@link AccessView}). */
  readonly view: AccessView;
  /** Read the advisory checks; the real read, with the token, by default. */
  readonly fetchChecks?: FetchChecks;
  /** Find the version's PDF; the signed manifest record by default. */
  readonly loadPdfFile?: (
    manifestCid: string | null,
  ) => Promise<UnlistedPdf | null>;
  /** How to fetch PDF.js; the default opens the file with the reader's token. */
  readonly loadPdf?: LoadPdfjs;
}

/**
 * The paper itself, for the reader the node says may see it: the status
 * banner above the title, the byline and facts, the author actions, the text
 * (already read with the token), the PDF behind a disclosure (opened with the
 * token — a plain link could not send one), and the status tracker with the
 * checks report.
 *
 * The margin panel and its tabs are the listed page's; this view shows the
 * paper and what its author can do about it.
 */
export function PaperAccessView({
  view,
  fetchChecks = fetchVersionChecks,
  loadPdfFile = loadUnlistedPdf,
  loadPdf = loadPdfjsWithSession,
}: PaperAccessViewProps) {
  const { version, banner, consents, text } = view;
  const authors = useAuthorProfiles(version.authors);
  const checks = useChecks(version, fetchChecks);
  const paperId = version.shortId ?? "";

  return (
    <div className="ppg ppg-access">
      <UnlistedStatusBanner banner={banner} />

      <header className="ppg-header">
        <h1 id="ppg-title" className="ppg-title">
          {version.title}
        </h1>

        <section className="ppg-authors" aria-labelledby="ppg-authors-heading">
          <h2 id="ppg-authors-heading" className="ppg-visually-hidden">
            Authors
          </h2>
          {version.authors.length === 0 ? (
            <p className="ppg-authors-empty">
              No authors are listed for this version.
            </p>
          ) : (
            <ol className="ppg-byline">
              {authors.map((author, index) => (
                <li
                  className="ppg-author"
                  key={`${author.did}-${index}`}
                  title={authorDetail(author)}
                >
                  {authorLabel(author)}
                </li>
              ))}
            </ol>
          )}
        </section>

        <p className="ppg-facts">
          <span className="ppg-fact ppg-version">
            {versionOfTotal(version.n, null)}
          </span>
          <span className="ppg-fact ppg-licence">
            {licenceLabel(version.licence)}
          </span>
        </p>

        {/* New version, Issue notice and — after a hold or reject — File an
            appeal: offered to a consented author, exactly as on the listed
            page (the API remains the gate). */}
        <AuthorActions
          paperId={paperId}
          paperCid={version.paperCid ?? ""}
          versionCid={version.versionCid}
          version={version.n}
          authorDids={version.authors.map((author) => author.did)}
        />
      </header>

      <section
        id={READING_ID}
        className="ppg-reading"
        aria-label="Paper text"
        tabIndex={-1}
      >
        <section className="ppg-abstract" aria-labelledby="ppg-abstract-heading">
          <h2 id="ppg-abstract-heading" className="ppg-section-title">
            Abstract
          </h2>
          <p className="ppg-abstract-body">
            {version.abstract.trim() !== ""
              ? version.abstract
              : "This version has no abstract."}
          </p>
        </section>

        {text.paragraphs.length > 0 ? (
          <ReadingText
            paperId={paperId}
            version={version.n}
            versionCid={version.versionCid}
            paragraphs={text.paragraphs}
          />
        ) : (
          <p className="ppg-reading-note">
            The text of this version is not available to read here. Open the
            PDF to read it.
          </p>
        )}
      </section>

      <PdfDisclosure
        manifestCid={version.manifestCid}
        loadPdfFile={loadPdfFile}
        loadPdf={loadPdf}
      />

      {consents !== null ? (
        <StatusTracker
          report={consents}
          checks={checks.message === null ? checks.report : undefined}
          paper={paperId}
          version={version.n}
        />
      ) : null}
      {checks.message !== null ? (
        <p className="ppg-access-note" role="status">
          {checks.message}
        </p>
      ) : null}
    </div>
  );
}

/** The version's PDF behind a disclosure: opened only when asked for. */
function PdfDisclosure({
  manifestCid,
  loadPdfFile,
  loadPdf,
}: {
  readonly manifestCid: string | null;
  readonly loadPdfFile: (manifestCid: string | null) => Promise<UnlistedPdf | null>;
  readonly loadPdf: LoadPdfjs;
}) {
  const headingId = useId();
  const bodyId = `${headingId}-body`;
  const [open, setOpen] = useState(false);
  // `undefined` is "not looked yet"; `null` is "there is none".
  const [pdf, setPdf] = useState<UnlistedPdf | null | undefined>(undefined);

  useEffect(() => {
    if (!open || pdf !== undefined) {
      return;
    }
    let cancelled = false;
    void loadPdfFile(manifestCid).then((found) => {
      if (!cancelled) {
        setPdf(found);
      }
    });
    return () => {
      cancelled = true;
    };
    // A new file lookup only happens on the first open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <section className="ppg-access-pdf" aria-labelledby={headingId}>
      <button
        type="button"
        id={headingId}
        className="ppg-access-pdf-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        PDF of this version
      </button>
      <div id={bodyId} className="ppg-access-pdf-body" hidden={!open}>
        {open ? (
          pdf === undefined ? (
            <p className="ppg-access-note" role="status">
              Looking for the PDF…
            </p>
          ) : pdf === null ? (
            <p className="ppg-access-note" role="status">
              This version has no PDF to open here. Its files are listed in the
              signed record.
            </p>
          ) : (
            // PDF.js fetches the file itself and sends no credentials, so it
            // is handed the reader's token (`loadPdfjsWithSession`) — the
            // node serves an unlisted version's bytes to its authors and to
            // moderators only.
            <PdfView url={pdf.url} loadPdf={loadPdf} />
          )
        ) : null}
      </div>
    </section>
  );
}
