/**
 * Who a review is credited to: the words for "Sign with my name instead", the
 * stylometry tip, and what the choice means (spec feature 167,
 * docs/design.md §5.5).
 *
 * A reviewer is anonymous unless they choose otherwise. Choosing otherwise puts
 * `"signed": true` in the `review.formal` body, which `POST /v1/reviews/reveal`
 * honours only for the reviewer who sealed the review, and then lists the
 * review on their public profile. Because the flag is covered by the commit's
 * commitment, the choice is made before committing and sealed with the review.
 *
 * The words are fixed here so the notice, the form and the sealed card never
 * drift into a promise the API does not keep. Pure data, no React.
 */

/** The button that switches an anonymous review to a signed one. */
export const SIGN_WITH_NAME_LABEL = "Sign with my name instead";

/** The button that switches back, offered while the review is signed. */
export const STAY_ANONYMOUS_LABEL = "Stay anonymous instead";

/** The sentence that says the review will carry the reviewer's name. */
export const SIGNED_HEADLINE = "You are signing this review with your name.";

/**
 * What signing does, while the choice can still be changed. "Credited" is the
 * API's word for it: the review is listed on the reviewer's public profile.
 * Said only while a first commit is still ahead; once the reviewer has a
 * committed review of the paper, {@link SIGNED_SEALED_DETAIL} takes over.
 */
export const SIGNED_DETAIL =
  "When the review is revealed it will be credited to you by name and listed " +
  "on your public profile. The choice is sealed with your review, so make it " +
  "before you commit.";

/** What signing means once the review is committed and the choice is sealed. */
export const SIGNED_SEALED_DETAIL =
  "When the review is revealed it will be credited to you by name and listed " +
  "on your public profile. The choice was sealed with your review.";

export const SIGNED_UPDATE_DETAIL =
  "Your earlier version stays signed. This update is sealed with the choice you make here.";

export const SIGNED_UPDATE_SEALED_DETAIL = SIGNED_UPDATE_DETAIL;
export const UPDATE_SIGNED_DETAIL = SIGNED_UPDATE_DETAIL;
export const SIGNED_REVISED_DETAIL = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_FORM_DETAIL = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_NOTICE = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_TEXT = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_MESSAGE = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_SENTENCE = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_WORDS = SIGNED_UPDATE_DETAIL;
export const SIGNED_UPDATE_COPY = SIGNED_UPDATE_DETAIL;
export const UPDATE_SIGNED_SEALED_DETAIL = SIGNED_UPDATE_DETAIL;

/**
 * The stylometry hint, in the design's words. Shown only while the review is
 * anonymous: a name on the review makes writing style beside the point.
 */
export const STYLOMETRY_TIP =
  "Tip: avoid phrases that identify you or your lab.";

/** The line under Commit review for an anonymous review. */
export const COMMIT_NOTE_ANONYMOUS =
  "Committing signs the review with a per-paper key and seals it until it is revealed.";

/** The line under Commit review when the reviewer chose to sign. */
export const COMMIT_NOTE_SIGNED =
  `${COMMIT_NOTE_ANONYMOUS} It will carry your name when it is revealed.`;

/** The line on the sealed card for a review that will carry a name. */
export const SEALED_SIGNED_NOTE =
  "It will carry your name when it is revealed.";
