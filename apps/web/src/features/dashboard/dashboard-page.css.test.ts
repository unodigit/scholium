import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for dashboard-page.css against docs/design.md §3, §5.6 and §9.
 *
 * The stylesheet is read as shipped so a hard-coded colour, a state that
 * leans on colour alone, or a card grid that never collapses fails here
 * rather than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "dashboard-page.css"), "utf8");
/** Rules only: the header comments deliberately name colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("dashboard-page.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("draws cards from surface, rule and the card corner token", () => {
    expect(rules).toMatch(/\.db-card\s*\{/);
    expect(rules).toMatch(/background:\s*var\(--surface\)/);
    expect(rules).toMatch(/border:\s*1px solid var\(--rule\)/);
    expect(rules).toMatch(/border-radius:\s*var\(--corner-card\)/);
  });

  it("carries a review state in the border and fill, never the word colour", () => {
    expect(rules).toMatch(/\.db-chip\[data-tone="pending"\]\s*\{/);
    expect(rules).toMatch(/border-color:\s*var\(--pending\)/);
    expect(rules).toMatch(/background:\s*var\(--pending-soft\)/);
    expect(rules).toMatch(/\.db-chip\[data-tone="verified"\]\s*\{/);
    // The label stays ink: --pending on --pending-soft is below 4.5:1.
    expect(rules).toMatch(/\.db-chip\s*\{[^}]*color:\s*var\(--ink\)/s);
  });

  it("marks the card the notifications bell deep-links to", () => {
    expect(rules).toMatch(/\.db-card:target\s*\{/);
  });

  it("wraps long ids instead of outgrowing the card", () => {
    expect(rules).toMatch(/\.db-cred-id\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it("keeps keyboard focus visible on links and buttons", () => {
    expect(rules).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  });

  it("gives touch readers a 44 px target (docs/design.md §9)", () => {
    expect(rules).toMatch(/@media \(pointer: coarse\)/);
    expect(rules).toMatch(/min-block-size:\s*44px/);
  });

  it("collapses the card grid to one column on a phone", () => {
    expect(rules).toMatch(/@media \(max-width: 40rem\)/);
    expect(rules).toMatch(/grid-template-columns:\s*1fr/);
  });

  it("honours reduced motion", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(rules).toMatch(/transition:\s*none/);
  });
});
