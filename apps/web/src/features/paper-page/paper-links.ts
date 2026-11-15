/**
 * Where the paper page's actions and tabs point.
 *
 * Two kinds of address live here. The **API** ones (cite, archive) are
 * absolute URLs because they are plain links the browser follows, not
 * API-client requests, the way the Files tab's download links are. The
 * **in-page** ones are fragments: the reading column answers to `#reading`
 * and every margin tab answers to `#{tab id}`, which is also how the Verify
 * badge "always opens the Proof tab" (`#proof`, ui-kit).
 *
 * Pure data and functions, no React.
 */

import { resolveApiBaseUrl } from "../../lib/api";
import { categoryPageHref } from "../feed/category";

/** The reading column's fragment: what the HTML action points at. */
export const READING_ID = "reading";

/** The six margin tabs, in the order docs/design.md §5.2 lists them. */
export const MARGIN_TAB_IDS = [
  "reviews",
  "ai",
  "discussion",
  "versions",
  "files",
  "proof",
] as const;

export type MarginTabId = (typeof MARGIN_TAB_IDS)[number];

/** Narrow text (a URL fragment) to a margin tab id. */
export function isMarginTabId(value: unknown): value is MarginTabId {
  return (
    typeof value === "string" &&
    (MARGIN_TAB_IDS as readonly string[]).includes(value)
  );
}

/**
 * The tab a URL fragment names: `#proof` → `proof`. A missing, empty or
 * unknown fragment is `null`, so a link to a paragraph (`#p-abc123`) leaves the
 * panel on whatever tab it was on.
 */
export function tabFromHash(hash: string): MarginTabId | null {
  const id = hash.replace(/^#/, "").trim().toLowerCase();
  return isMarginTabId(id) ? id : null;
}

/** The fragment of a tab. */
export function tabHash(tab: MarginTabId): string {
  return `#${tab}`;
}

/** The short id without its prefix, the way paper URLs write it. */
function bareId(shortId: string): string {
  return shortId.trim().replace(/^sch:/i, "");
}

/** `/p/k3f9-q2xz-7mwd/v2`: this page, for a version. */
export function versionPagePath(shortId: string, version: number): string {
  return `/p/${encodeURIComponent(bareId(shortId))}/v${version}`;
}

/** The category a paper is listed in: `/c/cs.AI`. */
export function categoryHref(category: string): string {
  return categoryPageHref(category);
}

/**
 * The citation of the version on screen, as BibTeX
 * (`GET /v1/papers/{id}/cite?format=bibtex`).
 *
 * The version id carries the `sch:` id and `/vN`, so the citation names the
 * exact version the reader is looking at, and says so if it was retracted.
 */
export function citeHref(
  shortId: string,
  version: number,
  baseUrl?: string,
): string {
  const base = resolveApiBaseUrl(baseUrl);
  return `${base}/v1/papers/${encodeURIComponent(shortId.trim())}/v${version}/cite?format=bibtex`;
}

/**
 * The paper's archive: every signed record, file and log entry of the paper
 * as one file (`GET /v1/export/paper/{id}.car`). It is the whole paper, not
 * the version on screen, because that is what lets someone else verify it.
 */
export function archiveHref(shortId: string, baseUrl?: string): string {
  const base = resolveApiBaseUrl(baseUrl);
  return `${base}/v1/export/paper/${encodeURIComponent(shortId.trim())}.car`;
}
