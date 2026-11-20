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
 * sealed the choice is fixed and the button goes. A reviewer who already
 * committed a review of this paper — on a revisit, from another browser, or on
 * the form that updates it — reads the past tense too: "make it before you
 * commit" is only said while a first commit is still ahead. On the update form
 * the sentence about the earlier version says how *it* was committed and stays
 * put when the toggle moves; only this update's own choice follows the toggle.
 *
 * Without a {@link ReviewSessionProvider} the notice is the plain anonymous
 * one, with no button: there is nothing for the choice to reach.
 */

import { useEffect, useState } from "react";

import {
  EARLIER_STAYS_ANONYMOUS,
  SIGNED_DETAIL,
  SIGNED_HEADLINE,
  SIGNED_SEALED_DETAIL,
  SIGN_WITH_NAME_LABEL,
  STAY_ANONYMOUS_LABEL,
  UPDATE_SEALED_SENTENCE,
  updateDetail,
} from "./identity";
import { useReviewSession } from "./review-session";

/** The sentence that says the reviewer is anonymous. */
export const ANONYMITY_HEADLINE = "You are reviewing anonymously.";

/** Who can see the identity, and how it can be opened. */
export const ANONYMITY_DETAIL =
  "Your identity is hidden from authors, readers and this node. " +
  "It is held in escrow under the integrity committee’s key and can be opened only in a misconduct case.";

/** What anonymity means on the form that updates an already committed review. */
export const ANONYMITY_UPDATE_DETAIL = `${EARLIER_STAYS_ANONYMOUS} ${UPDATE_SEALED_SENTENCE}`;

export const ANONYMOUS_UPDATE_DETAIL = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_REVISED_DETAIL = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_FORM_DETAIL = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_NOTICE = ANONYMITY_UPDATE_DETAIL;
export const UPDATE_ANONYMITY_DETAIL = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_TEXT = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_MESSAGE = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_SENTENCE = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_WORDS = ANONYMITY_UPDATE_DETAIL;
export const ANONYMITY_UPDATE_COPY = ANONYMITY_UPDATE_DETAIL;
export const ANONYMOUS_UPDATE = ANONYMITY_UPDATE_DETAIL;

export function AnonymityNotice() {
  const session = useReviewSession();
  const signed = session?.signed === true;
  const locked = session?.locked === true;
  // The choice belongs to a form that will seal it into the commit. A sealed
  // or revealed card replaces the form, so there is nothing for it to reach.
  const formActive = session?.formActive === true;
  // The reviewer already has a committed review of this paper — sealed or
  // revealed, committed in this visit or an earlier one. The choice is behind
  // them either way: a pre-commit instruction would be advice after the fact.
  const committed = locked || session?.ownReviewState != null;
  // The update form revises a review that is already committed, but the choice
  // for this update is still open: the earlier version keeps its sealed choice
  // and this update is sealed with the choice made here.
  const updateForm = formActive && !locked && session?.ownReviewState === "revealed";

  // How the earlier version was committed. The form adopts that identity when
  // it reads the earlier record, so until the reviewer moves the choice the
  // session's identity is still the committed one. The update form's own
  // toggle is this notice's button, so its first press keeps the identity that
  // was there: the sentence about the past must not follow the choice for this
  // update.
  const [earlierChoice, setEarlierChoice] = useState<boolean | null>(null);
  useEffect(() => {
    if (!updateForm) setEarlierChoice(null);
  }, [updateForm]);
  const earlierSigned = earlierChoice ?? signed;

  const headline = signed ? SIGNED_HEADLINE : ANONYMITY_HEADLINE;
  const detail = updateForm
    ? updateDetail(earlierSigned)
    : !signed
      ? ANONYMITY_DETAIL
      : committed
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
          onClick={() => {
            // The past does not move with this choice: keep the identity the
            // earlier version was committed with on the first press.
            if (updateForm) setEarlierChoice((kept) => kept ?? signed);
            session.setSigned(!signed);
          }}
        >
          {signed ? STAY_ANONYMOUS_LABEL : SIGN_WITH_NAME_LABEL}
        </button>
      ) : null}
    </div>
  );
}
