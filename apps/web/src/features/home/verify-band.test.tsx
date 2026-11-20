import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { VerifyBand } from "./verify-band";

afterEach(cleanup);

/** A `hidden` attribute inside a tag. */
const HIDDEN_ATTRIBUTE = /<[a-z][^>]*\shidden(=|\s|\/|>)/i;

const CHECKLIST = [
  "✓ Signed by all authors (2 of 2)",
  "✓ History intact (v1 → v2 → v3)",
  "✓ Files match what the authors signed",
  "◷ Timestamp anchor pending",
  "✓ No retraction",
  "Verified.",
];

describe("VerifyBand", () => {
  it("is the #verify section and sets the dark tokens on its own element", () => {
    const { container } = render(createElement(VerifyBand));
    const section = container.querySelector("section#verify");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("data-theme")).toBe("dark");
    expect(section?.getAttribute("aria-labelledby")).toBe("verify-title");
    expect(screen.getByRole("heading", { level: 2, name: "Take the record with you." }).id).toBe("verify-title");
  });

  it("shows the eyebrow, title and lead from the reference", () => {
    const { container } = render(createElement(VerifyBand));
    expect(container.querySelector(".eyebrow")?.textContent).toBe("Verify anywhere");
    const lead = container.querySelector(".lead");
    expect(lead?.textContent).toBe(
      "Export any paper, with every version, signature and review, as a single archive. It verifies offline, on your own machine, with no help from Scholium.",
    );
    expect(lead?.querySelector("b")?.textContent).toBe(
      "It verifies offline, on your own machine, with no help from Scholium.",
    );
  });

  it("gives the example terminal role img and a text label that says what it shows", () => {
    render(createElement(VerifyBand));
    const terminal = screen.getByRole("img", { name: /^Example terminal session: scholium verify reward-calibration\.car/ });
    const label = terminal.getAttribute("aria-label") ?? "";
    for (const phrase of [
      "signed by all authors",
      "history intact",
      "files match",
      "timestamp anchor pending",
      "no retraction",
      "verified",
    ]) {
      expect(label).toContain(phrase);
    }
  });

  it("types the command and lists the checklist, line by line, in order", () => {
    const { container } = render(createElement(VerifyBand));
    expect(container.querySelector(".typed")?.textContent).toBe("scholium verify reward-calibration.car");
    expect(container.querySelector(".t-prompt")?.textContent).toBe("$ ");
    expect(container.querySelector(".caret")).not.toBeNull();

    const lines = Array.from(container.querySelectorAll<HTMLElement>(".t-out"));
    expect(lines.map((line) => line.textContent)).toEqual(CHECKLIST);
    // Each line fades in on its own delay: the stagger index is its position.
    expect(lines.map((line) => line.style.getPropertyValue("--k"))).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(container.querySelector(".t-final")?.textContent).toBe("Verified.");
    expect(container.querySelector(".t-pend")?.textContent).toBe("◷");
  });

  it("links three cards: /verify, /papers and /network", () => {
    const { container } = render(createElement(VerifyBand));
    const cards = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.vlink"));
    expect(cards.map((card) => [card.querySelector("b")?.textContent, card.getAttribute("href")])).toEqual([
      ["Check a file in your browser", "/verify"],
      ["Export what you cite", "/papers"],
      ["See the network", "/network"],
    ]);
    expect(screen.getByRole("link", { name: /Check a file in your browser/ }).getAttribute("href")).toBe("/verify");
    expect(screen.getByRole("link", { name: /Export what you cite/ }).getAttribute("href")).toBe("/papers");
    expect(screen.getByRole("link", { name: /See the network/ }).getAttribute("href")).toBe("/network");
    expect(container.querySelectorAll("a")).toHaveLength(3);
  });

  it("tags the roadmap note as Planned", () => {
    const { container } = render(createElement(VerifyBand));
    const note = container.querySelector(".roadmap");
    expect(note?.querySelector(".tag")?.textContent).toBe("Planned");
    expect(note?.textContent).toBe("Planned Public timestamp anchoring, DOIs and independent library nodes.");
  });

  it("reveals each block on scroll through the shared reveal class", () => {
    const { container } = render(createElement(VerifyBand));
    // header, terminal, three cards, roadmap note
    expect(container.querySelectorAll(".reveal")).toHaveLength(6);
    expect(container.querySelector(".term-wrap")?.classList.contains("reveal")).toBe(true);
  });

  it("puts every word in the server-rendered HTML, with nothing hidden", () => {
    const html = renderToString(createElement(VerifyBand));
    for (const text of [
      "Verify anywhere",
      "Take the record with you.",
      "Export any paper, with every version, signature and review, as a single archive.",
      "scholium verify reward-calibration.car",
      "Signed by all authors",
      "(v1 → v2 → v3)",
      "Files match what the authors signed",
      "Timestamp anchor pending",
      "No retraction",
      "Verified.",
      "Check a file in your browser",
      "Export what you cite",
      "See the network",
      "Planned",
      "Public timestamp anchoring, DOIs and independent library nodes.",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('role="img"');
    expect(html).not.toMatch(HIDDEN_ATTRIBUTE);
  });
});

/* ---- journey.css: the constraints that live in the stylesheet ---------------- */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "journey.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Innermost rules: selector plus declarations (keyframe steps excluded). */
function rules(source: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (/^(from|to|\d+%)$/.test(selector) || selector.startsWith("@")) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

describe("journey.css", () => {
  it("reads every colour from a custom property: no hex literal", () => {
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/\brgba?\(/);
  });

  it("applies hidden animation start states only under html[data-home-js]", () => {
    // The caret is only ever shown by its blink, and the card ring only on hover.
    const alwaysHidden = [".band-dark .caret", ".band-dark .vlink::after"];
    const hiding = /(^|[;\s])(opacity:\s*0|width:\s*0|transform:\s*(scale\(0\.5\)|scale[XY]\(0\)))\s*(;|$)/;
    const offenders = rules(bare)
      .filter(({ selector, body }) => hiding.test(body) && !alwaysHidden.includes(selector))
      .filter(({ selector }) => !selector.split(",").every((part) => part.trim().startsWith("html[data-home-js]")))
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
    expect(bare).toContain("html[data-home-js] .band-dark .typed { width: 0; }");
  });

  it("animates transform and opacity only, bar the command's stepped width", () => {
    for (const match of bare.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      const [, name, body] = match;
      if (name === "journey-type") continue;
      const props = Array.from(body.matchAll(/([\w-]+)\s*:/g)).map((p) => p[1]);
      expect(props.length, name).toBeGreaterThan(0);
      for (const prop of props) expect(["opacity", "transform"], `${name}: ${prop}`).toContain(prop);
    }
    for (const decl of bare.matchAll(/transition:\s*([^;}]*)[;}]/g)) {
      const names = Array.from(decl[1].matchAll(/(?:^|,)\s*([a-z-]+)\s+[\d.]+m?s/g)).map((n) => n[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(["opacity", "transform"], decl[1]).toContain(name);
    }
  });

  it("types the 38-character command in 38 steps and blinks the caret", () => {
    expect("scholium verify reward-calibration.car").toHaveLength(38);
    expect(bare).toMatch(/\.typed \{ animation: journey-type [\d.]+s steps\(38, end\)/);
    expect(bare).toMatch(/@keyframes journey-type \{ from \{ width: 0; \} to \{ width: 38ch; \} \}/);
    expect(bare).toMatch(/\.caret \{ animation: journey-caret [\d.]+s steps\(1\) \d+ both; \}/);
  });

  it("lifts the cards on hover and presses them in on pointer-down", () => {
    expect(bare).toMatch(/\.band-dark \.vlink:hover \{ transform: translateY\(-3px\); \}/);
    expect(bare).toMatch(/\.band-dark \.vlink:active \{ transform: scale\(0\.98\);/);
  });

  it("draws the connector lines horizontally, then vertically under 900px", () => {
    expect(bare).toContain("html[data-home-js] .how .step-line::after { transform: scaleX(0); }");
    const mobile = bare.slice(bare.indexOf("@media (max-width: 900px)"));
    expect(mobile).toContain("html[data-home-js] .how .step-line::after { transform: scaleY(0); }");
    expect(mobile).toContain(".how .step-line { top: 54px;");
  });

  it("honours reduced motion, increased contrast and forced colours", () => {
    expect(bare).toContain("@media (prefers-reduced-motion: reduce)");
    expect(bare).toContain("@media (prefers-contrast: more)");
    expect(bare).toContain("@media (forced-colors: active)");
  });
});
