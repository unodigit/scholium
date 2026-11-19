// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, tokenStore } from "../../lib/api";
import { parseReviews } from "../paper-reviews/review";
import { ReviewCardActions, type ReviewCardTarget } from "./review-actions";
import type { RatingResult, RateReview } from "./rating";
import { REPLY_POINTS, type ReplyResult, type RespondToReview } from "./reply";
import type { Viewer } from "./viewer";

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.unstubAllGlobals();
});

const PAPER = "sch:6sel-2dio-orm6";
const AUTHOR = "did:key:z6MkAuthor";
const MEMBER = "did:key:z6MkMember";

const AUTHOR_VIEWER: Viewer = { signedIn: true, did: AUTHOR, tier: 2 };
const MEMBER_VIEWER: Viewer = { signedIn: true, did: MEMBER, tier: 3 };
const SIGNED_OUT_VIEWER: Viewer = { signedIn: false, did: null, tier: null };

const REVEALED: ReviewCardTarget = {
  reviewCid: "bafyreireviewcommit",
  label: "Reviewer A",
  report: "The adversarial baseline is unclear.",
  scores: [
    { dimension: "soundness", score: 4 },
    { dimension: "evidence", score: 3 },
  ],
};

const SEALED: ReviewCardTarget = { ...REVEALED, report: null };

const byline = async (): Promise<readonly string[]> => [AUTHOR, "did:key:z6MkSecond"];

function replyResult(): ReplyResult {
  return {
    responseCid: "bafyreiresponse",
    body: {
      review: "bafyreireviewcommit",
      items: [
        { dimension: "soundness", reply: "The proof is in Appendix B." },
        { dimension: "general", reply: "Thank you for the careful read." },
      ],
    },
    record: {
      v: 1,
      type: "review.response",
      id: "bafyreiresponse",
      author: AUTHOR,
      created: "2026-11-16T00:00:00Z",
      prev: null,
      body: {},
      proofs: [],
      sig: "sig",
    },
  };
}

/** The reply box for one point, found by its label. */
function box(label: string): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement;
}

function type(label: string, text: string): void {
  fireEvent.change(box(label), { target: { value: text } });
}

