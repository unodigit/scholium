import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for verify-page.css (and the route's shell) against
 * docs/design.md §3 (tokens), §5.3 and §9 (accessibility).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a status colour on text fails here rather
 * than in front of a reader checking a file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const page = read(join(here, "verify-page.css"));
const shell = read(join(here, "../../app/(verify-page)/verify-page.css"));

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
  ["verify-page.css", page],
  ["(verify-page)/verify-page.css", shell],
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

describe("verify-page.css", () => {
  it("puts status colour on icons and borders, never on the words (README: 4.5:1 rule)", () => {
    for (const { selector, body } of blocks(page.rules)) {
      if (/(^|;|\s)color:\s*var\(--(verified|pending|critical)\)/.test(body)) {
        expect(selector, `status colour on text in ${selector}`).toMatch(/__icon/);
      }
    }
    // The tints are fills, which take --ink text; none is used as a text colour.
    expect(page.rules).not.toMatch(/(^|;|\s)color:\s*var\(--(verified|pending|critical)-soft\)/);
  });

  it("colours the verdict through one custom property set per tone, red only for critical", () => {
    expect(page.rules).toMatch(/\.vp-verdict\[data-tone="verified"\][^{]*\{[^}]*--vp-icon:\s*var\(--verified\)/);
    expect(page.rules).toMatch(/\.vp-verdict\[data-tone="critical"\][^{]*\{[^}]*--vp-icon:\s*var\(--critical\)/);
    // "Checking…" and "Could not check" are grey: no tone rule gives them a status colour.
    expect(page.rules).not.toMatch(/data-tone="neutral"/);
    expect(page.rules).not.toMatch(/data-kind="(?:cannot_check|checking)"\][^{]*\{[^}]*--(?:verified|critical)/);
  });

  it("makes a mismatch heavier than a match, so it does not rest on hue alone", () => {
    const critical = blocks(page.rules).find((block) => block.selector === '.vp-verdict[data-tone="critical"]');
    expect(critical?.body).toMatch(/border-width:\s*2px/);
    expect(critical?.body).toMatch(/border-color:\s*var\(--critical\)/);
  });

  it("keeps targets at least 44px, and the ids in monospace", () => {
    for (const selector of [".vp-button", ".vp-input", ".vp-details__summary"]) {
      const rule = blocks(page.rules).find((block) => block.selector === selector);
      expect(rule?.body, selector).toMatch(/min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/);
    }
    expect(page.rules).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.vp-copy\s*\{[^}]*calc\(var\(--space-unit\) \* 11\)/);
    expect(page.rules).toMatch(/\.vp-copy__value\s*\{[^}]*font-family:\s*var\(--family-mono\)/);
    expect(page.rules).toMatch(/\.vp-input\s*\{[^}]*font-family:\s*var\(--family-mono\)/);
  });

  it("draws the drop target's edge at 3:1 (--ink-2, not the hairline --rule)", () => {
    const drop = blocks(page.rules).find((block) => block.selector === ".vp-drop");
    expect(drop?.body).toMatch(/border:\s*1px dashed var\(--ink-2\)/);
  });

  it("lets long ids, names and messages wrap instead of overflowing a narrow screen", () => {
    for (const selector of [
      ".vp-verdict__summary",
      ".vp-verdict__details",
      ".vp-copy__value",
      ".vp-tech__value",
      ".vp-signed__path",
      ".vp-drop__title",
      ".vp-error",
    ]) {
      const rule = blocks(page.rules).find((block) => block.selector === selector);
      expect(rule?.body, selector).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it("turns the checking ring, and stops it under reduced motion", () => {
    expect(page.rules).toMatch(
      /\.vp-verdict\[data-kind="checking"\] \.vp-verdict__icon\s*\{[^}]*animation:\s*vp-spin 900ms linear infinite/,
    );
    expect(page.rules).toMatch(/@keyframes vp-spin/);
    const reduced = page.rules.slice(page.rules.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/\.vp-verdict\[data-kind="checking"\] \.vp-verdict__icon\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.vp-drop,\s*\.vp-button\s*\{[^}]*transition:\s*none/);
  });

  it("recolours icons, links and borders in forced-colours mode", () => {
    const forced = page.rules.slice(page.rules.indexOf("forced-colors"));
    expect(forced).toMatch(/color:\s*CanvasText/);
    expect(forced).toMatch(/color:\s*LinkText/);
    expect(forced).toMatch(/border-color:\s*ButtonText/);
    expect(forced).toMatch(/\.vp-drop[^{]*\{[^}]*border-color:\s*CanvasText/);
  });

  it("prefixes every class so nothing leaks into other features", () => {
    const classes = [...page.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("vp-"))).toEqual([]);
  });
});

describe("(verify-page)/verify-page.css", () => {
  it("prefixes its classes apart from the feature's, so the two sheets cannot collide", () => {
    const classes = [...shell.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((name) => !name.startsWith("vps-"))).toEqual([]);
  });
});
