import { describe, expect, it } from "vitest";

import {
  confidenceLabel,
  dimensionLabel,
  dimensionMedians,
  emptyReviews,
  formatReviewDate,
  isRevealed,
  median,
  medianText,
  parseReviews,
  parseScores,
  recommendationLabel,
  recommendationTone,
  reportGateDate,
  reviewerLabelAt,
  scoreFraction,
  scoreText,
} from "./review";

/**
 * The wire shape, the labels and the summary arithmetic.
 *
 * The payload is the one `GET /v1/papers/{id}/reviews` sends (feature 110):
 * the endpoint's spellings, the rubric object, and reports that are absent
 * while the reveal gate is shut.
 */

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper: "sch:k3f9-q2xz-7mwd",
    shortId: "sch:k3f9-q2xz-7mwd",
    versionCid: "bafyrei-v2",
    version: 2,
    gate_open: true,
    count: 2,
    reviews: [
      {
        review_cid: "bafyrei-a",
        label: "Reviewer A",
        recommendation: "minor_revisions",
        confidence: 4,
        committed_at: "2027-03-02T04:00:00",
        scores: {
          soundness: { score: 4, justification: "The design is sound." },
          evidence: { score: 3, justification: "One claim is unsupported." },
          reproducibility: { score: 4, justification: "The bundle runs." },
          novelty: { score: 3, justification: "An incremental step." },
          clarity: { score: 5, justification: "Very clear." },
          limitations: { score: 2, justification: "Ethics is thin." },
        },
        report: "The paper is careful and the code runs.",
      },
      {
        review_cid: "bafyrei-b",
        label: "Reviewer B",
        recommendation: "major_concerns",
        confidence: 2,
        committed_at: "2027-03-03T04:00:00",
        scores: {
          soundness: { score: 3 },
          evidence: { score: 4 },
        },
        // no report: still sealed
      },
    ],
    ...overrides,
  };
}

describe("parseReviews", () => {
  it("reads the endpoint's payload into cards", () => {
    const data = parseReviews(payload());

    expect(data.paper).toBe("sch:k3f9-q2xz-7mwd");
    expect(data.version).toBe(2);
    expect(data.versionCid).toBe("bafyrei-v2");
    expect(data.gateOpen).toBe(true);
    expect(data.count).toBe(2);
    expect(data.reviews).toHaveLength(2);

    const [first, second] = data.reviews;
    expect(first.label).toBe("Reviewer A");
    expect(first.recommendation).toBe("minor_revisions");
    expect(first.recommendationLabel).toBe("Minor revisions");
    expect(first.confidenceLabel).toBe("High");
    expect(first.report).toBe("The paper is careful and the code runs.");
    expect(first.committedAt).toBe("2027-03-02T04:00:00");
    expect(first.scores.map((score) => score.dimension)).toEqual([
      "soundness",
      "evidence",
      "reproducibility",
      "novelty",
      "clarity",
      "limitations",
    ]);
    expect(first.scores[0]).toMatchObject({
      label: "Soundness",
      score: 4,
      justification: "The design is sound.",
    });

    expect(second.report).toBeNull();
    expect(second.confidenceLabel).toBe("Low");
  });

  it("labels an anonymous review at its position when no label is served", () => {
    const data = parseReviews({
      reviews: [{ review_cid: "a" }, { review_cid: "b" }, { review_cid: "c" }],
    });
    expect(data.reviews.map((review) => review.label)).toEqual([
      "Reviewer A",
      "Reviewer B",
      "Reviewer C",
    ]);
  });

  it("does not show a DID as a reviewer's name", () => {
    const data = parseReviews({
      reviews: [
        {
          label: "did:key:z6MkaliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          review_cid: "a",
        },
      ],
    });
    expect(data.reviews[0].label).toBe("Reviewer A");
  });

  it("closes the gate when the server says so, even if a report slips through", () => {
    const data = parseReviews({
      gate_open: false,
      reviews: [{ review_cid: "a", report: "leaked?" }],
    });
    expect(data.gateOpen).toBe(false);
  });

  it("reads an array payload as the review list", () => {
    const data = parseReviews([{ review_cid: "a", label: "Reviewer A" }]);
    expect(data.reviews).toHaveLength(1);
    expect(data.gateOpen).toBe(false);
  });

  it("never throws on junk: a half-built node is an empty state", () => {
    expect(parseReviews(null).reviews).toEqual([]);
    expect(parseReviews("not json").reviews).toEqual([]);
    expect(parseReviews({ reviews: "nope" }).reviews).toEqual([]);
    expect(parseReviews({ reviews: [null, 3, []] }).reviews).toHaveLength(3);
  });
});

