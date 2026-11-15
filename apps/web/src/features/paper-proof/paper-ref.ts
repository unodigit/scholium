/**
 * Which paper (and version) a Proof tab is checking.
 *
 * A paper is named by a `sch:xxxx-xxxx-xxxx` id and a version by
 * `sch:xxxx-xxxx-xxxx/vN` (docs/tech_architect.md §3.3). Paper page URLs drop
 * the `sch:` prefix (`/p/k3f9-q2xz-7mwd/v2`), so {@link refFromSegments} takes
 * route segments as well as whole ids. Every id is validated, checksum
 * included, by verify-core, so a mistyped id is reported as such instead of
 * being searched for.
 *
 * Pure data and functions, no React.
 */

import { formatVersionId, parseShortId, parseVersionId } from "../verify-core";

/** A paper, and optionally one of its versions. */
export interface PaperRef {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** Version number, or `null` for "the newest version". */
  readonly version: number | null;
  /** `shortId`, with `/vN` when there is a version: what the CLI is given. */
  readonly schId: string;
}

/** Thrown when text is not a well-formed paper or version id. */
export class PaperRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperRefError";
  }
}

function ref(shortId: string, version: number | null): PaperRef {
  return {
    shortId,
    version,
    schId: version === null ? shortId : formatVersionId(shortId, version),
  };
}

/**
 * Parse `sch:xxxx-xxxx-xxxx` or `sch:xxxx-xxxx-xxxx/vN`.
 *
 * @throws {PaperRefError} if the text is malformed or its checksum is wrong.
 */
export function parsePaperRef(value: string): PaperRef {
  const text = typeof value === "string" ? value.trim() : "";
  try {
    if (text.includes("/")) {
      const { shortId, version } = parseVersionId(text);
      return ref(shortId, version);
    }
    return ref(parseShortId(text), null);
  } catch (error) {
    throw new PaperRefError(
      error instanceof Error ? error.message : "Not a paper id.",
    );
  }
}

/** Decode one URL segment, leaving it alone when it is not valid escaping. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The paper named by route segments: `["k3f9-q2xz-7mwd"]` or
 * `["k3f9-q2xz-7mwd", "v2"]`. The `sch:` prefix is optional, and `sch%3A…` as
 * a browser or a pasted link may encode it is decoded first.
 *
 * @throws {PaperRefError} if there are no segments, more than two, or they do
 *   not name a paper.
 */
export function refFromSegments(segments: readonly string[]): PaperRef {
  if (segments.length < 1 || segments.length > 2) {
    throw new PaperRefError(
      "Expected a paper id like k3f9-q2xz-7mwd, optionally followed by a version like v2.",
    );
  }
  const [first, ...rest] = segments.map(decodeSegment);
  const paper = /^sch:/i.test(first) ? first : `sch:${first}`;
  return parsePaperRef([paper, ...rest].join("/"));
}
