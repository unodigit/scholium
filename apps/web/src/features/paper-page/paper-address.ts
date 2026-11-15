/**
 * Which paper (and version) a `/p/…` URL names.
 *
 * Paper URLs drop the `sch:` prefix (docs/design.md §4: `/p/k3f9-q2xz-7mwd/v2`),
 * and every feature that links to a paper writes them that way, but the
 * search page links with the prefix (`/p/sch%3Ak3f9-q2xz-7mwd`) and a search
 * hit without a short id falls back to the paper's record cid. All three are
 * accepted, because this page replaced the catch-all route that did.
 *
 * Only the *shape* is checked here. Whether the paper exists, and whether its
 * checksum is right, is the API's answer, so a mistyped id gets the page's
 * honest "not listed on this node" message instead of a parse error. (The
 * Proof tab checks the checksum itself, in the browser, on the canonical id
 * the API returns.)
 *
 * Pure data and functions, no React.
 */

import { parsePaperRoute, type PaperAddress } from "../search-page/paper";

export type { PaperAddress };

/** `k3f9-q2xz-7mwd`: a short id written without its `sch:` prefix. */
const BARE_SHORT_ID = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

/**
 * The paper named by route segments: `["k3f9-q2xz-7mwd"]` or
 * `["k3f9-q2xz-7mwd", "v2"]`. `null` when they do not name a paper.
 *
 * - The `sch:` prefix is optional, plain or percent-encoded (`sch%3A…`).
 * - A single path-safe token is taken as a record cid.
 * - The version is `v` and a positive whole number; `v0`, `2` and `vx` are not
 *   versions, so a hand-built link cannot ask the API for something odd.
 */
export function parsePaperAddress(
  segments: readonly string[],
): PaperAddress | null {
  const [first, ...rest] = segments;
  if (first === undefined) {
    return null;
  }
  // A bare short id has no `%`, so it is safe to test before decoding.
  const id = BARE_SHORT_ID.test(first.trim()) ? `sch:${first.trim()}` : first;
  return parsePaperRoute([id, ...rest]);
}
