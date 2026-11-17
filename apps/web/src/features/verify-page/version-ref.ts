/**
 * Which version of a paper the reader wants to compare a file with.
 *
 * A file is compared with the signed file list of *one version*, so the id has
 * to name one: `sch:xxxx-xxxx-xxxx/vN` (docs/tech_architect.md §3.3). Readers
 * paste these from a paper page, so the `sch:` prefix is optional here (paper
 * page URLs drop it) and stray spaces are ignored. The checksum is verified by
 * verify-core, so a mistyped id is told apart from one the node does not hold.
 *
 * Pure data and functions, no React.
 */

import { formatVersionId, parseShortId, parseVersionId } from "../verify-core";

/** One version of one paper. */
export interface VersionRef {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** Version number, at least 1. */
  readonly version: number;
  /** `shortId/vN`: what is shown, and what the offline CLI is given. */
  readonly schId: string;
}

export type ParsedVersionRef =
  | { readonly ok: true; readonly ref: VersionRef }
  | { readonly ok: false; readonly message: string };

/** An example id for messages (a real id from the shared vectors). */
export const EXAMPLE_VERSION_ID = "sch:6sel-2dio-orm6/v2";

/**
 * The id field's neutral placeholder: the shape of a version id, with no
 * checksum and therefore no paper behind it. The field's old placeholder was a
 * real vector id that no node holds, so it looked like a paper a reader could
 * try (bug_spec_verify5 bug 5). A link that carries an id fills the field
 * anyway; this is only what an empty field suggests.
 */
export const PLACEHOLDER_VERSION_ID = "sch:xxxx-xxxx-xxxx/v2";

const SHAPE = /^sch:(?:[a-z2-7]{4}-){2}[a-z2-7]{4}(?:\/v[1-9][0-9]{0,8})?$/i;

/** `sch%3A…` as a pasted link may encode it, otherwise the text as typed. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The text with its `sch:` prefix, which paper page URLs leave off. */
function withPrefix(text: string): string {
  return /^sch:/i.test(text) ? text : `sch:${text}`;
}

const BAD_SHAPE =
  `That is not a version id. A version id looks like ${EXAMPLE_VERSION_ID}: ` +
  "three groups of four letters or digits, then the version.";

const BAD_CHECKSUM =
  "That id has a typo: its checksum does not match. Copy it again from the paper's page.";

const NEEDS_VERSION =
  "Add the version, like /v2. A file is compared with the signed files of one version.";

/**
 * Parse what a reader typed or pasted into a version id.
 *
 * Never throws: a bad id comes back as a sentence to show next to the field.
 * Empty text is not an error to scold about, so callers check for it first.
 */
export function parseVersionRef(text: string): ParsedVersionRef {
  const candidate = withPrefix(decoded(typeof text === "string" ? text.trim() : ""));
  if (!SHAPE.test(candidate)) {
    return { ok: false, message: BAD_SHAPE };
  }

  if (!candidate.includes("/")) {
    // Well-formed paper id: either mistyped, or just missing its version.
    try {
      parseShortId(candidate);
    } catch {
      return { ok: false, message: BAD_CHECKSUM };
    }
    return { ok: false, message: NEEDS_VERSION };
  }

  try {
    const { shortId, version } = parseVersionId(candidate);
    return { ok: true, ref: { shortId, version, schId: formatVersionId(shortId, version) } };
  } catch {
    return { ok: false, message: BAD_CHECKSUM };
  }
}

/** The path of the Proof page for `ref`: the full signature check lives there. */
export function proofHref(ref: VersionRef): string {
  return `/proof/${ref.shortId.replace(/^sch:/, "")}/v${ref.version}`;
}