describe("revealed reviews and their revision history", () => {
  it("reads revealed_at even when the review carries no written report", () => {
    const data = parseReviews({
      reviews: [
        {
          review_cid: "a",
          revealed_at: "2027-03-02T05:00:00",
          scores: { soundness: { score: 4, justification: "Sound." } },
        },
      ],
    });

    expect(data.reviews[0].revealedAt).toBe("2027-03-02T05:00:00");
    expect(isRevealed(data.reviews[0])).toBe(true);
  });

  it("does not call a committed but unrevealed review revealed", () => {
    const data = parseReviews({
      reviews: [{ review_cid: "a", revealed_at: null, scores: null }],
    });
    expect(isRevealed(data.reviews[0])).toBe(false);
  });

  it("reads a reviewer's history oldest first, with each revision's version and date", () => {
    const data = parseReviews({
      reviews: [
        {
          review_cid: "a",
          revealed_at: "2027-04-01T00:00:00",
          recommendation: "sound_as_is",
          history: [
            {
              formal_cid: "bafy-formal-1",
              version: 1,
              revealed_at: "2027-03-02T05:00:00",
              recommendation: "minor_revisions",
              scores: {
                soundness: { score: 4, justification: "Mostly sound." },
              },
            },
            {
              formal_cid: "bafy-formal-2",
              version: 2,
              revealed_at: "2027-04-01T00:00:00",
              recommendation: "sound_as_is",
              scores: {
                soundness: { score: 5, justification: "Now sound." },
              },
            },
          ],
        },
      ],
    });

    const history = data.reviews[0].history ?? [];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      formalCid: "bafy-formal-1",
      version: 1,
      recommendation: "minor_revisions",
      recommendationLabel: "Minor revisions",
      revealedAt: "2027-03-02T05:00:00",
    });
    expect(history[0].scores[0]).toMatchObject({
      dimension: "soundness",
      justification: "Mostly sound.",
    });
    expect(history[1]).toMatchObject({
      formalCid: "bafy-formal-2",
      version: 2,
      recommendationLabel: "Sound as is",
      revealedAt: "2027-04-01T00:00:00",
    });
  });
});

describe("author replies", () => {
  it("reads point-by-point responses keyed by rubric dimension", () => {
    const data = parseReviews({
      reviews: [
        {
          review_cid: "a",
          responses: [
            {
              reply_cid: "bafyrei-reply",
              author_name: "Mei Zhang",
              version: 2,
              created_at: "2027-03-05T10:00:00",
              items: [
                { dimension: "soundness", text: "Section 3.2 names the baseline." },
                { dimension: "evidence", text: "Table 4 now reports the seeds." },
              ],
            },
          ],
        },
      ],
    });

    const [reply] = data.reviews[0].replies;
    expect(reply.id).toBe("bafyrei-reply");
    expect(reply.author).toBe("Mei Zhang");
    expect(reply.version).toBe(2);
    expect(reply.items.map((item) => item.label)).toEqual(["Soundness", "Evidence"]);
    expect(reply.items[0].text).toBe("Section 3.2 names the baseline.");
  });

  it("reads a plain reply string on the review", () => {
    const data = parseReviews({
      reviews: [{ review_cid: "a", reply: "Thank you — we fixed this in v2." }],
    });
    expect(data.reviews[0].replies[0].text).toBe(
      "Thank you — we fixed this in v2.",
    );
  });

  it("reads a review.response with rubric-dimension items", () => {
    const data = parseReviews({
      reviews: [
        {
          review_cid: "a",
          response: {
            replyCid: "bafyrei-response",
            items: [{ rubric_dimension: "clarity", reply: "Rewritten in §4." }],
          },
        },
      ],
    });

    const [reply] = data.reviews[0].replies;
    expect(reply.id).toBe("bafyrei-response");
    expect(reply.items[0]).toMatchObject({
      dimension: "clarity",
      label: "Clarity",
      text: "Rewritten in §4.",
    });
  });

  it("does not show a DID as the author's name", () => {
    const data = parseReviews({
      reviews: [
        {
          review_cid: "a",
          responses: [
            {
              reply_cid: "r",
              author: "did:key:z6MkaliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              text: "Fixed.",
            },
          ],
        },
      ],
    });
    expect(data.reviews[0].replies[0].author).toBeNull();
  });
});

