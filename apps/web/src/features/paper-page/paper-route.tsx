/**
 * What the `/p/{id}` and `/p/{id}/v{n}` route files do, in one place.
 *
 * Both route files are two lines: they take the URL's segments and hand them
 * here, so the two URLs cannot drift apart.
 *
 * - {@link renderPaperRoute} reads the paper and renders the page, or a notice
 *   saying why there is none. A `404` from the catalog is *not* the end:
 *   this render holds no token (the access token lives in browser memory), so
 *   the catalog also answers `404` for a version that is in moderation, held
 *   before listing or awaiting consent — even for its own author. What the
 *   server can still read is the paper's public record log:
 *     - a version a moderator **tombstoned** renders design.md's
 *       removed-content state, with the date and the policy;
 *     - anything else is a missing page. `/p/{id}` answers 404 through
 *       Next's `notFound()`, and the segment's `not-found.tsx` hydrates a
 *       client view that asks again with the signed-in reader's token
 *       ({@link PaperAccess}); `/p/{id}/v{n}` keeps its "no such version"
 *       notice and hydrates the same retry in place.
 *   A read that failed for any other reason is a message with a way back to
 *   search.
 * - {@link paperRouteMetadata} titles the page with the paper's title.
 *
 * **A tombstone is a `200` here, not a `451`.** Next.js lets a page choose
 * only 404, 403 and 401 (`notFound()`, `forbidden()`, `unauthorized()`); a
 * `451` has to come from middleware or the server in front of the app.
 *
 * **One read per request.** Next.js asks for the metadata and renders the page
 * in the same request, and both need the paper. `cache` makes the second ask
 * share the first one's reads instead of repeating a dozen API calls.
 * Listed papers never reach the extra read: it runs on a `404` only.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { ReactElement } from "react";

import { ApiError } from "../../lib/api";
import { versionOfTotal } from "./paper-facts";
import { parsePaperAddress } from "./paper-address";
import { PaperAccess } from "./paper-access";
import { PaperTombstoneView } from "./paper-access-view";
import {
  describePageError,
  loadPaperPageData,
  type PaperPageData,
} from "./paper-page-data";
import { PaperPageNotice, PaperPageView } from "./paper-page-view";
import {
  loadPaperRecords,
  tombstoneOf,
  type TombstoneFacts,
} from "./unlisted-paper";

/** What a route read came to: the page's data, or why there is none. */
type RouteRead =
  | { readonly ok: true; readonly data: PaperPageData }
  | {
      readonly ok: false;
      readonly message: string;
      /** The node answered `404`: there is no such paper on it. */
      readonly missing: boolean;
      /** The public log says moderation removed this version's content. */
      readonly tombstone: TombstoneFacts | null;
    };

/**
 * The removal facts of the paper behind a `404`, from its public record log.
 * Any failure to read the log is "no tombstone": the not-found path stands.
 */
async function readTombstone(
  id: string,
  version: number | null,
): Promise<TombstoneFacts | null> {
  try {
    return tombstoneOf(await loadPaperRecords(id), version);
  } catch {
    return null;
  }
}

const readPaper = cache(
  async (id: string, version: number | null): Promise<RouteRead> => {
    try {
      return { ok: true, data: await loadPaperPageData({ id, version }) };
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      return {
        ok: false,
        message: describePageError(error, { id, version }),
        missing,
        tombstone: missing ? await readTombstone(id, version) : null,
      };
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
  if (!read.ok) {
    // A takedown is a public fact in the signed log, so it is in the first
    // HTML for everyone: design.md's removed-content state, not a bare 404.
    if (read.tombstone !== null) {
      return <PaperTombstoneView facts={read.tombstone} />;
    }
    // An id the catalog does not list has no page *for this render*: answer
    // 404 rather than a 200 body that only says "not found", for readers and
    // crawlers alike. The segment's `not-found.tsx` then retries with the
    // reader's token, which this render does not have (paper-access.tsx).
    if (read.missing && address.version === null) {
      notFound();
    }
    // A requested version that is missing keeps its notice, since the paper
    // itself may well exist; the same retry hydrates in its place, because
    // the version may be the author's own held one.
    if (read.missing) {
      return <PaperAccess address={address} message={read.message} />;
    }
    return <PaperPageNotice message={read.message} />;
  }
  return <PaperPageView data={read.data} />;
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
  if (read !== null && !read.ok && read.tombstone !== null) {
    return {
      title: "Content removed · Scholium",
      robots: { index: false },
    };
  }
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
