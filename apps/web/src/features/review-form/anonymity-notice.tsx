/**
 * The anonymity notice at the top of the review form (docs/design.md §5.5).
 *
 * A reviewer is anonymous by default, and says so before they write a word:
 * who can see their identity (nobody a reader would think of), and the one way
 * it can be opened. The wording is the design's, fixed so it never drifts into
 * a promise the escrow does not keep — the committee threshold and the
 * misconduct case are the real conditions (`reviews` escrow, feature 108).
 *
 * Server-safe: no state, no hooks.
 */

/** The sentence that says the reviewer is anonymous. */
export const ANONYMITY_HEADLINE = "You are reviewing anonymously.";

/** Who can see the identity, and how it can be opened. */
export const ANONYMITY_DETAIL =
  "Your identity is hidden from authors, readers and this node. " +
  "It can be opened only by 3 of 5 integrity committee members in a misconduct case.";

export function AnonymityNotice() {
  return (
    <div className="rf-anonymity" role="note" aria-label="Anonymity">
      <p className="rf-anonymity-text">
        <strong className="rf-anonymity-headline">{ANONYMITY_HEADLINE}</strong>{" "}
        {ANONYMITY_DETAIL}
      </p>
    </div>
  );
}
