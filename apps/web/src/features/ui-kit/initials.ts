/**
 * Letters for an avatar, from a person's name.
 *
 * A title is not part of a name: "Dr. Tunde Okafor" is "TO", not "DT". The
 * consent tracker, the Authors step and the profile header all take their
 * avatar letters from here, so every avatar in the product agrees.
 */

/**
 * Titles and honorifics dropped before taking initials. The label is split on
 * full stops and other punctuation first, so "Dr." and "Dr" compare alike.
 */
const HONORIFICS = new Set(["dr", "prof", "mr", "ms", "mrs", "mx", "sir", "dame"]);

/**
 * Up to two capital letters for an avatar, or `null` when the label offers no
 * letters (an ORCID iD, a DID, a bare number, or nothing but a title).
 */
export function initials(label: string): string | null {
  const words = label
    .split(/[\s.,_@-]+/)
    .filter((word) => /^\p{L}/u.test(word))
    .filter((word) => !HONORIFICS.has(word.toLowerCase()));
  if (words.length === 0) {
    return null;
  }
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}
