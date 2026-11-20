import type { MetadataRoute } from "next";

import { DEFAULT_CATEGORIES, categoryHref } from "../components/nav/categories";
import { api, type ApiClient } from "../lib/api";
import { resolveSiteUrl } from "./site-metadata";

/**
 * `/sitemap.xml`, served by Next from this file as an App Router metadata
 * route.
 *
 * The static pages and the category pages are always present. The newest
 * publicly listed papers are read from `GET /v1/papers` (plugin: catalog,
 * feature 82) in pages of the API's maximum, following its keyset cursor until
 * {@link SITEMAP_PAPER_LIMIT} entries or the end of the catalog. A paper is
 * linked at `/p/{id}` and dated by its newest listed version (`updatedAt`),
 * which is what `lastModified` means to a crawler.
 *
 * The API is unreachable often enough — a cold deploy, a restart, a build —
 * that a failed read must never produce a failed sitemap: the static entries
 * still answer, so crawlers keep finding the site while the catalog recovers.
 *
 * Unlisted, held and tombstoned papers are never linked. The listing endpoint
 * already leaves unlisted and held versions out, but this module filters the
 * item's own status as well: the sitemap is a promise that a URL is public,
 * and it should not depend on a second service keeping that promise for it.
 */

/** The site's own pages, in the order a reader meets them (docs/design.md §4). */
export const STATIC_PATHS = [
  "/",
  "/papers",
  "/search",
  "/verify",
  "/network",
  "/policies",
] as const;

/** The most paper entries one sitemap carries. */
export const SITEMAP_PAPER_LIMIT = 5_000;

/** Papers asked for per page — the catalog's maximum (feature 82). */
export const SITEMAP_PAGE_SIZE = 100;

/**
 * States in which a version is not in the public catalog
 * (`paper_versions.state`, plugin: submissions, feature 52). A paper carrying
 * any of them is not a URL this sitemap may advertise.
 */
const NON_PUBLIC_STATUSES: ReadonlySet<string> = new Set([
  "unlisted",
  "held",
  "tombstoned",
  "draft",
  "awaiting_consent",
  "scanning",
  "moderation",
  "rejected",
]);

/** One paper the sitemap links. */
export interface SitemapPaper {
  /** Root-relative path, `/p/{id}`. */
  readonly path: string;
  /** When its newest listed version was listed, when the API names one. */
  readonly lastModified?: Date;
}

/** One page of `GET /v1/papers`, narrowed to what the sitemap reads. */
export interface SitemapPaperPage {
  readonly papers: readonly SitemapPaper[];
  readonly nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether an item from `GET /v1/papers` is a paper the public may see.
 *
 * The status is the version state the catalog carries; a paper with none is
 * treated as public (the endpoint has already filtered it) so a change of
 * vocabulary fails open for listings, never for a held or tombstoned one,
 * which are named here.
 */
export function isPubliclyListed(item: Record<string, unknown>): boolean {
  if (item.unlisted === true || item.held === true || item.tombstoned === true) {
    return false;
  }
  return !NON_PUBLIC_STATUSES.has(readText(item.status).toLowerCase());
}

function readDate(value: unknown): Date | undefined {
  const text = readText(value);
  if (text === "") {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The paper's path, `/p/{id}`, from the same id `paperHref` uses: the short id
 * without its `sch:` prefix, else a cid.
 */
function paperPath(item: Record<string, unknown>): string {
  const shortId = readText(item.shortId) || readText(item.paper);
  const id =
    shortId.replace(/^sch:/, "") ||
    readText(item.paperCid) ||
    readText(item.versionCid) ||
    readText(item.cid);
  return id === "" ? "" : `/p/${encodeURIComponent(id)}`;
}

/**
 * Validate one page of `GET /v1/papers`.
 *
 * Only items with an id and a public status survive; everything else is
 * dropped rather than thrown away wholesale, because one malformed row must
 * not cost the sitemap every other paper on the page. A body that is not a
 * list at all is an error, and the caller's fallback answers the static
 * entries.
 */
export function parseSitemapPaperPage(payload: unknown): SitemapPaperPage {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error("The API did not return a list of papers.");
  }

  const papers: SitemapPaper[] = [];
  for (const item of payload.items) {
    if (!isRecord(item) || !isPubliclyListed(item)) {
      continue;
    }
    const path = paperPath(item);
    if (path === "") {
      continue;
    }
    const lastModified = readDate(item.updatedAt) ?? readDate(item.listedAt);
    papers.push(lastModified ? { path, lastModified } : { path });
  }

  return { papers, nextCursor: readText(payload.nextCursor) || null };
}

/** A narrow interface for the shared API client, so tests can pass a stub. */
export type SitemapClient = Pick<ApiClient, "get">;

/**
 * Read the newest publicly listed papers, page by page.
 *
 * The cursor is passed back unchanged until the API says there is no next
 * page or {@link SITEMAP_PAPER_LIMIT} distinct papers are held. A repeated
 * cursor ends the walk too: a buggy cursor must not loop forever.
 */
export async function loadSitemapPapers(
  client: SitemapClient = api,
): Promise<SitemapPaper[]> {
  const byPath = new Map<string, SitemapPaper>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (byPath.size < SITEMAP_PAPER_LIMIT) {
    const query: Record<string, string | number> = {
      tab: "latest",
      sort: "newest",
      limit: Math.min(SITEMAP_PAGE_SIZE, SITEMAP_PAPER_LIMIT - byPath.size),
    };
    if (cursor !== null) {
      query.cursor = cursor;
    }

    const payload = await client.get<unknown>("/papers", {
      query,
      cache: "no-store",
    });
    const page = parseSitemapPaperPage(payload);

    for (const paper of page.papers) {
      if (!byPath.has(paper.path)) {
        byPath.set(paper.path, paper);
      }
      if (byPath.size >= SITEMAP_PAPER_LIMIT) {
        break;
      }
    }

    if (page.nextCursor === null || seenCursors.has(page.nextCursor)) {
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return [...byPath.values()].slice(0, SITEMAP_PAPER_LIMIT);
}

/** The static page entries and the category entries, as absolute URLs. */
export function staticSitemapEntries(siteUrl: string): MetadataRoute.Sitemap {
  const base = siteUrl.replace(/\/+$/, "");
  return [
    ...STATIC_PATHS.map((path) => ({ url: `${base}${path}` })),
    ...DEFAULT_CATEGORIES.map((category) => ({
      url: `${base}${categoryHref(category)}`,
    })),
  ];
}

/**
 * The catalog changes whenever a paper is listed, so the sitemap is rebuilt
 * on a schedule instead of frozen at build time (when the API may be down).
 */
export const revalidate = 3_600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = resolveSiteUrl();
  const base = siteUrl.replace(/\/+$/, "");
  const entries: MetadataRoute.Sitemap = staticSitemapEntries(siteUrl);

  try {
    const papers = await loadSitemapPapers();
    for (const paper of papers) {
      entries.push({
        url: `${base}${paper.path}`,
        ...(paper.lastModified ? { lastModified: paper.lastModified } : {}),
      });
    }
  } catch {
    // The API is unreachable or answered nonsense: the static entries above
    // are still a correct sitemap, so serve them rather than failing.
  }

  return entries;
}
