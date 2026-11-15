// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import type { ReviewCommitInput, ReviewCommitResult } from "./commit";
import { COMMIT_LABEL, ReviewForm } from "./review-form";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  withDimension,
  type ReviewDraft,
} from "./rubric";

afterEach(cleanup);

function completeDraft(): ReviewDraft {
  return RUBRIC_DIMENSIONS.reduce(
    (current, { id }) =>
      withDimension(current, id, { score: 3, justification: "Fine." }),
    {
      ...emptyDraft(),
      confidence: "high",
      recommendation: "sound_as_is",
    } as ReviewDraft,
  );
}

function result(revealAt = "2026-12-14T00:00:00.000Z"): ReviewCommitResult {
  return {
    reviewCid: "bafycommitted",
    revealAt,
    record: {
      v: 1,
      type: "review.commit",
      id: "bafycommitted",
      author: "did:key:z6Mkreview",
      created: "2026-11-23T00:00:00Z",
      prev: null,
      body: {},
      proofs: [],
      sig: "sig",
    },
    body: {
      target: "bafyversion",
      commitment: "00",
      nullifier: "11",
      reviewKey: "did:key:z6Mkreview",
    },
  };
}

describe("ReviewForm commit", () => {
  it("offers Commit review beneath the rubric", () => {
    render(<ReviewForm />);

    expect(screen.getByRole("button", { name: COMMIT_LABEL })).toBeTruthy();
    expect(COMMIT_LABEL).toBe("Commit review");
  });

  it("signs and submits the finished review, then says it is sealed with the reveal date", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput) => result());

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        commit={commit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));

    const sealed = await screen.findByRole("heading", {
      name: "Your review is sealed",
    });
    expect(sealed).toBeTruthy();
    expect(screen.getByText(/It will be revealed with the others/)).toBeTruthy();

    const date = screen.getByText("14 Dec");
    expect(date.tagName).toBe("TIME");
    expect(date.getAttribute("dateTime")).toBe("2026-12-14T00:00:00.000Z");

    expect(commit).toHaveBeenCalledTimes(1);
    const input = commit.mock.calls[0][0];
    expect(input.paperId).toBe("sch:6sel-2dio-orm6");
    expect(input.versionCid).toBe("bafyversion");
    expect(input.draft.confidence).toBe("high");
  });

  it("replaces the form once sealed, so it cannot be committed twice", async () => {
    const commit = vi.fn(async () => result());

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:abc"
        versionCid="bafyversion"
        commit={commit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { name: COMMIT_LABEL })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("shows what the reviewer must still fill in before signing", () => {
    const commit = vi.fn();

    render(<ReviewForm commit={commit} paperId="sch:abc" versionCid="bafy" />);

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));

    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByText("Choose how confident you are.")).toBeTruthy();
    expect(screen.getByText("Choose a recommendation.")).toBeTruthy();
    // Every dimension is flagged at once, not only the one last visited.
    expect(screen.getAllByText(/Add a justification/)).toHaveLength(6);
  });

  it("keeps the draft and says nothing was sent when the API refuses", async () => {
    const commit = vi.fn(async () => {
      throw new ApiError(409, { detail: "You have already reviewed this paper." });
    });

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:abc"
        versionCid="bafyversion"
        commit={commit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You have already reviewed this paper.");
    // The form is still here, with the draft in it.
    expect(screen.getByRole("form", { name: "Your review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: COMMIT_LABEL })).toBeTruthy();
  });

  it("asks a signed-out reviewer to sign in without calling the API", () => {
    const commit = vi.fn();

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        signedIn={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));

    expect(commit).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Sign in to commit your review/);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Freview%2Fsch%3A6sel-2dio-orm6",
    );
  });

  it("disables the button while signing", async () => {
    let release: (value: ReviewCommitResult) => void = () => undefined;
    const commit = vi.fn(
      () => new Promise<ReviewCommitResult>((resolve) => {
        release = resolve;
      }),
    );

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:abc"
        versionCid="bafyversion"
        commit={commit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));

    const signing = screen.getByRole("button", { name: "Signing…" });
    expect((signing as HTMLButtonElement).disabled).toBe(true);

    release(result());
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Your review is sealed" }),
      ).toBeTruthy(),
    );
  });
});
