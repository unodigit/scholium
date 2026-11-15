import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for the review card actions' stylesheet against
 * docs/design.md §3, §9 and §10: tokens only, the AI colour reserved, status
 * never by colour alone, 44px touch targets, a visible focus ring.
 *
 * The stylesheet is read as shipped so a hard-coded colour or a dropped focus
 * ring fails here rather than in front of an author.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Rules only: the header comment deliberately names colours and tokens. */
const rules = readFileSync(join(here, "review-actions.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("review-actions.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("casts no shadow: only the annotation popover floats", () => {
    expect(rules).not.toMatch(/box-shadow/);
  });

  it("keeps every rule under the ra- prefix, so nothing leaks into the card or other features", () => {
    const selectors = [...rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((match) =>
      (match[2] ?? "").trim(),
    );
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim()).toMatch(/^\.ra-/);
      }
    }
  });

  it("makes every control a target of at least 44px", () => {
    expect(rules).toMatch(/\.ra-summary\s*\{[^}]*min-block-size:\s*44px/);
    expect(rules).toMatch(/\.ra-button\s*\{[^}]*min-block-size:\s*44px/);
    expect(rules).toMatch(/\.ra-choice\s*\{[^}]*min-block-size:\s*44px/);
    expect(rules).toMatch(/\.ra-choice\s*\{[^}]*min-inline-size:\s*44px/);
  });

  it("shows a visible focus ring on every control", () => {
    for (const control of [
      "ra-summary",
      "ra-textarea",
      "ra-button",
      "ra-link",
    ]) {
      expect(rules).toMatch(
        new RegExp(
          `\\.${control}:focus-visible\\s*\\{[^}]*outline:\\s*2px solid var\\(--focus-ring\\)`,
        ),
      );
    }
  });

  it("marks a failure with the critical colour on the icon, not on the words", () => {
    expect(rules).toMatch(/\.ra-error__icon\s*\{[^}]*color:\s*var\(--critical\)/);
    expect(rules).toMatch(/\.ra-error\s*\{[^}]*color:\s*var\(--ink\)/);
  });

  it("marks success with the verified colour on the icon, and keeps the headline in ink", () => {
    expect(rules).toMatch(/\.ra-sent__icon\s*\{[^}]*color:\s*var\(--verified\)/);
    expect(rules).toMatch(/\.ra-sent__headline\s*\{[^}]*color:\s*var\(--ink\)/);
  });

  it("anchors the visually hidden score text to its label", () => {
    expect(rules).toMatch(/\.ra-choice\s*\{[^}]*position:\s*relative/);
    expect(rules).toMatch(/\.ra-sr-only\s*\{[^}]*position:\s*absolute/);
  });

  it("draws the rating's legend inside its fieldset", () => {
    expect(rules).toMatch(/\.ra-legend\s*\{[^}]*float:\s*left/);
    expect(rules).toMatch(/\.ra-legend \+ \*\s*\{[^}]*clear:\s*both/);
  });

  it("lets long words and a long reply wrap instead of overflowing the narrow panel", () => {
    expect(rules).toMatch(/\.ra-error\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(rules).toMatch(/\.ra-sent__answer\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(rules).toMatch(/\.ra-textarea\s*\{[^}]*inline-size:\s*100%/);
  });

  it("sets the UI in the UI face", () => {
    expect(rules).toMatch(/\.ra-actions\s*\{[^}]*font-family:\s*var\(--family-sans\)/);
  });
});
