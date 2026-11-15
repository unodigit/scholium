import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for the "Cite in review" stylesheet against docs/design.md
 * §3 and §9: tokens only, the AI colour reserved, a 44px target, a visible
 * focus ring, and a button that stays inside the paper it quotes.
 *
 * The stylesheet is read as shipped, so a hard-coded colour or a dropped focus
 * ring fails here rather than in front of a reviewer.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Rules only: the header comments deliberately name tokens. */
function rulesOf(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const cite = rulesOf(join(here, "review-cite.css"));
const form = rulesOf(join(here, "review-form.css"));

describe("review-cite.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(cite).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(cite).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(cite).not.toMatch(/--ai\b/);
    expect(cite).not.toMatch(/--ai-soft\b/);
  });

  it("prefixes every rule with rc-, so nothing leaks into other features", () => {
    const selectors = Array.from(cite.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)).flatMap(
      (match) => match[2].split(","),
    );
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.trim()).toMatch(/^\.rc-/);
    }
  });

  it("positions the button inside the paper's wrapper, so it scrolls with the text", () => {
    expect(cite).toMatch(/\.rc-root\s*\{[^}]*position:\s*relative/);
    expect(cite).toMatch(/\.rc-offer\s*\{[^}]*position:\s*absolute/);
  });

  it("keeps the button inside the wrapper: never past its right edge, never off its left", () => {
    // Its right edge sits at the end of the selection, clamped to the wrapper.
    expect(cite).toMatch(/\.rc-offer\s*\{[^}]*transform:\s*translateX\(-100%\)/);
    expect(cite).toMatch(
      /\.rc-offer\s*\{[^}]*left:\s*min\(max\(var\(--rc-x,\s*0px\),\s*var\(--rc-width\)\),\s*100%\)/,
    );
    expect(cite).toMatch(/\.rc-button\s*\{[^}]*min-width:\s*var\(--rc-width\)/);
  });

  it("makes the button a target of at least 44px", () => {
    expect(cite).toMatch(/\.rc-button\s*\{[^}]*min-height:\s*44px/);
  });

  it("lifts the button with the design's one elevation token", () => {
    expect(cite).toMatch(/\.rc-button\s*\{[^}]*box-shadow:\s*var\(--popover-shadow\)/);
  });

  it("shows a visible focus ring on the button", () => {
    expect(cite).toMatch(
      /\.rc-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
    );
  });

  it("sits above the text it floats over", () => {
    expect(cite).toMatch(/\.rc-offer\s*\{[^}]*z-index:\s*1/);
  });

  it("stops animating for a reader who asks for less motion", () => {
    expect(cite).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.rc-button\s*\{[^}]*transition:\s*none/,
    );
  });
});

describe("review-form.css (the identity choice)", () => {
  it("gives the Sign with my name instead button air under the notice's words", () => {
    expect(form).toMatch(/\.rf-anonymity \.rf-identity-toggle\s*\{[^}]*margin-top:/);
  });

  it("sets the stylometry tip as a quiet line with the icon beside the words", () => {
    expect(form).toMatch(/\.rf-tip\s*\{[^}]*display:\s*flex/);
    expect(form).toMatch(/\.rf-tip\s*\{[^}]*color:\s*var\(--ink-2\)/);
    expect(form).toMatch(/\.rf-tip-icon\s*\{[^}]*flex:\s*none/);
  });

  it("does not borrow a status colour for the choice: the words carry it", () => {
    const identityRules = form.match(/\.rf-(?:tip|identity)[^{]*\{[^}]*\}/g) ?? [];
    expect(identityRules.length).toBeGreaterThan(0);
    for (const rule of identityRules) {
      expect(rule).not.toMatch(/--(?:verified|pending|critical)\b/);
    }
  });
});
