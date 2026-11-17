/**
 * Licence ids by their full name.
 *
 * A signed version record carries the licence as an id (`CC-BY-4.0`), the same
 * values the submit wizard offers. A moderator reads the name: the id says
 * nothing to someone who has not memorised SPDX. The names are the ones the
 * submit wizard's summary card prints, so an author and a moderator see the
 * same words. An id this release does not know prints as itself rather than
 * being guessed at.
 */

const LICENCE_NAMES: Readonly<Record<string, string>> = {
  "CC-BY-4.0": "Creative Commons Attribution 4.0",
  "CC-BY-SA-4.0": "Creative Commons Attribution-ShareAlike 4.0",
  "CC-BY-NC-4.0": "Creative Commons Attribution-NonCommercial 4.0",
  "CC-BY-NC-ND-4.0":
    "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0",
  "CC0-1.0": "CC0 1.0 Universal",
};

/** The full name of a licence id, or the id itself when it is not known. */
export function licenceName(id: string): string {
  return LICENCE_NAMES[id] ?? id;
}