describe("ReviewCardActions: who is offered what", () => {
  it("offers nothing on a review that is still sealed", () => {
    const { container } = render(
      <ReviewCardActions review={SEALED} paperId={PAPER} viewer={AUTHOR_VIEWER} authorDids={[AUTHOR]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("offers nothing on a review with no cid to name", () => {
    const { container } = render(
      <ReviewCardActions
        review={{ ...REVEALED, reviewCid: null }}
        paperId={PAPER}
        viewer={AUTHOR_VIEWER}
        authorDids={[AUTHOR]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("offers nothing to a signed-out reader, and does not read the byline for them", () => {
    const loadAuthors = vi.fn(byline);

    const { container } = render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={SIGNED_OUT_VIEWER}
        loadAuthors={loadAuthors}
      />,
    );

    expect(container.innerHTML).toBe("");
    expect(loadAuthors).not.toHaveBeenCalled();
  });

  it("offers an author the reply form and not the rating", async () => {
    render(
      <ReviewCardActions review={REVEALED} paperId={PAPER} viewer={AUTHOR_VIEWER} loadAuthors={byline} />,
    );

    expect(await screen.findByText("Reply point by point")).toBeTruthy();
    expect(screen.queryByText("Rate this review’s quality")).toBeNull();
  });

  it("offers a tier-3 member who is not an author the rating and not the reply form", async () => {
    render(
      <ReviewCardActions review={REVEALED} paperId={PAPER} viewer={MEMBER_VIEWER} loadAuthors={byline} />,
    );

    expect(await screen.findByText("Rate this review’s quality")).toBeTruthy();
    expect(screen.queryByText("Reply point by point")).toBeNull();
  });

  it("offers an author who is also tier 3 only the reply form: the API refuses authors the rating", async () => {
    render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={{ signedIn: true, did: AUTHOR, tier: 3 }}
        loadAuthors={byline}
      />,
    );

    expect(await screen.findByText("Reply point by point")).toBeTruthy();
    expect(screen.queryByText("Rate this review’s quality")).toBeNull();
  });

  it("offers nothing to a signed-in member below tier 3 who is not an author", async () => {
    const loadAuthors = vi.fn(byline);
    const { container } = render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={{ signedIn: true, did: MEMBER, tier: 1 }}
        loadAuthors={loadAuthors}
      />,
    );

    await waitFor(() => expect(loadAuthors).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing while the byline is being read, so a control never flickers away", async () => {
    let resolve: (dids: readonly string[]) => void = () => {};
    const loadAuthors = () =>
      new Promise<readonly string[]>((done) => {
        resolve = done;
      });
    const { container } = render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={{ signedIn: true, did: AUTHOR, tier: 3 }}
        loadAuthors={loadAuthors}
      />,
    );

    // A tier-3 member could rate; the byline is not back, so the rating is not
    // put up only to be taken down when the viewer turns out to be an author.
    expect(container.innerHTML).toBe("");

    await act(async () => resolve([AUTHOR]));

    expect(await screen.findByText("Reply point by point")).toBeTruthy();
    expect(screen.queryByText("Rate this review’s quality")).toBeNull();
  });

  it("still offers a tier-3 member the rating when the byline cannot be read", async () => {
    render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={MEMBER_VIEWER}
        loadAuthors={async () => {
          throw new Error("offline");
        }}
      />,
    );

    expect(await screen.findByText("Rate this review’s quality")).toBeTruthy();
  });

  it("keeps the reply form out of the way when the byline cannot be read", async () => {
    const loadAuthors = vi.fn(async () => {
      throw new Error("offline");
    });
    const { container } = render(
      <ReviewCardActions review={REVEALED} paperId={PAPER} viewer={AUTHOR_VIEWER} loadAuthors={loadAuthors} />,
    );

    await waitFor(() => expect(loadAuthors).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("skips the byline read when the host already has the authors", async () => {
    const loadAuthors = vi.fn(byline);

    render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={AUTHOR_VIEWER}
        authorDids={[AUTHOR]}
        loadAuthors={loadAuthors}
      />,
    );

    expect(screen.getByText("Reply point by point")).toBeTruthy();
    expect(loadAuthors).not.toHaveBeenCalled();
  });

  it("does not restart the byline read when the host passes a new loader on each render", async () => {
    const calls = vi.fn();
    const { rerender } = render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={AUTHOR_VIEWER}
        loadAuthors={async () => {
          calls();
          return [AUTHOR];
        }}
      />,
    );
    await screen.findByText("Reply point by point");

    rerender(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={AUTHOR_VIEWER}
        loadAuthors={async () => {
          calls();
          return [AUTHOR];
        }}
      />,
    );
    await act(async () => {});

    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("labels the section with the review it belongs to", async () => {
    render(
      <ReviewCardActions review={REVEALED} paperId={PAPER} viewer={AUTHOR_VIEWER} authorDids={[AUTHOR]} />,
    );

    expect(screen.getByRole("region", { name: "Your response to Reviewer A" })).toBeTruthy();
  });
});

describe("ReviewCardActions: the viewer from the signed-in session", () => {
  /** An unsigned JWT: the card only reads its claims. */
  function sessionToken(claims: unknown): string {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "HS256" })}.${encode(claims)}.sig`;
  }

  it("is signed out, and offers nothing, with no session", () => {
    const { container } = render(
      <ReviewCardActions review={REVEALED} paperId={PAPER} loadAuthors={byline} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("reads the DID and tier from the stored access token", async () => {
    tokenStore.set({ accessToken: sessionToken({ sub: AUTHOR, tier: 2 }) });

    render(<ReviewCardActions review={REVEALED} paperId={PAPER} loadAuthors={byline} />);

    expect(await screen.findByText("Reply point by point")).toBeTruthy();
  });

  it("follows a sign-in that happens while the card is on the page", async () => {
    render(<ReviewCardActions review={REVEALED} paperId={PAPER} loadAuthors={byline} />);
    expect(screen.queryByText("Rate this review’s quality")).toBeNull();

    act(() => {
      tokenStore.set({ accessToken: sessionToken({ sub: MEMBER, tier: 3 }) });
    });

    expect(await screen.findByText("Rate this review’s quality")).toBeTruthy();
  });

  it("makes one request for the byline however many cards ask at once", async () => {
    tokenStore.set({ accessToken: sessionToken({ sub: AUTHOR, tier: 2 }) });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ authors: [{ did: AUTHOR }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <>
        <ReviewCardActions review={REVEALED} paperId={PAPER} />
        <ReviewCardActions review={{ ...REVEALED, reviewCid: "bafyreitwo", label: "Reviewer B" }} paperId={PAPER} />
        <ReviewCardActions review={{ ...REVEALED, reviewCid: "bafyreithree", label: "Reviewer C" }} paperId={PAPER} />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText("Reply point by point")).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toMatch(/\/v1\/papers\/sch%3A6sel-2dio-orm6$/);
  });
});

describe("the reply form", () => {
  async function renderReply(
    respond: RespondToReview,
    extra: Partial<React.ComponentProps<typeof ReviewCardActions>> = {},
  ) {
    render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={AUTHOR_VIEWER}
        authorDids={[AUTHOR]}
        respond={respond}
        {...extra}
      />,
    );
  }

  it("opens from an expander and has a labelled box for each rubric dimension and a general reply", async () => {
    await renderReply(vi.fn());

    const summary = screen.getByText("Reply point by point");
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);

    for (const { label } of REPLY_POINTS) {
      expect(box(label).value).toBe("");
    }
    expect(screen.getAllByRole("textbox")).toHaveLength(7);
  });

  it("starts with nothing answered and says so", async () => {
    await renderReply(vi.fn());

    expect(screen.getByRole("status").textContent).toMatch(/Answer at least one point/);
  });

  it("shows what the reviewer scored beside the point being answered", async () => {
    await renderReply(vi.fn());

    expect(box("Soundness").getAttribute("aria-describedby")).toContain("soundness-context");
    expect(screen.getByText("Reviewer scored 4 of 5")).toBeTruthy();
    expect(screen.getByText("Reviewer scored 3 of 5")).toBeTruthy();
    // No score for a point the reviewer was not shown to score.
    expect(screen.getAllByText(/Reviewer scored/)).toHaveLength(2);
  });

  it("says where the key lives, in the design's words, beside Sign and submit", async () => {
    await renderReply(vi.fn());

    expect(
      screen.getByText("You’re signing with your passkey. Scholium never sees your key."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign and submit" })).toBeTruthy();
  });

  it("counts the points as they are answered", async () => {
    await renderReply(vi.fn());

    type("Evidence", "See Table 2.");
    expect(screen.getByRole("status").textContent).toBe(
      "1 of 7 points answered. Points you leave blank are not sent.",
    );
    type("Clarity", "Reworded.");
    expect(screen.getByRole("status").textContent).toMatch(/^2 of 7 points answered/);
  });

  it("does not sign or send an empty reply, and says what is missing", async () => {
    const respond = vi.fn<RespondToReview>();
    await renderReply(respond);

    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Write a reply to at least one point before sending.");
    expect(respond).not.toHaveBeenCalled();
    // The message is tied to the boxes it is about.
    expect(box("Soundness").getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("signs and sends the answered points, then shows what was sent", async () => {
    const respond = vi.fn<RespondToReview>(async () => replyResult());
    const onResponded = vi.fn();
    await renderReply(respond, { onResponded });

    type("Soundness", "The proof is in Appendix B.");
    type("General reply", "Thank you for the careful read.");
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));

    const sent = await screen.findByText("Reply sent to Reviewer A");
    expect(sent).toBeTruthy();

    expect(respond).toHaveBeenCalledTimes(1);
    const [input] = respond.mock.calls[0] as unknown as [
      { reviewCid: string; draft: Record<string, string> },
    ];
    expect(input.reviewCid).toBe("bafyreireviewcommit");
    expect(input.draft.soundness).toBe("The proof is in Appendix B.");
    expect(input.draft.general).toBe("Thank you for the careful read.");
    expect(input.draft.evidence).toBe("");

    // What was sent is shown back, labelled the way the card labels it.
    const status = screen.getByRole("status");
    expect(within(status).getByText("The proof is in Appendix B.")).toBeTruthy();
    expect(within(status).getByText("Soundness")).toBeTruthy();
    expect(within(status).getByText("General reply")).toBeTruthy();
    expect(within(status).getByText("Thank you for the careful read.")).toBeTruthy();

    // The form is gone: a reply is sent once, not edited in place.
    expect(screen.queryByRole("button", { name: "Sign and submit" })).toBeNull();
    expect(onResponded).toHaveBeenCalledWith(replyResult());
  });

  it("is busy and locked while the passkey prompt is open, and ignores a second press", async () => {
    let finish: (value: ReplyResult) => void = () => {};
    const respond = vi.fn<RespondToReview>(
      () =>
        new Promise<ReplyResult>((done) => {
          finish = done;
        }),
    );
    await renderReply(respond);

    type("Clarity", "Reworded.");
    const button = screen.getByRole("button", { name: "Sign and submit" });
    fireEvent.click(button);

    const busy = await screen.findByRole("button", { name: "Signing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(box("Clarity").disabled).toBe(true);
    fireEvent.click(busy);
    fireEvent.submit(busy.closest("form") as HTMLFormElement);
    expect(respond).toHaveBeenCalledTimes(1);

    await act(async () => finish(replyResult()));
    expect(await screen.findByText("Reply sent to Reviewer A")).toBeTruthy();
  });

  it("keeps the draft and says nothing was sent when the API refuses", async () => {
    const respond = vi.fn<RespondToReview>(async () => {
      throw new ApiError(403, { detail: "Only a paper author may answer its reviews" });
    });
    await renderReply(respond);

    type("Novelty", "Prior work differs in X.");
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Only a paper author may answer its reviews. Nothing was sent.");
    // Still editable, draft intact, and Sign and submit is available again.
    expect(box("Novelty").value).toBe("Prior work differs in X.");
    expect(box("Novelty").disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Sign and submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText("Reply sent to Reviewer A")).toBeNull();
  });

  it("offers a sign-in link when the session has ended", async () => {
    const respond = vi.fn<RespondToReview>(async () => {
      throw new ApiError(401, { detail: "expired" });
    });
    await renderReply(respond, { signInHref: "/signin?next=%2Freviews%2F6sel" });

    type("Novelty", "x");
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));

    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/signin?next=%2Freviews%2F6sel");
  });

  it("can be sent again after a failure", async () => {
    const respond = vi
      .fn<RespondToReview>()
      .mockRejectedValueOnce(new ApiError(503, {}))
      .mockResolvedValueOnce(replyResult());
    await renderReply(respond);

    type("Clarity", "Reworded.");
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));

    expect(await screen.findByText("Reply sent to Reviewer A")).toBeTruthy();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the rating", () => {
  function renderRating(
    rate: RateReview,
    extra: Partial<React.ComponentProps<typeof ReviewCardActions>> = {},
  ) {
    render(
      <ReviewCardActions
        review={REVEALED}
        paperId={PAPER}
        viewer={MEMBER_VIEWER}
        authorDids={[AUTHOR]}
        rate={rate}
        {...extra}
      />,
    );
  }

  it("is a group of five radios, 1 to 5, none chosen, each named with its text equivalent", () => {
    renderRating(vi.fn());

    const group = screen.getByRole("group", { name: "Rate this review’s quality" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["1", "2", "3", "4", "5"]);
    expect(radios.some((radio) => radio.checked)).toBe(false);
    for (const value of [1, 2, 3, 4, 5]) {
      expect(within(group).getByRole("radio", { name: `${value} of 5` })).toBeTruthy();
    }
    // One group: choosing 4 clears nothing else and picks exactly one.
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
  });

  it("says what the scale means and what a rating is recorded as", () => {
    renderRating(vi.fn());

    const group = screen.getByRole("group", { name: "Rate this review’s quality" });
    expect(group.textContent).toMatch(/1 is a review that does not help, 5 is one that sharpens the paper/);
    expect(group.textContent).toContain(
      "You rate the review, not the paper. Ratings are recorded with the review and never change the paper’s status.",
    );
    // No reputation exists, so the hint must not promise an effect on one.
    expect(group.textContent).not.toMatch(/reputation/i);
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("does not send until a rating is chosen, and says so", async () => {
    const rate = vi.fn<RateReview>();
    renderRating(rate);

    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Choose a rating from 1 to 5 before sending.");
    expect(rate).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: "Rate this review’s quality" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("sends the chosen rating for this review and thanks the member", async () => {
    const rate = vi.fn<RateReview>(
      async (input): Promise<RatingResult> => ({
        reviewCid: input.reviewCid,
        rating: 4,
      }),
    );
    const onRated = vi.fn();
    renderRating(rate, { onRated });

    fireEvent.click(screen.getByRole("radio", { name: "4 of 5" }));
    expect((screen.getByRole("radio", { name: "4 of 5" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));

    const done = await screen.findByText("You rated Reviewer A 4 of 5");
    expect(done).toBeTruthy();
    expect(rate).toHaveBeenCalledWith({ reviewCid: "bafyreireviewcommit", rating: 4 });
    expect(onRated).toHaveBeenCalledWith({ reviewCid: "bafyreireviewcommit", rating: 4 });
    const note = screen.getByRole("status").textContent ?? "";
    expect(note).toContain(
      "A rating is about the review’s quality. It is recorded with the review and never changes the paper’s status.",
    );
    expect(note).not.toMatch(/reputation/i);
    // One rating per member per review: there is nothing left to change.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send rating" })).toBeNull();
  });

  it("shows the rating the API recorded, not only the one that was asked for", async () => {
    renderRating(async (input) => ({ reviewCid: input.reviewCid, rating: 5 }));

    fireEvent.click(screen.getByRole("radio", { name: "3 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));

    expect(await screen.findByText("You rated Reviewer A 5 of 5")).toBeTruthy();
  });

  it("is busy and locked while sending, and ignores a second press", async () => {
    let finish: (value: RatingResult) => void = () => {};
    const rate = vi.fn<RateReview>(
      () =>
        new Promise<RatingResult>((done) => {
          finish = done;
        }),
    );
    renderRating(rate);

    fireEvent.click(screen.getByRole("radio", { name: "2 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));

    const busy = await screen.findByRole("button", { name: "Sending…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "5 of 5" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.submit(busy.closest("form") as HTMLFormElement);
    expect(rate).toHaveBeenCalledTimes(1);

    await act(async () => finish({ reviewCid: "bafyreireviewcommit", rating: 2 }));
    expect(await screen.findByText("You rated Reviewer A 2 of 5")).toBeTruthy();
  });

  it("keeps the choice and uses the API's own words when it refuses", async () => {
    const rate = vi.fn<RateReview>(async () => {
      throw new ApiError(403, { detail: "The reviewer of a review may not rate it." });
    });
    renderRating(rate);

    fireEvent.click(screen.getByRole("radio", { name: "3 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The reviewer of a review may not rate it. Nothing was sent.");
    expect((screen.getByRole("radio", { name: "3 of 5" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/You rated/)).toBeNull();
  });

  it("offers a sign-in link when the session has ended", async () => {
    renderRating(
      async () => {
        throw new ApiError(401, {});
      },
      { signInHref: "/signin" },
    );

    fireEvent.click(screen.getByRole("radio", { name: "1 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));

    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/signin");
  });
});

describe("with the reviews tab's own data", () => {
  /** The shape `GET /v1/papers/{id}/reviews` serves (reviews/router.py). */
  const payload = {
    paper: PAPER,
    version: 2,
    versionCid: "bafyreiversion",
    gate_open: true,
    reviews: [
      {
        review_cid: "bafyreirevealed",
        label: "Reviewer A",
        committed_at: "2026-11-02T00:00:00",
        revealed_at: "2026-11-09T00:00:00",
        recommendation: "minor_revisions",
        scores: {
          soundness: { score: 4, justification: "Solid." },
          evidence: { score: 3, justification: "Thin." },
        },
        report: "The adversarial baseline is unclear.",
        responses: [],
      },
      {
        review_cid: "bafyreisealed",
        label: "Reviewer B",
        committed_at: "2026-11-03T00:00:00",
        revealed_at: null,
        recommendation: "sound_as_is",
        scores: { soundness: { score: 5, justification: "Great." } },
        responses: [],
      },
    ],
  };

  it("takes a parsed Review as it is: the revealed one is actionable, the sealed one is not", async () => {
    const [revealed, sealed] = parseReviews(payload).reviews;
    expect(revealed).toBeDefined();
    expect(sealed).toBeDefined();
    if (revealed === undefined || sealed === undefined) return;

    render(
      <>
        <ReviewCardActions review={revealed} paperId={PAPER} viewer={AUTHOR_VIEWER} authorDids={[AUTHOR]} />
        <ReviewCardActions review={sealed} paperId={PAPER} viewer={AUTHOR_VIEWER} authorDids={[AUTHOR]} />
      </>,
    );

    expect(screen.getAllByText("Reply point by point")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Your response to Reviewer A" })).toBeTruthy();
    // The reviewer's score for the point is carried over from the card's data.
    expect(screen.getByText("Reviewer scored 4 of 5")).toBeTruthy();
  });

  it("treats a review with a reveal date but no written report as revealed", async () => {
    const [revealed] = parseReviews({
      reviews: [
        {
          review_cid: "bafyrei-noreport",
          label: "Reviewer A",
          revealed_at: "2026-11-09T00:00:00",
          recommendation: "minor_revisions",
          scores: { soundness: { score: 4, justification: "Solid." } },
        },
      ],
    }).reviews;

    render(
      <ReviewCardActions
        review={revealed}
        paperId={PAPER}
        viewer={AUTHOR_VIEWER}
        authorDids={[AUTHOR]}
      />,
    );

    expect(await screen.findByText("Reply point by point")).toBeTruthy();
  });

  it("names the review by the cid the API's response and rating paths expect", async () => {
    const [revealed] = parseReviews(payload).reviews;
    if (revealed === undefined) throw new Error("no review parsed");
    const rate = vi.fn<RateReview>(async (input) => ({ reviewCid: input.reviewCid, rating: 5 }));

    render(
      <ReviewCardActions
        review={revealed}
        paperId={PAPER}
        viewer={MEMBER_VIEWER}
        authorDids={[AUTHOR]}
        rate={rate}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "5 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Send rating" }));
    await screen.findByText(/You rated/);

    expect(rate).toHaveBeenCalledWith({ reviewCid: "bafyreirevealed", rating: 5 });
  });
});

beforeEach(() => {
  tokenStore.clear();
});
