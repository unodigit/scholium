/**
 * What the `/p/{id}` and `/p/{id}/v{n}` route files do, in one place.
 *
 * Both route files are two lines: they take the URL's segments and hand them
 * here, so the two URLs cannot drift apart.
 *
 * - {@link renderPaperRoute} reads the paper and renders the page, or a notice
 *   saying why there is none. A failed lookup is a message with a way back to
 *   search, never a thrown error.
 * - {@link paperRouteMetadata} titles the page with the paper's title.
 *
 * **One read per request.** Next.js asks for the metadata and renders the page
 * in the same request, and both need the paper. `cache` makes the second ask
 * share the first one's reads instead of repeating a dozen API calls.
 */

import type { Metadata } from "next";
import { cache } from "react";
import type { ReactElement } from "react";

import { versionOfTotal } from "./paper-facts";
import { parsePaperAddress } from "./paper-address";
import {
  describePageError,
  loadPaperPageData,
  type PaperPageData,
} from "./paper-page-data";
import { PaperPageNotice, PaperPageView } from "./paper-page-view";

/** What a route read came to: the page's data, or the sentence that says why not. */
type RouteRead =
  | { readonly ok: true; readonly data: PaperPageData }
  | { readonly ok: false; readonly message: string };

const readPaper = cache(
  async (id: string, version: number | null): Promise<RouteRead> => {
    try {
      return { ok: true, data: await loadPaperPageData({ id, version }) };
    } catch (error) {
      return { ok: false, message: describePageError(error, { id, version }) };
    }
  },
);

/** The sentence for an address that is not a paper address at all. */
export const NOT_A_PAPER_ADDRESS =
  "That is not a paper address. Open a paper from search.";

/** Render the page for these route segments (`[id]` or `[id, "v2"]`). */
export async function renderPaperRoute(
  segments: readonly string[],
): Promise<ReactElement> {
  const address = parsePaperAddress(segments);
  if (address === null) {
    return <PaperPageNotice message={NOT_A_PAPER_ADDRESS} />;
  }
  const read = await readPaper(address.id, address.version);
  return read.ok ? (
    <PaperPageView data={read.data} />
  ) : (
    <PaperPageNotice message={read.message} />
  );
}

/** The longest description a search result or link preview needs. */
const DESCRIPTION_LENGTH = 200;

const FALLBACK_DESCRIPTION =
  "A paper on Scholium, with its reviews, discussion, versions, files and proof.";

/** The abstract, cut at a word and ended with an ellipsis if it was long. */
function describe(abstract: string): string {
  const text = abstract.replace(/\s+/g, " ").trim();
  if (text === "") {
    return FALLBACK_DESCRIPTION;
  }
  if (text.length <= DESCRIPTION_LENGTH) {
    return text;
  }
  const cut = text.slice(0, DESCRIPTION_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/** The page's `<title>` and description. A page with no paper is not indexed. */
export async function paperRouteMetadata(
  segments: readonly string[],
): Promise<Metadata> {
  const address = parsePaperAddress(segments);
  const read =
    address === null ? null : await readPaper(address.id, address.version);
  if (read === null || !read.ok) {
    return {
      title: "Paper unavailable · Scholium",
      robots: { index: false },
    };
  }
  const { paper, version, totalVersions } = read.data;
  return {
    title: `${paper.title} · ${versionOfTotal(version, totalVersions)} · Scholium`,
    description: describe(paper.abstract),
  };
}
