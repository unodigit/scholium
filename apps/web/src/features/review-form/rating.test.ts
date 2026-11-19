import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  InvalidRatingError,
  RATING_HINT,
  RATING_VALUES,
  RatingInputError,
  describeRatingError,
  isRating,
  ratingPath,
  ratingText,
  rateReview,
} from "./rating";

const REVIEW = "bafyreireviewcommit";

describe("ratings", () => {
  it("run from 1 to 5, like the rubric", () => {
    expect(RATING_VALUES).toEqual([1, 2, 3, 4, 5]);
  });

  it("have a text equivalent", () => {
    expect(ratingText(4)).toBe("4 of 5");
  });

  it("are whole numbers from 1 to 5 and nothing else", () => {
    for (const ok of [1, 2, 3, 4, 5]) expect(isRating(ok)).toBe(true);
    for (const bad of [0, 6, -1, 2.5, NaN, Infinity, "3", null, undefined, true]) {
      expect(isRating(bad)).toBe(false);
    }
  });
});

describe("the rating hint", () => {
  it("says what a rating is and what it does, and nothing more", () => {
    expect(RATING_HINT).toBe(
      "1 is a review that does not help, 5 is one that sharpens the paper. " +
        "You rate the review, not the paper. " +
        "Ratings are recorded with the review and never change the paper’s status.",
    );
  });

  it("does not promise a reputation effect: no reputation exists", () => {
    expect(RATING_HINT).not.toMatch(/reputation/i);
  });
});

describe("rateReview", () => {
  it("sends the rating to the review's rating path and returns what the API recorded", async () => {
    const submit = vi.fn(async () => ({ rating: 4, status: "recorded" }));

    const result = await rateReview({ reviewCid: ` ${REVIEW} `, rating: 4 }, { submit });

    expect(submit).toHaveBeenCalledWith(REVIEW, 4);
    expect(result).toEqual({ reviewCid: REVIEW, rating: 4 });
  });

  it("trusts the rating the API echoes over the one it was asked to send", async () => {
    const result = await rateReview(
      { reviewCid: REVIEW, rating: 4 },
      { submit: async () => ({ rating: 5 }) },
    );
    expect(result.rating).toBe(5);
  });

  it("falls back to the rating it sent when the API does not echo one", async () => {
    const result = await rateReview(
      { reviewCid: REVIEW, rating: 2 },
      { submit: async () => ({}) },
    );
    expect(result.rating).toBe(2);
  });

  it("sends nothing for a rating that is not 1 to 5", async () => {
    const submit = vi.fn(async () => ({}));

    for (const rating of [0, 6, 2.5, Number.NaN]) {
      await expect(rateReview({ reviewCid: REVIEW, rating }, { submit })).rejects.toThrow(
        InvalidRatingError,
      );
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends nothing when the review is not named", async () => {
    const submit = vi.fn(async () => ({}));

    await expect(rateReview({ reviewCid: "  ", rating: 3 }, { submit })).rejects.toThrow(
      RatingInputError,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets an API refusal reach the caller", async () => {
    const refusal = new ApiError(403, { detail: "The reviewer of a review may not rate it." });

    await expect(
      rateReview(
        { reviewCid: REVIEW, rating: 3 },
        {
          submit: async () => {
            throw refusal;
          },
        },
      ),
    ).rejects.toBe(refusal);
  });

  it("posts to /reviews/{cid}/rating", () => {
    expect(ratingPath(REVIEW)).toBe(`/reviews/${REVIEW}/rating`);
  });
});

describe("describeRatingError", () => {
  it("offers sign-in when the session has ended", () => {
    const failure = describeRatingError(new ApiError(401, {}));
    expect(failure.signIn).toBe(true);
    expect(failure.message).toMatch(/session has ended/);
  });

  it("shows the API's own words for each refusal", () => {
    for (const detail of [
      "This action requires Reviewer or higher; the caller is Member.",
      "An author of the paper may not rate its review.",
      "The reviewer of a review may not rate it.",
    ]) {
      const failure = describeRatingError(new ApiError(403, { detail }));
      expect(failure.signIn).toBe(false);
      expect(failure.message).toBe(`${detail} Nothing was sent.`);
    }
  });

  it("explains a refusal that has no words of its own", () => {
    expect(describeRatingError(new ApiError(403, {})).message).toMatch(
      /Only tier-3 members who did not write this review/,
    );
  });

  it("says a repeat rating stands, rather than telling the member to try again", () => {
    expect(describeRatingError(new ApiError(409, {})).message).toMatch(
      /already rated this review\. Your first rating stands\./,
    );
    // The API has one rating per member per review, and a repeat surfaces as a
    // server failure: "try again" would be wrong advice.
    const failure = describeRatingError(new ApiError(500, {})).message;
    expect(failure).toMatch(/If you have already rated this review, your first rating stands/);
  });

  it("covers a missing review, a bad rating, an offline API and local refusals", () => {
    expect(describeRatingError(new ApiError(404, {})).message).toMatch(/could not be found/);
    expect(
      describeRatingError(new ApiError(422, { detail: "rating must be an integer from 1 to 5." })).message,
    ).toBe("rating must be an integer from 1 to 5. Nothing was sent.");
    expect(describeRatingError(new NetworkError("http://api")).message).toMatch(
      /could not reach the API/,
    );
    expect(describeRatingError(new InvalidRatingError()).message).toBe(
      "Choose a rating from 1 to 5. Nothing was sent.",
    );
    expect(describeRatingError(new RatingInputError("No id.")).message).toBe(
      "No id. Nothing was sent.",
    );
  });

  it("never throws, whatever it is given", () => {
    for (const thing of [null, undefined, "boom", 7, {}]) {
      expect(describeRatingError(thing).message).toMatch(/rating could not be sent/);
    }
  });
});
