// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CITE_LABEL } from "./citation";
import { SELECTION_SETTLE_MS } from "./cite-in-review";
import type { ReviewCommitInput, ReviewCommitResult } from "./commit";
import type { ReviewPaper } from "./paper";
import { PaperPane } from "./paper-pane";
import { COMMIT_LABEL, ReviewForm } from "./review-form";
import { ReviewPage } from "./review-page";
import { ReviewSessionProvider } from "./review-session";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  withDimension,
  type ReviewDraft,
} from "./rubric";

const PAPER: ReviewPaper = {
  shortId: "sch:6sel-2dio-orm6",
  versionCid: "bafyversion",
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "We study how a meta-agent picks between branches.",
  categories: ["cs.AI"],
  paragraphs: [
    { id: "aaaa1111bbbb", text: "Multi-agent systems increasingly delegate choices." },
    { id: "cccc2222dddd", text: "We define a safety score for each branch." },
  ],
};

// Timers are faked so the pause before the button appears can be stepped
// through; nothing here awaits a timer, so `findBy*` is not used.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  // A successful commit keeps the review on the device for its later reveal.
  window.localStorage.clear();
  vi.useRealTimers();
});

/** The text node of one paragraph, by the id the pane writes on it. */
function paragraph(id: string): Text {
  const node = document.querySelector(`[data-paragraph-id="${id}"]`)?.firstChild;
  if (!(node instanceof Text)) throw new Error(`no paragraph ${id}`);
  return node;
}

/** Select `phrase` inside `node`, as a reviewer would, and let the page notice. */
function selectPhrase(node: Text, phrase: string): void {
  const start = node.data.indexOf(phrase);
  if (start < 0) throw new Error(`"${phrase}" is not in "${node.data}"`);
  selectRange(node, start, node, start + phrase.length);
}

function selectRange(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  settle();
}

/** The browser's `selectionchange`, then the pause until the selection is still. */
function settle(): void {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(SELECTION_SETTLE_MS + 10);
  });
}

const citeButton = () => screen.queryByRole("button", { name: CITE_LABEL });

function box(dimension: string): HTMLTextAreaElement {
  const group = screen.getByRole("group", { name: dimension });
  return within(group).getByRole("textbox", { name: /Justification/ }) as HTMLTextAreaElement;
}

const FIRST_QUOTE = "“safety score” [¶ 2 · cccc2222]";

