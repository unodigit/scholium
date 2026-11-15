import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for network-page.css against docs/design.md §3 and §9.
 *
 * The stylesheet is read as shipped so a hard-coded colour or a chip that
 * leans on colour alone fails here rather than in front of a reader who
 * cannot tell amber from grey.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "network-page.css"), "utf8");
/** Rules only: the header comments deliberately name colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("network-page.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("carries the pending state in the icon and the border, never the word", () => {
    // The tone rule sets the chip's colour family…
    expect(rules).toMatch(/\.np-chip\[data-tone="pending"\]\s*\{/);
    expect(rules).toMatch(/--np-chip-icon:\s*var\(--pending\)/);
    expect(rules).toMatch(/--np-chip-edge:\s*var\(--pending\)/);
    expect(rules).toMatch(/--np-chip-fill:\s*var\(--pending-soft\)/);
    // …and the label stays ink: --pending on --pending-soft is below 4.5:1.
    expect(rules).toMatch(/\.np-chip__label\s*\{[^}]*color:\s*var\(--ink\)/s);
  });

  it("draws the replica meter with tokens, filled before unfilled", () => {
    expect(rules).toMatch(/\.np-meter-segment\[data-filled="true"\]\s*\{/);
    expect(rules).toMatch(/background:\s*var\(--accent\)/);
    expect(rules).toMatch(/background:\s*var\(--rule\)/);
  });

  it("keeps ids and hashes monospace and breakable", () => {
    expect(rules).toMatch(/\.np-hash\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(rules).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("gives touch readers a 44 px clause target (docs/design.md §9)", () => {
    expect(rules).toMatch(/@media \(pointer: coarse\)/);
    expect(rules).toMatch(/min-block-size:\s*44px/);
  });

  it("collapses the card grid to one column on a phone", () => {
    expect(rules).toMatch(/@media \(max-width: 40rem\)/);
    expect(rules).toMatch(/grid-template-columns:\s*1fr/);
  });
});
