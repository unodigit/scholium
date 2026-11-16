import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for follow-toggle.css against docs/design.md §3, §5.1 and §9.
 *
 * The stylesheet is read as shipped so a hard-coded colour, a pressed state
 * that leans on colour alone, or a target too small to touch fails here
 * rather than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "follow-toggle.css"), "utf8");
/** Rules only: the header comment deliberately names colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("follow-toggle.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("draws the pressed state in the border and fill, and keeps the label ink", () => {
    expect(rules).toMatch(
      /\.db-follow-button\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/s,
    );
    expect(rules).toMatch(/\.db-follow-button\s*\{[^}]*color:\s*var\(--ink\)/s);
  });

  it("keeps keyboard focus visible", () => {
    expect(rules).toMatch(
      /\.db-follow-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s,
    );
  });

  it("gives touch readers a 44 px target (docs/design.md §9)", () => {
    expect(rules).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*min-block-size:\s*44px/s);
  });

  it("honours reduced motion", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(rules).toMatch(/transition:\s*none/);
  });
});
