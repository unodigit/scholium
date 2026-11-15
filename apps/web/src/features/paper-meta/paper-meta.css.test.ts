import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for paper-meta.css and the route's shell against
 * docs/design.md §3 (tokens), §5.2 and §9 (accessibility).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a status colour on text fails here rather
 * than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const tabs = read(join(here, "paper-meta.css"));
const shell = read(join(here, "../../app/(paper-meta)/paper-meta.css"));

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
  ["paper-meta.css", tabs],
  ["app/(paper-meta)/paper-meta.css", shell],
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

  it("casts no shadow (design.md §3: only the annotation popover floats)", () => {
    expect(css.rules).not.toMatch(/box-shadow|text-shadow|drop-shadow|--popover-shadow/);
  });

  it("never removes the keyboard focus ring", () => {
    expect(css.rules).not.toMatch(/outline:\s*(?:none|0)\b/);
  });
});

describe("paper-meta.css", () => {
  it("puts status colour on icons and borders, never on the words", () => {
    for (const { selector, body } of blocks(tabs.rules)) {
      if (/(^|;|\s)color:\s*var\(--(verified|pending|critical)\)/.test(body)) {
        expect(selector, `status colour on text in ${selector}`).toMatch(/__icon/);
      }
    }
    expect(tabs.rules).not.toMatch(/(^|;|\s)color:\s*var\(--(verified|pending|critical)-soft\)/);
  });

  it("gives the anchor its own icon colour per state", () => {
    expect(tabs.rules).toMatch(
      /\.pm-anchor\[data-status="pending"\][^{]*\{[^}]*--pm-anchor-icon:\s*var\(--pending\)/,
    );
    expect(tabs.rules).toMatch(
      /\.pm-anchor\[data-status="anchored"\][^{]*\{[^}]*--pm-anchor-icon:\s*var\(--verified\)/,
    );
  });

  it("gives each scan tone its own icon and border colour, with the label in ink", () => {
    expect(tabs.rules).toMatch(
      /\.pm-scan\[data-tone="verified"\][^{]*\{[^}]*--pm-scan-icon:\s*var\(--verified\)[^}]*border-color:\s*var\(--verified\)/,
    );
    expect(tabs.rules).toMatch(
      /\.pm-scan\[data-tone="pending"\][^{]*\{[^}]*--pm-scan-icon:\s*var\(--pending\)[^}]*border-color:\s*var\(--pending\)/,
    );
    expect(tabs.rules).toMatch(
      /\.pm-scan\[data-tone="critical"\][^{]*\{[^}]*--pm-scan-icon:\s*var\(--critical\)[^}]*border-color:\s*var\(--critical\)/,
    );
    const scan = blocks(tabs.rules).find((block) => block.selector === ".pm-scan");
    expect(scan?.body).toMatch(/color:\s*var\(--ink\)/);
  });

  it("keeps every standalone control at least 44px tall (touch target, design.md §9)", () => {
    expect(tabs.rules).toMatch(
      /\.pm-button\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/,
    );
    expect(tabs.rules).toMatch(
      /\.pm-download\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/,
    );
  });

  it("sets file paths in monospace and lets long ids and notes wrap", () => {
    const path = blocks(tabs.rules).find((block) => block.selector === ".pm-file__path");
    expect(path?.body).toMatch(/font-family:\s*var\(--family-mono\)/);
    expect(path?.body).toMatch(/overflow-wrap:\s*anywhere/);
    for (const selector of [".pm-version__note", ".pm-error__message"]) {
      const rule = blocks(tabs.rules).find((block) => block.selector === selector);
      expect(rule?.body, selector).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it("threads the timeline through its markers, never colour alone", () => {
    expect(tabs.rules).toMatch(/\.pm-version:not\(:last-child\)::before\s*\{[^}]*background:\s*var\(--rule\)/);
    expect(tabs.rules).toMatch(/\.pm-timeline\s*\{[^}]*list-style:\s*none/);
    expect(tabs.rules).toMatch(/\.pm-chip--current\s*\{[^}]*border-color:\s*var\(--accent\)/);
  });

  it("separates file meta with generated content that is not read aloud", () => {
    expect(tabs.rules).toMatch(
      /\.pm-file__meta > :not\(:last-child\)::after\s*\{[^}]*content:\s*"·" \/ ""/,
    );
  });

  it("turns the loading and scanning rings, and stops them under reduced motion", () => {
    expect(tabs.rules).toMatch(
      /\.pm-loading__icon\s*\{[^}]*animation:\s*pm-spin 900ms linear infinite/,
    );
    expect(tabs.rules).toMatch(
      /\.pm-scan\[data-status="scanning"\] \.pm-scan__icon\s*\{[^}]*animation:\s*pm-spin 900ms linear infinite/,
    );
    const reduced = tabs.rules.slice(tabs.rules.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/\.pm-loading__icon[\s\S]*animation:\s*none/);
    expect(reduced).toMatch(/\.pm-scan\[data-status="scanning"\] \.pm-scan__icon\s*\{[^}]*animation:\s*none/);
  });

  it("recolours icons, links and controls in forced-colours mode", () => {
    const forced = tabs.rules.slice(tabs.rules.indexOf("forced-colors"));
    expect(forced).toMatch(/color:\s*CanvasText/);
    expect(forced).toMatch(/color:\s*LinkText/);
    expect(forced).toMatch(/border-color:\s*ButtonText/);
  });

  it("has a visually hidden class that keeps text readable by assistive technology", () => {
    const hidden = blocks(tabs.rules).find((block) => block.selector === ".pm-visually-hidden");
    expect(hidden?.body).toMatch(/position:\s*absolute/);
    expect(hidden?.body).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden?.body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("prefixes every class so nothing leaks into other features", () => {
    const classes = [...tabs.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("pm-"))).toEqual([]);
  });
});

describe("the route shell", () => {
  it("prefixes every class with pmeta-", () => {
    const classes = [...shell.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("pmeta-"))).toEqual([]);
  });

  it("centres the page in a column of its own width", () => {
    const rule = blocks(shell.rules).find((block) => block.selector === ".pmeta-shell");
    expect(rule?.body).toMatch(/max-width:\s*calc\(var\(--margin-panel\)/);
    expect(rule?.body).toMatch(/margin-inline:\s*auto/);
  });
});
