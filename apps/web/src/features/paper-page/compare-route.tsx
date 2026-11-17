/**
 * What the `/p/{id}/compare/{from}..{to}` route file does, in one place.
 *
 * ```tsx
 * import { compareRouteMetadata, renderCompareRoute } from "@/features/paper-page";
 *
 * export const generateMetadata = async ({ params }) => {
 *   const { id, range } = await params;
 *   return compareRouteMetadata([id, "compare", range]);
 * };
 * export default async ({ params }) => {
 *   const { id, range } = await params;
 *   return renderCompareRoute([id, "compare", range]);
 * };
 * ```
 *
 * The comparison is the reason the page exists, so its read decides whether
 * there is a page. The paper's title is a second, optional read: if it fails,
 * the comparison still reads, with the versions named in the heading. Every
 * failure is a sentence with a way back, never a thrown error.
 *
 * **One read per request.** Next.js asks for the metadata and renders the page
 * in the same request; `cache` shares the two reads between them.
 */

import type { Metadata } from "next";
import { cache } from "react";
import type { ReactElement } from "react";

import { loadPaper } from "../search-page/paper";
import { describeCompareError, loadCompare, type CompareData } from "./compare";
import { CompareNotice, CompareView } from "./compare-view";
import { versionPagePath } from "./paper-links";
import { parsePaperAddress } from "./paper-address";

/** One comparison address: the paper and the two version numbers. */
export interface CompareAddress {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

/** The sentence for an address that is not a comparison address at all. */
export const NOT_A_COMPARE_ADDRESS =
  "That is not a comparison address. Open a version from the paper's Versions tab.";

/** `1..2`: two positive whole numbers joined by `..`. */
const RANGE = /^([1-9][0-9]{0,8})\.\.([1-9][0-9]{0,8})$/;

/** Decode one route segment, tolerating a stray `%` in a hand-built link. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The comparison named by route segments:
 * `["k3f9-q2xz-7mwd", "compare", "1..2"]`. `null` when they do not name one.
 *
 * The paper segment accepts everything a paper address does (`sch:` optional,
 * a record cid, either case), and only the *shape* of the range is checked:
 * whether both versions exist is the API's answer.
 */
export function parseCompareAddress(
  segments: readonly string[],
): CompareAddress | null {
  if (segments.length !== 3) {
    return null;
  }
  const [idSegment, marker, rangeSegment] = segments;
  if (
    idSegment === undefined ||
    marker === undefined ||
    rangeSegment === undefined ||
    decode(marker).trim().toLowerCase() !== "compare"
  ) {
    return null;
  }
  const paper = parsePaperAddress([idSegment]);
  if (paper === null) {
    return null;
  }
  const match = RANGE.exec(decode(rangeSegment).trim());
  if (match === null) {
    return null;
  }
  return {
    id: paper.id,
    from: Number.parseInt(match[1], 10),
    to: Number.parseInt(match[2], 10),
  };
}

/** What a comparison read came to: the diff, or the sentence that says why not. */
type CompareRead =
  | {
      readonly ok: true;
      readonly data: CompareData;
      readonly paperTitle: string | null;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly backHref: string;
      readonly backLabel: string;
    };

const readComparison = cache(
  async (
    id: string,
    from: number,
    to: number,
  ): Promise<CompareRead> => {
    // The diff decides the page; the title only decorates it, so it is read
    // beside the diff and its failure never takes the comparison down.
    const [paper, comparison] = await Promise.allSettled([
      loadPaper({ id, version: to }),
      loadCompare(id, from, to),
    ]);
    const backHref = versionPagePath(id, to);
    if (comparison.status === "rejected") {
      return {
        ok: false,
        message: describeCompareError(comparison.reason),
        backHref,
        backLabel: `Back to v${to}`,
      };
    }
    return {
      ok: true,
      data: comparison.value,
      paperTitle: paper.status === "fulfilled" ? paper.value.title : null,
    };
  },
);

/** Render the comparison for these route segments (`[id, "compare", range]`). */
export async function renderCompareRoute(
  segments: readonly string[],
): Promise<ReactElement> {
  const address = parseCompareAddress(segments);
  if (address === null) {
    return (
      <CompareNotice
        message={NOT_A_COMPARE_ADDRESS}
        backHref="/search"
        backLabel="Back to search"
      />
    );
  }
  const read = await readComparison(address.id, address.from, address.to);
  if (!read.ok) {
    return (
      <CompareNotice
        message={read.message}
        backHref={read.backHref}
        backLabel={read.backLabel}
      />
    );
  }
  return (
    <CompareView
      shortId={address.id}
      data={read.data}
      paperTitle={read.paperTitle}
    />
  );
}

/** The comparison's `<title>` and description. */
export async function compareRouteMetadata(
  segments: readonly string[],
): Promise<Metadata> {
  const address = parseCompareAddress(segments);
  if (address === null) {
    return {
      title: "Comparison unavailable",
      robots: { index: false },
    };
  }
  const read = await readComparison(address.id, address.from, address.to);
  const heading = `Compare v${address.from} with v${address.to}`;
  if (!read.ok) {
    return { title: `${heading}`, robots: { index: false } };
  }
  const paper = read.paperTitle === null ? "" : ` of ${read.paperTitle}`;
  return {
    title: `${heading}${paper}`,
    description: `Paragraph-by-paragraph changes between version ${address.from} and version ${address.to}${paper}.`,
  };
}