describe("parseScores", () => {
  it("accepts a dimension map, a number map and an array", () => {
    expect(parseScores({ soundness: { score: 4 } })[0]).toMatchObject({
      dimension: "soundness",
      score: 4,
    });
    expect(parseScores({ evidence: 3 })[0]).toMatchObject({
      dimension: "evidence",
      score: 3,
    });
    expect(parseScores([{ key: "novelty", value: 2 }])[0]).toMatchObject({
      dimension: "novelty",
      score: 2,
    });
  });

  it("puts the six rubric dimensions in the form's order, extras after", () => {
    const scores = parseScores({
      clarity: 4,
      soundness: 5,
      impact: 2,
      evidence: 3,
    });
    expect(scores.map((score) => score.dimension)).toEqual([
      "soundness",
      "evidence",
      "clarity",
      "impact",
    ]);
  });

  it("drops values outside 1–5", () => {
    expect(parseScores({ soundness: 0, evidence: 6, clarity: "x" })).toEqual([]);
  });
});

describe("labels", () => {
  it("names the six dimensions compactly", () => {
    expect(dimensionLabel("soundness")).toBe("Soundness");
    expect(dimensionLabel("limitations")).toBe("Limitations & ethics");
    expect(dimensionLabel("factual_accuracy")).toBe("Factual accuracy");
  });

  it("reads every recommendation the form and schema agree on", () => {
    expect(recommendationLabel("sound_as_is")).toBe("Sound as is");
    expect(recommendationLabel("minor_revisions")).toBe("Minor revisions");
    expect(recommendationLabel("major_concerns")).toBe("Major concerns");
    expect(recommendationLabel("fundamentally_flawed")).toBe("Fundamentally flawed");
    expect(recommendationLabel("Weak accept")).toBe("Weak accept");
    expect(recommendationLabel(null)).toBe("No recommendation");
  });

  it("sorts recommendations into their tone families", () => {
    expect(recommendationTone("sound_as_is")).toBe("supportive");
    expect(recommendationTone("minor_revisions")).toBe("supportive");
    expect(recommendationTone("major_concerns")).toBe("concerned");
    expect(recommendationTone("fundamentally_flawed")).toBe("rejecting");
    expect(recommendationTone("weak reject")).toBe("rejecting");
    expect(recommendationTone(null)).toBe("neutral");
  });

  it("reads a confidence as words or as the API's 1–5 integer", () => {
    expect(confidenceLabel(1)).toBe("Low");
    expect(confidenceLabel(2)).toBe("Low");
    expect(confidenceLabel(3)).toBe("Medium");
    expect(confidenceLabel(4)).toBe("High");
    expect(confidenceLabel("high")).toBe("High");
    expect(confidenceLabel(null)).toBeNull();
  });

  it("writes reviewer labels A, B, … Z, then numbers", () => {
    expect(reviewerLabelAt(0)).toBe("Reviewer A");
    expect(reviewerLabelAt(25)).toBe("Reviewer Z");
    expect(reviewerLabelAt(26)).toBe("Reviewer 27");
  });
});

