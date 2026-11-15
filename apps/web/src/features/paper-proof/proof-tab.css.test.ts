import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for proof-tab.css (and the route's shell) against
 * docs/design.md §3 (tokens), §5.3 and §9 (accessibility).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a status colour on text fails here rather
 * than in front of a reader checking a paper.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const tab = read(join(here, "proof-tab.css"));
const shell = read(join(here, "../../app/(paper-proof)/paper-proof.css"));

/** Selector + declarations of every rule, flattening @media blocks. */
function blocks(rules: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(rules); match; match = pattern.exec(rules)) {
    out.push({ selector: match[1].trim().replace(/^@media[^{]*$/, ""), body: match[2] });
  }
  return out;
}

describe.each([
  ["proof-tab.css", tab],
  ["paper-proof.css", shell],
])("%s", (_name, css) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(css.rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css.rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(css.rules).not.toMatch(/--ai\b|--ai-soft\b/);
  });

  it("only reads custom properties that exist", () => {
    const defined = new Set(
      [...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g), ...css.rules.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(
        (match) => match[1],
      ),
    );
    const used = [...css.rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });
});

describe("proof-tab.css", () => {
  it("puts status colour on icons and borders, never on the words (README: 4.5:1 rule)", () => {
    for (const { selector, body } of blocks(tab.rules)) {
      if (/(^|;|\s)color:\s*var\(--(verified|pending|critical)\)/.test(body)) {
        expect(selector, `status colour on text in ${selector}`).toMatch(/__icon/);
      }
    }
    // The tints are fills, which take --ink text; none is used as a text colour.
    expect(tab.rules).not.toMatch(/(^|;|\s)color:\s*var\(--(verified|pending|critical)-soft\)/);
  });

  it("colours the verdict and each line through one custom property set per state", () => {
    expect(tab.rules).toMatch(/\.pt-verdict\[data-tone="verified"\][^{]*\{[^}]*--pt-icon:\s*var\(--verified\)/);
    expect(tab.rules).toMatch(/\.pt-verdict\[data-tone="pending"\][^{]*\{[^}]*--pt-icon:\s*var\(--pending\)/);
    expect(tab.rules).toMatch(/\.pt-verdict\[data-tone="critical"\][^{]*\{[^}]*--pt-icon:\s*var\(--critical\)/);
    expect(tab.rules).toMatch(/\.pt-item\[data-state="fail"\][^{]*\{[^}]*--pt-item-icon:\s*var\(--critical\)/);
    // "Could not check" and "Checking…" are grey: no tone rule gives them a status colour.
    expect(tab.rules).not.toMatch(/data-tone="neutral"/);
  });

  it("keeps targets at least 44px, and the ids in monospace", () => {
    expect(tab.rules).toMatch(/\.pt-button\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/);
    expect(tab.rules).toMatch(/\.pt-details__summary\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/);
    expect(tab.rules).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.pt-copy\s*\{[^}]*calc\(var\(--space-unit\) \* 11\)/);
    expect(tab.rules).toMatch(/\.pt-copy__value\s*\{[^}]*font-family:\s*var\(--family-mono\)/);
  });

  it("lets long ids and messages wrap instead of overflowing the 360px panel", () => {
    for (const selector of [".pt-item__text", ".pt-copy__value", ".pt-check__message", ".pt-tech__value"]) {
      const rule = blocks(tab.rules).find((block) => block.selector === selector);
      expect(rule?.body, selector).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it("turns the checking ring, and stops it under reduced motion", () => {
    expect(tab.rules).toMatch(
      /\.pt-verdict\[data-state="checking"\] \.pt-verdict__icon\s*\{[^}]*animation:\s*pt-spin 900ms linear infinite/,
    );
    expect(tab.rules).toMatch(/@keyframes pt-spin/);
    const reduced = tab.rules.slice(tab.rules.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/\.pt-verdict\[data-state="checking"\] \.pt-verdict__icon\s*\{[^}]*animation:\s*none/);
  });

  it("recolours icons, links and the button in forced-colours mode", () => {
    const forced = tab.rules.slice(tab.rules.indexOf("forced-colors"));
    expect(forced).toMatch(/color:\s*CanvasText/);
    expect(forced).toMatch(/color:\s*LinkText/);
    expect(forced).toMatch(/border-color:\s*ButtonText/);
  });

  it("has a visually hidden class that keeps the text readable by assistive technology", () => {
    const hidden = blocks(tab.rules).find((block) => block.selector === ".pt-visually-hidden");
    expect(hidden?.body).toMatch(/position:\s*absolute/);
    expect(hidden?.body).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden?.body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("prefixes every class so nothing leaks into other features", () => {
    const classes = [...tab.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("pt-"))).toEqual([]);
  });
});
