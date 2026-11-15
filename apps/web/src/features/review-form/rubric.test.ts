import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_OPTIONS,
  IncompleteReviewError,
  RECOMMENDATION_OPTIONS,
  RUBRIC_DIMENSIONS,
  SCORES,
  describeProgress,
  emptyDraft,
  isComplete,
  isDimensionComplete,
  progressOf,
  toReviewBody,
  validateDraft,
  withDimension,
  type DimensionId,
  type ReviewDraft,
} from "./rubric";

const here = dirname(fileURLToPath(import.meta.url));

/** The record schema the API validates a revealed review against. */
const schema = JSON.parse(
  readFileSync(
    join(
      here,
      "../../../../api/packages/record-core/schemas/review.formal.json",
    ),
    "utf8",
  ),
) as {
  properties: {
    scores: { required: string[] };
    confidence: { anyOf: { enum?: string[] }[] };
    recommendation: { enum: string[] };
  };
};

/** A draft with everything filled in. */
function completeDraft(): ReviewDraft {
  let draft: ReviewDraft = {
    ...emptyDraft(),
    confidence: "medium",
    recommendation: "minor_revisions",
  };
  for (const { id } of RUBRIC_DIMENSIONS) {
    draft = withDimension(draft, id, { score: 4, justification: `Because ${id}.` });
  }
  return draft;
}

describe("the rubric", () => {
  it("has the six dimensions, in the design's order and words", () => {
    expect(RUBRIC_DIMENSIONS.map(({ label }) => label)).toEqual([
      "Soundness of method",
      "Evidence for claims",
      "Reproducibility",
      "Novelty",
      "Clarity",
      "Limitations & ethics",
    ]);
  });

  it("uses exactly the score keys the record schema requires", () => {
    expect(RUBRIC_DIMENSIONS.map(({ id }) => id).sort()).toEqual(
      [...schema.properties.scores.required].sort(),
    );
  });

  it("scores from 1 to 5", () => {
    expect(SCORES).toEqual([1, 2, 3, 4, 5]);
  });

  it("offers Low, Medium and High confidence, spelled as the schema spells them", () => {
    expect(CONFIDENCE_OPTIONS.map(({ label }) => label)).toEqual([
      "Low",
      "Medium",
      "High",
    ]);
    const allowed = schema.properties.confidence.anyOf.flatMap(
      ({ enum: values }) => values ?? [],
    );
    for (const { value } of CONFIDENCE_OPTIONS) {
      expect(allowed).toContain(value);
    }
  });

  it("offers the four recommendations, spelled as the schema spells them", () => {
    expect(RECOMMENDATION_OPTIONS.map(({ label }) => label)).toEqual([
      "Sound as is",
      "Minor revisions",
      "Major concerns",
      "Fundamentally flawed",
    ]);
    for (const { value } of RECOMMENDATION_OPTIONS) {
      expect(schema.properties.recommendation.enum).toContain(value);
    }
  });
});

describe("emptyDraft", () => {
  it("chooses nothing for the reviewer", () => {
    const draft = emptyDraft();

    expect(draft.confidence).toBeNull();
    expect(draft.recommendation).toBeNull();
    expect(draft.aiAssisted).toBe(false);
    for (const { id } of RUBRIC_DIMENSIONS) {
      expect(draft.scores[id]).toEqual({ score: null, justification: "" });
    }
  });

  it("returns a fresh draft each time", () => {
    expect(emptyDraft()).not.toBe(emptyDraft());
    expect(emptyDraft().scores).not.toBe(emptyDraft().scores);
  });
});

describe("withDimension", () => {
  it("changes one dimension and leaves the original and the others alone", () => {
    const before = emptyDraft();
    const after = withDimension(before, "novelty", { score: 5 });

    expect(after.scores.novelty).toEqual({ score: 5, justification: "" });
    expect(before.scores.novelty.score).toBeNull();
    expect(after.scores.clarity).toBe(before.scores.clarity);
  });

  it("keeps the other field of the dimension it changes", () => {
    const draft = withDimension(
      withDimension(emptyDraft(), "clarity", { score: 2 }),
      "clarity",
      { justification: "Dense." },
    );
    expect(draft.scores.clarity).toEqual({ score: 2, justification: "Dense." });
  });
});

