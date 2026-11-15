import { describe, expect, it } from "vitest";

import { NetworkError, apiErrorFrom } from "../../lib/api";

import {
  NO_AI_REVIEW_YET,
  SIGNED_OUT_TO_ANSWER,
  aiReviewsPath,
  classifyAiActionError,
  classifyAiReportError,
  loadAiReport,
  postAssessment,
  postRebuttal,
  type AiClient,
} from "./ai-api";
import { ADVISORY_BANNER, type AiReport } from "./ai-report";

/**
 * The two endpoints this feature calls, and what the tab says when they
 * refuse. The paths and bodies are pinned against
 * `apps/api/.../ai_review/router.py`; the messages against the calm-under-
 * failure rule (docs/design.md §1: an inability to read is a state, not an
 * error) and the API's own plain-language details.
 */

/** A client that answers from a script of `(method, path)` → result. */
function clientOf(
  script: Record<string, unknown | Error>,
): AiClient & {
  calls: Array<{ method: string; path: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; path: string; args: unknown[] }> = [];
  const record = (method: string) => (path: string, ...rest: unknown[]) => {
    const entry = script[`${method} ${path}`];
    calls.push({ method, path, args: rest });
    if (entry instanceof Error) {
      return Promise.reject(entry);
    }
    return Promise.resolve(entry);
  };
  return {
    get: record("GET") as AiClient["get"],
    post: record("POST") as AiClient["post"],
    calls,
  };
}

const REPORT = { advisory: true, label: ADVISORY_BANNER, agents: [], reviewCid: "bafy…k" };

describe("aiReviewsPath", () => {
  it("reads a paper by any spelling the catalog accepts", () => {
    expect(aiReviewsPath("sch:k3f9-q2xz-7mwd")).toBe(
      "/papers/sch%3Ak3f9-q2xz-7mwd/ai-reviews",
    );
    expect(aiReviewsPath("k3f9-q2xz-7mwd")).toBe("/papers/k3f9-q2xz-7mwd/ai-reviews");
  });

  it("a version id uses the version's own route, not a slash inside the id", () => {
    expect(aiReviewsPath("sch:k3f9-q2xz-7mwd/v2")).toBe(
      "/papers/sch%3Ak3f9-q2xz-7mwd/v2/ai-reviews",
    );
    expect(aiReviewsPath("k3f9-q2xz-7mwd/v12")).toBe(
      "/papers/k3f9-q2xz-7mwd/v12/ai-reviews",
    );
  });
});

describe("loadAiReport", () => {
  it("GETs the report's path anonymously and uncached, and parses the payload", async () => {
    const client = clientOf({ "GET /papers/sch%3Ak3f9-q2xz-7mwd/ai-reviews": REPORT });

    const report: AiReport = await loadAiReport("sch:k3f9-q2xz-7mwd", { client });

    expect(client.calls).toEqual([
      {
        method: "GET",
        path: "/papers/sch%3Ak3f9-q2xz-7mwd/ai-reviews",
        args: [expect.objectContaining({ auth: false, cache: "no-store" })],
      },
    ]);
    expect(report.reviewCid).toBe("bafy…k");
  });
});

describe("classifyAiReportError", () => {
  it("a 404 is the calm missing state, whatever its detail says", () => {
    for (const detail of [
      "No listed paper 'sch:…' is on this node.",
      "No AI pre-review for 'sch:…' yet.",
    ]) {
      expect(classifyAiReportError(apiErrorFrom(404, { detail }))).toEqual(NO_AI_REVIEW_YET);
    }
  });

  it("transport and server failures stay retryable errors with plain words", () => {
    expect(classifyAiReportError(new NetworkError("http://x"))).toMatchObject({
      kind: "error",
      message: expect.stringContaining("could not reach the API"),
    });
    expect(
      classifyAiReportError(apiErrorFrom(503, { detail: "upgrading" })),
    ).toMatchObject({ kind: "error", message: "upgrading" });
  });
});

describe("the answer endpoints", () => {
  const target = { reviewCid: "bafyrei-test", findingId: "3" };

  it("a rebuttal posts the finding id and the author's text", async () => {
    const client = clientOf({ "POST /ai-reviews/bafyrei-test/rebuttal": { status: "created" } });

    await postRebuttal(target, "The weights ship in the bundle.", client);

    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/ai-reviews/bafyrei-test/rebuttal",
    });
    expect(client.calls[0].args[0]).toEqual({
      finding_id: "3",
      text: "The weights ship in the bundle.",
    });
  });

  it("an assessment posts the finding id and the verdict", async () => {
    const client = clientOf({ "POST /ai-reviews/bafyrei-test/assessments": { verdict: "wrong" } });

    await postAssessment(target, "wrong", client);

    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/ai-reviews/bafyrei-test/assessments",
    });
    expect(client.calls[0].args[0]).toEqual({ finding_id: "3", verdict: "wrong" });
  });
});

describe("classifyAiActionError", () => {
  it("a 401 asks for a sign-in", () => {
    const failure = classifyAiActionError(apiErrorFrom(401, { detail: "not authenticated" }));
    expect(failure).toMatchObject({
      kind: "signed-out",
      message: expect.stringContaining("Sign in again"),
    });
  });

  it("a 403 repeats the API's own words: they are the rule", () => {
    const failure = classifyAiActionError(
      apiErrorFrom(403, { detail: "Only a paper author may rebut an AI finding." }),
    );
    expect(failure).toEqual({
      kind: "forbidden",
      message: "Only a paper author may rebut an AI finding.",
    });
  });

  it("a 422 shows the field the API names", () => {
    const failure = classifyAiActionError(apiErrorFrom(422, { detail: "text is required" }));
    expect(failure).toEqual({ kind: "invalid", message: "text is required" });
  });

  it("transport failures say so; the signed-out copy is available for the tab", () => {
    expect(classifyAiActionError(new NetworkError("http://x")).kind).toBe("error");
    expect(SIGNED_OUT_TO_ANSWER.message).toContain("Sign in");
  });

  it("an ApiError without a detail still gets words", () => {
    const failure = classifyAiActionError(apiErrorFrom(500, undefined));
    expect(failure.kind).toBe("error");
    expect(failure.message.length).toBeGreaterThan(0);
  });
});
