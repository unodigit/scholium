// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProvenanceSection } from "./provenance";
import { VERDICT_BAD, VERDICT_OK } from "./tamper-demo";

/**
 * The Provenance section: the tamper toggle in both directions, the pressed
 * state and the live verdict it announces, and the five status chips, each of
 * which keeps its word beside its icon.
 */

afterEach(() => {
  cleanup();
});

function liveVerdict(container: HTMLElement): string {
  const live = container.querySelector('[aria-live="polite"]');
  expect(live).not.toBeNull();
  const shown = Array.from(live!.querySelectorAll(":scope > span")).find(
    (span) => !(span as HTMLElement).hidden,
  );
  expect(shown).toBeTruthy();
  return shown!.textContent!.trim();
}

describe("the section", () => {
  it("names itself, with the reference's eyebrow, title and lead", () => {
    const { container } = render(<ProvenanceSection />);

    const section = container.querySelector("#signed")!;
    expect(section).not.toBeNull();
    expect(section.getAttribute("aria-labelledby")).toBe("signed-title");
    expect(screen.getByText("Provenance")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Signed by you. Checkable by anyone.",
      }),
    ).toBeTruthy();
    expect(container.textContent).toContain(
      "Each new version records the fingerprint of the one before",
    );
  });

  it("shows three signed versions joined by drawn arrows", () => {
    const { container } = render(<ProvenanceSection />);

    const blocks = container.querySelectorAll(".chain .block");
    expect(blocks).toHaveLength(3);
    expect(Array.from(blocks).map((block) => block.querySelector(".vtag")!.textContent)).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
    // Every version carries a date, both fingerprints and a 2-of-2 signature.
    for (const block of Array.from(blocks)) {
      expect(block.querySelector("time")).not.toBeNull();
      expect(block.querySelectorAll("dd")).toHaveLength(2);
      expect(block.querySelector(".signer")!.textContent).toContain("2 of 2");
      expect(block.querySelector(".signer .ico")).not.toBeNull();
    }
    // Two links, and the second is the one that can break.
    expect(container.querySelectorAll(".chain .link")).toHaveLength(2);
    expect(container.querySelector(".chain .link.brk")).not.toBeNull();
  });

  it("carries the reference's three promises and the stable ID to cite", () => {
    const { container } = render(<ProvenanceSection />);

    const items = container.querySelectorAll(".trio li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Your key stays yours.");
    expect(items[1].textContent).toContain("Every author agrees.");
    expect(items[2].textContent).toContain("A stable ID to cite.");
    expect(items[2].querySelector("code")!.textContent).toBe("sch:k3f9-q2xz-7mwd/v1");
  });
});

describe("the tamper demo", () => {
  const trigger = () =>
    screen.getByRole("button", {
      name: /Change one byte in v2|Restore v2/,
    });

  it("starts verified, with the button unpressed and wired to the demo", () => {
    const { container } = render(<ProvenanceSection />);

    const demo = container.querySelector("#chain")!;
    expect(demo.getAttribute("data-state")).toBe("ok");
    expect(trigger().getAttribute("aria-pressed")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBe("chain");
    expect(liveVerdict(container)).toBe(VERDICT_OK);
    expect(container.querySelector(".cid .ok")!.getAttribute("aria-hidden")).toBeNull();
  });

  it("breaks v2, the v2–v3 link and the verdict when one byte changes", () => {
    const { container } = render(<ProvenanceSection />);

    fireEvent.click(trigger());

    const demo = container.querySelector("#chain")!;
    expect(demo.getAttribute("data-state")).toBe("bad");
    expect(trigger().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Restore v2" })).toBeTruthy();
    expect(liveVerdict(container)).toBe(VERDICT_BAD);

    // v2's fingerprint swaps to the tampered one.
    expect(container.querySelector(".block.v2 .cid .ok")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".block.v2 .cid .bad")!.getAttribute("aria-hidden")).toBeNull();
    // The signature line changes in the same place.
    expect(container.querySelector(".block.v2 .signer")!.textContent).toContain(
      "Signature no longer matches",
    );
    // v3's previous value gains the ≠ mark.
    expect(container.querySelector(".block .neq")).not.toBeNull();
  });

  it("puts everything back when pressed again", () => {
    const { container } = render(<ProvenanceSection />);

    fireEvent.click(trigger());
    fireEvent.click(trigger());

    const demo = container.querySelector("#chain")!;
    expect(demo.getAttribute("data-state")).toBe("ok");
    expect(trigger().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Change one byte in v2" })).toBeTruthy();
    expect(liveVerdict(container)).toBe(VERDICT_OK);
    expect(container.querySelector(".block.v2 .cid .ok")!.getAttribute("aria-hidden")).toBeNull();
    expect(container.querySelector(".block.v2 .cid .bad")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the corrections row", () => {
  it("keeps each status chip's word beside its icon", () => {
    const { container } = render(<ProvenanceSection />);

    expect(container.textContent).toContain("Corrections are part of the record.");
    const chips = Array.from(container.querySelectorAll(".chips .chip"));
    expect(chips.map((chip) => chip.textContent!.trim())).toEqual([
      "Preprint",
      "Under review",
      "Reviewed",
      "Corrected",
      "Retracted",
    ]);
    for (const chip of chips) {
      expect(chip.querySelector("svg")).not.toBeNull();
    }
  });
});
