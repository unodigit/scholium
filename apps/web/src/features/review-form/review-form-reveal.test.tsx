// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import type { ReviewCommitInput, ReviewCommitResult } from "./commit";
import {
  REVEAL_LABEL,
  REVEALED_HEADLINE,
  type RevealGate,
  type RevealReview,
  type ReviewRevealResult,
} from "./reveal";
import { COMMIT_LABEL, ReviewForm } from "./review-form";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  withDimension,
  type ReviewDraft,
} from "./rubric";
import { saveSealedReview, type SealedReview } from "./sealed-review";

/**
 * The Reveal action on the sealed review card (docs/design.md §5.5).
 *
 * A committed review is sealed until the reveal gate opens (two reviews on the
 * version, or 21 days after the first). The reviewer then reveals it from this
 * page: the action signs the `review.formal` with their per-paper key and
 * posts it to `POST /v1/reviews/reveal`. Before this existed the sealed card
 * had no way to do it, so a web review stayed sealed forever.
 */

const PAPER = "sch:6sel-2dio-orm6";
const COMMITMENT = "a1b2c3";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

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

function result(): ReviewCommitResult {
  return {
    reviewCid: "bafycommitted",
    revealAt: "2026-12-14T00:00:00.000Z",
    revealBody: {
      target: "bafyversion",
      scores: Object.fromEntries(
        RUBRIC_DIMENSIONS.map(({ id }) => [id, { score: 3, justification: "Fine." }]),
      ),
      confidence: "high",
      recommendation: "sound_as_is",
      aiAssisted: false,
    },
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
      commitment: COMMITMENT,
      nullifier: "11",
      reviewKey: "did:key:z6Mkreview",
    },
  };
}

const SEALED: SealedReview = {
  paperId: PAPER,
  versionCid: "bafyversion",
  reviewCid: "bafycommitted",
  revealAt: "2026-12-14T00:00:00.000Z",
  commitment: COMMITMENT,
  revealBody: result().revealBody,
};

const OPEN: RevealGate = { open: true, versionCid: "bafyversion" };
const CLOSED: RevealGate = { open: false, versionCid: "bafyversion" };

function revealResult(): ReviewRevealResult {
  return {
    revealCid: "bafyreveal",
    reviewCid: "bafycommitted",
    body: { target: "bafyversion", commitment: COMMITMENT },
    record: {
      v: 1,
      type: "review.formal",
      id: "bafyreveal",
      author: "did:key:z6Mkreview",
      created: "2026-12-01T00:00:00Z",
      prev: null,
      body: {},
      proofs: [],
      sig: "sig",
    },
  };
}

