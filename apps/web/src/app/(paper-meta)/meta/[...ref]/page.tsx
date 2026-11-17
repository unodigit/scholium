import type { Metadata } from "next";
import { cache } from "react";

import {
  FilesTab,
  MetaRefError,
  VersionsTab,
  currentVersionOf,
  describeMetaError,
  loadManifest,
  loadVersions,
  metaRefFromSegments,
  type ManifestData,
  type MetaRef,
  type VersionsData,
} from "../../../../features/paper-meta";
import { loadPaper } from "../../../../features/search-page/paper";

/**
 * `/meta/{id}[/v{n}]` — the Versions and Files tabs on a page of their own.
 *
 * The URL mirrors the paper page's (`/p/{id}[/v{n}]`, docs/design.md §4). The
 * server fetches both public reads — `GET /v1/papers/{id}/versions` and
 * `GET /v1/papers/{id}/v/{n}/manifest` — and hands them to the tabs as
 * `initial`, so the first HTML response already contains the timeline and the
 * file list. A failed fetch becomes a retryable message, not a 500: the tab
 * components take over and offer "Try again".
 *
 * The route group `(paper-meta)` adds no URL segment; the layout in this
 * directory carries the global navigation.
 */

/**
 * Both reads happen per request, and the version manifest changes as a file's
 * scan finishes. `force-dynamic` also keeps `next build` from fetching the
 * catalog (and baking an error state into the page) when the API is down.
 */
export const dynamic = "force-dynamic";

interface MetaPageProps {
  /** `/meta/6sel-2dio-orm6` or `/meta/6sel-2dio-orm6/v2` (Next 15: a promise). */
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

const readPaperTitle = cache(async (shortId: string, version: number | null): Promise<string | null> => {
  try {
    const paper = await loadPaper({ id: shortId, version });
    return paper.title;
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: MetaPageProps): Promise<Metadata> {
  const parsed = parse((await params).ref);
  if (parsed.ref === undefined) {
    return {
      title: "Versions and files",
      description:
        "Every listed version of a Scholium paper, with its change note and public timestamp, and the signed files of one version with their size, licence, scan status and download links.",
    };
  }
  const title = await readPaperTitle(parsed.ref.shortId, parsed.ref.version);
  return {
    title: title !== null ? `Versions and files of ${title}` : `Versions and files of ${parsed.ref.schId}`,
    description:
      "Every listed version of a Scholium paper, with its change note and public timestamp, and the signed files of one version with their size, licence, scan status and download links.",
  };
}

function Header({ schId, paperId, title }: { schId?: string; paperId?: string; title?: string | null }) {
  const bare = (paperId ?? schId ?? "").trim().replace(/^sch:/i, "").split("/")[0];
  return (
    <header className="pmeta-header">
      {title ? (
        <p className="pmeta-paper">
          <a href={`/p/${encodeURIComponent(bare)}`}>{title}</a>
        </p>
      ) : null}
      <p className="pmeta-kicker mono-id">
        scholium / versions &amp; files{schId !== undefined ? ` / ${schId}` : ""}
      </p>
      <h1 className="pmeta-title">Versions and files</h1>
      <p className="pmeta-lede">
        Every listed version of the paper, with the change note its authors
        signed and its public timestamp &mdash; and the files of one version,
        with their size, licence and the node&rsquo;s scan result.
      </p>
    </header>
  );
}

export default async function MetaPage({ params }: MetaPageProps) {
  const parsed = parse((await params).ref);

  if (parsed.ref === undefined) {
    return (
      <>
        <Header />
        <div className="pmeta-notice" role="alert">
          <p className="pmeta-notice__title">That is not a paper id</p>
          <p className="pmeta-notice__text">{parsed.error}</p>
        </div>
      </>
    );
  }

  const ref = parsed.ref;

  let versions: VersionsData | undefined;
  let versionsError: string | undefined;
  try {
    versions = await loadVersions(ref.shortId);
  } catch (error) {
    versionsError = describeMetaError(error, "versions");
  }

  // The version the page shows: the one in the URL, else the newest listed.
  const version = currentVersionOf(versions, ref.version);

  let manifest: ManifestData | undefined;
  let manifestError: string | undefined;
  if (version !== null) {
    try {
      manifest = await loadManifest(ref.shortId, version);
    } catch (error) {
      manifestError = describeMetaError(error, "files");
    }
  }

  const paperTitle = await readPaperTitle(ref.shortId, ref.version);

  return (
    <>
      <Header schId={ref.schId} paperId={ref.shortId} title={paperTitle} />

      <section className="pmeta-section" aria-labelledby="pmeta-versions">
        <h2 className="pmeta-section-title" id="pmeta-versions">
          Versions
        </h2>
        <p className="pmeta-section-note">
          Oldest first. Each change note and anchor status is the signed
          version record&rsquo;s.
        </p>
        <VersionsTab
          paperId={ref.shortId}
          currentVersion={version ?? undefined}
          initial={versions}
          initialError={versionsError}
        />
      </section>

      <section className="pmeta-section" aria-labelledby="pmeta-files">
        <h2 className="pmeta-section-title" id="pmeta-files">
          Files
        </h2>
        <p className="pmeta-section-note">
          {version !== null
            ? `Version ${version} of ${ref.shortId}. Only files whose scan passed can be downloaded.`
            : "The version whose files to show is not known yet."}
        </p>
        {version !== null ? (
          <FilesTab
            paperId={ref.shortId}
            version={version}
            initial={manifest}
            initialError={manifestError}
          />
        ) : (
          <p className="pmeta-notice__text">
            The version list could not be read, so there is no version to show
            files for. Reload the page to try again.
          </p>
        )}
      </section>
    </>
  );
}
