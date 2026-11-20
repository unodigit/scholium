import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for profile-page.css against docs/design.md §3 and §9.
 *
 * Bug: the profile page's `pp-*` classes had no stylesheet at all, so the page
 * rendered as an unstyled list. The stylesheet is read as shipped so a
 * missing rule, a hard-coded colour or a target too small to touch fails here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "profile-page.css"), "utf8");
/** Rules only: the header comment deliberately names colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("profile-page.css", () => {
  it("styles every class the profile page renders", () => {
    for (const name of [
      "pp-page",
      "pp-hero",
      "pp-name",
      "pp-name--pseudonym",
      "pp-affiliation",
      "pp-chips",
      "pp-chip",
      "pp-chip--orcid",
      "pp-did",
      "pp-copy-button",
      "pp-copy-tip",
      "pp-grid",
      "pp-card",
      "pp-card-heading",
      "pp-papers",
      "pp-paper",
      "pp-paper-title",
      "pp-reviews",
      "pp-review",
      "pp-empty",
      "pp-notice",
      "pp-button",
    ]) {
      expect(rules, `.${name}`).toMatch(new RegExp(`\\.${name}\\b`));
    }
  });

  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("draws cards as the design does: 1 px rule, card radius, no drop shadow", () => {
    expect(rules).toMatch(/\.pp-card[^{]*\{[^}]*border:\s*1px solid var\(--rule\)/s);
    expect(rules).toMatch(/\.pp-card[^{]*\{[^}]*border-radius:\s*var\(--corner-card\)/s);
    expect(rules).not.toMatch(/box-shadow/);
  });

  it("keeps a link underlined, so it never rests on colour alone", () => {
    expect(rules).toMatch(/\.pp-paper-title\s*\{[^}]*text-decoration-line:\s*underline/s);
  });

  it("keeps keyboard focus visible", () => {
    expect(rules).toMatch(/\.pp-copy-button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
    expect(rules).toMatch(/\.pp-paper-title:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  });

  it("gives touch readers a 44 px target (docs/design.md §9)", () => {
    expect(rules).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*min-block-size:\s*44px/s);
  });

  it("honours reduced motion", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(rules).toMatch(/transition:\s*none/);
  });

  it("does not title-case the recommendation label", () => {
    expect(rules).not.toMatch(/\.pp-review-rec[^{]*\{[^}]*text-transform/);
  });
});