describe("Cite in review", () => {
  it("offers nothing until text is selected", () => {
    render(<ReviewPage paper={PAPER} />);

    expect(citeButton()).toBeNull();
  });

  it("offers Cite in review for text selected in the paper", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");

    expect(citeButton()).not.toBeNull();
    expect(CITE_LABEL).toBe("Cite in review");
  });

  it("offers it for the abstract too", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);

    const abstract = container.querySelector(".rf-abstract")?.firstChild as Text;
    selectPhrase(abstract, "meta-agent");

    expect(citeButton()).not.toBeNull();
  });

  it("puts the quote, and where it is, into the first justification by default", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);

    expect(box("Soundness of method").value).toBe(`${FIRST_QUOTE}\n`);
    expect(box("Novelty").value).toBe("");
  });

  it("puts it into the justification the reviewer last had open", () => {
    render(<ReviewPage paper={PAPER} />);

    fireEvent.focus(box("Novelty"));
    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);

    expect(box("Novelty").value).toBe(`${FIRST_QUOTE}\n`);
    expect(box("Soundness of method").value).toBe("");
  });

  it("adds to what the reviewer has written rather than replacing it", () => {
    render(<ReviewPage paper={PAPER} />);

    fireEvent.change(box("Soundness of method"), {
      target: { value: "The argument rests on this." },
    });
    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);

    expect(box("Soundness of method").value).toBe(
      `The argument rests on this.\n\n${FIRST_QUOTE}\n`,
    );
  });

  it("stacks a second quote below the first", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);
    selectPhrase(paragraph("aaaa1111bbbb"), "delegate choices");
    fireEvent.click(citeButton() as HTMLElement);

    expect(box("Soundness of method").value).toBe(
      `${FIRST_QUOTE}\n\n“delegate choices” [¶ 1 · aaaa1111]\n`,
    );
  });

  it("moves the reviewer into that box, caret at the end, to carry on writing", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);

    const target = box("Soundness of method");
    expect(document.activeElement).toBe(target);
    expect(target.selectionStart).toBe(target.value.length);
    expect(target.selectionEnd).toBe(target.value.length);
  });

  it("says where the quote went, in a polite live region", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);

    const status = container.querySelector("[data-cite-status]") as HTMLElement;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe(
      "Quoted ¶ 2 · cccc2222 in the justification for Soundness of method.",
    );
  });

  it("leaves the form's one status line alone", () => {
    const { container } = render(<ReviewForm />);

    // The progress line is the form's only `status`; the citation notice is a
    // plain live region, not another. (Scoped to the form: the UI kit's toast
    // region is a `status` on the body that outlives the test that made it.)
    const form = screen.getByRole("form", { name: "Your review" });
    expect(within(form).getAllByRole("status")).toHaveLength(1);
    expect(container.querySelector("[data-cite-status]")?.getAttribute("role")).toBeNull();
  });

  it("clears the selection and the button once the quote is placed", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.click(citeButton() as HTMLElement);

    expect(citeButton()).toBeNull();
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it("does not let a press on the button take the selection away", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    const notPrevented = fireEvent.mouseDown(citeButton() as HTMLElement);

    // `fireEvent` returns false when a listener cancelled the event.
    expect(notPrevented).toBe(false);
  });

  it("takes the button away when the selection is dropped", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    act(() => window.getSelection()?.removeAllRanges());
    settle();

    expect(citeButton()).toBeNull();
  });

  it("dismisses the button on Escape", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(citeButton()).toBeNull();
  });

  it("offers nothing for a selection in the form", () => {
    render(<ReviewPage paper={PAPER} />);

    const lede = screen.getByText(/Score each dimension/).firstChild as Text;
    selectRange(lede, 0, lede, 5);

    expect(citeButton()).toBeNull();
  });

  it("offers nothing for a selection that runs from the paper into the form", () => {
    render(<ReviewPage paper={PAPER} />);

    const lede = screen.getByText(/Score each dimension/).firstChild as Text;
    selectRange(paragraph("cccc2222dddd"), 3, lede, 5);

    expect(citeButton()).toBeNull();
  });

  it("waits for the pointer to come up before offering the button", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);
    const text = container.querySelector(".rf-paper-text") as HTMLElement;

    // A drag in progress: the selection changes under the pointer.
    fireEvent.pointerDown(text);
    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    expect(citeButton()).toBeNull();

    fireEvent.pointerUp(document);
    act(() => {
      vi.advanceTimersByTime(SELECTION_SETTLE_MS + 10);
    });
    expect(citeButton()).not.toBeNull();
  });

  it("does not offer the button from a pause that began before the pointer went down", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);
    const text = container.querySelector(".rf-paper-text") as HTMLElement;

    // The selection changes, starting the pause...
    const node = paragraph("cccc2222dddd");
    const range = document.createRange();
    range.setStart(node, 3);
    range.setEnd(node, 9);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(SELECTION_SETTLE_MS / 2);
    });
    // ...and the pointer goes down for another drag before it ends.
    fireEvent.pointerDown(text);
    act(() => {
      vi.advanceTimersByTime(SELECTION_SETTLE_MS * 2);
    });

    expect(citeButton()).toBeNull();
  });

  it("takes a button left from the last selection away when a new drag starts", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);
    const text = container.querySelector(".rf-paper-text") as HTMLElement;

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    expect(citeButton()).not.toBeNull();

    fireEvent.pointerDown(text);

    expect(citeButton()).toBeNull();
  });

  it("does not take the button away when it is the button that is pressed", () => {
    render(<ReviewPage paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    const button = citeButton() as HTMLElement;
    fireEvent.pointerDown(button);

    // Still there for the click that follows the press.
    expect(citeButton()).toBe(button);
    fireEvent.click(button);
    expect(box("Soundness of method").value).toBe(`${FIRST_QUOTE}\n`);
  });

  it("puts the button just under the end of the selection", () => {
    const original = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [
        { left: 20, top: 100, right: 240, bottom: 124, width: 220, height: 24 },
      ],
    });
    try {
      const { container } = render(<ReviewPage paper={PAPER} />);

      selectPhrase(paragraph("cccc2222dddd"), "safety score");

      const offer = container.querySelector(".rc-offer") as HTMLElement;
      // jsdom lays nothing out, so the wrapper sits at the origin.
      expect(offer.style.getPropertyValue("--rc-x")).toBe("240px");
      expect(offer.style.getPropertyValue("--rc-y")).toBe("124px");
    } finally {
      if (original === undefined) {
        delete (Range.prototype as Partial<Range>).getClientRects;
      } else {
        Object.defineProperty(Range.prototype, "getClientRects", original);
      }
    }
  });

  it("marks every paragraph with the name a citation gives it", () => {
    const { container } = render(<PaperPane paper={PAPER} />);

    const names = Array.from(container.querySelectorAll("[data-cite]")).map((node) =>
      node.getAttribute("data-cite"),
    );
    expect(names).toEqual([
      "abstract",
      "¶ 1 · aaaa1111",
      "¶ 2 · cccc2222",
    ]);
  });
});

