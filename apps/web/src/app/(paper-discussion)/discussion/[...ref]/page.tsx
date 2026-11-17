import type { Metadata } from "next";

import {
  DiscussionTab,
  describeLoadError,
  loadThreads,
  type DiscussionData,
} from "../../../../features/paper-discussion";
// The id rules (format and checksum) and the version list are paper-meta's:
// one parser for every page that takes `/{id}[/v{n}]`.
import {
  MetaRefError,
  currentVersionOf,
  loadVersions,
  metaRefFromSegments,
  type MetaRef,
} from "../../../../features/paper-meta";

/**
 * `/discussion/{id}[/v{n}]` — the Discussion tab on a page of its own.
 *
 * The URL mirrors the paper page's (`/p/{id}[/v{n}]`, docs/design.md §4). The
 * server fetches the public thread list — `GET /v1/papers/{id}/threads` — and
 * hands it to the tab as `initial`, so the first HTML response already
 * contains the discussion, readable before any JavaScript runs. A failed fetch
 * becomes a retryable message, not a 500: the tab takes over and offers "Try
 * again".
 *
 * The server read is anonymous, so it cannot apply a reader's mutes; that
 * belongs to a tab that loads in the browser with the reader's session.
 *
 * New threads are attached to the version in the URL (else the newest listed).
 * Finding its record id is a second public read; if that fails the tab still
 * works and attaches new threads to the paper itself.
 *
 * The route group `(paper-discussion)` adds no URL segment; the layout in this
 * directory carries the global navigation.
 */

/**
 * The thread list changes with every post and helpful mark. `force-dynamic`
 * also keeps `next build` from fetching it (and baking an error state into the
 * page) when the API is down.
 */
export const dynamic = "force-dynamic";

interface DiscussionPageProps {
  /** `/discussion/6sel-2dio-orm6` or `/discussion/6sel-2dio-orm6/v2` (Next 15: a promise). */
  params: Promise<{ ref: string[] }>;
}

type Parsed = { ref: MetaRef; error?: undefined } | { ref?: undefined; error: string };

function parse(segments: string[]): Parsed {
  try {
    return { ref: metaRefFromSegments(segments) };
  } catch (error) {
    return {
      error: error instanceof MetaRefError ? error.message : "That is not a paper id.",
    };
  }
}

export async function generateMetadata({ params }: DiscussionPageProps): Promise<Metadata> {
  const parsed = parse((await params).ref);
  return {
    title:
      parsed.ref !== undefined
        ? `Discussion of ${parsed.ref.schId}`
        : "Discussion",
    description:
      "Open discussion threads on a Scholium paper, most helpful first, with replies and a way to report any post.",
  };
}

function Header({ schId }: { schId?: string }) {
  return (
    <header className="pdisc-header">
      <p className="pdisc-kicker mono-id">
        scholium / discussion{schId !== undefined ? ` / ${schId}` : ""}
      </p>
      <h1 className="pdisc-title">Discussion</h1>
      <p className="pdisc-lede">
        Open threads about the paper, most helpful first. A helpful mark only
        orders the thread &mdash; it never changes what the paper&rsquo;s status
        says. Any post can be reported.
      </p>
    </header>
  );
}

export default async function DiscussionPage({ params }: DiscussionPageProps) {
  const parsed = parse((await params).ref);

  if (parsed.ref === undefined) {
    return (
      <>
        <Header />
        <div className="pdisc-notice" role="alert">
          <p className="pdisc-notice__title">That is not a paper id</p>
          <p className="pdisc-notice__text">{parsed.error}</p>
        </div>
      </>
    );
  }

  const ref = parsed.ref;

  const [threads, versions] = await Promise.allSettled([
    loadThreads(ref.shortId),
    loadVersions(ref.shortId),
  ]);

  let initial: DiscussionData | undefined;
  let initialError: string | undefined;
  if (threads.status === "fulfilled") {
    initial = threads.value;
  } else {
    initialError = describeLoadError(threads.reason);
  }

  // The record id of the version being read: where a new thread attaches.
  let versionCid: string | undefined;
  if (versions.status === "fulfilled") {
    const shown = currentVersionOf(versions.value, ref.version);
    versionCid = versions.value.versions.find((version) => version.n === shown)?.cid;
  }

  return (
    <>
      <Header schId={ref.schId} />
      <DiscussionTab
        paperId={ref.shortId}
        versionCid={versionCid}
        initial={initial}
        initialError={initialError}
      />
    </>
  );
}