describe("scores and dates", () => {
  it("spells a score with the scale, including a half-point median", () => {
    expect(scoreText(4)).toBe("4 of 5");
    expect(scoreText(3.5)).toBe("3.5 of 5");
    // A median is always shown with its decimal, so it cannot be mistaken
    // for one review's integer score.
    expect(medianText(4)).toBe("4.0 of 5");
    expect(medianText(3.5)).toBe("3.5 of 5");
    expect(scoreFraction(4)).toBe(0.8);
    expect(scoreFraction(9)).toBe(1);
  });

  it("writes an anchor date in the design's words", () => {
    expect(formatReviewDate("2027-03-02T04:00:00")).toBe("2 Mar 2027");
    expect(formatReviewDate("2027-03-02")).toBe("2 Mar 2027");
    expect(formatReviewDate("not a date")).toBeNull();
    expect(formatReviewDate(null)).toBeNull();
  });
});

describe("medians", () => {
  it("averages the middle pair for an even count", () => {
    expect(median([4, 3])).toBe(3.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 4, 1, 3])).toBe(3.5);
    expect(median([])).toBeNull();
  });

  it("is the median per dimension across every served score", () => {
    const data = parseReviews(payload());
    const rows = dimensionMedians(data.reviews);

    expect(rows.map((row) => row.dimension)).toEqual([
      "soundness",
      "evidence",
      "reproducibility",
      "novelty",
      "clarity",
      "limitations",
    ]);
    expect(rows.find((row) => row.dimension === "soundness")).toMatchObject({
      label: "Soundness",
      median: 3.5,
      count: 2,
    });
    expect(rows.find((row) => row.dimension === "evidence")).toMatchObject({
      median: 3.5,
      count: 2,
    });
    // One review scored clarity and only one: its score is the median.
    expect(rows.find((row) => row.dimension === "clarity")).toMatchObject({
      median: 5,
      count: 1,
    });
  });

  it("ignores reviews with no served scores", () => {
    const rows = dimensionMedians([
      {
        key: "a",
        reviewCid: "a",
        label: "Reviewer A",
        recommendation: null,
        recommendationLabel: "No recommendation",
        confidenceLabel: null,
        scores: [],
        report: null,
        replies: [],
        committedAt: null,
        version: null,
      },
    ]);
    expect(rows).toEqual([]);
  });
});

describe("emptyReviews", () => {
  it("is the calm empty state for a paper id", () => {
    const data = emptyReviews("sch:k3f9-q2xz-7mwd");
    expect(data.reviews).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.gateOpen).toBe(false);
    expect(data.shortId).toBe("sch:k3f9-q2xz-7mwd");
  });
});

describe("reportGateDate", () => {
  const at = (committedAt: string | null, version: number | null) => ({ committedAt, version });

  it("is 21 days after the first review counted on the version", () => {
    expect(
      reportGateDate([at("2027-03-10T00:00:00", 2), at("2027-03-05T23:30:00", 2)], 2),
    ).toBe("26 Mar 2027");
  });

  it("crosses a month and a year", () => {
    expect(reportGateDate([at("2027-12-20T12:00:00Z", 3)], 3)).toBe("10 Jan 2028");
    expect(reportGateDate([at("2028-02-15T00:00:00", 3)], 3)).toBe("7 Mar 2028");
  });

  it("does not count the earlier versions' reviews a listing merely carries", () => {
    expect(
      reportGateDate([at("2027-01-01T00:00:00", 1), at("2027-03-05T00:00:00", 2)], 2),
    ).toBe("26 Mar 2027");
    expect(reportGateDate([at("2027-01-01T00:00:00", 1)], 2)).toBeNull();
  });

  it("counts a review that names no version, and every review for a listing with no version", () => {
    expect(reportGateDate([at("2027-03-05T00:00:00", null)], 2)).toBe("26 Mar 2027");
    expect(reportGateDate([at("2027-03-05T00:00:00", 1)], null)).toBe("26 Mar 2027");
  });

  it("is null when no counted review has a commit date", () => {
    expect(reportGateDate([], 2)).toBeNull();
    expect(reportGateDate([at(null, 2), at("sometime", 2)], 2)).toBeNull();
  });
});
