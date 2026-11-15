import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for policies-page.css against docs/design.md §3 and §9.
 *
 * The stylesheet is read as shipped so a hard-coded colour or a dropped
 * anchor offset fails here rather than in front of a reader arriving from a
 * decision banner.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "policies-page.css"), "utf8");
/** Rules only: the header comment deliberately names colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("policies-page.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("offsets anchor targets below the 64px sticky header", () => {
    expect(rules).toMatch(/scroll-margin-top:\s*calc\(64px \+ 8px\)/);
  });

  it("marks the clause a decision banner linked to", () => {
    expect(rules).toMatch(/\.pp-clause:target\s*\{/);
    expect(rules).toMatch(/border-color:\s*var\(--accent\)/);
  });

  it("keeps the clause reading text on the design tokens", () => {
    expect(rules).toMatch(/font-family:\s*var\(--family-serif\)/);
    expect(rules).toMatch(/max-width:\s*var\(--measure-reading\)/);
    expect(rules).toMatch(/line-height:\s*var\(--leading-reading\)/);
  });
});
