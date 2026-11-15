import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for security-page.css against docs/design.md §3, §5.6 and §9.
 *
 * The stylesheet is read as shipped so a hard-coded colour, a state that
 * leans on colour alone, or a control that loses its focus ring fails here
 * rather than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "security-page.css"), "utf8");
/** Rules only: the header comments deliberately name colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("security-page.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("only uses tokens that exist", () => {
    const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");
    const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      expect(tokens, `${token} is not defined in tokens.css`).toContain(`${token}:`);
    }
  });

  it("marks an error with a critical border and fill, never the word colour", () => {
    expect(rules).toMatch(/\.db-error\s*\{[^}]*border-color:\s*var\(--critical\)/s);
    expect(rules).toMatch(/\.db-error\s*\{[^}]*background:\s*var\(--critical-soft\)/s);
    // The message stays ink: it is the words that carry the meaning.
    expect(rules).toMatch(/\.db-note,\s*\.db-error\s*\{[^}]*color:\s*var\(--ink\)/s);
  });

  it("makes a disabled button look disabled by more than its colour", () => {
    expect(rules).toMatch(/\.db-button:disabled\s*\{[^}]*border-style:\s*dashed/s);
    expect(rules).toMatch(/\.db-button:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
  });

  it("fills only the primary action", () => {
    expect(rules).toMatch(/\.db-button\[data-variant="primary"\]\s*\{[^}]*background:\s*var\(--accent\)/s);
    expect(rules).toMatch(/\.db-button\[data-variant="primary"\]\s*\{[^}]*color:\s*var\(--accent-ink\)/s);
  });

  it("lets a disabled primary button win over the primary fill", () => {
    const primary = rules.indexOf('.db-button[data-variant="primary"] {');
    const disabled = rules.indexOf(".db-button:disabled {");
    expect(primary).toBeGreaterThan(-1);
    expect(disabled).toBeGreaterThan(primary);
  });

  it("keeps keyboard focus visible on the reason field", () => {
    expect(rules).toMatch(/\.db-input:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  });

  it("gives touch readers a 44 px field (docs/design.md §9)", () => {
    expect(rules).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\.db-input\s*\{[^}]*min-block-size:\s*44px/s);
  });

  it("wraps nothing it should not: the stat figure keeps its digits aligned", () => {
    expect(rules).toMatch(/\.db-stat-value\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
  });
});