async function commitFirst(
  options: {
    gate?: RevealGate;
    reveal?: RevealReview;
  } = {},
): Promise<void> {
  render(
    <ReviewForm
      initialDraft={completeDraft()}
      paperId={PAPER}
      versionCid="bafyversion"
      commit={vi.fn(async (_input: ReviewCommitInput) => result())}
      reveal={options.reveal ?? vi.fn<RevealReview>(async () => revealResult())}
      loadGate={vi.fn(async () => options.gate ?? OPEN)}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
  await screen.findByRole("heading", { name: "Your review is sealed" });
}

describe("Reveal review", () => {
  it("offers the action once the gate is open, signs and posts, then says it is revealed", async () => {
    const reveal = vi.fn<RevealReview>(async () => revealResult());
    await commitFirst({ gate: OPEN, reveal });

    fireEvent.click(await screen.findByRole("button", { name: REVEAL_LABEL }));

    expect(await screen.findByRole("heading", { name: REVEALED_HEADLINE })).toBeTruthy();
    expect(reveal).toHaveBeenCalledTimes(1);
    const input = (reveal.mock.calls[0] as unknown[])[0] as {
      sealed: SealedReview;
    };
    // The reveal signs exactly the content the commit sealed.
    expect(input.sealed).toMatchObject({
      paperId: PAPER,
      versionCid: "bafyversion",
      commitment: COMMITMENT,
      revealBody: result().revealBody,
    });
  });

  it("keeps the sealed card and says nothing was sent when the API refuses", async () => {
    const reveal = vi.fn<RevealReview>(async () => {
      throw new ApiError(409, {
        detail:
          "The report gate is still closed for this version: a review may be revealed only once two independent reviews have been committed on it (this version has 1).",
      });
    });
    await commitFirst({ gate: OPEN, reveal });

    fireEvent.click(await screen.findByRole("button", { name: REVEAL_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("report gate is still closed");
    expect(alert.textContent).toContain("Nothing was sent.");
    // Still sealed, and still able to try again.
    expect(screen.getByRole("button", { name: REVEAL_LABEL })).toBeTruthy();
  });

  it("does not sign while the gate is closed, and says why", async () => {
    const reveal = vi.fn<RevealReview>(async () => revealResult());
    await commitFirst({ gate: CLOSED, reveal });

    fireEvent.click(await screen.findByRole("button", { name: REVEAL_LABEL }));

    expect(await screen.findByText(/report gate is still closed/)).toBeTruthy();
    // No passkey prompt is spent on a reveal the API would refuse.
    expect(reveal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: REVEAL_LABEL })).toBeTruthy();
  });

  it("reveals once the gate opens, without reopening the page", async () => {
    let gate: RevealGate = CLOSED;
    const reveal = vi.fn<RevealReview>(async () => revealResult());
    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId={PAPER}
        versionCid="bafyversion"
        commit={vi.fn(async (_input: ReviewCommitInput) => result())}
        reveal={reveal}
        loadGate={vi.fn(async () => gate)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("button", { name: REVEAL_LABEL });

    // The gate is still shut: the action says so and signs nothing.
    fireEvent.click(screen.getByRole("button", { name: REVEAL_LABEL }));
    await screen.findByText(/report gate is still closed/);
    expect(reveal).not.toHaveBeenCalled();

    // The second review is committed elsewhere; the same action now works.
    gate = OPEN;
    fireEvent.click(screen.getByRole("button", { name: REVEAL_LABEL }));

    expect(await screen.findByRole("heading", { name: REVEALED_HEADLINE })).toBeTruthy();
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("shows the sealed state on a return to the page, from what was kept locally", async () => {
    saveSealedReview(SEALED);

    render(<ReviewForm paperId={PAPER} versionCid="bafyversion" loadGate={vi.fn(async () => OPEN)} />);

    expect(
      await screen.findByRole("heading", { name: "Your review is sealed" }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: REVEAL_LABEL })).toBeTruthy();
    // The blank form is gone: there is nothing to write a second time.
    expect(screen.queryByRole("button", { name: COMMIT_LABEL })).toBeNull();
  });

  it("reveals a review kept locally, so a return to the page can open it", async () => {
    saveSealedReview(SEALED);
    const reveal = vi.fn<RevealReview>(async () => revealResult());

    render(
      <ReviewForm
        paperId={PAPER}
        versionCid="bafyversion"
        reveal={reveal}
        loadGate={vi.fn(async () => OPEN)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: REVEAL_LABEL }));

    expect(await screen.findByRole("heading", { name: REVEALED_HEADLINE })).toBeTruthy();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect((reveal.mock.calls[0] as unknown[])[0]).toMatchObject({ sealed: SEALED });
  });

  it("forgets the sealed review once it is revealed, so the page does not offer it again", async () => {
    saveSealedReview(SEALED);

    render(
      <ReviewForm
        paperId={PAPER}
        versionCid="bafyversion"
        reveal={vi.fn<RevealReview>(async () => revealResult())}
        loadGate={vi.fn(async () => OPEN)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: REVEAL_LABEL }));
    await screen.findByRole("heading", { name: REVEALED_HEADLINE });

    await waitFor(() =>
      expect(
        window.localStorage.getItem("scholium.sealed-review.v1:" + PAPER),
      ).toBeNull(),
    );
  });
});
