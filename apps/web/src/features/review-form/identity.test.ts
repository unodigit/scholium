import { cleanup, render, screen } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ANONYMITY_DETAIL,
  ANONYMITY_HEADLINE,
  AnonymityNotice,
} from "./anonymity-notice";
import {
  COMMIT_NOTE_ANONYMOUS,
  COMMIT_NOTE_SIGNED,
  SEALED_SIGNED_NOTE,
  SIGNED_DETAIL,
  SIGNED_HEADLINE,
  SIGNED_SEALED_DETAIL,
  SIGN_WITH_NAME_LABEL,
  STAY_ANONYMOUS_LABEL,
  STYLOMETRY_TIP,
} from "./identity";
import {
  ReviewSessionProvider,
  useReviewSession,
  type OwnReviewState,
} from "./review-session";

afterEach(cleanup);

describe("the design's words (docs/design.md §5.5)", () => {
  it("names the option exactly as the design does", () => {
    expect(SIGN_WITH_NAME_LABEL).toBe("Sign with my name instead");
  });

  it("gives the stylometry tip exactly as the design does", () => {
    expect(STYLOMETRY_TIP).toBe("Tip: avoid phrases that identify you or your lab.");
  });
});

describe("what signing means", () => {
  it("says the review is credited by name and listed on the profile", () => {
    for (const detail of [SIGNED_DETAIL, SIGNED_SEALED_DETAIL]) {
      expect(detail).toMatch(/credited to you by name/);
      expect(detail).toMatch(/public profile/);
    }
  });

  it("says before committing that the choice is sealed with the review", () => {
    expect(SIGNED_DETAIL).toMatch(/sealed with your review/);
    expect(SIGNED_DETAIL).toMatch(/before you commit/);
    expect(SIGNED_SEALED_DETAIL).toMatch(/was sealed with your review/);
  });

  it("never promises anonymity to a reviewer who is signing", () => {
    for (const words of [SIGNED_HEADLINE, SIGNED_DETAIL, SIGNED_SEALED_DETAIL]) {
      expect(words).not.toMatch(/anonym|hidden/i);
    }
  });

  it("offers a way back that names what it goes back to", () => {
    expect(STAY_ANONYMOUS_LABEL).toBe("Stay anonymous instead");
  });

  it("adds to the commit note, not replaces it, when signing", () => {
    expect(COMMIT_NOTE_SIGNED.startsWith(COMMIT_NOTE_ANONYMOUS)).toBe(true);
    expect(COMMIT_NOTE_SIGNED).toMatch(/carry your name/);
    expect(SEALED_SIGNED_NOTE).toMatch(/carry your name/);
  });
});

/**
 * The notice as a reviewer sees it when the page already knows about a review
 * of theirs. `ownReviewState` is what the form reports once it has read that
 * review (from the dashboard, from this device, or from the record an update
 * revises); it arrives before any commit happens in this visit.
 */
function noticeForOwnReview(
  state: OwnReviewState,
  { signed, formActive = true }: { signed: boolean; formActive?: boolean },
) {
  /** Stands in for the form: reports the review it found, and the byline. */
  function ReportOwnReview() {
    const session = useReviewSession();
    const setOwnReviewState = session?.setOwnReviewState;
    const setSigned = session?.setSigned;
    const setFormActive = session?.setFormActive;
    useEffect(() => {
      setOwnReviewState?.(state);
      // Choosing to sign would already be the page's choice, as the form's
      // adoption of a signed byline is.
      if (signed) setSigned?.(true);
      // A committed review page has no editable form; an update form does.
      if (!formActive) setFormActive?.(false);
    }, [setOwnReviewState, setSigned, setFormActive, formActive]);
    return null;
  }

  return createElement(
    ReviewSessionProvider,
    null,
    createElement(ReportOwnReview),
    createElement(AnonymityNotice),
  );
}

describe("the words for a reviewer who already committed", () => {
  it("stays in the imperative only while a first commit is still ahead", () => {
    render(noticeForOwnReview(null, { signed: true }));

    expect(screen.getByRole("note", { name: "Signed review" }).textContent).toBe(
      `${SIGNED_HEADLINE} ${SIGNED_DETAIL}`,
    );
  });

  it("says the choice was sealed for a signed review on a revisit after committing", () => {
    render(noticeForOwnReview("revealed", { signed: true, formActive: false }));

    expect(screen.getByRole("note", { name: "Signed review" }).textContent).toBe(
      `${SIGNED_HEADLINE} ${SIGNED_SEALED_DETAIL}`,
    );
    expect(screen.queryByText(/make it before you commit/)).toBeNull();
  });

  it("says it for a review that is still sealed elsewhere too", () => {
    render(noticeForOwnReview("sealed", { signed: true }));

    expect(screen.getByRole("note", { name: "Signed review" }).textContent).toBe(
      `${SIGNED_HEADLINE} ${SIGNED_SEALED_DETAIL}`,
    );
  });

  it("keeps the anonymous notice, which never asked for a choice before a commit", () => {
    render(noticeForOwnReview("revealed", { signed: false, formActive: false }));

    expect(screen.getByRole("note", { name: "Anonymity" }).textContent).toBe(
      `${ANONYMITY_HEADLINE} ${ANONYMITY_DETAIL}`,
    );
    expect(ANONYMITY_DETAIL).not.toMatch(/before you commit/i);
  });
});
