/**
 * The link to `/verify` with a version already filled in.
 *
 * Pure data and functions, no React, so a server component (the paper page)
 * can import it without pulling in the page's client code.
 */

/** The route (docs/design.md §4: Docs · Policies · Verify a file). */
export const VERIFY_PATH = "/verify";

/**
 * `/verify`, or `/verify?id=sch%3A6sel-2dio-orm6%2Fv2` for a given version.
 *
 * The id is passed through as given: the page parses and checks it, so a link
 * with a mistyped id arrives as a sentence about the id, not a broken page.
 */
export function verifyHref(schId?: string): string {
  const id = schId?.trim();
  return id ? `${VERIFY_PATH}?id=${encodeURIComponent(id)}` : VERIFY_PATH;
}
