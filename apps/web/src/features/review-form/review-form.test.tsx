// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";

import {
  AI_ASSISTANCE_HINT,
  AI_ASSISTANCE_LABEL,
  UPDATE_LABEL,
  ReviewForm,
} from "./review-form";
import type { LoadRevealGate, UpdateReview, UpdateReviewResult } from "./reveal";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  withDimension,
  type ReviewDraft,
} from "./rubric";

afterEach(cleanup);

/** A draft with every rubric answer filled in. */
function completeDraft(): ReviewDraft {
  return RUBRIC_DIMENSIONS.reduce(
    (current, { id }) =>
      withDimension(current, id, { score: 4, justification: "Fine." }),
    {
      ...emptyDraft(),
      confidence: "high",
      recommendation: "sound_as_is",
    } as ReviewDraft,
  );
}

/** What a successful update returns: the body the reviewer now stands on. */
function updatedReview(): UpdateReviewResult {
  return {
    revealCid: "bafyreveal2",
    reviewCid: "bafycommit",
    body: {
      target: "bafyversion",
      scores: Object.fromEntries(
        RUBRIC_DIMENSIONS.map(({ id }) => [
          id,
          { score: 4, justification: `Revised ${id}.` },
        ]),
      ),
      confidence: "high",
      recommendation: "sound_as_is",
      aiAssisted: false,
      report: "The revised report.",
    },
    record: {
      v: 1,
      type: "review.formal",
      id: "bafyreveal2",
      author: "did:key:z6Mkreview",
      created: "2026-12-01T00:00:00Z",
      prev: "bafyformal",
      body: {},
      proofs: [],
      sig: "sig",
    },
  };
}

/** The fieldset for one rubric dimension, found by its legend. */
function dimension(label: string): HTMLElement {
  return screen.getByRole("group", { name: label });
}

