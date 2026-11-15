// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  ANONYMITY_DETAIL,
  ANONYMITY_HEADLINE,
  AnonymityNotice,
} from "./anonymity-notice";
import type { ReviewCommitInput, ReviewCommitResult } from "./commit";
import {
  COMMIT_NOTE_ANONYMOUS,
  COMMIT_NOTE_SIGNED,
  SIGNED_DETAIL,
  SIGNED_HEADLINE,
  SIGNED_SEALED_DETAIL,
  SIGN_WITH_NAME_LABEL,
  STAY_ANONYMOUS_LABEL,
  STYLOMETRY_TIP,
} from "./identity";
import type { ReviewPaper } from "./paper";
import { COMMIT_LABEL, ReviewForm } from "./review-form";
import { ReviewPage } from "./review-page";
import { ReviewSessionProvider } from "./review-session";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  withDimension,
  type ReviewDraft,
} from "./rubric";

afterEach(cleanup);

const PAPER: ReviewPaper = {
  shortId: "sch:6sel-2dio-orm6",
  versionCid: "bafyversion",
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "We study how a meta-agent picks between branches.",
  categories: ["cs.AI"],
  paragraphs: [{ id: "aaaa", text: "Multi-agent systems increasingly delegate choices." }],
};

function completeDraft(): ReviewDraft {
  return RUBRIC_DIMENSIONS.reduce(
    (current, { id }) =>
      withDimension(current, id, { score: 4, justification: "Sound." }),
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

/** The notice above the form, sharing one session as the page does. */
function NoticeAndForm({
  commit,
}: {
  commit: (input: ReviewCommitInput) => Promise<ReviewCommitResult>;
}) {
  return (
    <ReviewSessionProvider>
      <AnonymityNotice />
      <ReviewForm
        initialDraft={completeDraft()}
        paperId={PAPER.shortId}
        versionCid="bafyversion"
        commit={commit}
      />
    </ReviewSessionProvider>
  );
}

const signButton = () =>
  screen.getByRole("button", { name: SIGN_WITH_NAME_LABEL });
const stayButton = () =>
  screen.getByRole("button", { name: STAY_ANONYMOUS_LABEL });

describe("the review page's identity choice", () => {
  it("is anonymous to begin with, and offers Sign with my name instead", () => {
    render(<ReviewPage paper={PAPER} />);

    const notice = screen.getByRole("note", { name: "Anonymity" });
    expect(notice.textContent).toBe(`${ANONYMITY_HEADLINE} ${ANONYMITY_DETAIL}`);
    expect(signButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: STAY_ANONYMOUS_LABEL })).toBeNull();
  });

  it("keeps the button out of the notice's own words, so they are read as the design wrote them", () => {
    render(<ReviewPage paper={PAPER} />);

    const notice = screen.getByRole("note", { name: "Anonymity" });
    expect(notice.contains(signButton())).toBe(false);
  });

  it("shows the stylometry tip to a reviewer who is anonymous", () => {
    render(<ReviewPage paper={PAPER} />);

    expect(screen.getByText(STYLOMETRY_TIP)).toBeTruthy();
    expect(STYLOMETRY_TIP).toBe("Tip: avoid phrases that identify you or your lab.");
  });

  it("puts the tip in the form, where the reviewer writes, and the option above it", () => {
    render(<ReviewPage paper={PAPER} />);

    const form = screen.getByRole("form", { name: "Your review" });
    const tip = screen.getByText(STYLOMETRY_TIP);
    expect(form.contains(tip)).toBe(true);
    // The tip comes before the first justification box.
    const firstBox = screen.getAllByRole("textbox", { name: /Justification/ })[0];
    expect(
      tip.compareDocumentPosition(firstBox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      signButton().compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("swaps the notice for what signing means, and drops the tip, when the reviewer signs", () => {
    render(<ReviewPage paper={PAPER} />);

    fireEvent.click(signButton());

    const notice = screen.getByRole("note", { name: "Signed review" });
    expect(notice.textContent).toBe(`${SIGNED_HEADLINE} ${SIGNED_DETAIL}`);
    expect(screen.queryByText(STYLOMETRY_TIP)).toBeNull();
    expect(screen.queryByText(ANONYMITY_HEADLINE)).toBeNull();
    expect(stayButton()).toBeTruthy();
  });

  it("goes back to anonymous, tip and all, when the reviewer changes their mind", () => {
    render(<ReviewPage paper={PAPER} />);

    fireEvent.click(signButton());
    fireEvent.click(stayButton());

    expect(screen.getByRole("note", { name: "Anonymity" }).textContent).toBe(
      `${ANONYMITY_HEADLINE} ${ANONYMITY_DETAIL}`,
    );
    expect(screen.getByText(STYLOMETRY_TIP)).toBeTruthy();
    expect(signButton()).toBeTruthy();
  });

  it("keeps keyboard focus on the button as its words change", () => {
    render(<ReviewPage paper={PAPER} />);

    const button = signButton();
    button.focus();
    fireEvent.click(button);

    // One button, relabelled: the same node still holds focus.
    expect(stayButton()).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("announces the change politely", () => {
    render(<ReviewPage paper={PAPER} />);

    const notice = screen.getByRole("note", { name: "Anonymity" });
    expect(notice.getAttribute("aria-live")).toBe("polite");
  });

  it("says in the commit note that a signed review will carry the reviewer's name", () => {
    render(<ReviewPage paper={PAPER} />);

    expect(screen.getByText(COMMIT_NOTE_ANONYMOUS)).toBeTruthy();
    fireEvent.click(signButton());

    expect(screen.getByText(COMMIT_NOTE_SIGNED)).toBeTruthy();
    expect(screen.queryByText(COMMIT_NOTE_ANONYMOUS)).toBeNull();
  });
});

describe("the notice on its own", () => {
  it("is the plain anonymous notice, with no button that could reach nothing", () => {
    render(<AnonymityNotice />);

    expect(screen.getByRole("note", { name: "Anonymity" }).textContent).toBe(
      `${ANONYMITY_HEADLINE} ${ANONYMITY_DETAIL}`,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("committing", () => {
  it("seals an anonymous review as anonymous", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput) => result());
    render(<NoticeAndForm commit={commit} />);

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(commit.mock.calls[0][0].draft.signed).toBe(false);
    expect(screen.queryByText(/carry your name/)).toBeNull();
  });

  it("seals the choice to sign with the commit", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput) => result());
    render(<NoticeAndForm commit={commit} />);

    fireEvent.click(signButton());
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(commit.mock.calls[0][0].draft.signed).toBe(true);
  });

  it("commits what the page says, not what the draft began with", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput) => result());
    render(
      <ReviewSessionProvider>
        <AnonymityNotice />
        <ReviewForm
          initialDraft={{ ...completeDraft(), signed: true }}
          paperId={PAPER.shortId}
          versionCid="bafyversion"
          commit={commit}
        />
      </ReviewSessionProvider>,
    );

    // The page's session starts anonymous, whatever the draft says.
    expect(screen.getByText(STYLOMETRY_TIP)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(commit.mock.calls[0][0].draft.signed).toBe(false);
  });

  it("tells a signed reviewer, once sealed, that the review will carry their name", async () => {
    render(<NoticeAndForm commit={async () => result()} />);

    fireEvent.click(signButton());
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(screen.getByText("It will carry your name when it is revealed.")).toBeTruthy();
  });

  it("fixes the choice once the review is sealed: the button goes, the words stay", async () => {
    render(<NoticeAndForm commit={async () => result()} />);

    fireEvent.click(signButton());
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(screen.queryByRole("button", { name: STAY_ANONYMOUS_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeNull();
    expect(screen.getByRole("note", { name: "Signed review" }).textContent).toBe(
      `${SIGNED_HEADLINE} ${SIGNED_SEALED_DETAIL}`,
    );
  });

  it("keeps an anonymous review's notice, without the button, once sealed", async () => {
    render(<NoticeAndForm commit={async () => result()} />);

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(screen.queryByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeNull();
    expect(screen.getByRole("note", { name: "Anonymity" }).textContent).toBe(
      `${ANONYMITY_HEADLINE} ${ANONYMITY_DETAIL}`,
    );
  });

  it("fixes the choice while the commit is being signed, so the page cannot disagree with the commitment", async () => {
    let release: (value: ReviewCommitResult) => void = () => undefined;
    const commit = vi.fn(
      (_input: ReviewCommitInput) =>
        new Promise<ReviewCommitResult>((resolve) => {
          release = resolve;
        }),
    );
    render(<NoticeAndForm commit={commit} />);

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));

    expect(screen.queryByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: STAY_ANONYMOUS_LABEL })).toBeNull();

    await act(async () => {
      release(result());
    });
    await screen.findByRole("heading", { name: "Your review is sealed" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("gives the choice back when the commit fails, and keeps what was chosen", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput): Promise<ReviewCommitResult> => {
      throw new ApiError(409, { detail: "You have already reviewed this paper." });
    });
    render(<NoticeAndForm commit={commit} />);

    fireEvent.click(signButton());
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("alert");

    // Still signed, and still changeable: nothing was sealed.
    await waitFor(() => expect(stayButton()).toBeTruthy());
    fireEvent.click(stayButton());
    expect(signButton()).toBeTruthy();
    expect(screen.getByText(STYLOMETRY_TIP)).toBeTruthy();
  });
});

describe("a form on its own", () => {
  it("starts signed when its draft is, and says so by dropping the tip", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput) => result());
    render(
      <ReviewForm
        initialDraft={{ ...completeDraft(), signed: true }}
        paperId={PAPER.shortId}
        versionCid="bafyversion"
        commit={commit}
      />,
    );

    expect(screen.queryByText(STYLOMETRY_TIP)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    expect(commit.mock.calls[0][0].draft.signed).toBe(true);
  });

  it("shows the tip to an anonymous review, as a form does by default", () => {
    render(<ReviewForm />);

    expect(screen.getByText(STYLOMETRY_TIP)).toBeTruthy();
  });
});