describe("Cite in review when the draft may not change", () => {
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
      revealBody: {
        target: "bafyversion",
        scores: {},
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
      body: { target: "bafyversion", commitment: "00", nullifier: "11", reviewKey: "did:key:z6Mkreview" },
    };
  }

  function PaperAndForm({
    commit,
  }: {
    commit: (input: ReviewCommitInput) => Promise<ReviewCommitResult>;
  }) {
    return (
      <ReviewSessionProvider>
        <PaperPane paper={PAPER} />
        <ReviewForm
          initialDraft={completeDraft()}
          paperId={PAPER.shortId}
          versionCid="bafyversion"
          commit={commit}
        />
      </ReviewSessionProvider>
    );
  }

  it("offers nothing while the commit is being signed", async () => {
    let release: (value: ReviewCommitResult) => void = () => undefined;
    const commit = vi.fn(
      (_input: ReviewCommitInput) =>
        new Promise<ReviewCommitResult>((resolve) => {
          release = resolve;
        }),
    );
    render(<PaperAndForm commit={commit} />);

    // Offered beforehand, as it is while editing.
    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    expect(citeButton()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    expect(citeButton()).toBeNull();

    // Nor for a new selection: what is on the page is what is being sealed.
    selectPhrase(paragraph("aaaa1111bbbb"), "delegate choices");
    expect(citeButton()).toBeNull();

    await act(async () => {
      release(result());
    });
  });

  it("offers nothing once the review is sealed", async () => {
    render(<PaperAndForm commit={async () => result()} />);

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Your review is sealed" })).toBeTruthy();

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    expect(citeButton()).toBeNull();
  });

  it("offers it again if the commit fails and the draft is open again", async () => {
    const commit = vi.fn(async (_input: ReviewCommitInput): Promise<ReviewCommitResult> => {
      throw new Error("The API is down.");
    });
    render(<PaperAndForm commit={commit} />);

    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toBeTruthy();

    selectPhrase(paragraph("cccc2222dddd"), "safety score");
    expect(citeButton()).not.toBeNull();
  });
});

describe("the paper without a form", () => {
  it("offers nothing, since there is nowhere to cite into", () => {
    render(<PaperPane paper={PAPER} />);

    selectPhrase(paragraph("cccc2222dddd"), "safety score");

    expect(citeButton()).toBeNull();
    // The paper reads as it always did.
    expect(screen.getByText("We define a safety score for each branch.")).toBeTruthy();
  });
});
