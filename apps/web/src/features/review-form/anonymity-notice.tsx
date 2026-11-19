"use client";

/**
 * The anonymity notice at the top of the review form (docs/design.md §5.5).
 *
 * A reviewer is anonymous by default, and says so before they write a word:
 * who can see their identity (nobody a reader would think of), and the one way
 * it can be opened. The wording is the design's, fixed so it never drifts into
 * a promise the escrow does not keep. The identity is one sealed box under the
 * committee's key (`COMMITTEE_PUBLIC_KEY`; `reviews` escrow, feature 108), so
 * the notice names the key and the misconduct case, and promises no threshold
 * of members: none exists.
 *
 * Beside it is **Sign with my name instead** (feature 167). Choosing it swaps
 * the notice for what signing means — the review will be credited to the
 * reviewer by name — and offers **Stay anonymous instead** to go back. It is
 * one button whose words change, so keyboard focus stays on it. The notice is
 * a polite live region, so the change is read out. Once the form is signing or
 * sealed the choice is fixed and the button goes.
 *
 * Without a {@link ReviewSessionProvider} the notice is the plain anonymous
 * one, with no button: there is nothing for the choice to reach.
 */

import {
  SIGNED_DETAIL,
  SIGNED_HEADLINE,
  SIGNED_SEALED_DETAIL,
  SIGN_WITH_NAME_LABEL,
  STAY_ANONYMOUS_LABEL,
} from "./identity";
import { useReviewSession } from "./review-session";

/** The sentence that says the reviewer is anonymous. */
export const ANONYMITY_HEADLINE = "You are reviewing anonymously.";

/** Who can see the identity, and how it can be opened. */
export const ANONYMITY_DETAIL =
  "Your identity is hidden from authors, readers and this node. " +
  "It is held in escrow under the integrity committee’s key and can be opened only in a misconduct case.";

export function AnonymityNotice() {
  const session = useReviewSession();
  const signed = session?.signed === true;
  const locked = session?.locked === true;
  // The choice belongs to a form that will seal it into the commit. A sealed
  // or revealed card replaces the form, so there is nothing for it to reach.
  const formActive = session?.formActive === true;

  const headline = signed ? SIGNED_HEADLINE : ANONYMITY_HEADLINE;
  const detail = !signed
    ? ANONYMITY_DETAIL
    : locked
      ? SIGNED_SEALED_DETAIL
      : SIGNED_DETAIL;

  return (
    <div
      className="rf-anonymity"
      data-identity={signed ? "signed" : "anonymous"}
    >
      <p
        className="rf-anonymity-text"
        role="note"
        aria-label={signed ? "Signed review" : "Anonymity"}
        aria-live="polite"
      >
        <strong className="rf-anonymity-headline">{headline}</strong> {detail}
      </p>
      {session !== null && formActive && !locked ? (
        <button
          type="button"
          className="rf-button rf-button--quiet rf-identity-toggle"
          onClick={() => session.setSigned(!signed)}
        >
          {signed ? STAY_ANONYMOUS_LABEL : SIGN_WITH_NAME_LABEL}
        </button>
      ) : null}
    </div>
  );
}