describe("ReviewForm rubric", () => {
  it("shows the six dimensions, each as a group", () => {
    render(<ReviewForm />);

    for (const { label } of RUBRIC_DIMENSIONS) {
      expect(dimension(label)).toBeTruthy();
    }
  });

  it("gives each dimension five score radios, 1 to 5, none chosen", () => {
    render(<ReviewForm />);

    for (const { label } of RUBRIC_DIMENSIONS) {
      const radios = within(dimension(label)).getAllByRole("radio");
      expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
      expect(radios.some((radio) => (radio as HTMLInputElement).checked)).toBe(
        false,
      );
    }
  });

  it("names each radio with its text equivalent, so it never rests on the circle alone", () => {
    render(<ReviewForm />);

    const group = dimension("Soundness of method");
    for (const score of [1, 2, 3, 4, 5]) {
      expect(within(group).getByRole("radio", { name: `${score} of 5` })).toBeTruthy();
    }
  });

  it("gives each dimension a required justification box", () => {
    render(<ReviewForm />);

    for (const { label } of RUBRIC_DIMENSIONS) {
      const box = within(dimension(label)).getByRole("textbox", {
        name: /Justification/,
      }) as HTMLTextAreaElement;
      expect(box.required).toBe(true);
      expect(box.value).toBe("");
    }
    expect(screen.getAllByText("(required)")).toHaveLength(6);
  });

  it("keeps each dimension's radios in their own group", () => {
    render(<ReviewForm />);

    fireEvent.click(
      within(dimension("Novelty")).getByRole("radio", { name: "5 of 5" }),
    );
    fireEvent.click(
      within(dimension("Clarity")).getByRole("radio", { name: "2 of 5" }),
    );

    expect(
      (within(dimension("Novelty")).getByRole("radio", { name: "5 of 5" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(dimension("Clarity")).getByRole("radio", { name: "2 of 5" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("lets a reviewer change their mind: one radio per dimension is ever chosen", () => {
    render(<ReviewForm />);
    const group = dimension("Evidence for claims");

    fireEvent.click(within(group).getByRole("radio", { name: "2 of 5" }));
    fireEvent.click(within(group).getByRole("radio", { name: "4 of 5" }));

    const checked = within(group)
      .getAllByRole("radio")
      .filter((radio) => (radio as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect((checked[0] as HTMLInputElement).value).toBe("4");
  });

  it("keeps what is typed in a justification", () => {
    render(<ReviewForm />);
    const box = within(dimension("Clarity")).getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "Section 3 is hard to follow." } });

    expect(box.value).toBe("Section 3 is hard to follow.");
  });
});

describe("ReviewForm confidence and recommendation", () => {
  it("offers Low, Medium and High confidence, none chosen", () => {
    render(<ReviewForm />);
    const group = screen.getByRole("group", { name: "Confidence" });

    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Low",
      "Medium",
      "High",
    ]);
    expect(radios.some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
  });

  it("offers the four recommendations, none chosen", () => {
    render(<ReviewForm />);
    const group = screen.getByRole("group", { name: "Recommendation" });

    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Sound as is",
      "Minor revisions",
      "Major concerns",
      "Fundamentally flawed",
    ]);
    expect(radios.some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
  });

  it("selects a confidence and a recommendation independently", () => {
    render(<ReviewForm />);

    fireEvent.click(screen.getByRole("radio", { name: "Medium" }));
    fireEvent.click(screen.getByRole("radio", { name: "Major concerns" }));

    expect((screen.getByRole("radio", { name: "Medium" }) as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole("radio", { name: "Major concerns" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByRole("radio", { name: "Low" }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("ReviewForm AI assistance", () => {
  it("shows an unticked checkbox with the design's words", () => {
    render(<ReviewForm />);

    const box = screen.getByRole("checkbox", {
      name: `${AI_ASSISTANCE_LABEL} ${AI_ASSISTANCE_HINT}`,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(AI_ASSISTANCE_LABEL).toBe("I used AI assistance in writing this review");
    expect(AI_ASSISTANCE_HINT).toBe("(declared on the report)");
  });

  it("toggles on and off", () => {
    render(<ReviewForm />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;

    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });
});

describe("ReviewForm justification errors", () => {
  it("says nothing before the reviewer has been to a justification box", () => {
    render(<ReviewForm />);

    expect(screen.queryByText(/Add a justification/)).toBeNull();
    expect(screen.queryByText(/Choose a score/)).toBeNull();
  });

  it("asks for a justification when the reviewer leaves the box empty", () => {
    render(<ReviewForm />);
    const group = dimension("Reproducibility");
    const box = within(group).getByRole("textbox");

    fireEvent.blur(box);

    expect(within(group).getByText("Add a justification for Reproducibility.")).toBeTruthy();
    expect(box.getAttribute("aria-invalid")).toBe("true");
  });

  it("ties the message to the box, so a screen reader reads it with the field", () => {
    render(<ReviewForm />);
    const box = within(dimension("Reproducibility")).getByRole("textbox");

    fireEvent.blur(box);

    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      box.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent),
    ).toEqual(["Add a justification for Reproducibility."]);
  });

  it("makes the error an icon and words, never colour alone", () => {
    render(<ReviewForm />);
    const group = dimension("Reproducibility");

    fireEvent.blur(within(group).getByRole("textbox"));

    const message = within(group).getByText("Add a justification for Reproducibility.");
    expect(message.parentElement?.querySelector("svg")).toBeTruthy();
  });

  it("clears the message once a justification is written", () => {
    render(<ReviewForm />);
    const group = dimension("Reproducibility");
    const box = within(group).getByRole("textbox");

    fireEvent.blur(box);
    fireEvent.change(box, { target: { value: "No code was released." } });

    expect(within(group).queryByText(/Add a justification/)).toBeNull();
    expect(box.getAttribute("aria-invalid")).toBeNull();
    expect(box.getAttribute("aria-describedby")).toBeNull();
  });

  it("does not take whitespace for a justification", () => {
    render(<ReviewForm />);
    const group = dimension("Clarity");
    const box = within(group).getByRole("textbox");

    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.blur(box);

    expect(within(group).getByText("Add a justification for Clarity.")).toBeTruthy();
  });

  it("asks for the score when the reviewer wrote a justification but chose none", () => {
    render(<ReviewForm />);
    const group = dimension("Novelty");
    const box = within(group).getByRole("textbox");

    fireEvent.change(box, { target: { value: "Closely follows prior work." } });
    fireEvent.blur(box);

    expect(
      within(group).getByText("Choose a score from 1 to 5 for Novelty."),
    ).toBeTruthy();
    expect(within(group).queryByText(/Add a justification/)).toBeNull();
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("flags only the dimension the reviewer left, not the others", () => {
    render(<ReviewForm />);

    fireEvent.blur(within(dimension("Clarity")).getByRole("textbox"));

    expect(screen.getAllByText(/Add a justification/)).toHaveLength(1);
  });
});

describe("ReviewForm progress", () => {
  function progress(): string {
    return screen.getByRole("status").textContent ?? "";
  }

  it("starts with nothing done", () => {
    render(<ReviewForm />);
    expect(progress()).toBe(
      "0 of 6 rubric dimensions complete · still needed: confidence and recommendation",
    );
  });

  it("counts a dimension once it has both a score and a justification", () => {
    render(<ReviewForm />);
    const group = dimension("Soundness of method");

    fireEvent.click(within(group).getByRole("radio", { name: "4 of 5" }));
    expect(progress()).toContain("0 of 6");

    fireEvent.change(within(group).getByRole("textbox"), {
      target: { value: "The proof is sound." },
    });
    expect(progress()).toContain("1 of 6");
  });

  it("drops the confidence from what is still needed once it is chosen", () => {
    render(<ReviewForm />);

    fireEvent.click(screen.getByRole("radio", { name: "High" }));

    expect(progress()).toContain("still needed: recommendation");
    expect(progress()).not.toContain("confidence");
  });

  it("says the review is filled in when every part is", () => {
    const draft: ReviewDraft = RUBRIC_DIMENSIONS.reduce(
      (current, { id }) =>
        withDimension(current, id, { score: 3, justification: "Fine." }),
      { ...emptyDraft(), confidence: "low", recommendation: "sound_as_is" } as ReviewDraft,
    );

    render(<ReviewForm initialDraft={draft} />);

    expect(progress()).toBe("Every part of the review is filled in.");
  });
});

describe("ReviewForm as a form", () => {
  it("is named, and does not submit anywhere on Enter", () => {
    render(<ReviewForm />);

    const form = screen.getByRole("form", { name: "Your review" });
    const submitted = fireEvent.submit(form);

    // `preventDefault` was called, so the browser would not reload the page.
    expect(submitted).toBe(false);
  });

  it("starts from the draft it is given", () => {
    const draft = withDimension(emptyDraft(), "clarity", {
      score: 2,
      justification: "Hard to follow.",
    });

    render(<ReviewForm initialDraft={{ ...draft, aiAssisted: true }} />);

    const group = dimension("Clarity");
    expect((within(group).getByRole("radio", { name: "2 of 5" }) as HTMLInputElement).checked).toBe(true);
    expect((within(group).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Hard to follow.");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("keeps two forms on one page apart", () => {
    render(
      <>
        <ReviewForm />
        <ReviewForm />
      </>,
    );

    const ids = Array.from(document.querySelectorAll("[id]")).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = new Set(
      Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map(
        (input) => input.name,
      ),
    );
    // Eight radio groups per form: six dimensions, confidence, recommendation.
    expect(names.size).toBe(16);
  });
});

describe("ReviewForm written report", () => {
  it("offers an optional free-text report in addition to the rubric", () => {
    render(<ReviewForm />);

    const box = screen.getByRole("textbox", {
      name: /Written report/,
    }) as HTMLTextAreaElement;
    expect(box.required).toBe(false);
    expect(box.value).toBe("");

    fireEvent.change(box, {
      target: { value: "## Summary\nThe method is sound." },
    });
    expect(box.value).toBe("## Summary\nThe method is sound.");
  });

  it("starts from the report in the draft it is given", () => {
    render(
      <ReviewForm initialDraft={{ ...completeDraft(), report: "A prior report." }} />,
    );

    const box = screen.getByRole("textbox", {
      name: /Written report/,
    }) as HTMLTextAreaElement;
    expect(box.value).toBe("A prior report.");
  });
});

describe("ReviewForm update", () => {
  it("switches to a confirmed, read-only state showing the new review", async () => {
    const update = vi.fn<UpdateReview>(async () => updatedReview());

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        prev="bafyformal"
        update={update}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: UPDATE_LABEL }));

    expect(
      await screen.findByRole("heading", { name: "Your review is updated" }),
    ).toBeTruthy();
    expect(screen.getByText("Sound as is")).toBeTruthy();
    expect(screen.getAllByText("4 of 5").length).toBeGreaterThan(0);
    expect(screen.getByText("Revised soundness.")).toBeTruthy();
    expect(screen.getByText("The revised report.")).toBeTruthy();
    // The form is gone, so a second click cannot surface an API refusal.
    expect(screen.queryByRole("button", { name: UPDATE_LABEL })).toBeNull();
  });

  it("says the scores and recommendation are public now and when the report unseals", async () => {
    const update = vi.fn<UpdateReview>(async () => updatedReview());

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        prev="bafyformal"
        update={update}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: UPDATE_LABEL }));
    await screen.findByRole("heading", { name: "Your review is updated" });

    // The update is revealed at once, but its written report waits for the
    // version's gate (REV-4): the confirmation may not call the whole review
    // published. The date is the record's own date plus the 21-day window.
    expect(screen.getByText(/Your scores and recommendation are public now/)).toBeTruthy();
    expect(
      screen.getByText(
        /Your written report unseals once 2 reviews are committed on this version, or on 22 Dec\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/now published on the paper/)).toBeNull();
  });

  it("says the report is public now when this update opened the gate", async () => {
    // The gate read is taken after the update is posted, so it reflects the
    // new state: this update was the second review counted on the version.
    const loadGate: LoadRevealGate = vi.fn(async () => ({
      open: true,
      versionCid: "bafyversion",
      committed: 2,
    }));
    const update = vi.fn<UpdateReview>(async () => updatedReview());

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        prev="bafyformal"
        update={update}
        loadGate={loadGate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: UPDATE_LABEL }));
    await screen.findByRole("heading", { name: "Your review is updated" });

    expect(screen.getByText(/Your written report is public now/)).toBeTruthy();
    expect(screen.queryByText(/unseals once 2 reviews/)).toBeNull();
    expect(loadGate).toHaveBeenCalledWith("sch:6sel-2dio-orm6");
  });

  it("renders the confirmed report as Markdown, not with its asterisks", async () => {
    const result = updatedReview();
    result.body.report = "**Summary:** the revised method is *sound*.\n\n- clear\n- tested\n\n<b>not bold</b>";
    const update = vi.fn<UpdateReview>(async () => result);

    const { container } = render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        prev="bafyformal"
        update={update}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: UPDATE_LABEL }));
    await screen.findByRole("heading", { name: "Your review is updated" });

    const body = container.querySelector(".rf-updated__report-body") as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("Summary:");
    expect(body.querySelector("em")?.textContent).toBe("sound");
    expect(body.querySelectorAll("li")).toHaveLength(2);
    expect(body.textContent).not.toContain("**");
    // Raw HTML stays text.
    expect(body.querySelector("b")).toBeNull();
    expect(body.textContent).toContain("<b>not bold</b>");
  });

  it("shows an already-updated refusal in human words, not the API's `prev` message", async () => {
    const update = vi.fn<UpdateReview>(async () => {
      throw new ApiError(409, {
        detail:
          "This review has already been updated; point 'prev' at the reviewer's latest review.",
      });
    });

    render(
      <ReviewForm
        initialDraft={completeDraft()}
        paperId="sch:6sel-2dio-orm6"
        versionCid="bafyversion"
        prev="bafyformal"
        update={update}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: UPDATE_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already been updated");
    expect(alert.textContent).toContain("Nothing was sent.");
    expect(alert.textContent).not.toContain("prev");
    // Still editable, so the reviewer can reload or try again.
    expect(screen.getByRole("button", { name: UPDATE_LABEL })).toBeTruthy();
  });
});
