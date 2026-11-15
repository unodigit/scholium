import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import * as kit from "./index";
import {
  ContestedChip,
  CorrectedChip,
  PreprintChip,
  RetractedChip,
  ReviewedChip,
  StatusChip,
  UnderReviewChip,
} from "./status-chip";
import { PAPER_STATUSES, STATUS_CHIP_SPECS, type PaperStatus } from "./status";

afterEach(cleanup);

/** Render a chip and hand back its root element. */
function chipOf(element: ReturnType<typeof createElement>): HTMLElement {
  const { container } = render(element);
  const chip = container.firstElementChild;
  if (!(chip instanceof HTMLElement)) throw new Error("chip did not render");
  return chip;
}

describe("StatusChip", () => {
  it.each(PAPER_STATUSES)("%s shows an icon plus its word", (status) => {
    const chip = chipOf(createElement(StatusChip, { status }));
    const icon = chip.querySelector("svg");

    // The word is real text, and the only text: this is the accessible name.
    expect(chip.textContent).toBe(STATUS_CHIP_SPECS[status].label);
    expect(screen.getByText(STATUS_CHIP_SPECS[status].label)).toBeTruthy();

    // The icon is drawn, decorative, and not a tab stop.
    expect(icon).not.toBeNull();
    expect(icon?.querySelectorAll("path, circle").length).toBeGreaterThan(0);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
  });

  it("renders the six words from docs/design.md §7", () => {
    const words = PAPER_STATUSES.map(
      (status) => chipOf(createElement(StatusChip, { status })).textContent,
    );
    expect(words).toEqual([
      "Preprint",
      "Under review",
      "Reviewed",
      "Contested",
      "Corrected",
      "Retracted",
    ]);
  });

  it("gives every status a different icon, so colour is never the only difference", () => {
    const icons = PAPER_STATUSES.map(
      (status) =>
        chipOf(createElement(StatusChip, { status })).querySelector("svg")?.innerHTML,
    );
    expect(icons.every((markup) => markup && markup.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(PAPER_STATUSES.length);
  });

  it("shows the reviewer count on Under review: Under review (n)", () => {
    const chip = chipOf(createElement(StatusChip, { status: "under_review", count: 3 }));
    expect(chip.textContent).toBe("Under review (3)");
    expect(screen.getByText("Under review (3)")).toBeTruthy();
  });

  it("shows no count on Under review when none is given or it is not a count", () => {
    expect(chipOf(createElement(StatusChip, { status: "under_review" })).textContent).toBe(
      "Under review",
    );
    cleanup();
    expect(
      chipOf(createElement(StatusChip, { status: "under_review", count: Number.NaN }))
        .textContent,
    ).toBe("Under review");
  });

  it("ignores count on every other status", () => {
    for (const status of PAPER_STATUSES) {
      if (status === "under_review") continue;
      const chip = chipOf(createElement(StatusChip, { status, count: 5 }));
      expect(chip.textContent).toBe(STATUS_CHIP_SPECS[status].label);
      cleanup();
    }
  });

  it("exposes status and colour family as data attributes for styling and tests", () => {
    const chip = chipOf(createElement(StatusChip, { status: "retracted" }));
    expect(chip.dataset.status).toBe("retracted");
    expect(chip.dataset.tone).toBe("critical");
    expect(chip.classList.contains("sch-chip")).toBe(true);
  });

  it("is a plain span: no role, no tab stop, nothing to announce on its own", () => {
    const chip = chipOf(createElement(StatusChip, { status: "reviewed" }));
    expect(chip.tagName).toBe("SPAN");
    expect(chip.hasAttribute("role")).toBe(false);
    expect(chip.hasAttribute("tabindex")).toBe(false);
    expect(chip.hasAttribute("aria-label")).toBe(false);
  });

  it("passes className and other span attributes through without losing its own", () => {
    const chip = chipOf(
      createElement(StatusChip, {
        status: "contested",
        className: "ml-2",
        id: "paper-status",
        "data-testid": "chip",
      } as never),
    );
    expect(chip.className).toBe("sch-chip ml-2");
    expect(chip.id).toBe("paper-status");
    expect(chip.dataset.testid).toBe("chip");
    expect(chip.dataset.status).toBe("contested");
  });

  it("cannot be made to lie about its status through passed attributes", () => {
    const chip = chipOf(
      createElement(StatusChip, {
        status: "reviewed",
        "data-status": "retracted",
        "data-tone": "critical",
      } as never),
    );
    expect(chip.dataset.status).toBe("reviewed");
    expect(chip.dataset.tone).toBe("verified");
  });

  it("renders nothing for a status outside the six, rather than the wrong word", () => {
    for (const status of ["withdrawn", "", "under-review", undefined, null, 4]) {
      const { container } = render(createElement(StatusChip, { status } as never));
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("renders on the server with the word in the HTML, no client JS needed", () => {
    const html = renderToStaticMarkup(
      createElement(StatusChip, { status: "under_review", count: 2 }),
    );
    expect(html).toContain("Under review (2)");
    expect(html).toContain('data-status="under_review"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<svg");
  });
});

describe("named chips", () => {
  type AnyChip = (props: never) => unknown;
  const cases: Array<[string, AnyChip, PaperStatus, string]> = [
    ["PreprintChip", PreprintChip, "preprint", "Preprint"],
    ["UnderReviewChip", UnderReviewChip, "under_review", "Under review"],
    ["ReviewedChip", ReviewedChip, "reviewed", "Reviewed"],
    ["ContestedChip", ContestedChip, "contested", "Contested"],
    ["CorrectedChip", CorrectedChip, "corrected", "Corrected"],
    ["RetractedChip", RetractedChip, "retracted", "Retracted"],
  ];

  it.each(cases)("%s renders the %s chip", (_name, Chip, status, label) => {
    const chip = chipOf(createElement(Chip as never));
    expect(chip.dataset.status).toBe(status);
    expect(chip.textContent).toBe(label);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("UnderReviewChip takes the reviewer count", () => {
    expect(chipOf(createElement(UnderReviewChip, { count: 4 })).textContent).toBe(
      "Under review (4)",
    );
  });

  it("pass className through", () => {
    expect(
      chipOf(createElement(RetractedChip, { className: "extra" })).className,
    ).toBe("sch-chip extra");
  });

  it("have display names for React DevTools", () => {
    expect(PreprintChip.displayName).toBe("PreprintChip");
    expect(UnderReviewChip.displayName).toBe("UnderReviewChip");
    expect(RetractedChip.displayName).toBe("RetractedChip");
  });
});

describe("the ui-kit entry point", () => {
  it("exports every chip and the status helpers", () => {
    for (const name of [
      "StatusChip",
      "PreprintChip",
      "UnderReviewChip",
      "ReviewedChip",
      "ContestedChip",
      "CorrectedChip",
      "RetractedChip",
      "PAPER_STATUSES",
      "STATUS_CHIP_SPECS",
      "isPaperStatus",
      "statusChipLabel",
      "Icon",
    ]) {
      expect(kit, `missing export ${name}`).toHaveProperty(name);
    }
  });
});