describe("validateDraft", () => {
  it("flags every dimension, the confidence and the recommendation on a blank draft", () => {
    const problems = validateDraft(emptyDraft());

    expect(Object.keys(problems.scores)).toHaveLength(6);
    expect(problems.scores.soundness).toEqual({
      score: "Choose a score from 1 to 5 for Soundness of method.",
      justification: "Add a justification for Soundness of method.",
    });
    expect(problems.confidence).toBe("Choose how confident you are.");
    expect(problems.recommendation).toBe("Choose a recommendation.");
    expect(isComplete(problems)).toBe(false);
  });

  it("requires a justification even when the score is chosen", () => {
    const draft = withDimension(emptyDraft(), "evidence", { score: 3 });
    expect(validateDraft(draft).scores.evidence).toEqual({
      justification: "Add a justification for Evidence for claims.",
    });
  });

  it("requires a score even when the justification is written", () => {
    const draft = withDimension(emptyDraft(), "evidence", {
      justification: "Thin.",
    });
    expect(validateDraft(draft).scores.evidence).toEqual({
      score: "Choose a score from 1 to 5 for Evidence for claims.",
    });
  });

  it("does not count whitespace as a justification", () => {
    const draft = withDimension(emptyDraft(), "clarity", {
      score: 4,
      justification: "  \n\t ",
    });
    expect(validateDraft(draft).scores.clarity?.justification).toBeDefined();
    expect(isDimensionComplete(draft.scores.clarity)).toBe(false);
  });

  it("finds nothing wrong with a complete draft", () => {
    const problems = validateDraft(completeDraft());

    expect(problems).toEqual({ scores: {} });
    expect(isComplete(problems)).toBe(true);
  });

  it("is not complete while only the confidence is missing", () => {
    const draft: ReviewDraft = { ...completeDraft(), confidence: null };
    expect(isComplete(validateDraft(draft))).toBe(false);
  });

  it("does not require the AI declaration: leaving it unticked is an answer", () => {
    expect(completeDraft().aiAssisted).toBe(false);
    expect(isComplete(validateDraft(completeDraft()))).toBe(true);
  });
});

describe("progress", () => {
  it("counts a dimension only when it has a score and a justification", () => {
    let draft = withDimension(emptyDraft(), "soundness", { score: 4 });
    expect(progressOf(draft).dimensionsDone).toBe(0);

    draft = withDimension(draft, "soundness", { justification: "Sound." });
    draft = withDimension(draft, "novelty", { justification: "Not new." });
    expect(progressOf(draft).dimensionsDone).toBe(1);
    expect(progressOf(draft).dimensionsTotal).toBe(6);
  });

  it("says what is still missing", () => {
    expect(describeProgress(progressOf(emptyDraft()))).toBe(
      "0 of 6 rubric dimensions complete · still needed: confidence and recommendation",
    );

    const draft: ReviewDraft = { ...emptyDraft(), confidence: "high" };
    expect(describeProgress(progressOf(draft))).toBe(
      "0 of 6 rubric dimensions complete · still needed: recommendation",
    );
  });

  it("says so when everything is filled in", () => {
    expect(describeProgress(progressOf(completeDraft()))).toBe(
      "Every part of the review is filled in.",
    );
  });

  it("does not call a review finished while a dimension is open", () => {
    const draft = withDimension(completeDraft(), "clarity", { justification: "" });
    expect(describeProgress(progressOf(draft))).toBe(
      "5 of 6 rubric dimensions complete",
    );
  });
});

describe("toReviewBody", () => {
  it("builds the review.formal body: scores with justifications, confidence, recommendation", () => {
    const body = toReviewBody({
      ...completeDraft(),
      aiAssisted: true,
    });

    expect(Object.keys(body.scores).sort()).toEqual(
      [...schema.properties.scores.required].sort(),
    );
    for (const { id } of RUBRIC_DIMENSIONS) {
      expect(body.scores[id]).toEqual({
        score: 4,
        justification: `Because ${id}.`,
      });
    }
    expect(body.confidence).toBe("medium");
    expect(body.recommendation).toBe("minor_revisions");
    expect(body.aiAssisted).toBe(true);
  });

  it("trims the justification it sends", () => {
    const draft = withDimension(completeDraft(), "novelty", {
      justification: "  Padded.  ",
    });
    expect(toReviewBody(draft).scores.novelty.justification).toBe("Padded.");
  });

  it("refuses a draft that is not complete, and says what is wrong", () => {
    const draft = withDimension(completeDraft(), "limitations", {
      justification: "",
    });

    let caught: unknown;
    try {
      toReviewBody(draft);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IncompleteReviewError);
    const problems = (caught as IncompleteReviewError).problems;
    expect(Object.keys(problems.scores)).toEqual(["limitations" satisfies DimensionId]);
  });

  it("refuses a draft with scores but no verdict", () => {
    expect(() =>
      toReviewBody({ ...completeDraft(), recommendation: null }),
    ).toThrow(IncompleteReviewError);
  });

  it("never produces a review from a blank draft", () => {
    expect(() => toReviewBody(emptyDraft())).toThrow(IncompleteReviewError);
  });
});
